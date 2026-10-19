-- =============================================================================
-- fix-cross-branch-rls.sql
-- =============================================================================
-- Purpose: Sửa RLS để hỗ trợ workflow giao hàng liên tỉnh SG ↔ GL.
--
-- Bug đang gặp:
--   1. NV chi nhánh B (branch nhận) bấm "Xác nhận giao hàng" cho bill do
--      NV chi nhánh A (branch gửi) tạo → INSERT bill_payment_details bị RLS
--      chặn với lỗi:  new row violates row-level security policy for table
--      "bill_payment_details".
--   2. Ẩn hơn: UPDATE bills cùng flow cũng bị chặn (0 rows, KHÔNG throw error) →
--      bill status vẫn "pending" mà UI không báo lỗi. Nếu bill unpaid (không hit
--      bpd insert), toàn bộ mutation bị silent no-op.
--   3. NV chi nhánh A thu tiền cho bill do chi nhánh B tạo (khách quay lại nhà
--      gửi thanh toán) → cùng lỗi RLS.
--   4. bpd_select cho member chỉ dựa vào bill.branch_id → NV chi nhánh thu tiền
--      không đọc lại được chính row bpd mình vừa insert khi bill khác branch.
--
-- Fix:
--   A. bills_update_member — cho member UPDATE bill của chi nhánh KHÁC khi bill
--      đang ở trạng thái pending/delivered (giao / thu nợ liên tỉnh). Rule cũ
--      cho own-branch (draft/pending/delivered/cancelled) giữ nguyên.
--   B. bpd_insert — bỏ ràng buộc bills.branch_id = current_branch_id(); thay
--      bằng ràng buộc new.branch_id = current_branch_id() (branch trong row
--      luôn = branch của NV đang login = branch thu tiền → doanh thu attribute
--      đúng). Bill phải chưa cancelled và chưa is_delete.
--   C. bpd_select — cho member đọc row bpd nếu chính branch mình thu (bpd.branch_id
--      = current_branch_id()) HOẶC bill do branch mình tạo (bill.branch_id
--      = current_branch_id()).
--
-- Không đụng: admin/boss policy, bpd_update, bpd_delete, bills_insert,
--             bills_update_admin, các policy khác.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- A. bills_update_member — cho phép cross-branch update khi pending/delivered
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS bills_update_member ON public.bills;
CREATE POLICY bills_update_member ON public.bills
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'member'
    AND (
      -- Own branch: được sửa draft, xác nhận giao, xác nhận thanh toán, cancel
      (branch_id = public.current_branch_id()
        AND delivery_status IN ('draft', 'pending', 'delivered'))
      -- Cross branch: chỉ được thao tác giao hàng / thu nợ (không được đụng draft)
      OR (branch_id <> public.current_branch_id()
        AND delivery_status IN ('pending', 'delivered'))
    )
  )
  WITH CHECK (
    public.current_role() = 'member'
    AND (
      (branch_id = public.current_branch_id()
        AND delivery_status IN ('draft', 'pending', 'delivered', 'cancelled'))
      OR (branch_id <> public.current_branch_id()
        AND delivery_status IN ('pending', 'delivered', 'cancelled'))
    )
  );

-- -----------------------------------------------------------------------------
-- B. bpd_insert — branch trong row = branch NV login (branch thu tiền)
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS bpd_insert ON public.bill_payment_details;
CREATE POLICY bpd_insert ON public.bill_payment_details
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.current_role() = 'admin'
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

-- -----------------------------------------------------------------------------
-- C. bpd_select — mở rộng cho branch thu tiền lẫn branch tạo bill
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS bpd_select ON public.bill_payment_details;
CREATE POLICY bpd_select ON public.bill_payment_details
  FOR SELECT
  TO authenticated
  USING (
    public.current_role() IN ('admin', 'boss')
    OR (
      public.current_role() = 'member'
      AND (
        -- Row bpd do branch mình thu
        branch_id = public.current_branch_id()
        -- Hoặc bill do branch mình tạo
        OR EXISTS (
          SELECT 1 FROM public.bills b
          WHERE b.id = bill_payment_details.bill_id
            AND b.branch_id = public.current_branch_id()
        )
      )
    )
  );

COMMIT;

-- =============================================================================
-- Rollback (chạy tay nếu cần revert):
-- =============================================================================
-- BEGIN;
-- -- Khôi phục bills_update_member cũ
-- DROP POLICY IF EXISTS bills_update_member ON public.bills;
-- CREATE POLICY bills_update_member ON public.bills
--   FOR UPDATE
--   TO authenticated
--   USING (
--     public.current_role() = 'member'
--     AND branch_id = public.current_branch_id()
--     AND delivery_status IN ('draft', 'pending', 'delivered')
--   )
--   WITH CHECK (
--     public.current_role() = 'member'
--     AND branch_id = public.current_branch_id()
--     AND delivery_status IN ('draft', 'pending', 'delivered', 'cancelled')
--   );
-- -- Khôi phục bpd_insert cũ
-- DROP POLICY IF EXISTS bpd_insert ON public.bill_payment_details;
-- CREATE POLICY bpd_insert ON public.bill_payment_details
--   FOR INSERT
--   TO authenticated
--   WITH CHECK (
--     public.current_role() = 'admin'
--     OR (
--       public.current_role() = 'member'
--       AND EXISTS (
--         SELECT 1 FROM public.bills b
--         WHERE b.id = bill_payment_details.bill_id
--           AND b.branch_id = public.current_branch_id()
--       )
--     )
--   );
-- -- Khôi phục bpd_select cũ
-- DROP POLICY IF EXISTS bpd_select ON public.bill_payment_details;
-- CREATE POLICY bpd_select ON public.bill_payment_details
--   FOR SELECT
--   TO authenticated
--   USING (
--     public.current_role() IN ('admin', 'boss')
--     OR (
--       public.current_role() = 'member'
--       AND EXISTS (
--         SELECT 1 FROM public.bills b
--         WHERE b.id = bill_payment_details.bill_id
--           AND b.branch_id = public.current_branch_id()
--       )
--     )
--   );
-- COMMIT;
