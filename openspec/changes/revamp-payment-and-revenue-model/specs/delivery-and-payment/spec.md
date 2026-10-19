# Delta: delivery-and-payment (revamp-payment-and-revenue-model)

> Áp dụng decisions D1, D2, D3, D6, D7, D8, D9, D10 cho capability `delivery-and-payment`.
> Tách 1 nút "Hoàn tất giao hàng" thành state machine 2 nút, freeze info giao sau khi delivered, thêm `actual_recipient_role`, branch payment = login branch.

## ADDED Requirements

### Requirement: Bill state machine 2 nút giao và thu

Bill Detail screen SHALL hiển thị nút action theo state hiện tại của bill:

| Bill state | Nút | Handler |
|---|---|---|
| `pending` (mọi payment_status) | "✅ Hoàn tất giao hàng" | `handleConfirmDelivery` |
| `delivered + unpaid` | "✅ Xác nhận thanh toán" | `handleConfirmPayment` |
| `delivered + paid` | (ẩn) | — |
| `delivered + free` | (ẩn) | — |
| `cancelled` | (ẩn) | — |

`handleConfirmDelivery` SHALL update delivery fields + tùy chọn payment fields. `handleConfirmPayment` SHALL CHỈ update payment fields, KHÔNG đụng delivery fields.

#### Scenario: Pending bill - hiện nút Hoàn tất giao hàng

- **GIVEN** bill `01SGA02` ở trạng thái `pending + unpaid`
- **WHEN** user mở Bill Detail
- **THEN** thấy nút "✅ Hoàn tất giao hàng"
- **AND** KHÔNG thấy nút "✅ Xác nhận thanh toán"

#### Scenario: Delivered + unpaid - đổi nút sang Xác nhận thanh toán

- **GIVEN** bill `01SGA02` đã ở trạng thái `delivered + unpaid`
- **WHEN** user mở Bill Detail
- **THEN** thấy nút "✅ Xác nhận thanh toán" (cùng vị trí với nút Hoàn tất giao hàng cũ)
- **AND** KHÔNG thấy nút "✅ Hoàn tất giao hàng"

#### Scenario: Delivered + paid hoặc free - ẩn nút

- **GIVEN** bill `01SGA02` ở trạng thái `delivered + paid` (hoặc `delivered + free`)
- **WHEN** user mở Bill Detail
- **THEN** KHÔNG thấy nút action (cả 2 nút đều ẩn)
- **AND** form delivery + payment hiển thị read-only

### Requirement: handleConfirmPayment chỉ update payment, freeze delivery

Khi user bấm "Xác nhận thanh toán" trên bill `delivered + unpaid`, hệ thống SHALL CHỈ update các field thanh toán và MUST KHÔNG đụng đến các field giao hàng đã freeze.

`bills` SHALL được update CHỈ các field sau:
- `payment_status` → `paid`

`bills` MUST KHÔNG được update:
- `delivery_date` (giữ giá trị từ lần delivered đầu tiên)
- `delivered_by`
- `recipient_type`
- `actual_recipient_name`
- `actual_recipient_phone`
- `actual_recipient_role`

Đồng thời INSERT 1 row vào `bill_payment_details`:
- `bill_id` = bill đang chốt
- `amount_paid` = số tiền thực thu (theo payOption)
- `branch_id` = `session.branch_id` (KHÔNG `bill.branch_id`)
- `collected_by` = `session.userId`
- `note` = `paymentNote` từ input (nullable)

Sau khi insert, `bills.actual_amount_paid` SHALL được update = `SUM(bill_payment_details.amount_paid)` của bill đó.

#### Scenario: Thu nợ sau giao - delivery_date giữ nguyên

- **GIVEN** bill `01SGA02` `delivered + unpaid`, `delivery_date = '2026-06-25 16:00:00+07'`, `delivered_by = User U1`, `recipient_type = 'helper'`, `actual_recipient_name = 'Nguyễn B'`
- **WHEN** ngày 2026-06-28 user U2 (chi nhánh GL) bấm "Xác nhận thanh toán", chọn payOption=full
- **THEN** `bills.payment_status = 'paid'`
- **AND** `bills.delivery_date` VẪN = `'2026-06-25 16:00:00+07'` (KHÔNG bị overwrite)
- **AND** `bills.delivered_by` VẪN = U1
- **AND** `bills.actual_recipient_name` VẪN = 'Nguyễn B'
- **AND** insert `bill_payment_details(amount_paid=shipping_fee, branch_id=GL, collected_by=U2, created_at=2026-06-28 ...)`
- **AND** `bills.actual_amount_paid = shipping_fee`

#### Scenario: Thu nợ với note

- **GIVEN** bill `01SGA02` `delivered + unpaid`
- **WHEN** user bấm "Xác nhận thanh toán", nhập paymentNote = "Khách quay lại trả tiền mặt"
- **THEN** `bill_payment_details.note = 'Khách quay lại trả tiền mặt'`

#### Scenario: Thu nợ - không có payOption=unpaid

- **GIVEN** form "Xác nhận thanh toán" hiển thị
- **THEN** chỉ có 2 radio: `full` và `actual`
- **AND** KHÔNG có radio `unpaid` (vì đã ở `delivered + unpaid`, click "Xác nhận thanh toán" = bắt buộc chuyển sang paid)

### Requirement: actual_recipient_role lưu vai trò người nhận giùm

`bills.actual_recipient_role TEXT` (nullable) SHALL lưu vai trò người nhận giùm khi `recipient_type = 'helper'`. Khi `recipient_type ∈ {self, home}` → MUST giữ NULL.

UI form delivery SHALL có 1 input "Vai trò người nhận giùm" hiện chỉ khi `recipientType === 'helper'`, kèm datalist gợi ý `[Shipper, Người thân, Đồng nghiệp, Hàng xóm, Khác]` (user vẫn tự nhập tay được). Optional — cho phép để rỗng.

#### Scenario: Helper với role

- **GIVEN** user chọn `recipientType = "helper"`, nhập `repName = "Nguyễn B"`, `repPhone = "0909..."`, `repRole = "Shipper"`
- **WHEN** bấm "Hoàn tất giao hàng"
- **THEN** `bills.actual_recipient_role = 'Shipper'`

#### Scenario: Helper không nhập role

- **GIVEN** user chọn `recipientType = "helper"`, nhập tên + SĐT, `repRole = ""`
- **WHEN** bấm "Hoàn tất giao hàng"
- **THEN** `bills.actual_recipient_role = NULL` (không bắt buộc)

#### Scenario: Self - role luôn NULL

- **WHEN** `recipientType = "self"` và submit
- **THEN** `bills.actual_recipient_role = NULL` (kể cả nếu state `repRole` còn giá trị từ lần chọn helper trước)

#### Scenario: Load bill helper - hiển thị role

- **GIVEN** bill `delivered`, `recipient_type='helper'`, `actual_recipient_role='Người thân'`
- **WHEN** user mở Bill Detail
- **THEN** section giao nhận read-only hiển thị "Người ký nhận: Nguyễn B (Người thân) — SĐT: 0909... — Ngày giao: 25/06/2026"

### Requirement: branch_id của payment_details = chi nhánh login

Mọi INSERT vào `bill_payment_details` SHALL set `branch_id = session.branch_id` (chi nhánh của nhân viên đang login). MUST KHÔNG dùng `bill.branch_id`.

Áp dụng cho 3 đường code:
1. `executeCreateBill` (intake paid immediately)
2. `handleConfirmDelivery` (giao + thu cùng lúc)
3. `handleConfirmPayment` (thu nợ sau giao)

Cộng với `collected_by = session.userId`.

#### Scenario: Bill SG, giao + thu tại GL

- **GIVEN** bill `01SGA02` `pending + unpaid`, `bill.branch_id = SG`
- **WHEN** user (login GL) bấm "Hoàn tất giao hàng" với payOption=full
- **THEN** insert `bill_payment_details(branch_id=GL, collected_by=<user GL>, ...)`
- **AND** `bill.branch_id` VẪN = SG (không đổi)

#### Scenario: Intake paid immediately - branch = login

- **GIVEN** user login SG đang tạo bill mới
- **WHEN** tick "Thanh toán ngay", submit
- **THEN** insert `bills` với `branch_id = SG`
- **AND** insert `bill_payment_details(branch_id=SG, collected_by=<user SG>, ...)`

### Requirement: bill_payment_details có collected_by và note

Schema `bill_payment_details` SHALL có 2 cột mới:
- `collected_by UUID REFERENCES users(id) ON DELETE SET NULL`
- `note TEXT` (nullable)

`collected_by` MUST được set = `session.userId` ở mọi INSERT mới. Cho row cũ trước migration: backfill `collected_by = bills.delivered_by` của bill tương ứng (best-effort; nullable cho row không có delivered_by).

#### Scenario: Insert mới - collected_by không null

- **WHEN** code INSERT vào `bill_payment_details` qua bất kỳ flow nào
- **THEN** `collected_by` MUST có giá trị (= session.userId)

#### Scenario: Row cũ sau backfill

- **GIVEN** row `bill_payment_details` cũ trước migration, `bill.delivered_by = U1`
- **WHEN** migration backfill chạy
- **THEN** row đó có `collected_by = U1`

### Requirement: actual_amount_paid được persist sau mỗi payment

`bills.actual_amount_paid` SHALL được update = `SUM(bill_payment_details.amount_paid)` của bill đó NGAY SAU MỖI INSERT vào `bill_payment_details`. App-level update, không trigger DB.

Doanh thu SHALL đọc từ `bill_payment_details` (xem capability `revenue-reporting`). `bills.actual_amount_paid` chỉ là denormalized cache cho UI Bill Detail và báo cáo nhanh.

Nếu update `actual_amount_paid` fail (vd network) — MUST KHÔNG throw lên main flow, chỉ `console.warn`.

#### Scenario: Thu lần đầu

- **GIVEN** bill `01SGA02`, `actual_amount_paid = 0`, `shipping_fee = 300000`
- **WHEN** user bấm "Hoàn tất giao hàng" với payOption=full
- **THEN** sau INSERT payment_details `amount_paid=300000`
- **AND** `bills.actual_amount_paid = 300000`

#### Scenario: Thu thiếu (case 4)

- **GIVEN** bill `01SGA02`, `shipping_fee = 100000`, `unpaid`
- **WHEN** user bấm "Hoàn tất giao hàng" với payOption=actual, actualAmountPaid=80000
- **THEN** insert `bill_payment_details(amount_paid=80000)`
- **AND** `bills.payment_status = 'paid'`
- **AND** `bills.actual_amount_paid = 80000` (KHÔNG = 100000)

#### Scenario: Update fail không block

- **GIVEN** INSERT `bill_payment_details` thành công
- **WHEN** call `refreshBillActualPaid()` lỗi mạng
- **THEN** toast "Đã cập nhật" vẫn hiển thị
- **AND** console.warn `[actual_amount_paid] refresh failed: ...`

### Requirement: UX stay on page sau save

Sau khi `handleConfirmDelivery` hoặc `handleConfirmPayment` thành công, hệ thống SHALL:

1. Giữ `selectedBill` ≠ null (KHÔNG reset).
2. Giữ `currentScreen = 'bills'`.
3. KHÔNG đổi `activeSubTab`.
4. Update local state (`bills[i]`, `payments[]`) thay vì re-fetch toàn bộ.
5. Re-render Bill Detail với state mới → button đổi theo state machine.
6. Toast "Đã cập nhật" hiển thị.

Nút "← Quay lại" giữ nguyên, trỏ về `previousTab` (warehouse / all-bills / etc).

#### Scenario: Hoàn tất giao - stay

- **GIVEN** user từ Warehouse click vào bill `01SGA02`, mở Bill Detail
- **WHEN** bấm "Hoàn tất giao hàng" với payOption=unpaid
- **THEN** sau save, vẫn ở Bill Detail của `01SGA02`
- **AND** state hiển thị `delivered + unpaid`
- **AND** button đổi sang "✅ Xác nhận thanh toán"
- **AND** section giao nhận chuyển sang read-only
- **AND** nút "← Quay lại" vẫn về Warehouse khi click

#### Scenario: Xác nhận thanh toán - stay

- **GIVEN** user mở bill `delivered + unpaid`
- **WHEN** bấm "Xác nhận thanh toán" với payOption=full
- **THEN** vẫn ở Bill Detail
- **AND** state `delivered + paid`
- **AND** button ẩn
- **AND** cả 2 section read-only

## MODIFIED Requirements

### Requirement: payment_status cuối khi payOption=actual

Khi `payOption = "actual"` và `actualAmountPaid > 0`, `bills.payment_status` SHALL = `paid` và `bills.actual_amount_paid` SHALL = `actualAmountPaid`. KHÔNG tạo trạng thái `partial` mới.

INSERT `bill_payment_details.amount_paid = actualAmountPaid` (số thực thu, có thể < `shipping_fee`).

Doanh thu (capability `revenue-reporting`) cộng `actualAmountPaid`, KHÔNG cộng `shipping_fee`.

> Quyết định D2: KHÔNG tạo trạng thái `partial` mới. Trả thiếu được coi là "đã xong" về business — phần thiếu không được tự động chuyển thành nợ. Nếu muốn truy thu, nhân viên ghi note trong bill và xử lý thủ công.

#### Scenario: Thu thiếu lúc giao

- **GIVEN** bill `01SGA02` `pending + unpaid`, `shipping_fee = 100000`
- **WHEN** user bấm "Hoàn tất giao hàng", chọn `actual`, nhập 80000
- **THEN** `bills.payment_status = 'paid'`
- **AND** `bills.delivery_status = 'delivered'`
- **AND** `bill_payment_details.amount_paid = 80000`
- **AND** `bills.actual_amount_paid = 80000`
- **AND** doanh thu chi nhánh login cộng 80000 vào ngày bấm

### Requirement: delivery_date = thời điểm bấm "Hoàn tất giao hàng" (lần đầu)

`bills.delivery_date` SHALL được set = `new Date().toISOString()` tại thời điểm bấm "Hoàn tất giao hàng" LẦN ĐẦU (khi `pending → delivered`).

Sau khi đã `delivered`, `delivery_date` SHALL MUST KHÔNG bị overwrite bởi bất kỳ action nào (kể cả "Xác nhận thanh toán" sau).

User MUST KHÔNG có UI để sửa `delivery_date` tay.

> Note: tài xế đi giao luôn trong ngày, không có case "ngày giao là hôm qua". State UI `deliveryDate` cũ (line 315) — XÓA.

#### Scenario: Bấm Hoàn tất - delivery_date set lần đầu

- **GIVEN** bill `pending`, `delivery_date = NULL`
- **WHEN** user bấm "Hoàn tất giao hàng" lúc 2026-06-25 16:42:11+07
- **THEN** `bills.delivery_date = '2026-06-25T09:42:11.000Z'` (UTC ISO)

#### Scenario: Bấm Xác nhận thanh toán - delivery_date giữ nguyên

- **GIVEN** bill `delivered + unpaid`, `delivery_date = '2026-06-25T09:42:11.000Z'`
- **WHEN** user bấm "Xác nhận thanh toán" ngày 2026-06-28
- **THEN** `bills.delivery_date` VẪN = `'2026-06-25T09:42:11.000Z'` (KHÔNG cập nhật)

## REMOVED Requirements

### Requirement: Sub-tab Hoàn Tất hiển thị đơn pending để chốt

**Reason**: Spec gốc mô tả "sub-tab Hoàn Tất" nhưng thực tế UX là click bill pending từ Warehouse/All-bills/etc → Bill Detail có embedded section Hoàn Tất. Không có sub-tab riêng. Spec gốc lỗi thời, không match code.

UX thay thế (giữ trong main spec):
- Mọi tab list bill (Warehouse, All-bills, etc) đều click được vào bill pending để mở Bill Detail.
- Bill Detail có section "Thanh toán & Giao nhận" với nút action theo state machine (xem requirement "Bill state machine 2 nút").

### Requirement: Reset form sau chốt giao thành công

**Reason**: D9 đảo ngược hành vi này. Sau save user SHALL stay ở Bill Detail screen với state mới (xem requirement "UX stay on page sau save"). Không còn reset state về form Tạo Đơn.
