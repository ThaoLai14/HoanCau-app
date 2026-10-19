-- ============================================================
-- Migration: revamp-payment-and-revenue.sql
-- Change: revamp-payment-and-revenue-model
-- Purpose: Add collected_by + note to bill_payment_details,
--          add actual_recipient_role to bills,
--          backfill actual_amount_paid + collected_by from historical rows,
--          index for revenue queries.
-- Safe to run multiple times (idempotent CREATE INDEX IF NOT EXISTS + guarded ALTER).
-- ============================================================

-- 1) Add columns to bill_payment_details
ALTER TABLE bill_payment_details
  ADD COLUMN IF NOT EXISTS collected_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE bill_payment_details
  ADD COLUMN IF NOT EXISTS note TEXT;

-- 1b) Ensure created_at exists (older schemas may not have it — cần cho index §5 + filter revenue theo ngày)
ALTER TABLE bill_payment_details
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- 2) Add column to bills
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS actual_recipient_role TEXT;

-- 2b) Ensure bills.actual_amount_paid exists (older schemas may not have it — cần cho backfill §4)
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS actual_amount_paid NUMERIC(15,2) NOT NULL DEFAULT 0;

-- 3) Backfill collected_by from bills.delivered_by (best-effort)
UPDATE bill_payment_details bpd
SET collected_by = b.delivered_by
FROM bills b
WHERE bpd.bill_id = b.id
  AND bpd.collected_by IS NULL
  AND b.delivered_by IS NOT NULL;

-- 4) Backfill bills.actual_amount_paid = SUM(bill_payment_details.amount_paid) per bill
UPDATE bills b
SET actual_amount_paid = COALESCE(s.total, 0)
FROM (
  SELECT bill_id, SUM(amount_paid) AS total
  FROM bill_payment_details
  GROUP BY bill_id
) s
WHERE b.id = s.bill_id;

-- 5) Indexes for revenue query (group by branch + created_at day) and joins by bill
CREATE INDEX IF NOT EXISTS idx_payment_branch_created
  ON bill_payment_details(branch_id, created_at);

CREATE INDEX IF NOT EXISTS idx_payment_bill
  ON bill_payment_details(bill_id);

-- 6) §18: expenses soft-delete + audit columns
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS is_delete BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Ensure created_by exists (older schemas may not have it)
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Index for typical revenue query on expenses
CREATE INDEX IF NOT EXISTS idx_expenses_branch_created
  ON expenses(branch_id, created_at)
  WHERE is_delete = false;

-- ============================================================
-- Sanity checks (run manually after migration)
-- SELECT COUNT(*) AS bpd_missing_collected_by
--   FROM bill_payment_details WHERE collected_by IS NULL;
--   -- Should equal count of legacy rows whose bill has no delivered_by yet.
--
-- SELECT b.id, b.bill_code, b.actual_amount_paid,
--        COALESCE(SUM(bpd.amount_paid), 0) AS sum_details
-- FROM bills b LEFT JOIN bill_payment_details bpd ON bpd.bill_id = b.id
-- GROUP BY b.id, b.bill_code, b.actual_amount_paid
-- HAVING b.actual_amount_paid <> COALESCE(SUM(bpd.amount_paid), 0);
--   -- Should return 0 rows (all bills reconciled).
-- ============================================================
