-- =============================================================================
-- add-bill-branch-snapshot.sql
-- =============================================================================
-- Purpose: Thêm 2 cột snapshot address + hotline của chi nhánh lên bills.
--
-- Rationale (yêu cầu anh):
--   - Bill in cho khách hiển thị address + hotline của chi nhánh gửi.
--   - Khi sys_admin đổi address/hotline chi nhánh, chỉ BILL MỚI dùng info mới.
--   - Bill CŨ giữ nguyên snapshot info tại thời điểm tạo.
--
-- Approach: snapshot 2 field vào bills tại thời điểm INSERT.
-- App code phải update để populate 2 cột này khi tạo bill.
-- =============================================================================

BEGIN;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS branch_address_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS branch_hotline_snapshot TEXT;

COMMIT;

-- =============================================================================
-- Verify:
-- =============================================================================
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema='public' AND table_name='bills'
--   AND column_name IN ('branch_address_snapshot', 'branch_hotline_snapshot');
-- Kỳ vọng: 2 rows.

-- =============================================================================
-- Rollback:
-- =============================================================================
-- BEGIN;
-- ALTER TABLE public.bills
--   DROP COLUMN IF EXISTS branch_address_snapshot,
--   DROP COLUMN IF EXISTS branch_hotline_snapshot;
-- COMMIT;
