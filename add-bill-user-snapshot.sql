-- =============================================================================
-- add-bill-user-snapshot.sql
--
-- Purpose: Snapshot tên nhân viên tạo đơn + giao đơn lên bills.
-- Vấn đề: khi admin đổi full_name của user (VD "Nhân viên A" → "Nhân viên B"),
-- bill CŨ đang hiển thị tên mới vì frontend join live tới profiles.
-- Audit log đã snapshot full_name tại thời điểm log → source of truth cho backfill.
--
-- Approach:
--   1. Thêm 2 cột: creator_name_snapshot + deliverer_name_snapshot
--   2. Backfill từ audit_log (bill_create + bill_delivered) — sớm nhất theo bill
--   3. Fallback từ profiles (bills chưa có audit) — dùng tên hiện tại
--   4. Frontend: snapshot khi tạo/giao + hiển thị snapshot trước, fallback join
-- =============================================================================

BEGIN;

ALTER TABLE public.bills
  ADD COLUMN IF NOT EXISTS creator_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS deliverer_name_snapshot TEXT;

-- Backfill creator: audit_log.action = 'bill_create' (entry đầu tiên theo bill).
WITH first_create AS (
  SELECT DISTINCT ON (entity_id) entity_id, full_name
  FROM public.audit_log
  WHERE entity_type = 'bill' AND action = 'bill_create'
  ORDER BY entity_id, created_at ASC
)
UPDATE public.bills b
SET creator_name_snapshot = f.full_name
FROM first_create f
WHERE b.id = f.entity_id
  AND b.creator_name_snapshot IS NULL;

-- Backfill deliverer: audit_log.action = 'bill_delivered' (entry đầu tiên).
WITH first_deliver AS (
  SELECT DISTINCT ON (entity_id) entity_id, full_name
  FROM public.audit_log
  WHERE entity_type = 'bill' AND action = 'bill_delivered'
  ORDER BY entity_id, created_at ASC
)
UPDATE public.bills b
SET deliverer_name_snapshot = f.full_name
FROM first_deliver f
WHERE b.id = f.entity_id
  AND b.deliverer_name_snapshot IS NULL;

-- Fallback: bills chưa có audit → dùng tên hiện tại của profiles.
UPDATE public.bills b
SET creator_name_snapshot = COALESCE(p.full_name, p.username)
FROM public.profiles p
WHERE b.creator_name_snapshot IS NULL
  AND b.created_by = p.id;

UPDATE public.bills b
SET deliverer_name_snapshot = COALESCE(p.full_name, p.username)
FROM public.profiles p
WHERE b.deliverer_name_snapshot IS NULL
  AND b.delivered_by = p.id;

COMMIT;

-- Verify:
--   SELECT bill_code, creator_name_snapshot, deliverer_name_snapshot
--   FROM public.bills WHERE bill_code = '05GLA01';

-- Rollback:
--   ALTER TABLE public.bills
--     DROP COLUMN IF EXISTS creator_name_snapshot,
--     DROP COLUMN IF EXISTS deliverer_name_snapshot;
