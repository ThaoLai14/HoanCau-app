# Tasks: Hoàn hàng & Tiêu hủy

## 1. Migration DB

- [x] 1.1 `add-return-destroy-flow.sql`: ADD COLUMN `return_fee`, `current_branch_id`, `return_confirmed_at`.
- [x] 1.2 Nới CHECK `bills_delivery_status_check` thêm `returned`, `destroyed`.
- [x] 1.3 Nới RLS `bills_update_member` (own + cross) thêm 2 status mới; DROP `audit_log_action_check`.
- [x] 1.4 Đã chạy `add-return-destroy-flow.sql` trên Supabase (2026-10-24).

## 2. Data layer

- [x] 2.1 `fetchData` bills select: `*` + join `current_branch:branches!current_branch_id(branch_code)`.

## 3. Handlers

- [x] 3.1 `handleReturnBill` — `delivery_status='returned'`, `return_fee`, `current_branch_id`=session.branch_id, `business_date`=today, note; audit `bill_returned`.
- [x] 3.2 `handleDestroyBill` — chỉ `paid`/`free`; `delivery_status='destroyed'`, note; audit `bill_destroyed`.
- [x] 3.3 `handleConfirmReturnArrived` — `return_confirmed_at=now`, `current_branch_id`=branch gốc; audit `bill_return_confirmed`.
- [x] 3.4 `handleCollectReturnPayment` — `(shipping_fee+return_fee)-paid`; payment(branch=session); `payment_status='paid'`; audit `bill_payment_received`.

## 4. UI — popup + nút

- [x] 4.1 Popup `returnDialog` 3 bước: choose / return (MoneyInput + lý do) / destroy (lý do); disable Tiêu hủy khi còn nợ.
- [x] 4.2 Action bar: "↩️ Hoàn hàng" (pending, chi nhánh nhận, hàng tới); "✅ Xác nhận đã hoàn hàng"; "💰 Thu tiền hoàn".
- [x] 4.3 Chi tiết đơn: badge returned/destroyed + hiển thị `return_fee`.

## 5. Doanh thu / Công nợ / Bốc xếp / Tổng hợp

- [x] 5.1 `groupBillsByCustomer`: thêm `returned`; nợ = `(shipping_fee+return_fee)-paid`.
- [x] 5.2 `warehouseFilteredBills` + tab count + print: lọc theo `COALESCE(current_branch, branch)`; ẩn `destroyed`.
- [x] 5.3 Tổng Hợp: badge "Quay đầu"/"Tiêu hủy" + filter `returned`/`destroyed`.
- [x] 5.4 Revenue: status mới KHÔNG bị loại (chỉ loại `cancelled`).

## 6. Audit + build

- [x] 6.1 `auditLabels`: enum `returned`/`destroyed`; action `bill_returned`/`bill_destroyed`/`bill_return_confirmed`.
- [x] 6.2 Build pass.

## Scope note
- Chuyến về hiện trong Bốc Xếp SG qua `current_branch_id`, nhưng `performDeparture` (xuất bến) vẫn lọc theo `branch_id` gốc → đơn `returned` ride-along, không bị validate xuất bến chuyến về. Mở rộng sau nếu cần.

## 7. Post-launch refinements (2026-10-21 → 2026-10-24)

### 7.1 Đổi tên hiển thị "Quay đầu" → "Hoàn hàng"
Nghe lịch sự hơn. Đổi toàn bộ text UI + nhãn audit (`bill_returned` = "hoàn hàng", enum `returned` = "Hoàn hàng").
- [x] 7.1.1 [src/App.jsx](../../../src/App.jsx) + [src/auditLabels.js](../../../src/auditLabels.js).

### 7.2 Panel thu cước hoàn hàng thay form giao nhận (đơn returned)
Đơn `returned` không còn dùng form "Thanh toán & Giao nhận" thường (đã disable). Thay bằng panel "Thu cước hoàn hàng (đi + về)" hiển thị: cước đi, **cước hoàn (về)** (luôn hiện kể cả 0), tổng cần thu, đã thu, còn lại + hướng dẫn theo trạng thái.
- [x] 7.2.1 Banner tiêu hủy ghi rõ chi nhánh (`current_branch` else gốc).
- [x] 7.2.2 Nút "Thu tiền hoàn" hiện theo **còn-lại > 0** (= `(ship+return)-paid`), KHÔNG theo `payment_status` — fix đơn đã trả cước đi nhưng còn nợ cước hoàn.

### 7.3 Audit tiếng Việt cho field hoàn hàng
`return_fee` = "Cước hoàn (về)" (format tiền); `bill_return_confirmed` text = "đã hoàn hàng cho khách". Bỏ dòng vô nghĩa "Hoàn hàng về: now" — `renderChanges` lọc bỏ field `return_confirmed_at`.
- [x] 7.3.1 [src/auditLabels.js](../../../src/auditLabels.js).

### 7.4 current_branch_id — không reset về gốc khi xác nhận hoàn hàng
Rule: Danh Sách Bốc Xếp track xe hôm đó chở đơn nào → đơn hoàn hàng phải thuộc chi nhánh **chở về** (nơi bấm hoàn hàng), không nhảy về gốc. Bỏ dòng ghi đè `current_branch_id` trong `handleConfirmReturnArrived`.
- [x] 7.4.1 [src/App.jsx](../../../src/App.jsx) `handleConfirmReturnArrived`.
- [x] 7.4.2 `fix-returned-current-branch.sql` — sửa đơn cũ bị gán sai (user chạy tay).

### 7.5 Quyền sửa kho theo chi nhánh hiện tại (current_branch)
Đơn hoàn hàng nằm kho chi nhánh chở về → nhân viên chi nhánh đó phải sửa được Trong/Ngoài/Hàng ghép. Đổi check từ `branch` gốc sang `COALESCE(current_branch, branch)`.
- [x] 7.5.1 [src/App.jsx](../../../src/App.jsx) `canEditWarehouse` + `handleUpdateLocationCounts` + `handleCombinedGoodsSave`.

### 7.6 sys_admin sửa lại cước hoàn (về) trên đơn returned
Đơn `returned` panel chỉ-đọc → sys_admin không chỉnh được `return_fee` nhập nhầm. Thêm nút "✏️ Sửa" (chỉ sys_admin) ở dòng Cước hoàn → MoneyInput (bắt đầu trống) + Lưu; audit `bill_update`; yêu cầu PIN sys_admin.
- [x] 7.6.1 [src/App.jsx](../../../src/App.jsx) `handleSaveReturnFee` + state `editReturnFee`.

