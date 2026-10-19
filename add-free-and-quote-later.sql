-- ============================================
-- CHỈ chạy nếu cột payment_status / delivery_status đang có CHECK constraint cũ
-- (chỉ cho các giá trị cũ). Nếu cột là TEXT thường không có CHECK thì bỏ qua hoàn toàn file này.
-- ============================================

-- 1) payment_status: thêm 'free'
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payment_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_payment_status_check
  CHECK (payment_status IN ('paid', 'unpaid', 'free'));

-- 2) delivery_status: thêm 'cancelled'
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_delivery_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_delivery_status_check
  CHECK (delivery_status IN ('pending', 'delivered', 'draft', 'cancelled'));
