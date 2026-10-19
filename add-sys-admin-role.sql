-- =============================================================================
-- add-sys-admin-role.sql
-- =============================================================================
-- Purpose: Thêm role `sys_admin` + hạ tầng bảo mật cho trang Quản Trị Hệ Thống.
--
-- Nội dung:
--   Section A — CHECK constraints mở rộng cho role mới.
--   Section B — profiles: thêm cột is_disabled, is_deleted, disabled_at,
--                disabled_by, sys_admin_pin_hash.
--   Section C — audit_log: thêm cột is_sys_admin_action + mở rộng CHECK action.
--   Section D — Function current_role() trả NULL khi user bị disable/delete.
--   Section E — Mở rộng 15+ RLS policies: admin → sys_admin OR admin.
--   Section F — RLS policies mới cho profiles (sys_admin CRUD + anti-lockout).
--   Section G — Bảng mfa_recovery_codes + RLS.
--
-- Idempotent: có thể re-run an toàn (DROP + CREATE, ADD COLUMN IF NOT EXISTS).
--
-- Sau migration:
--   - Chưa có sys_admin nào trong DB → chạy scripts/add-user.mjs để bootstrap.
--   - Existing user (admin/member/boss) hoạt động bình thường.
--   - Function current_role() cho phép sys_admin tự động qua mọi policy hiện có.
-- =============================================================================

BEGIN;

-- =============================================================================
-- Section A: CHECK constraints — thêm 'sys_admin' vào danh sách role hợp lệ
-- =============================================================================

-- A.1: profiles.role
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('sys_admin', 'admin', 'member', 'boss'));

-- A.2: audit_log.user_role (snapshot lúc log)
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_user_role_check;
ALTER TABLE public.audit_log
  ADD CONSTRAINT audit_log_user_role_check
  CHECK (user_role IN ('sys_admin', 'admin', 'member', 'boss', 'unknown'));


-- =============================================================================
-- Section B: profiles — thêm cột lockout + pin
-- =============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS disabled_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS sys_admin_pin_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_active
  ON public.profiles(id)
  WHERE is_disabled = false AND is_deleted = false;


-- =============================================================================
-- Section C: audit_log — thêm cột is_sys_admin_action + mở rộng CHECK action
-- =============================================================================

ALTER TABLE public.audit_log
  ADD COLUMN IF NOT EXISTS is_sys_admin_action BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_audit_log_sys_admin
  ON public.audit_log(created_at DESC)
  WHERE is_sys_admin_action = true;

-- CHECK constraint action — nếu tồn tại thì DROP để re-add với danh sách mở rộng
DO $$
DECLARE
  con_name TEXT;
BEGIN
  SELECT conname INTO con_name
  FROM pg_constraint
  WHERE conrelid = 'public.audit_log'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%action%IN%';
  IF con_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.audit_log DROP CONSTRAINT %I', con_name);
  END IF;
END $$;

-- Không add CHECK constraint action mới ở đây — audit_log.action đã dùng nhiều
-- action name không cố định, ràng buộc CHECK làm khó extend. Rely on app validation.


-- =============================================================================
-- Section D: current_role() — trả NULL khi user disabled/deleted
-- =============================================================================

CREATE OR REPLACE FUNCTION public.current_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles
  WHERE id = auth.uid()
    AND COALESCE(is_disabled, false) = false
    AND COALESCE(is_deleted, false) = false
$$;


-- =============================================================================
-- Section E: RLS policies — mở rộng admin → sys_admin OR admin
-- =============================================================================
-- Chiến lược: mọi policy hiện đang gate theo `current_role() = 'admin'` đổi
-- thành `current_role() IN ('sys_admin', 'admin')`. Sys_admin có quyền như
-- admin: không bị ràng buộc branch, được UPDATE/INSERT trên mọi row.

-- E.1: profiles — sẽ được cover đầy đủ trong Section F.

-- E.2: branches — sys_admin quản lý config (address, hotline).
DROP POLICY IF EXISTS branches_write_admin ON public.branches;
CREATE POLICY branches_write_admin ON public.branches
  FOR ALL
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.3: clients_insert — sys_admin cũng insert được.
DROP POLICY IF EXISTS clients_insert ON public.clients;
CREATE POLICY clients_insert ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin', 'member'));

DROP POLICY IF EXISTS clients_update_admin ON public.clients;
CREATE POLICY clients_update_admin ON public.clients
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.4: client_phones
DROP POLICY IF EXISTS client_phones_insert ON public.client_phones;
CREATE POLICY client_phones_insert ON public.client_phones
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin', 'member'));

DROP POLICY IF EXISTS client_phones_update_admin ON public.client_phones;
CREATE POLICY client_phones_update_admin ON public.client_phones
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.5: bills
DROP POLICY IF EXISTS bills_insert ON public.bills;
CREATE POLICY bills_insert ON public.bills
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() IN ('sys_admin', 'admin')
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

DROP POLICY IF EXISTS bills_update_admin ON public.bills;
CREATE POLICY bills_update_admin ON public.bills
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.6: bill_payment_details
DROP POLICY IF EXISTS bpd_select ON public.bill_payment_details;
CREATE POLICY bpd_select ON public.bill_payment_details
  FOR SELECT
  TO authenticated
  USING (
    public.current_role() IN ('sys_admin', 'admin', 'boss')
    OR (
      public.current_role() = 'member'
      AND (
        branch_id = public.current_branch_id()
        OR EXISTS (
          SELECT 1 FROM public.bills b
          WHERE b.id = bill_payment_details.bill_id
            AND b.branch_id = public.current_branch_id()
        )
      )
    )
  );

DROP POLICY IF EXISTS bpd_insert ON public.bill_payment_details;
CREATE POLICY bpd_insert ON public.bill_payment_details
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() IN ('sys_admin', 'admin')
    OR (
      public.current_role() = 'member'
      AND branch_id = public.current_branch_id()
      AND EXISTS (
        SELECT 1 FROM public.bills b
        WHERE b.id = bill_payment_details.bill_id
          AND b.delivery_status <> 'cancelled'
          AND COALESCE(b.is_delete, false) = false
      )
    )
  );

DROP POLICY IF EXISTS bpd_update ON public.bill_payment_details;
CREATE POLICY bpd_update ON public.bill_payment_details
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.7: expenses
DROP POLICY IF EXISTS expenses_select ON public.expenses;
CREATE POLICY expenses_select ON public.expenses
  FOR SELECT
  TO authenticated
  USING (
    public.current_role() IN ('sys_admin', 'admin', 'boss')
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

DROP POLICY IF EXISTS expenses_insert ON public.expenses;
CREATE POLICY expenses_insert ON public.expenses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() IN ('sys_admin', 'admin')
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

DROP POLICY IF EXISTS expenses_update_admin ON public.expenses;
CREATE POLICY expenses_update_admin ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.8: branch_sessions
DROP POLICY IF EXISTS branch_sessions_insert_admin ON public.branch_sessions;
CREATE POLICY branch_sessions_insert_admin ON public.branch_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

DROP POLICY IF EXISTS branch_sessions_update_admin ON public.branch_sessions;
CREATE POLICY branch_sessions_update_admin ON public.branch_sessions
  FOR UPDATE
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));

-- E.9: audit_log — sys_admin cũng đọc audit history.
DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin', 'boss'));


-- =============================================================================
-- Section F: RLS policies mới cho profiles — sys_admin CRUD + anti-lockout
-- =============================================================================

-- F.1: SELECT — sys_admin/admin/boss xem tất cả (kể cả disabled/deleted);
--       member chỉ xem profile của mình.
-- Note: current_role() là SECURITY DEFINER → bypass RLS trên profiles → safe.
DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_select_self ON public.profiles;

CREATE POLICY profiles_select_admin ON public.profiles
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin', 'boss'));

CREATE POLICY profiles_select_self ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = auth.uid());

-- F.2: UPDATE — sys_admin sửa mọi row, nhưng KHÔNG được tự disable/delete/demote.
DROP POLICY IF EXISTS profiles_update_admin ON public.profiles;
DROP POLICY IF EXISTS profiles_update_sys_admin ON public.profiles;
CREATE POLICY profiles_update_sys_admin ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'sys_admin')
  WITH CHECK (
    public.current_role() = 'sys_admin'
    -- Anti-lockout: sys_admin không được disable/delete/demote chính mình
    AND NOT (
      id = auth.uid()
      AND (
        COALESCE(is_disabled, false) = true
        OR COALESCE(is_deleted, false) = true
        OR role <> 'sys_admin'
      )
    )
  );

-- F.3: UPDATE — user tự sửa full_name của mình. KHÔNG được sửa role,
--       branch_id, username, is_disabled, is_deleted, sys_admin_pin_hash.
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
    AND branch_id = (SELECT branch_id FROM public.profiles WHERE id = auth.uid())
    AND username = (SELECT username FROM public.profiles WHERE id = auth.uid())
    AND COALESCE(is_disabled, false) = COALESCE((SELECT is_disabled FROM public.profiles WHERE id = auth.uid()), false)
    AND COALESCE(is_deleted, false) = COALESCE((SELECT is_deleted FROM public.profiles WHERE id = auth.uid()), false)
    -- sys_admin_pin_hash: đổi PIN qua Edge Function (bypass RLS bằng SERVICE_ROLE_KEY).
    AND sys_admin_pin_hash IS NOT DISTINCT FROM (SELECT sys_admin_pin_hash FROM public.profiles WHERE id = auth.uid())
  );

-- F.4: INSERT/DELETE tiếp tục deny hoàn toàn.
-- Trigger handle_new_auth_user SECURITY DEFINER tự INSERT được, không cần policy.


-- =============================================================================
-- Section G: mfa_recovery_codes — bảng lưu recovery codes cho MFA fallback
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,       -- bcrypt hash của recovery code
  used_at TIMESTAMPTZ,           -- NULL nếu chưa dùng
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_codes_user
  ON public.mfa_recovery_codes(user_id)
  WHERE used_at IS NULL;

ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

-- SELECT: chỉ user xem codes của mình (dùng để đếm còn bao nhiêu).
DROP POLICY IF EXISTS mfa_codes_select_self ON public.mfa_recovery_codes;
CREATE POLICY mfa_codes_select_self ON public.mfa_recovery_codes
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- INSERT/UPDATE/DELETE: deny hoàn toàn từ client.
-- Chỉ Edge Function với SERVICE_ROLE_KEY mới thao tác được (bypass RLS).


COMMIT;


-- =============================================================================
-- Verify sau khi chạy migration:
-- =============================================================================
-- 1. CHECK constraint có sys_admin:
--    SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname LIKE '%role_check%';
--
-- 2. Profiles có cột mới:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='profiles'
--    ORDER BY column_name;
--    Kỳ vọng: có is_disabled, is_deleted, disabled_at, disabled_by, sys_admin_pin_hash.
--
-- 3. current_role() trả NULL cho user bị disable:
--    UPDATE profiles SET is_disabled=true WHERE username='<test_user>';
--    → login test_user → SELECT current_role() phải trả NULL.
--    → UPDATE profiles SET is_disabled=false WHERE username='<test_user>'; (revert)
--
-- 4. mfa_recovery_codes tồn tại:
--    SELECT * FROM mfa_recovery_codes LIMIT 1;
--    → không lỗi table không tồn tại.
--
-- 5. Sys_admin chưa có user nào:
--    SELECT count(*) FROM profiles WHERE role='sys_admin';
--    Kỳ vọng: 0 (bootstrap qua CLI ở section 10).


-- =============================================================================
-- Rollback (chạy tay nếu cần revert):
-- =============================================================================
-- BEGIN;
-- -- Xóa policies mới
-- DROP POLICY IF EXISTS profiles_select_admin ON public.profiles;
-- DROP POLICY IF EXISTS profiles_select_self ON public.profiles;
-- DROP POLICY IF EXISTS profiles_update_sys_admin ON public.profiles;
-- DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
-- DROP POLICY IF EXISTS mfa_codes_select_self ON public.mfa_recovery_codes;
-- DROP TABLE IF EXISTS public.mfa_recovery_codes;
--
-- -- Revert current_role()
-- CREATE OR REPLACE FUNCTION public.current_role()
-- RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
-- AS $$
--   SELECT role FROM public.profiles WHERE id = auth.uid()
-- $$;
--
-- -- Revert các policies về admin-only (chỉ example, xem add-supabase-auth-and-rls.sql)
-- -- ... (copy lại từ file gốc)
--
-- -- Xóa cột mới
-- ALTER TABLE public.audit_log DROP COLUMN IF EXISTS is_sys_admin_action;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS sys_admin_pin_hash;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS disabled_by;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS disabled_at;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_deleted;
-- ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_disabled;
--
-- -- Revert CHECK constraints
-- ALTER TABLE public.profiles DROP CONSTRAINT profiles_role_check;
-- ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
--   CHECK (role IN ('admin', 'member', 'boss'));
-- ALTER TABLE public.audit_log DROP CONSTRAINT audit_log_user_role_check;
-- ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_user_role_check
--   CHECK (user_role IN ('admin', 'member', 'boss', 'unknown'));
-- COMMIT;
