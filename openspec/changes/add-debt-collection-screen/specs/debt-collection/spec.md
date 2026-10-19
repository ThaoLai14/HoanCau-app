# Delta spec: debt-collection (NEW capability)

## ADDED Requirements

### Requirement: Màn Công Nợ hiển thị tổng nợ theo khách

Hệ thống SHALL cung cấp 1 màn riêng "Công Nợ" hiển thị danh sách khách hàng có bill chưa thu đủ tiền, group theo khách. Mỗi row khách hiển thị: tên + SĐT + số lượng bill + tổng nợ.

**Phone source**: SĐT hiển thị MUST lấy từ join sẵn có ở bill (`sender_phone` / `receiver_phone` — trỏ tới row `client_phones` mà user chọn khi lập bill đó). KHÔNG lấy từ `clients.phone` vì column đó KHÔNG tồn tại (số điện thoại nằm ở table riêng `client_phones` với 3 type primary/secondary/old — xem change `add-client-phone-history`). Fallback: nếu bill đầu tiên của group không có phone (trường hợp bill cũ chưa link `sender_phone_id`/`receiver_phone_id`), lấy phone từ bill tiếp theo của group đó.

Data source: `bills` WHERE `is_delete = false` AND `delivery_status != 'cancelled'` AND `payment_status IN ('unpaid', 'quote_later')`.

Grouping key theo thứ tự fallback:
1. `bills.receiver_id` (khách nhận — người chịu trách nhiệm trả tiền trong luồng chành xe).
2. `bills.sender_id` (khách gửi — fallback khi khách nhận là vãng lai).
3. `null` → hiển thị "Khách vãng lai" per-bill (mỗi bill 1 group riêng).

#### Scenario: Nhóm theo người nhận

- **GIVEN** 3 bill `01SGA02`, `02SGA03`, `03SGA05` cùng `receiver_id = client-X`, `delivered + unpaid`
- **AND** cước lần lượt 100k, 200k, 150k, chưa trả gì
- **WHEN** user mở màn Công Nợ
- **THEN** thấy 1 row "Khách X - 0912xxx - 3 bill - 450.000đ"

#### Scenario: Fallback sang người gửi

- **GIVEN** 1 bill có `receiver_id = null` (khách vãng lai nhận), `sender_id = client-Y`, delivered + unpaid, nợ 100k
- **WHEN** mở màn Công Nợ
- **THEN** row hiển thị dưới nhóm khách Y (không phải "Khách vãng lai")

#### Scenario: Cả sender và receiver null

- **GIVEN** 1 bill cả `sender_id` và `receiver_id` null
- **WHEN** mở màn Công Nợ
- **THEN** 1 row "Khách vãng lai" riêng cho bill này

### Requirement: Tính tổng nợ per khách

`totalDebt` per group SHALL = SUM(`shipping_fee` - COALESCE(`actual_amount_paid`, 0)) qua các bill của khách trong filter hiện tại, **TRỪ** bill có `payment_status = 'quote_later'` (chưa xác định cước).

Bill `quote_later` MUST được đếm vào `billCount` nhưng KHÔNG cộng `totalDebt`. Hiển thị badge "Chưa báo cước x N" nếu group có ≥1 quote_later bill.

#### Scenario: Bill quote_later không cộng tổng

- **GIVEN** khách X có 2 bill: bill A `unpaid` cước 100k, bill B `quote_later` (chưa có cước)
- **WHEN** hiển thị màn Công Nợ
- **THEN** row hiển thị "2 bill - 100.000đ" + badge "Chưa báo cước x 1"

#### Scenario: Đã trả 1 phần

- **GIVEN** bill cước 500k, `actual_amount_paid = 300k`, `payment_status = unpaid`
- **THEN** debt contribution = 200.000đ

### Requirement: Filter mặc định + toggle "Bao gồm đơn chưa giao"

Filter mặc định (khi mở màn) SHALL include: `delivery_status = 'delivered' AND payment_status IN ('unpaid', 'quote_later')`.

Toggle checkbox "Bao gồm đơn chưa giao" (mặc định OFF), khi ON SHALL thêm điều kiện: HOẶC (`delivery_status = 'pending' AND payment_status = 'unpaid'`).

`pending + quote_later` MUST KHÔNG bao giờ hiển thị (bill chưa giao + chưa báo cước = không phải công nợ).

`delivered + quote_later` KHÔNG xuất hiện trong dataset thực tế (rule nghiệp vụ: user PHẢI chọn paid/unpaid khi giao, không có option quote_later ở bước giao). Không cần code xử lý riêng — filter tự nhiên loại.

#### Scenario: Mặc định chỉ giao rồi

- **GIVEN** 3 bill: A (`delivered+unpaid`), B (`pending+unpaid`), C (`delivered+quote_later` — không tồn tại thực tế nhưng test bảo vệ)
- **WHEN** mở màn Công Nợ (toggle OFF)
- **THEN** chỉ thấy A

#### Scenario: Toggle ON thêm pending unpaid

- **WHEN** user check "Bao gồm đơn chưa giao"
- **THEN** thấy cả A và B

#### Scenario: pending + quote_later luôn ẩn

- **GIVEN** 1 bill `pending + quote_later`
- **WHEN** mở màn (dù toggle ON hay OFF)
- **THEN** KHÔNG thấy bill này

### Requirement: Search + sort

Màn Công Nợ SHALL có:
- Search box: match `name` (case-insensitive substring, locale='vi') hoặc `phone` (startsWith).
- Sort toggle: default = `totalDebt` giảm dần; toggle → sort theo `name` A→Z (locale='vi').

#### Scenario: Search theo tên

- **GIVEN** khách có tên "Nguyễn Văn A", "Nguyễn Văn B", "Trần Thị C"
- **WHEN** user search "nguyễn"
- **THEN** thấy 2 khách "Nguyễn Văn A" và "Nguyễn Văn B"

#### Scenario: Search theo SĐT startsWith

- **WHEN** search "0912"
- **THEN** chỉ hiện khách có SĐT bắt đầu 0912

### Requirement: Expand/collapse chi tiết bill

Row khách SHALL default collapse (chỉ hiện tóm tắt). Click ▶ → expand hiển thị danh sách bill của khách đó, mỗi row bill: `bill_code | business_date | Cước X, đã trả Y | Nợ Z`.

Bill `quote_later` hiển thị "Chưa báo cước" thay chỗ số tiền nợ.

Click `bill_code` SHALL mở Bill Detail (reuse `selectedBill` state của App.jsx), set `previousTab = 'debt'` để nút "← Quay lại" biết đường về.

#### Scenario: Expand rồi click bill

- **WHEN** user bấm ▶ vào khách X → thấy list 3 bill
- **AND** click `01SGA02`
- **THEN** navigate sang Bill Detail của bill 01SGA02
- **AND** nút "← Quay lại" trên Bill Detail trỏ về màn Công Nợ

### Requirement: Refresh sau khi mutate

Nút "🔄 Cập nhật" SHALL re-fetch data. Toast "Đã cập nhật" sau khi xong. Loading state + disable button khi đang fetch.

Sau khi user thao tác (thu tiền / huỷ) từ Bill Detail rồi quay lại → màn Công Nợ MUST tự động re-fetch (không cần user bấm refresh).

State màn (search query, includePending, sort mode, expanded set) MUST được preserve khi vào Bill Detail rồi quay lại.

#### Scenario: Auto refresh sau thu tiền

- **GIVEN** khách X có 1 bill nợ 100k
- **WHEN** user click bill → thu full → back về màn Công Nợ
- **THEN** khách X biến mất khỏi list (không còn nợ)
- **AND** search query cũ vẫn còn trong input

### Requirement: Role gating truy cập màn Công Nợ

Màn Công Nợ SHALL áp dụng access matrix theo role:

| Role | Menu | Truy cập | Thao tác trên bill |
|---|---|---|---|
| member | Ẩn | Không | — |
| admin | Hiện | Full | Đủ quyền (thu tiền, huỷ) khi mở Bill Detail |
| boss | Hiện | Full | Read-only (Bill Detail đã tự read-only cho boss) |

Nếu member vào screen qua state cũ / URL cache MUST redirect về màn chính + toast "Không có quyền".

#### Scenario: Member ẩn menu

- **GIVEN** `session.role = 'member'`
- **WHEN** render navigation
- **THEN** item "Công Nợ" KHÔNG xuất hiện

#### Scenario: Boss xem nhưng không thu tiền

- **GIVEN** `session.role = 'boss'`, mở màn Công Nợ, click 1 bill
- **THEN** Bill Detail load ở read-only mode (nút "Xác nhận thanh toán" ẩn theo logic Bill Detail hiện có)
