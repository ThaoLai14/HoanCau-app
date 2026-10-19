-- ============================================================
-- Migration: add-audit-log-table.sql
-- Change: add-audit-log (2026-06-29 scope, 2026-07-02 apply)
-- Reference: openspec/changes/add-audit-log/design.md §2
-- Purpose:
--   Tạo table `audit_log` append-only để lưu lịch sử mọi mutation
--   quan trọng: bill create/update/cancel/deliver/pay, client CRUD,
--   expense CRUD, refund, session departure.
--
-- Idempotent: chạy nhiều lần vẫn OK (CREATE TABLE IF NOT EXISTS +
-- DROP CONSTRAINT/POLICY IF EXISTS).
-- ============================================================

-- 1) Table
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  user_role TEXT NOT NULL,

  entity_type TEXT NOT NULL,
  entity_id UUID,
  entity_label TEXT,

  action TEXT NOT NULL,
  changes JSONB,
  note TEXT
);

-- 2) CHECK constraints (drop + add để idempotent + để mở rộng action list sau)
ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_user_role_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_user_role_check
  CHECK (user_role IN ('admin', 'member', 'boss', 'unknown'));

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entity_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_entity_type_check
  CHECK (entity_type IN ('bill', 'client', 'expense', 'session'));

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_action_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN (
    'bill_create', 'bill_update', 'bill_cancel',
    'bill_delivered', 'bill_payment_received',
    'client_create', 'client_update', 'client_delete', 'client_blacklist',
    'expense_create', 'expense_update', 'expense_delete',
    'refund_created',
    'session_departure'
  ));

-- 3) Indexes
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log (user_id);

-- 4) RLS permissive (app dùng custom auth, không dùng Supabase Auth
--    nên tất cả traffic vào bằng anon key. Guard thực sự nằm ở UI/code layer.)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_log_insert_all ON audit_log;
CREATE POLICY audit_log_insert_all ON audit_log
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS audit_log_select_all ON audit_log;
CREATE POLICY audit_log_select_all ON audit_log
  FOR SELECT TO anon, authenticated
  USING (true);

-- KHÔNG có policy UPDATE / DELETE → append-only (Postgres RLS default deny)

-- ============================================================
-- Sanity check sau migration:
--   SELECT COUNT(*) FROM audit_log;                    -- expect 0
--   \d+ audit_log                                       -- verify columns + constraints
--   SELECT indexname FROM pg_indexes                    -- verify 3 index
--     WHERE tablename = 'audit_log';
-- ============================================================
