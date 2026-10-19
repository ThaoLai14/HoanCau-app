-- ============================================================
-- Migration: add-business-date.sql
-- Change: add-server-session (2026-07-01 scope, 2026-07-02 apply)
-- Reference: openspec/changes/add-server-session/design.md §2.3
-- Purpose:
--   Thêm cột bills.business_date DATE NOT NULL — ngày kinh doanh
--   (nghiệp vụ). Khác created_at (timestamp thực tế) ở chỗ:
--   - business_date = ngày trong session (có thể là ngày mai nếu
--     đã Xuất Bến rồi).
--   - created_at   = timestamp thực tế lúc INSERT.
--   Filter warehouse / báo cáo dùng business_date; audit dùng created_at.
--
--   Chạy SAU add-branch-sessions.sql.
--
-- Idempotent nhất có thể: ADD COLUMN IF NOT EXISTS + backfill guarded.
-- ============================================================

-- 1) Add column nullable trước
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS business_date DATE;

-- 2) Backfill từ created_at (convert UTC → VN date)
UPDATE bills
SET business_date = (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
WHERE business_date IS NULL;

-- 3) Verify NULL count = 0 (chạy manually trước khi bước 4)
--   SELECT COUNT(*) AS null_count FROM bills WHERE business_date IS NULL;
--   → phải = 0.

-- 4) Set NOT NULL + DEFAULT (chạy sau khi verify)
ALTER TABLE bills
  ALTER COLUMN business_date SET DEFAULT CURRENT_DATE;

-- Chỉ set NOT NULL nếu chưa NOT NULL (idempotent guard)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bills'
      AND column_name = 'business_date'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE bills ALTER COLUMN business_date SET NOT NULL;
  END IF;
END $$;

-- 5) Indexes cho filter (warehouse tab + Tổng Hợp)
CREATE INDEX IF NOT EXISTS idx_bills_business_date
  ON bills(business_date);

CREATE INDEX IF NOT EXISTS idx_bills_branch_business_date
  ON bills(branch_id, business_date);

-- ============================================================
-- Sanity check sau migration:
--   SELECT COUNT(*) FROM bills WHERE business_date IS NULL;   -- expect 0
--   SELECT MIN(business_date), MAX(business_date) FROM bills; -- range hợp lý
--   SELECT business_date, COUNT(*)
--   FROM bills GROUP BY business_date ORDER BY business_date DESC LIMIT 10;
-- ============================================================
