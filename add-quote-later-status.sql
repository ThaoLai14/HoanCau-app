-- ============================================
-- N-11: Thêm enum 'quote_later' vào payment_status
-- Change: fix-shipment-intake-issues
-- ============================================
-- Chạy trong Supabase SQL Editor.
-- Trước khi chạy production: verify trên staging + review backfill.

-- 1) Update CHECK constraint: thêm 'quote_later'
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payment_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_payment_status_check
  CHECK (payment_status IN ('paid', 'unpaid', 'free', 'quote_later'));

-- 2) Backfill: bill hiện tại shipping_fee=0 + unpaid + chưa cancelled → giả định quote_later.
--
-- ⚠️ CẢNH BÁO: backfill này dựa trên GIẢ ĐỊNH, có thể sai với bill mới tạo chưa nhập cước.
-- Trước khi commit, chạy SELECT sau để review:
--
--   SELECT id, bill_code, branch_id, shipping_fee, payment_status, delivery_status, created_at
--     FROM bills
--    WHERE payment_status = 'unpaid'
--      AND (shipping_fee = 0 OR shipping_fee IS NULL)
--      AND delivery_status != 'cancelled'
--    ORDER BY created_at DESC;
--
-- Nếu OK → uncomment và chạy UPDATE bên dưới:

-- UPDATE bills
--    SET payment_status = 'quote_later'
--  WHERE payment_status = 'unpaid'
--    AND (shipping_fee = 0 OR shipping_fee IS NULL)
--    AND delivery_status != 'cancelled';
