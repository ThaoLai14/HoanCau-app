-- =============================================================================
-- fix-draft-branch-restriction.sql
-- =============================================================================
-- Purpose: Đơn nháp (delivery_status = 'draft') chỉ được sửa/hủy/hoàn tất bởi
-- ĐÚNG chi nhánh đã tạo ra nó. Trước đây member đã bị chặn cross-branch cho
-- draft (bills_update_member, xem fix-cross-branch-rls.sql), nhưng ADMIN thì
-- KHÔNG — bills_update_admin cho phép admin UPDATE bất kỳ bill nào (mọi
-- branch, mọi status) → admin chi nhánh A vẫn sửa/xóa được nháp của chi
-- nhánh B. Fix này thêm ràng buộc branch riêng cho draft, các status khác
-- (pending/delivered/cancelled) giữ nguyên hành vi admin cross-branch cũ.
--
-- sys_admin KHÔNG bị ảnh hưởng — luôn full quyền như thiết kế hiện tại.
-- =============================================================================

BEGIN;

DROP POLICY IF EXISTS bills_update_admin ON public.bills;
CREATE POLICY bills_update_admin ON public.bills
  FOR UPDATE
  TO authenticated
  USING (
    public.current_role() = 'sys_admin'
    OR (
      public.current_role() = 'admin'
      AND (delivery_status <> 'draft' OR branch_id = public.current_branch_id())
    )
  )
  WITH CHECK (
    public.current_role() = 'sys_admin'
    OR (
      public.current_role() = 'admin'
      AND (delivery_status <> 'draft' OR branch_id = public.current_branch_id())
    )
  );

COMMIT;

-- =============================================================================
-- ROLLBACK (nếu cần khôi phục lại behavior admin cross-branch cho cả draft):
-- =============================================================================
-- BEGIN;
-- DROP POLICY IF EXISTS bills_update_admin ON public.bills;
-- CREATE POLICY bills_update_admin ON public.bills
--   FOR UPDATE
--   TO authenticated
--   USING (public.current_role() IN ('sys_admin', 'admin'))
--   WITH CHECK (public.current_role() IN ('sys_admin', 'admin'));
-- COMMIT;
