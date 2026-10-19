# Delta: revenue-reporting (revamp-payment-and-revenue-model)

> Áp dụng decisions D3, D4, D5 cho capability `revenue-reporting`.
> Đổi nguồn doanh thu từ `SUM(bills.shipping_fee WHERE paid)` sang `SUM(bill_payment_details.amount_paid)` group theo `branch_id` + `created_at::date`.

## ADDED Requirements

### Requirement: Doanh thu tính từ bill_payment_details

Doanh thu SHALL được tính bằng `SUM(bill_payment_details.amount_paid)` filter theo:
- `bill_payment_details.branch_id` = branch của sub-tab đang xem (mapping qua `branch_code`)
- `bill_payment_details.created_at` calendar day/month/year tùy filter type

KHÔNG còn join với `bills.payment_status`. Sự tồn tại của row `bill_payment_details` = tiền đã về (KHÔNG cần check status nữa).

Mỗi bill có thể đóng góp 0, 1, hoặc N row vào doanh thu (case 1 row khi trả full lúc gửi/giao; N row khi tương lai có "trả trước" + "trả nốt").

#### Scenario: Lọc theo ngày

- **GIVEN** ngày 2026-06-25, branch SG có 3 row payment: amount [100k, 200k, 150k]; branch GL có 1 row: 80k
- **WHEN** user chọn sub-tab SG, filter type=day, date=2026-06-25
- **THEN** doanh thu SG = 450000
- **AND** lọc qua GL → doanh thu GL = 80000

#### Scenario: Lọc theo tháng

- **WHEN** filter type=month, month="2026-06"
- **THEN** doanh thu = SUM(amount_paid) của payment có `created_at::date` slice(0,7) = "2026-06"

#### Scenario: Bill có 0 row payment

- **GIVEN** bill `01SGA02` `delivered + unpaid`, KHÔNG có row payment
- **THEN** đơn này KHÔNG góp gì vào doanh thu

### Requirement: Doanh thu cộng đúng số thực thu (case actual)

Đơn `payOption = actual` SHALL được cộng vào doanh thu = `bill_payment_details.amount_paid` thực tế (có thể < `shipping_fee`).

Trước đây code cộng full `shipping_fee` kể cả trả thiếu → SAI. Sau refactor: chỉ cộng số thực thu.

#### Scenario: Đơn thu thiếu

- **GIVEN** bill cước 100k, trả thực tế 80k → `bill_payment_details.amount_paid = 80000`
- **WHEN** tính doanh thu khoảng chứa `created_at` của payment đó
- **THEN** doanh thu cộng 80000 (KHÔNG 100000)

### Requirement: Branch của doanh thu = branch nhân viên thực thu

Doanh thu SHALL group theo `bill_payment_details.branch_id` (= chi nhánh nhân viên đang login lúc bấm "Xác nhận thanh toán" hoặc "Hoàn tất giao hàng").

KHÔNG dùng `bills.branch_id` (= chi nhánh gửi bill). Bill có thể được gửi từ chi nhánh A nhưng thu tiền tại chi nhánh B → doanh thu cộng cho B.

#### Scenario: Bill SG, thu tại GL

- **GIVEN** bill `01SGA02`, `bills.branch_id = SG`
- **AND** user login GL bấm "Hoàn tất giao hàng" + payOption=full
- **THEN** `bill_payment_details.branch_id = GL`
- **AND** doanh thu GL cộng `amount_paid`
- **AND** doanh thu SG KHÔNG cộng row này

#### Scenario: Khách gom 3 bill (mix SG + GL) trả tại GL

- **GIVEN** 3 bill: `01SGA02` (branch SG, unpaid), `02SGA03` (branch SG, unpaid), `05GLA01` (branch GL, unpaid), tất cả `delivered`
- **WHEN** user login GL bấm "Xác nhận thanh toán" cho từng bill lần lượt
- **THEN** 3 row payment_details được insert, tất cả `branch_id = GL`
- **AND** doanh thu GL cộng tổng cước 3 bill
- **AND** doanh thu SG KHÔNG cộng

### Requirement: Doanh thu detail = list payment, không phải list bill

Tab Doanh Thu → bảng chi tiết SHALL render từ `bill_payment_details` (mỗi row UI = 1 row payment), KHÔNG phải từ `bills`.

Cột hiển thị:
- `bill_code` (link sang Bill Detail của `bill_id`)
- Tên người gửi (qua `bills.sender.fullname`)
- Tên người nhận (qua `bills.receiver.fullname`)
- `amount_paid` (số tiền lần này)
- `branch.branch_code` (chi nhánh thu)
- `collector.full_name` (nhân viên thu = `users.full_name` qua `collected_by`)
- `created_at` (thời điểm thu, format dd/MM/yyyy HH:mm)
- `note`

1 bill có nhiều payment → xuất hiện nhiều row (mỗi row 1 lần thu).

#### Scenario: Bill có 2 payment

- **GIVEN** bill `01SGA02` cước 100k, paid 60k ngày 25/6, paid 40k ngày 28/6
- **WHEN** user xem doanh thu tháng 6/2026
- **THEN** bảng detail có 2 row cho `01SGA02`: 1 row 60k ngày 25/6, 1 row 40k ngày 28/6
- **AND** tổng doanh thu cộng 100k

### Requirement: Expense filter giữ nguyên (không đổi)

Chi phí (`expenses`) SHALL tiếp tục được lọc theo `expenses.created_at::date` (không có khái niệm `business_date` cho expense). Logic chi phí KHÔNG thay đổi so với main spec.

#### Scenario: Chi phí trong ngày

- **WHEN** filter type=day, date="2026-06-25"
- **THEN** chỉ cộng expense có `created_at::date = '2026-06-25'`, `is_delete = false`, `branch_id` map với sub-tab

### Requirement: Loại trừ bill cancelled khỏi doanh thu

Doanh thu SHALL filter `bill_payment_details` join `bills.delivery_status !== 'cancelled'` VÀ `bills.is_delete = false`. Payment row cũ của bill sau đó bị cancel MUST KHÔNG được cộng.

Bill cancelled + có payment cũ → doanh thu ngày cũ giảm; đồng thời auto-tạo expense refund (xem Requirement dưới) → net effect = 0 cho ngày cancel.

#### Scenario: Bill cancel sau khi thu tiền

- **GIVEN** bill 100k trả full ngày 2026-06-25 → `payment_details.amount_paid = 100000, created_at = 2026-06-25`
- **AND** ngày 2026-06-28 admin cancel bill (bill_delete=true or delivery_status=cancelled)
- **WHEN** xem doanh thu ngày 2026-06-25 (query lại)
- **THEN** doanh thu KHÔNG cộng 100k của bill này

### Requirement: Auto-tạo expense refund khi cancel bill có payment

Khi admin cancel 1 bill có `bill_payment_details` (đã thu ≥1 lần), hệ thống MUST tự động INSERT 1 row `expenses` với:
- `amount = SUM(bill_payment_details.amount_paid)` cho bill đó — 1 row tổng, không phải N row.
- `note = 'Hoàn tiền cho bill <bill_code>'`.
- `branch_id = bills.branch_id` (chi nhánh gửi của bill, KHÔNG phải chi nhánh login của user cancel).
- `created_by = session.userId`.
- `created_at = now()`.

Row expense này MUST xuất hiện trong bảng chi phí của chi nhánh gửi + có thể edit/xoá bởi admin của chi nhánh đó (theo Requirement CRUD chi phí).

Log audit MUST ghi action `refund_created`.

Không hiển thị popup xác nhận; hiển thị toast "Đã tạo phiếu hoàn tiền {formatVND(amount)} cho bill {bill_code}".

Bill draft (hard-delete, chưa có payment): KHÔNG tạo expense.

#### Scenario: Cancel bill 100k đã trả full

- **GIVEN** bill 100k `delivered + paid`, có 1 row payment 100k
- **WHEN** admin bấm Huỷ đơn (soft-cancel)
- **THEN** INSERT 1 row `expenses(amount=100000, note='Hoàn tiền cho bill 01SGA02', branch_id=<bill.branch_id>, ...)`.
- **AND** toast "Đã tạo phiếu hoàn tiền 100.000đ cho bill 01SGA02"
- **AND** audit_log có entry `refund_created`.

#### Scenario: Cancel bill có 2 lần thu

- **GIVEN** bill 100k, thu 60k ngày X + thu 40k ngày Y → 2 rows payment
- **WHEN** cancel bill
- **THEN** INSERT 1 row expense duy nhất, `amount = 100000` (tổng).

#### Scenario: Cancel bill draft chưa thu

- **GIVEN** bill draft, KHÔNG có payment row
- **WHEN** admin cancel (hard-delete draft)
- **THEN** KHÔNG có expense insert.

### Requirement: Timezone helper toVNDate cho mọi filter theo ngày

Mọi filter/hiển thị "ngày" dựa trên `timestamptz` (bao gồm `bill_payment_details.created_at`, `expenses.created_at`, `bills.delivery_date`) MUST dùng helper `toVNDate(ts)` chuyển timezone UTC+7 trước khi so sánh chuỗi `YYYY-MM-DD`.

```js
const toVNDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
};
```

Trực tiếp `.slice(0, 10)` trên timestamptz MUST KHÔNG còn được dùng cho filter ngày (gây lệch 1 ngày ở khoảng 0h–7h VN sáng).

Cột `business_date` (kiểu DATE) KHÔNG cần helper — dùng trực tiếp.

#### Scenario: Payment lúc 23h55 giờ VN

- **GIVEN** `bill_payment_details.created_at = '2026-07-01T23:55:00+07:00'` (tức '2026-07-01T16:55:00Z' UTC)
- **WHEN** filter doanh thu ngày 2026-07-01
- **THEN** payment này ĐƯỢC cộng (vì `toVNDate` trả về '2026-07-01', không phải '2026-07-01' ngày UTC).
- **AND** hiển thị cột "Ngày thu" = '01/07/2026'.

### Requirement: Bảng chi phí có nút edit và soft-delete cho admin

Bảng chi tiết chi phí SHALL hiển thị 2 nút "✏️ Sửa" và "🗑️ Xoá" trên mỗi row, chỉ khi:
- `session.role === 'admin'`, VÀ
- `revenueTab === session.branch_code` (admin chỉ CRUD chi nhánh mình).

Member và boss MUST KHÔNG thấy 2 nút này ở mọi sub-tab.

Nút "Sửa" mở modal edit `amount`, `note`, `created_at` (date only). Save → UPDATE row expense. Log audit `expense_update` với `changes: { amount: [old, new], note: [old, new], date: [old, new] }`.

Nút "Xoá" confirm rồi soft-delete: `UPDATE expenses SET is_delete=true, deleted_at=now(), deleted_by=session.userId`. Log audit `expense_delete` với `entity_label = note || 'Chi phí ' + formatVND(amount)`.

Filter query fetch expenses MUST thêm `.eq('is_delete', false)`.

#### Scenario: Admin SG edit chi phí SG

- **GIVEN** session `role=admin`, `branch_code=SG`, `revenueTab='SG'`
- **WHEN** admin bấm Sửa 1 row chi phí SG, đổi amount 200k → 250k, save
- **THEN** DB UPDATE thành công, audit `expense_update` xuất hiện

#### Scenario: Admin SG xem tab GL — nút ẩn

- **GIVEN** session `role=admin`, `branch_code=SG`, chuyển `revenueTab='GL'`
- **THEN** bảng chi phí GL hiển thị bình thường nhưng KHÔNG có nút Sửa/Xoá

#### Scenario: Boss xem chi phí — nút ẩn

- **GIVEN** session `role=boss`
- **THEN** cả 2 tab SG và GL không có nút Sửa/Xoá

### Requirement: Role gating truy cập màn Doanh Thu

Màn Doanh Thu SHALL áp dụng access matrix theo role:

| Role | Menu "Doanh Thu" | Sub-tab Tổng Hợp | Sub-tab Doanh Thu (own branch) | Sub-tab Doanh Thu (other branch) |
|---|---|---|---|---|
| member | Ẩn | KHÔNG truy cập | KHÔNG truy cập | KHÔNG truy cập |
| admin | Hiện | Full (cả 2 branch) | Full CRUD chi phí | Read-only (ẩn form thêm + nút CRUD) |
| boss | Hiện | Full | Read-only | Read-only |

Guard: nếu member vào screen (vd URL cache, state cũ), MUST redirect về màn chính + toast "Không có quyền truy cập".

`handleAddExpense` MUST double-check `session.role === 'admin' && revenueTab === session.branch_code` trước INSERT. Sai → toast "Không có quyền" + return.

`handleAddExpense` payload MUST dùng `session.branch_id` (KHÔNG lookup `revenueTab` → branch_id) — vì đã guard tab = login branch.

#### Scenario: Member không thấy menu

- **GIVEN** session `role='member'`
- **WHEN** render navigation
- **THEN** item "Doanh Thu" KHÔNG xuất hiện

#### Scenario: Admin GL mở tab Doanh Thu SG

- **GIVEN** session `role=admin`, `branch_code=GL`, `revenueTab='SG'`
- **THEN** bảng data hiện đủ, form "Thêm chi phí" ẩn, mỗi row expense không có nút edit/xoá

#### Scenario: Boss vào tab riêng — read-only

- **GIVEN** session `role=boss`, `revenueTab='SG'`
- **THEN** form "Thêm chi phí" ẩn, không nút CRUD

### Requirement: Bảng breakdown Month/Year + so sánh kỳ trước

Khi `revenueFilterType === 'month'`, màn Doanh Thu SHALL hiển thị bảng breakdown TỪNG NGÀY trong tháng:
- Rows: mỗi ngày 01..(30/31) của tháng, giữ cả row revenue=0 && expense=0.
- Cols: Ngày | Doanh thu | Chi phí | Net.

Khi `revenueFilterType === 'year'`:
- Rows: 12 tháng (01..12) của năm.
- Cols: Tháng | Doanh thu | Chi phí | Net.

Khi `revenueFilterType === 'day'`: KHÔNG hiển thị bảng breakdown (giữ layout cũ).

Card "So sánh kỳ trước" SHALL hiển thị:
- Filter=month: so với tháng liền trước.
- Filter=year: so với năm liền trước.
- Format: `"Kỳ này: 15.000.000đ | Kỳ trước: 12.000.000đ (+25%)"`.
- Kỳ trước = 0 → hiển thị "—" thay vì %.

#### Scenario: Filter month có bảng 30 rows

- **WHEN** `filterType=month`, `month='2026-06'`
- **THEN** bảng breakdown có 30 rows (tháng 6/2026 có 30 ngày)
- **AND** card "So sánh kỳ trước" so với tháng 5/2026

#### Scenario: Filter year có bảng 12 rows

- **WHEN** `filterType=year`, `year=2026`
- **THEN** bảng breakdown có 12 rows

### Requirement: Nút refresh thủ công

Header màn Doanh Thu SHALL có nút "🔄 Cập nhật". Bấm → gọi `fetchData()` re-fetch bills + expenses + payments. Hiển thị toast "Đã cập nhật" sau khi xong. Button disable + spinner khi đang loading.

#### Scenario: Refresh sau khi tạo bill mới

- **GIVEN** user đang xem màn Doanh Thu
- **WHEN** tạo 1 bill mới từ tab khác + quay lại + bấm refresh
- **THEN** doanh thu update lên với bill mới, toast xác nhận

## MODIFIED Requirements

### Requirement: Doanh thu tính theo amount_paid thực tế

Doanh thu SHALL được tính dựa trên SỐ TIỀN THỰC THU (`bill_payment_details.amount_paid`), KHÔNG phải `shipping_fee`. Cụ thể, hệ thống MUST SUM `bill_payment_details.amount_paid` filter theo `branch_id` (chi nhánh người thu) + `created_at` (calendar day thu).

> Trước đây: tính từ `SUM(bills.shipping_fee WHERE payment_status='paid')`.
> Sau: tính từ `SUM(bill_payment_details.amount_paid)` filter theo branch + date.

`bills.actual_amount_paid` (cột denormalized) tồn tại như cache cho UI Bill Detail nhưng KHÔNG được dùng làm nguồn doanh thu — luôn re-aggregate từ `bill_payment_details` tại thời điểm query.

#### Scenario: Đơn trả full

- **GIVEN** bill cước 300k, trả full → `bill_payment_details.amount_paid = 300000`
- **WHEN** tính doanh thu
- **THEN** cộng 300000

#### Scenario: Đơn trả thiếu

- **GIVEN** bill cước 300k, trả 200k → `bill_payment_details.amount_paid = 200000`, `bills.payment_status = 'paid'`
- **WHEN** tính doanh thu
- **THEN** cộng 200000 (KHÔNG 300000)

### Requirement: Loại trừ đơn unpaid khỏi doanh thu

Đơn `unpaid` (không có row `bill_payment_details`) SHALL tự động KHÔNG xuất hiện trong doanh thu vì không có row để SUM. Hệ thống MUST KHÔNG cộng `shipping_fee` của đơn unpaid vào doanh thu.

> Thay đổi semantics: trước đây filter `bills.payment_status === 'paid'`. Sau: filter qua tồn tại row trong `bill_payment_details`.

Khi đơn `unpaid` có 1 partial payment (vd intake pre-pay tương lai), phần đó VẪN được cộng vào doanh thu của ngày trả (vì row payment_details tồn tại).

#### Scenario: Đơn unpaid không có payment

- **GIVEN** bill `01SGA02` `delivered + unpaid`, KHÔNG có row payment
- **WHEN** tính doanh thu khoảng chứa `delivery_date`
- **THEN** đơn KHÔNG được cộng

### Requirement: Loại trừ đơn free khỏi doanh thu

Đơn `payment_status = "free"` SHALL không được cộng vào doanh thu vì KHÔNG có row `bill_payment_details` (intake / delivery flow skip insert cho free).

#### Scenario: Đơn free

- **GIVEN** bill free, `delivered + free`, KHÔNG có row payment_details
- **WHEN** tính doanh thu
- **THEN** đơn KHÔNG xuất hiện

## REMOVED Requirements

### Requirement: Doanh thu tính theo shipping_fee, không phải tiền thực thu

**Reason**: Đảo ngược hoàn toàn. Sau refactor: doanh thu tính theo `amount_paid` thực tế (xem MODIFIED). Đơn trả thiếu KHÔNG còn được cộng full `shipping_fee` → sửa bug đã flag ở callout trong main spec.
