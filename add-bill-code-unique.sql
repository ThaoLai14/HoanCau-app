-- ============================================
-- I-9: UNIQUE constraint (branch_id, bill_code) — safety net chống race
-- Change: fix-shipment-intake-issues
-- ============================================
-- Chạy trong Supabase SQL Editor SAU khi add-server-session đã merge
-- (vì session DB đã giảm race window; constraint chỉ là safety net cuối).

-- Trước khi ADD: verify không có duplicate hiện tại.
-- Nếu có duplicate → phải resolve manual trước (rename bill_code cũ hơn).
--
--   SELECT branch_id, bill_code, COUNT(*)
--     FROM bills
--    GROUP BY branch_id, bill_code
--   HAVING COUNT(*) > 1;

ALTER TABLE bills
  ADD CONSTRAINT bills_branch_code_uniq UNIQUE (branch_id, bill_code);

-- Sau khi ADD thành công, INSERT/UPDATE trùng (branch_id, bill_code) sẽ raise
-- error code 23505 với message chứa 'bills_branch_code_uniq'.
-- Code frontend (insertBillWithRetry) sẽ catch và retry silent max 3 lần.
