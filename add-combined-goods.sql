-- Thêm cột "Hàng Ghép" cho danh sách bốc xếp (nhân viên tự điền). Idempotent.
ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS combined_goods TEXT;
