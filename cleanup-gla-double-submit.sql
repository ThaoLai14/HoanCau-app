-- Dọn 3 bill rác do bug double-submit nút "Tạo đơn ngày mai" (giữ lại 01GLA11 là đúng).
-- Chạy trên Supabase SQL Editor. Làm theo thứ tự, xem kết quả bước 1 trước khi chạy bước 2.

-- 1) KIỂM TRA trước khi xoá — chắc chắn 3 bill này unpaid, chưa giao, không có payment.
SELECT b.bill_code, b.business_date, b.delivery_status, b.payment_status, b.created_at,
       (SELECT COUNT(*) FROM bill_payment_details p WHERE p.bill_id = b.id) AS so_payment
FROM bills b
JOIN branches br ON br.id = b.branch_id AND br.branch_code = 'GL'
WHERE b.bill_code IN ('01GLA12','01GLA13','02GLA13')
ORDER BY b.bill_code;

-- 2) XOÁ 3 bill sai (chỉ khi bước 1 xác nhận không có payment).
DELETE FROM bills
WHERE bill_code IN ('01GLA12','01GLA13','02GLA13')
  AND branch_id = (SELECT id FROM branches WHERE branch_code = 'GL');

-- 3) RESET session GL về đúng chuyến của 01GLA11.
--    bill_seq = 2 vì số 01 đã dùng → bill GL kế tiếp sẽ là 02GLA11.
--    day_counter = phần sau "01GL" của mã (vd "01GLA11" -> "A11").
UPDATE branch_sessions bs
SET business_date = b.business_date,
    day_counter   = substring(b.bill_code FROM 5),
    bill_seq      = 2,
    updated_at    = now()
FROM bills b
WHERE b.bill_code = '01GLA11'
  AND b.branch_id = (SELECT id FROM branches WHERE branch_code = 'GL')
  AND bs.branch_id = b.branch_id;

-- 4) VERIFY — session GL phải là: business_date = ngày của 01GLA11, day_counter = A11, bill_seq = 2.
SELECT br.branch_code, bs.business_date, bs.day_counter, bs.bill_seq
FROM branch_sessions bs
JOIN branches br ON br.id = bs.branch_id
WHERE br.branch_code = 'GL';
