-- Fix đơn hoàn hàng bị gán sai current_branch_id về chi nhánh gốc (bug cũ ở
-- handleConfirmReturnArrived — đã sửa trong code). Đơn hoàn hàng phải nằm trong
-- bốc xếp của chi nhánh CHỞ VỀ, không phải chi nhánh gốc.
--
-- 1) Xem các đơn returned đang có current_branch_id = chi nhánh gốc (nghi bị bug):
SELECT b.bill_code,
       og.branch_code  AS origin_branch,
       cb.branch_code  AS current_branch,
       b.return_confirmed_at
FROM bills b
JOIN branches og  ON og.id = b.branch_id
LEFT JOIN branches cb ON cb.id = b.current_branch_id
WHERE b.delivery_status = 'returned';

-- 2) Sửa riêng đơn 01SGA10 về chi nhánh GL (xe GL chở về):
UPDATE bills
SET current_branch_id = (SELECT id FROM branches WHERE branch_code = 'GL')
WHERE bill_code = '01SGA10';
