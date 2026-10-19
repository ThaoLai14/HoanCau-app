-- =============================================================================
-- fix-timestamptz.sql
-- =============================================================================
-- Purpose: Đổi tất cả cột `timestamp without time zone` sang `timestamptz`.
--
-- Bug đang gặp:
--   - App gửi `new Date().toISOString()` (UTC, có "Z" cuối) khi INSERT bill.
--   - Cột `bills.created_at` là `timestamp without time zone` → Postgres strip
--     mất TZ marker, lưu naive value trong DB (ví dụ `2026-08-27 09:31:05`).
--   - Fetch về không có TZ marker → JS `new Date("2026-08-27T09:31:05")` parse
--     như LOCAL time của trình duyệt.
--   - Kết quả: bill detail hiển thị "27/08/2026 09:31" (thực chất là giờ UTC)
--     trong khi audit_log.created_at (đã là TIMESTAMPTZ) hiển thị đúng
--     "16:31 27/08/2026" (giờ VN).
--
-- Backfill giả định:
--   Toàn bộ giá trị hiện có được coi là UTC vì:
--     (a) App code luôn gửi `new Date().toISOString()` = UTC.
--     (b) DB default `now()` trên Supabase = UTC (server TZ = UTC).
--   → `USING <col> AT TIME ZONE 'UTC'` chuyển đổi đúng cho MỌI row.
--
-- Cột được migrate (7 cột, từ 6 bảng):
--   bills.created_at
--   bills.delivery_date
--   bills.sent_date            (legacy, không dùng ở code — vẫn migrate cho sạch)
--   branches.created_at
--   client_phones.created_at
--   clients.created_at
--   expenses.created_at
--
-- Cột SKIP (do phụ thuộc view `monthly_revenue_report`, không dùng ở code):
--   bill_payment_details.payment_date  → giữ nguyên naive, không đụng.
--
-- Không đụng: các cột đã TIMESTAMPTZ (audit_log.created_at,
--             bill_payment_details.created_at, bills.updated_at, ...).
--
-- Sau migration:
--   - App KHÔNG cần đổi code — fetch về sẽ có TZ marker, JS parse đúng.
--   - `formatDateTime` (đã force `Asia/Ho_Chi_Minh`) sẽ hiển thị đúng giờ VN.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- bills (3 cột)
-- -----------------------------------------------------------------------------
ALTER TABLE public.bills
  ALTER COLUMN created_at   TYPE TIMESTAMPTZ USING created_at   AT TIME ZONE 'UTC',
  ALTER COLUMN delivery_date TYPE TIMESTAMPTZ USING delivery_date AT TIME ZONE 'UTC',
  ALTER COLUMN sent_date     TYPE TIMESTAMPTZ USING sent_date     AT TIME ZONE 'UTC';

-- -----------------------------------------------------------------------------
-- bill_payment_details.payment_date — SKIP: view `monthly_revenue_report` phụ thuộc,
-- không dùng ở app code, giữ nguyên để tránh phải drop/recreate view.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- branches (1 cột)
-- -----------------------------------------------------------------------------
ALTER TABLE public.branches
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- -----------------------------------------------------------------------------
-- client_phones (1 cột)
-- -----------------------------------------------------------------------------
ALTER TABLE public.client_phones
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- -----------------------------------------------------------------------------
-- clients (1 cột)
-- -----------------------------------------------------------------------------
ALTER TABLE public.clients
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

-- -----------------------------------------------------------------------------
-- expenses (1 cột) — cần drop policy tạm để migrate, rồi tạo lại
-- Policy `expenses_update_member_own_today` dùng `created_at::date = CURRENT_DATE`.
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS expenses_update_member_own_today ON public.expenses;

ALTER TABLE public.expenses
  ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC';

CREATE POLICY expenses_update_member_own_today ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND created_by = auth.uid()
    AND branch_id = public.current_branch_id()
    AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND created_by = auth.uid()
    AND branch_id = public.current_branch_id()
  );

COMMIT;

-- =============================================================================
-- Verify sau khi chạy — mọi cột phải trả về "timestamp with time zone".
-- =============================================================================
-- SELECT table_name, column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND data_type = 'timestamp without time zone'
-- ORDER BY table_name;
--
-- Kỳ vọng: chỉ còn 1 row = `bill_payment_details.payment_date` (SKIP có chủ đích).
--
-- Verify giá trị bill 03SGA03 sau migration (giả sử bill được tạo lúc 16:31 VN):
-- SELECT bill_code, created_at, created_at AT TIME ZONE 'Asia/Ho_Chi_Minh' AS vn_time
-- FROM bills WHERE bill_code = '03SGA03';
--
-- Kỳ vọng: `created_at` = `2026-08-27 09:31:05.551801+00`
--          `vn_time`    = `2026-08-27 16:31:05.551801`

-- =============================================================================
-- Rollback (chạy tay nếu cần revert):
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS expenses_update_member_own_today ON public.expenses;
-- ALTER TABLE public.bills
--   ALTER COLUMN created_at    TYPE TIMESTAMP USING created_at    AT TIME ZONE 'UTC',
--   ALTER COLUMN delivery_date TYPE TIMESTAMP USING delivery_date AT TIME ZONE 'UTC',
--   ALTER COLUMN sent_date     TYPE TIMESTAMP USING sent_date     AT TIME ZONE 'UTC';
-- ALTER TABLE public.branches
--   ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';
-- ALTER TABLE public.client_phones
--   ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';
-- ALTER TABLE public.clients
--   ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';
-- ALTER TABLE public.expenses
--   ALTER COLUMN created_at TYPE TIMESTAMP USING created_at AT TIME ZONE 'UTC';
-- CREATE POLICY expenses_update_member_own_today ON public.expenses
--   FOR UPDATE TO authenticated
--   USING (
--     public.current_role() = 'member'
--     AND created_by = auth.uid()
--     AND branch_id = public.current_branch_id()
--     AND created_at::date = CURRENT_DATE
--   )
--   WITH CHECK (
--     public.current_role() = 'member'
--     AND created_by = auth.uid()
--     AND branch_id = public.current_branch_id()
--   );
-- COMMIT;
