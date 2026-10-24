-- Lưu "Ngày giao dự kiến" (text dd/mm/yyyy) vào bill. Trước đây form có thu thập
-- nhưng không ghi DB nên xem lại bill đã lưu bị trống. Idempotent.
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS expected_delivery_date TEXT;
