-- ============================================================
-- Migration: add-client-phone-old-type.sql
-- Change: add-client-phone-history (2026-06-30)
-- Reference: openspec/changes/add-client-phone-history/design.md §2
-- Purpose: Cho phép client_phones.type có 3 giá trị 'primary' | 'secondary' | 'old'.
--          Cần cho việc bảo toàn bill cũ (FK sender_phone_id / receiver_phone_id)
--          khi khách đổi SĐT: thay vì DELETE row, ta flip type sang 'old'.
-- Idempotent: chạy nhiều lần vẫn OK.
-- ============================================================

-- 1) Xóa CHECK constraint cũ nếu có (tên default của postgres)
ALTER TABLE client_phones
  DROP CONSTRAINT IF EXISTS client_phones_type_check;

-- 2) Add CHECK constraint mới với 3 giá trị
ALTER TABLE client_phones
  ADD CONSTRAINT client_phones_type_check
  CHECK (type IN ('primary', 'secondary', 'old'));

-- ============================================================
-- Sanity checks (chạy thủ công sau migration)
--
-- Kiểm tra orphan FK: bill cũ có sender_phone_id/receiver_phone_id
-- trỏ vào row phones đã bị DELETE (do bug cũ handleAddClient DELETE hết phones).
-- Không tự fix — cần review từng case:
--
-- SELECT b.id, b.bill_code, b.sender_phone_id
-- FROM bills b LEFT JOIN client_phones p ON p.id = b.sender_phone_id
-- WHERE b.sender_phone_id IS NOT NULL AND p.id IS NULL;
--
-- SELECT b.id, b.bill_code, b.receiver_phone_id
-- FROM bills b LEFT JOIN client_phones p ON p.id = b.receiver_phone_id
-- WHERE b.receiver_phone_id IS NOT NULL AND p.id IS NULL;
--
-- Nếu tìm ra orphan → có 2 lựa chọn:
--   a) UPDATE bills SET sender_phone_id = NULL WHERE id = <bill_id>;
--   b) INSERT lại row client_phones với id đúng, type='old', link về client cũ.
-- ============================================================
