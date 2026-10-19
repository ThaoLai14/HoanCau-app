-- ============================================
-- N-12: Thêm 4 cột snapshot tên/SĐT khách vào bills
-- Change: fix-shipment-intake-issues
-- ============================================
-- Chạy trong Supabase SQL Editor. Nên chia 3 bước, verify giữa mỗi bước.

-- ============================================
-- BƯỚC 1: ADD cột (nullable ban đầu để backfill an toàn)
-- ============================================
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS sender_name_text    TEXT,
  ADD COLUMN IF NOT EXISTS sender_phone_text   TEXT,
  ADD COLUMN IF NOT EXISTS receiver_name_text  TEXT,
  ADD COLUMN IF NOT EXISTS receiver_phone_text TEXT;

-- ============================================
-- BƯỚC 2: BACKFILL từ FK (clients + client_phones)
-- ============================================
-- Copy fullname + phone_number vào 4 cột snapshot.
-- LEFT JOIN cho phép bill có FK NULL (bill khách không SĐT trong tương lai —
-- hiện tại chưa có nhưng bill legacy có thể missing).

UPDATE bills b
   SET sender_name_text    = sc.fullname,
       sender_phone_text   = sp.phone_number,
       receiver_name_text  = rc.fullname,
       receiver_phone_text = rp.phone_number
  FROM bills bb
  LEFT JOIN clients        sc ON sc.id = bb.sender_id
  LEFT JOIN client_phones  sp ON sp.id = bb.sender_phone_id
  LEFT JOIN clients        rc ON rc.id = bb.receiver_id
  LEFT JOIN client_phones  rp ON rp.id = bb.receiver_phone_id
 WHERE b.id = bb.id;

-- ============================================
-- BƯỚC 3: VERIFY count NULL trước khi SET NOT NULL
-- ============================================
-- Chạy SELECT bên dưới. Nếu count > 0 → điều tra bill orphan trước khi tiếp tục.
--
--   SELECT COUNT(*) AS null_sender   FROM bills WHERE sender_name_text   IS NULL;
--   SELECT COUNT(*) AS null_receiver FROM bills WHERE receiver_name_text IS NULL;
--
-- Nếu = 0 cho cả hai → uncomment và chạy tiếp:

-- ALTER TABLE bills ALTER COLUMN sender_name_text   SET NOT NULL;
-- ALTER TABLE bills ALTER COLUMN receiver_name_text SET NOT NULL;

-- Note: sender_phone_text và receiver_phone_text VẪN NULLABLE (case N-12 khách không SĐT).
