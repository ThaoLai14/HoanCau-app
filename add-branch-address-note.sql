-- =============================================================================
-- add-branch-address-note.sql
-- =============================================================================
-- Purpose: Thêm cột address_note vào bảng branches để lưu chú thích thêm
-- (VD: "Bên trong chung cư Trần Quang Diệu, Phường Nhiêu Lộc").
-- Hiển thị dưới địa chỉ + hotline trên bill in.
-- =============================================================================

BEGIN;

ALTER TABLE public.branches
  ADD COLUMN IF NOT EXISTS address_note TEXT;

-- Tương tự cho bills — snapshot address_note cùng lúc với address/hotline.
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS branch_address_note_snapshot TEXT;

COMMIT;

-- =============================================================================
-- Rollback:
-- =============================================================================
-- BEGIN;
-- ALTER TABLE public.branches DROP COLUMN IF EXISTS address_note;
-- ALTER TABLE public.bills DROP COLUMN IF EXISTS branch_address_note_snapshot;
-- COMMIT;
