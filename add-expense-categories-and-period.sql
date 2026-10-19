-- ============================================================
-- Migration: add-expense-categories-and-period.sql
-- Change: expand-revenue-reporting
-- Reference: openspec/changes/expand-revenue-reporting/{design,tasks}.md
-- Purpose:
--   1) Bảng expense_categories dùng chung 2 chi nhánh (sys_admin quản lý).
--   2) expenses: thêm category_id, period_type ('day'|'month'), period_month.
--   3) Bảng monthly_closes: khóa sổ chi phí theo (branch, tháng).
--   4) RLS cho các bảng mới.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
--             DROP POLICY IF EXISTS. Chạy nhiều lần vẫn OK.
-- Ghi chú: quy tắc khóa theo thời gian (hôm nay / ân hạn 3 ngày) enforce
--          ở app code; FK ON DELETE RESTRICT lo việc "không cho xoá category
--          còn phiếu chi". RLS giữ baseline theo role.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1) expense_categories
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.expense_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed danh mục mặc định (idempotent qua UNIQUE name)
INSERT INTO public.expense_categories (name)
VALUES
  ('Chưa phân loại'),
  ('tiền ăn'),
  ('tiền mua vật dụng'),
  ('tiền lương'),
  ('tiền thuê văn phòng'),
  ('tiền xe'),
  ('tiền trà nước lái xe')
ON CONFLICT (name) DO NOTHING;

-- ------------------------------------------------------------
-- 2) expenses: thêm cột category_id / period_type / period_month
-- ------------------------------------------------------------
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES public.expense_categories(id) ON DELETE RESTRICT;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS period_type TEXT NOT NULL DEFAULT 'day';

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS period_month DATE;

-- Backfill: phiếu chi cũ → "Chưa phân loại", period_type='day'
UPDATE public.expenses e
SET category_id = c.id
FROM public.expense_categories c
WHERE c.name = 'Chưa phân loại'
  AND e.category_id IS NULL;

-- Sau backfill: category_id NOT NULL
ALTER TABLE public.expenses
  ALTER COLUMN category_id SET NOT NULL;

-- CHECK period_type hợp lệ (drop trước để idempotent)
ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS expenses_period_type_check;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_period_type_check CHECK (period_type IN ('day', 'month'));

-- CHECK: period_type='month' bắt buộc có period_month; 'day' thì không
ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS expenses_period_month_check;
ALTER TABLE public.expenses
  ADD CONSTRAINT expenses_period_month_check CHECK (
    (period_type = 'month' AND period_month IS NOT NULL)
    OR (period_type = 'day' AND period_month IS NULL)
  );

CREATE INDEX IF NOT EXISTS idx_expenses_category ON public.expenses(category_id);
CREATE INDEX IF NOT EXISTS idx_expenses_period_month ON public.expenses(branch_id, period_month);

-- ------------------------------------------------------------
-- 3) monthly_closes — khóa sổ theo (branch, tháng)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.monthly_closes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  period_month DATE NOT NULL,           -- ngày đầu tháng, ví dụ 2026-10-01
  status TEXT NOT NULL DEFAULT 'closed' CHECK (status IN ('open', 'closed')),
  closed_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (branch_id, period_month)
);

CREATE INDEX IF NOT EXISTS idx_monthly_closes_branch ON public.monthly_closes(branch_id, period_month);

-- ------------------------------------------------------------
-- 4) RLS
-- ------------------------------------------------------------
ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monthly_closes ENABLE ROW LEVEL SECURITY;

-- expense_categories: mọi role đăng nhập ĐỌC được (để hiện dropdown);
-- chỉ sys_admin thêm/sửa/xoá.
DROP POLICY IF EXISTS expense_categories_select ON public.expense_categories;
CREATE POLICY expense_categories_select ON public.expense_categories
  FOR SELECT TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin', 'boss', 'member'));

DROP POLICY IF EXISTS expense_categories_insert ON public.expense_categories;
CREATE POLICY expense_categories_insert ON public.expense_categories
  FOR INSERT TO authenticated
  WITH CHECK (public.current_role() = 'sys_admin');

DROP POLICY IF EXISTS expense_categories_update ON public.expense_categories;
CREATE POLICY expense_categories_update ON public.expense_categories
  FOR UPDATE TO authenticated
  USING (public.current_role() = 'sys_admin')
  WITH CHECK (public.current_role() = 'sys_admin');

DROP POLICY IF EXISTS expense_categories_delete ON public.expense_categories;
CREATE POLICY expense_categories_delete ON public.expense_categories
  FOR DELETE TO authenticated
  USING (public.current_role() = 'sys_admin');

-- monthly_closes: sys_admin/admin/boss ĐỌC; chỉ boss + sys_admin ghi (khóa sổ).
DROP POLICY IF EXISTS monthly_closes_select ON public.monthly_closes;
CREATE POLICY monthly_closes_select ON public.monthly_closes
  FOR SELECT TO authenticated
  USING (public.current_role() IN ('sys_admin', 'admin', 'boss'));

DROP POLICY IF EXISTS monthly_closes_insert ON public.monthly_closes;
CREATE POLICY monthly_closes_insert ON public.monthly_closes
  FOR INSERT TO authenticated
  WITH CHECK (public.current_role() IN ('sys_admin', 'boss'));

DROP POLICY IF EXISTS monthly_closes_update ON public.monthly_closes;
CREATE POLICY monthly_closes_update ON public.monthly_closes
  FOR UPDATE TO authenticated
  USING (public.current_role() IN ('sys_admin', 'boss'))
  WITH CHECK (public.current_role() IN ('sys_admin', 'boss'));

-- ------------------------------------------------------------
-- 5) audit_log: nới CHECK action cho month_close + category CRUD
--    (entity_type tái dùng 'expense' để khỏi đụng entity_type CHECK)
-- ------------------------------------------------------------
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE public.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'bill_create', 'bill_update', 'bill_cancel',
    'bill_delivered', 'bill_payment_received',
    'client_create', 'client_update', 'client_delete', 'client_blacklist',
    'expense_create', 'expense_update', 'expense_delete',
    'refund_created',
    'session_departure',
    'month_close', 'category_create', 'category_update', 'category_delete'
  ));

COMMIT;

-- ============================================================
-- Verify:
--   SELECT name FROM expense_categories ORDER BY created_at;
--   SELECT period_type, count(*) FROM expenses GROUP BY period_type;
--   \d expenses   -- kiểm tra category_id NOT NULL + 2 CHECK
-- ============================================================
-- Rollback (chạy tay nếu cần):
-- BEGIN;
--   DROP TABLE IF EXISTS public.monthly_closes;
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_period_month_check;
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_period_type_check;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS period_month;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS period_type;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS category_id;
--   DROP TABLE IF EXISTS public.expense_categories;
-- COMMIT;
-- ============================================================
