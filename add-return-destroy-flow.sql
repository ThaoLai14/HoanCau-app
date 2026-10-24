-- ============================================================================
-- add-return-destroy-flow.sql
-- Hoàn hàng (returned) & Tiêu hủy (destroyed). Idempotent.
-- Ref: openspec/changes/add-return-and-destroy-flow/
-- ============================================================================
BEGIN;

-- 1) Cột mới trên bills
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS return_fee INTEGER DEFAULT 0;
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS current_branch_id UUID REFERENCES public.branches(id);
ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS return_confirmed_at TIMESTAMPTZ;

-- 2) Nới CHECK delivery_status
ALTER TABLE public.bills DROP CONSTRAINT IF EXISTS bills_delivery_status_check;
ALTER TABLE public.bills ADD CONSTRAINT bills_delivery_status_check
  CHECK (delivery_status IN ('pending', 'delivered', 'draft', 'cancelled', 'returned', 'destroyed'));

-- 3) RLS: nới bills_update_member cho 2 status mới (admin/sys_admin policy không filter status nên không cần sửa)
DROP POLICY IF EXISTS bills_update_member ON public.bills;
CREATE POLICY bills_update_member ON public.bills
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND (
      (branch_id = public.current_branch_id()
        AND delivery_status IN ('draft', 'pending', 'delivered', 'returned', 'destroyed'))
      OR (branch_id <> public.current_branch_id()
        AND delivery_status IN ('pending', 'delivered', 'returned', 'destroyed'))
    )
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND (
      (branch_id = public.current_branch_id()
        AND delivery_status IN ('draft', 'pending', 'delivered', 'cancelled', 'returned', 'destroyed'))
      OR (branch_id <> public.current_branch_id()
        AND delivery_status IN ('pending', 'delivered', 'cancelled', 'returned', 'destroyed'))
    )
  );

-- 4) audit_log: bỏ CHECK action (action names không cố định — rely on app validation,
--    theo chủ trương add-sys-admin-role). Mở đường cho bill_returned/bill_destroyed/bill_return_confirmed.
ALTER TABLE public.audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;

COMMIT;

-- Verify:
--   \d public.bills   -- return_fee, current_branch_id, return_confirmed_at
--   SELECT conname FROM pg_constraint WHERE conname = 'bills_delivery_status_check';
