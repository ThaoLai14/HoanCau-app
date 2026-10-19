-- ============================================================================
-- add-supabase-auth-and-rls.sql
-- ============================================================================
-- Change: openspec/changes/add-supabase-auth-and-rls
--
-- Chuyển toàn bộ auth stack sang Supabase Auth, bật RLS thật cho 9 bảng public.
--
-- Precondition (đã chạy manual cleanup):
--   - Bảng public.users đã bị DROP CASCADE
--   - Bảng public.monthly_revenue đã bị DROP
--   - Data operational (bills, clients, ...) đã TRUNCATE
--   - Bảng branches vẫn còn 2 row SG/GL
--
-- Idempotent: chạy nhiều lần vẫn OK (CREATE ... IF NOT EXISTS,
-- DROP POLICY IF EXISTS, DO blocks kiểm tra pg_constraint).
--
-- ============================================================================
-- ROLLBACK (chạy tay từng dòng nếu cần revert):
--   DROP TABLE IF EXISTS public.profiles CASCADE;
--   DROP FUNCTION IF EXISTS public.current_profile();
--   DROP FUNCTION IF EXISTS public.current_role();
--   DROP FUNCTION IF EXISTS public.current_branch_id();
--   DROP FUNCTION IF EXISTS public.handle_new_auth_user();
--   ALTER TABLE bills                DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE clients              DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE client_phones        DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE bill_payment_details DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE expenses             DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE branch_sessions      DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE audit_log            DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE branches             DISABLE ROW LEVEL SECURITY;
-- ============================================================================

BEGIN;

-- ============================================================================
-- Section A: branches — UNIQUE constraint + idempotent seed
-- ============================================================================

-- Đảm bảo branches.id có default gen_random_uuid() (extension pgcrypto có sẵn Supabase)
ALTER TABLE public.branches ALTER COLUMN id SET DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS branches_branch_code_key
  ON public.branches(branch_code);

-- Seed idempotent. Cột branch_name là NOT NULL nên phải cung cấp giá trị dù
-- ON CONFLICT sẽ skip khi row đã tồn tại (Postgres check NOT NULL trước conflict).
INSERT INTO public.branches (branch_code, branch_name)
VALUES ('SG', 'TP. HCM'), ('GL', 'Gia Lai')
ON CONFLICT (branch_code) DO NOTHING;

-- Seed branch_sessions cho 2 branch (mỗi branch 1 row). Cần cho bill_code generation.
-- Idempotent qua ON CONFLICT trên branch_id (PK).
INSERT INTO public.branch_sessions (branch_id, business_date, day_counter, bill_seq, session_start)
SELECT id, CURRENT_DATE, 'A01', 1, now()
FROM public.branches
WHERE branch_code IN ('SG', 'GL')
ON CONFLICT (branch_id) DO NOTHING;


-- ============================================================================
-- Section B: profiles table (1-1 với auth.users)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'boss')),
  branch_id UUID NOT NULL REFERENCES public.branches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_profiles_username ON public.profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_branch   ON public.profiles(branch_id);


-- ============================================================================
-- Section C: trigger auto-create profile khi có auth.users row mới
-- ============================================================================
-- SECURITY DEFINER cho phép trigger bypass RLS (INSERT profile mà không cần policy).
-- User được tạo qua supabase.auth.admin.createUser({ user_metadata: { username, full_name, role, branch_id } })
-- Trigger đọc metadata và INSERT.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  meta       JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::JSONB);
  v_username TEXT  := meta->>'username';
  v_fullname TEXT  := meta->>'full_name';
  v_role     TEXT  := meta->>'role';
  v_branchid UUID  := NULLIF(meta->>'branch_id', '')::UUID;
BEGIN
  -- Bỏ qua nếu thiếu metadata (vd user tạo trực tiếp qua dashboard chưa có meta).
  -- Admin có thể INSERT profile bằng tay sau đó.
  IF v_username IS NULL OR v_fullname IS NULL OR v_role IS NULL OR v_branchid IS NULL THEN
    RAISE WARNING 'handle_new_auth_user: skip % — missing metadata (username/full_name/role/branch_id)', NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO public.profiles (id, username, full_name, role, branch_id)
  VALUES (NEW.id, v_username, v_fullname, v_role, v_branchid)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();


-- ============================================================================
-- Section D: helper functions cho RLS policy
-- ============================================================================
-- SECURITY DEFINER + STABLE để planner cache 1 lần per statement.
-- SET search_path = public để tránh SQL injection qua search_path.

CREATE OR REPLACE FUNCTION public.current_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.profiles WHERE id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.current_branch_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT branch_id FROM public.profiles WHERE id = auth.uid()
$$;


-- ============================================================================
-- Section E: FK constraints trỏ về profiles (thay cho users cũ đã bị DROP)
-- ============================================================================
-- Các cột UUID vẫn tồn tại (bills.created_by, ...), chỉ mất FK khi DROP users CASCADE.
-- Add lại FK sang profiles(id) với ON DELETE SET NULL để giữ audit history.
--
-- DO block: chỉ ADD nếu constraint chưa tồn tại.

DO $$
DECLARE
  fk_specs TEXT[][] := ARRAY[
    ['audit_log',            'user_id',      'fk_audit_log_user'],
    ['bills',                'created_by',   'fk_bills_created_by'],
    ['bills',                'delivered_by', 'fk_bills_delivered_by'],
    ['bill_payment_details', 'collected_by', 'fk_bpd_collected_by'],
    ['expenses',             'created_by',   'fk_expenses_created_by'],
    ['expenses',             'updated_by',   'fk_expenses_updated_by'],
    ['expenses',             'deleted_by',   'fk_expenses_deleted_by']
  ];
  spec TEXT[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY fk_specs LOOP
    -- Chỉ add nếu bảng + cột tồn tại và FK chưa có
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = spec[1] AND column_name = spec[2]
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = spec[3]
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE SET NULL',
        spec[1], spec[3], spec[2]
      );
    END IF;
  END LOOP;
END $$;


-- ============================================================================
-- Section F: ENABLE ROW LEVEL SECURITY (9 bảng)
-- ============================================================================

ALTER TABLE public.profiles             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branches             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_phones        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bills                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bill_payment_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.branch_sessions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log            ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- Section G: DROP các permissive policy cũ (từ add-branch-sessions.sql +
--             add-audit-log-table.sql) để tránh conflict với policy mới
-- ============================================================================

DROP POLICY IF EXISTS branch_sessions_select_all ON public.branch_sessions;
DROP POLICY IF EXISTS branch_sessions_update_all ON public.branch_sessions;
DROP POLICY IF EXISTS branch_sessions_insert_all ON public.branch_sessions;
DROP POLICY IF EXISTS audit_log_insert_all       ON public.audit_log;
DROP POLICY IF EXISTS audit_log_select_all       ON public.audit_log;


-- ============================================================================
-- Section H: RLS policy — profiles
-- ============================================================================

-- SELECT: mọi authenticated (member xem được profile người khác để hiển thị tên nhân viên tạo/giao đơn)
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated USING (true);

-- INSERT: deny cho mọi role (chỉ trigger SECURITY DEFINER tạo được)
-- Không tạo policy INSERT nào → default deny.

-- UPDATE: admin sửa mọi profile; user sửa full_name của chính mình
DROP POLICY IF EXISTS profiles_update_admin ON public.profiles;
CREATE POLICY profiles_update_admin ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- Chặn tự nâng role/đổi branch/đổi username: các cột này phải giữ nguyên
    AND role = (SELECT role FROM public.profiles WHERE id = auth.uid())
    AND branch_id = (SELECT branch_id FROM public.profiles WHERE id = auth.uid())
    AND username = (SELECT username FROM public.profiles WHERE id = auth.uid())
  );

-- DELETE: deny cho mọi role (phải DELETE auth.users → cascade)
-- Không tạo policy DELETE nào → default deny.


-- ============================================================================
-- Section I: RLS policy — branches
-- ============================================================================

DROP POLICY IF EXISTS branches_select ON public.branches;
CREATE POLICY branches_select ON public.branches
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS branches_write_admin ON public.branches;
CREATE POLICY branches_write_admin ON public.branches
  FOR ALL
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');


-- ============================================================================
-- Section J: RLS policy — clients + client_phones
-- ============================================================================

-- clients: shared cả 2 branch
DROP POLICY IF EXISTS clients_select ON public.clients;
CREATE POLICY clients_select ON public.clients
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS clients_insert ON public.clients;
CREATE POLICY clients_insert ON public.clients
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() IN ('admin', 'member'));

DROP POLICY IF EXISTS clients_update_admin ON public.clients;
CREATE POLICY clients_update_admin ON public.clients
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

-- DELETE: deny hết (soft-delete = UPDATE is_delete=true)

-- client_phones
DROP POLICY IF EXISTS client_phones_select ON public.client_phones;
CREATE POLICY client_phones_select ON public.client_phones
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS client_phones_insert ON public.client_phones;
CREATE POLICY client_phones_insert ON public.client_phones
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() IN ('admin', 'member'));

DROP POLICY IF EXISTS client_phones_update_admin ON public.client_phones;
CREATE POLICY client_phones_update_admin ON public.client_phones
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');


-- ============================================================================
-- Section K: RLS policy — bills
-- ============================================================================

-- SELECT: mọi authenticated (member xem được cả 2 branch, guardrail branch nằm ở UI + UPDATE policy)
DROP POLICY IF EXISTS bills_select ON public.bills;
CREATE POLICY bills_select ON public.bills
  FOR SELECT TO authenticated USING (true);

-- INSERT: admin all; member chỉ branch của mình
DROP POLICY IF EXISTS bills_insert ON public.bills;
CREATE POLICY bills_insert ON public.bills
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() = 'admin'
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

-- UPDATE: admin all; member chỉ draft của branch mình
DROP POLICY IF EXISTS bills_update_admin ON public.bills;
CREATE POLICY bills_update_admin ON public.bills
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

DROP POLICY IF EXISTS bills_update_member_draft ON public.bills;
CREATE POLICY bills_update_member ON public.bills
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND branch_id = public.current_branch_id()
    AND delivery_status IN ('draft', 'pending', 'delivered')
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND branch_id = public.current_branch_id()
    AND delivery_status IN ('draft', 'pending', 'delivered', 'cancelled')
  );

-- DELETE: deny cho MỌI role (hủy draft = soft-cancel qua UPDATE)


-- ============================================================================
-- Section L: RLS policy — bill_payment_details
-- ============================================================================

-- SELECT: admin/boss all; member cùng branch với bill (JOIN)
DROP POLICY IF EXISTS bpd_select ON public.bill_payment_details;
CREATE POLICY bpd_select ON public.bill_payment_details
  FOR SELECT
  TO authenticated
  USING (
    public.current_role() IN ('admin', 'boss')
    OR (
      public.current_role() = 'member'
      AND EXISTS (
        SELECT 1 FROM public.bills b
        WHERE b.id = bill_payment_details.bill_id
          AND b.branch_id = public.current_branch_id()
      )
    )
  );

-- INSERT: admin all; member cùng branch với bill
DROP POLICY IF EXISTS bpd_insert ON public.bill_payment_details;
CREATE POLICY bpd_insert ON public.bill_payment_details
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() = 'admin'
    OR (
      public.current_role() = 'member'
      AND EXISTS (
        SELECT 1 FROM public.bills b
        WHERE b.id = bill_payment_details.bill_id
          AND b.branch_id = public.current_branch_id()
      )
    )
  );

-- UPDATE: admin only
DROP POLICY IF EXISTS bpd_update ON public.bill_payment_details;
CREATE POLICY bpd_update ON public.bill_payment_details
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

-- DELETE: deny cho MỌI role (append-only)


-- ============================================================================
-- Section M: RLS policy — expenses
-- ============================================================================

-- SELECT: admin/boss all; member cùng branch
DROP POLICY IF EXISTS expenses_select ON public.expenses;
CREATE POLICY expenses_select ON public.expenses
  FOR SELECT
  TO authenticated
  USING (
    public.current_role() IN ('admin', 'boss')
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

-- INSERT: admin all; member cùng branch
DROP POLICY IF EXISTS expenses_insert ON public.expenses;
CREATE POLICY expenses_insert ON public.expenses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() = 'admin'
    OR (public.current_role() = 'member' AND branch_id = public.current_branch_id())
  );

-- UPDATE: admin all; member sửa row do mình tạo trong ngày hôm nay
DROP POLICY IF EXISTS expenses_update_admin ON public.expenses;
CREATE POLICY expenses_update_admin ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

DROP POLICY IF EXISTS expenses_update_member_own_today ON public.expenses;
CREATE POLICY expenses_update_member_own_today ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND created_by = auth.uid()
    AND branch_id = public.current_branch_id()
    AND created_at::date = CURRENT_DATE
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND created_by = auth.uid()
    AND branch_id = public.current_branch_id()
  );

-- DELETE: deny cho MỌI role (soft-delete = UPDATE is_delete=true)


-- ============================================================================
-- Section N: RLS policy — branch_sessions
-- ============================================================================

DROP POLICY IF EXISTS branch_sessions_select ON public.branch_sessions;
CREATE POLICY branch_sessions_select ON public.branch_sessions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS branch_sessions_insert_admin ON public.branch_sessions;
CREATE POLICY branch_sessions_insert_admin ON public.branch_sessions
  FOR INSERT
  TO authenticated
  WITH CHECK (public.current_role() = 'admin');

-- UPDATE: admin all; member cùng branch (để rollover business_date khi Xuất Bến)
DROP POLICY IF EXISTS branch_sessions_update_admin ON public.branch_sessions;
CREATE POLICY branch_sessions_update_admin ON public.branch_sessions
  FOR UPDATE
  TO authenticated
  USING (public.current_role() = 'admin')
  WITH CHECK (public.current_role() = 'admin');

DROP POLICY IF EXISTS branch_sessions_update_member ON public.branch_sessions;
CREATE POLICY branch_sessions_update_member ON public.branch_sessions
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND branch_id = public.current_branch_id()
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND branch_id = public.current_branch_id()
  );

-- DELETE: deny


-- ============================================================================
-- Section O: RLS policy — audit_log
-- ============================================================================

-- Thêm cột full_name (snapshot) cho hiển thị lịch sử — che username của nhân viên.
ALTER TABLE public.audit_log ADD COLUMN IF NOT EXISTS full_name TEXT;

-- SELECT: admin, boss
DROP POLICY IF EXISTS audit_log_select ON public.audit_log;
CREATE POLICY audit_log_select ON public.audit_log
  FOR SELECT
  TO authenticated
  USING (public.current_role() IN ('admin', 'boss'));

-- INSERT: mọi authenticated (kể cả boss — cho action tương lai)
DROP POLICY IF EXISTS audit_log_insert ON public.audit_log;
CREATE POLICY audit_log_insert ON public.audit_log
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- UPDATE, DELETE: deny (append-only)


-- ============================================================================
-- END migration
-- ============================================================================

COMMIT;

-- Post-check queries (chạy tay để verify):
--   SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';
--   SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;
--   SELECT branch_code FROM public.branches ORDER BY branch_code;
