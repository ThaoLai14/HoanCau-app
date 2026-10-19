-- ============================================================
-- Migration: add-branch-sessions.sql
-- Change: add-server-session (2026-07-01 scope, 2026-07-02 apply)
-- Reference: openspec/changes/add-server-session/design.md §2.1 - §2.2
-- Purpose:
--   Tạo bảng branch_sessions làm source of truth cho:
--     - business_date (ngày kinh doanh hiện tại)
--     - day_counter  (chữ cái mã ngày: A, B, ..., Z, AA, ...)
--     - bill_seq     (số thứ tự bill kế tiếp trong session)
--   Thay thế localStorage per-device để 2+ máy cùng chi nhánh
--   không xảy ra desync mã đơn.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT DO NOTHING seed.
-- ============================================================

-- 1) Table
CREATE TABLE IF NOT EXISTS branch_sessions (
  branch_id      UUID PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  business_date  DATE NOT NULL,
  day_counter    TEXT NOT NULL,          -- 'A', 'B', ..., 'Z', 'AA', ...
  bill_seq       INT  NOT NULL DEFAULT 1,
  session_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

COMMENT ON TABLE branch_sessions IS
  'Session state per branch. Source of truth for business_date, bill_code seq/counter.';

COMMENT ON COLUMN branch_sessions.day_counter IS
  'Chữ cái mã ngày, tăng khi Xuất Bến hoặc qua ngày mới: A -> B -> ... -> Z -> AA -> AB -> ...';

-- 2) Seed 2 chi nhánh (SG + GL). Chỉ insert nếu chưa có row.
INSERT INTO branch_sessions (branch_id, business_date, day_counter, bill_seq, session_start)
SELECT id, CURRENT_DATE, 'A', 1, now()
FROM branches
WHERE branch_code IN ('SG', 'GL')
ON CONFLICT (branch_id) DO NOTHING;

-- 3) RLS permissive (app dùng anon key, guard ở UI/code layer)
ALTER TABLE branch_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS branch_sessions_select_all ON branch_sessions;
CREATE POLICY branch_sessions_select_all ON branch_sessions
  FOR SELECT TO anon, authenticated
  USING (true);

DROP POLICY IF EXISTS branch_sessions_update_all ON branch_sessions;
CREATE POLICY branch_sessions_update_all ON branch_sessions
  FOR UPDATE TO anon, authenticated
  USING (true) WITH CHECK (true);

-- INSERT ít khi cần (seed 1 lần), nhưng thêm policy cho phòng trường hợp thêm branch mới
DROP POLICY IF EXISTS branch_sessions_insert_all ON branch_sessions;
CREATE POLICY branch_sessions_insert_all ON branch_sessions
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- KHÔNG cho DELETE (tránh accidental clear session)

-- ============================================================
-- Sanity check sau migration:
--   SELECT COUNT(*) FROM branch_sessions;            -- expect 2 (SG + GL)
--   SELECT b.branch_code, s.business_date, s.day_counter, s.bill_seq
--   FROM branch_sessions s JOIN branches b ON b.id = s.branch_id;
-- ============================================================
