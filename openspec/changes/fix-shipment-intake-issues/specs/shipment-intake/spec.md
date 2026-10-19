# Delta: shipment-intake (fix-shipment-intake-issues)

> Áp dụng các sửa đổi I-1, I-4, I-6, I-8, N-1, N-4, N-10, N-11, N-12, N-13 cho capability `shipment-intake`.
> N-13 (address exception) chính + phụ thuộc spec `customer-management` (cùng change).

## MODIFIED Requirements

### Requirement: Cước phí và các flag thanh toán loại trừ nhau

Cước phí SHALL bắt buộc TRỪ KHI đơn là "miễn phí" (`isFreeShipping`) hoặc "báo giá sau" (`feeQuoteLater`). 3 checkbox `isFreeShipping`, `feeQuoteLater`, `isPaidImmediately` MUST loại trừ nhau ở UI.

`payment_status` của `bills` SHALL nhận 1 trong 4 giá trị: `paid`, `unpaid`, `free`, `quote_later` (DB CHECK constraint).

Mapping flag UI → DB:

| Flag UI | `payment_status` | `shipping_fee` |
|---|---|---|
| `isFreeShipping = true` | `free` | `0` |
| `feeQuoteLater = true` | `quote_later` | `0` |
| `isPaidImmediately = true` | `paid` | giá trị user nhập |
| (không flag nào) | `unpaid` | giá trị user nhập |

UI input cước:
- `isFreeShipping = true` → **ẩn input**, thay bằng label "Miễn phí" (read-only).
- `feeQuoteLater = true` → input vẫn hiển thị nhưng placeholder "Báo giá sau" (cho phép trống).
- Còn lại → input bình thường, required.

Khi LOAD bill cũ vào form:
- `payment_status` được đọc thẳng từ `bills.payment_status` (KHÔNG re-derive từ `shipping_fee = 0`).
- Set lại 3 flag UI tương ứng.

#### Scenario: Đơn miễn phí — UI ẩn input cước

- **GIVEN** form intake đang mở, chưa tick flag nào
- **WHEN** user tick `isFreeShipping`
- **THEN** input cước biến mất, hiển thị label "Miễn phí"
- **AND** khi submit, `payment_status = "free"`, `shipping_fee = 0` được ghi vào DB
- **AND** KHÔNG insert row vào `bill_payment_details`

#### Scenario: Báo giá sau — persist `quote_later`

- **WHEN** `feeQuoteLater = true`, user bấm Lưu
- **THEN** `payment_status = "quote_later"`, `shipping_fee = 0` được ghi vào DB
- **AND** đơn này hiển thị "Chưa có cước" ở cột Cước phí trong các bảng tổng hợp

#### Scenario: Load bill cũ `quote_later`

- **GIVEN** bill `bills.payment_status = "quote_later"`, `shipping_fee = 0`
- **WHEN** admin mở bill để sửa
- **THEN** UI hiển thị `feeQuoteLater = true` (tick sẵn), input cước hiện với placeholder "Báo giá sau"

### Requirement: special_stars auto-derive từ goodsValue (load bill không force manual)

`special_stars` SHALL tự derive từ `goodsValue`: ≥10M → 2 sao, ≥5M → 1 sao, else → 0. User MAY override tay (giữ `starsManual = true` trong session form hiện tại).

Khi LOAD bill cũ vào form: `starsManual` SHALL được reset về `false` → re-derive theo `goods_value` hiện đang load (không giữ override từ DB).

Lý do: không thêm cột `bills.stars_manual` BOOLEAN. Trade-off: bill cũ admin từng override → khi load lại, auto-derive ghi đè. Admin phải override lại nếu muốn giữ. Trường hợp này hiếm và thường đi cùng `no_declared_value = true` (đã ép `special_stars = 0`).

#### Scenario: Load bill cũ có override (12M, 0 sao)

- **GIVEN** bill cũ `goods_value = 12000000`, `special_stars = 0` (admin từng override)
- **WHEN** admin mở bill để sửa
- **THEN** form auto-derive lại → `special_stars = 2` hiển thị
- **AND** `starsManual = false` (không lock)
- **AND** admin phải tự chọn lại `0 sao` nếu muốn giữ

#### Scenario: Đổi goodsValue trong form, chưa override

- **GIVEN** form đang mở, `starsManual = false`
- **WHEN** user đổi `goodsValue` từ 0 → 6000000
- **THEN** `special_stars` re-derive thành 1

### Requirement: no_declared_value persist trên cả 3 đường code

`no_declared_value` SHALL được persist trong `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`. Khi LOAD bill cũ, UI SHALL đọc trực tiếp `bill.no_declared_value`, KHÔNG suy diễn từ `goods_value === 0`.

#### Scenario: Lưu nháp với no_declared_value = true

- **WHEN** user tick "Không khai giá trị" và bấm "Lưu nháp"
- **THEN** `bills.no_declared_value = true` được ghi vào DB

#### Scenario: Convert draft → pending với no_declared_value

- **GIVEN** draft có `no_declared_value = true`
- **WHEN** user bấm "Tạo Hóa Đơn" để convert
- **THEN** sau khi convert, `bills.no_declared_value` VẪN = true

#### Scenario: Load bill có goods_value = 0 nhưng KHÔNG phải no_declared_value

- **GIVEN** bill `goods_value = 0`, `no_declared_value = false` (user thực sự không nhập giá trị nhưng vẫn khai)
- **WHEN** admin mở bill để sửa
- **THEN** checkbox "Không khai giá trị" KHÔNG được tick

### Requirement: Resolve khách hàng — 1 helper duy nhất, match combo

3 đường code (`executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`) SHALL dùng chung 1 helper `resolveOrCreateClient({ fullname, phone, isReceiver, isHomeDelivery, deliveryAddress })`.

Logic match:
- Match key = combo `(LOWER(fullname), phone_number)` trong `client_phones` JOIN `clients` (chỉ xét `is_delete = false`).
- Match được → trả `clientId`, `phoneId` cũ. KHÔNG update `clients.fullname`, `clients.is_blacklist`, `clients.blacklist_reason`. KHÔNG đụng `client_phones`. CÓ THỂ update `clients.address` theo rule N-13 (xem spec `customer-management`).
- Không match → INSERT mới vào `clients` + `client_phones`.
- **N-12**: nếu `phone` rỗng/trắng → KHÔNG insert vào `clients`/`client_phones`. Trả `clientId = null`, `phoneId = null`.

#### Scenario: Tên trùng khác SĐT — tạo khách mới

- **GIVEN** đã tồn tại khách "Trần A" với SĐT 0909-A
- **WHEN** user tạo bill mới với sender "Trần A" SĐT 0909-B
- **THEN** `resolveOrCreateClient` KHÔNG match khách cũ
- **AND** tạo client mới + phone mới
- **AND** toast hiển thị "Đã lưu khách mới Trần A vào danh sách khách hàng"

#### Scenario: SĐT trùng khác tên — tạo khách mới

- **GIVEN** đã tồn tại khách "Lê Bê" với SĐT 0909-C
- **WHEN** user tạo bill với receiver "Lê B" SĐT 0909-C
- **THEN** `resolveOrCreateClient` KHÔNG match (vì tên khác)
- **AND** tạo client "Lê B" mới + phone mới (kết quả: 2 client cùng SĐT trong DB)

> Note kỹ thuật: case này gây dữ liệu rác. Sẽ được clean ở change về Quản Lý Khách Hàng (out of scope ở đây).

#### Scenario: Khách không SĐT — không tạo client

- **WHEN** user tạo bill với sender "Nguyễn X" + để trống SĐT
- **THEN** `bills.sender_id = NULL`, `bills.sender_phone_id = NULL`
- **AND** KHÔNG có row mới trong `clients` / `client_phones`
- **AND** `bills.sender_name_text = "Nguyễn X"` (snapshot)

### Requirement: Admin/boss sửa được đơn pending — popup confirm liệt kê field đổi

Admin SHALL sửa được toàn bộ form intake cho bill có `delivery_status = "pending"` + `payment_status ∈ {unpaid, free, quote_later}`. Member MUST KHÔNG sửa được. Boss đối xử như admin nhưng không thấy nút "Tạo Đơn" (block tab).

Khi bấm Lưu trên form sửa:
1. Compute diff giữa state hiện tại và snapshot lúc mở form.
2. Hiển thị modal liệt kê các field đã đổi (tên hiển thị tiếng Việt, format giá trị).
3. OK → UPDATE bills + toast "Đã cập nhật đơn <bill_code>".
4. Cancel → giữ nguyên form, không submit.

Guardrails:
- `bill_code` MUST readonly (input disabled).
- `branch_id` MUST readonly khi bill đã có `bill_code` (mọi case admin sửa đều thoả).
- Đổi `senderName`/`receiverName`/`senderPhone`/`receiverPhone` → re-resolve qua `resolveOrCreateClient()` (có thể tạo client mới).
- Đổi `payment_status` → CHỈ persist lên `bills`, KHÔNG sync `bill_payment_details` ở change này.

#### Scenario: Admin sửa cước cho đơn báo-giá-sau

- **GIVEN** đơn `05SGA02` đang `pending` + `quote_later` với `shipping_fee = 0`
- **WHEN** admin mở đơn, nhập `shippingFee = 250000`, tick `isPaidImmediately`, bấm Lưu
- **THEN** modal hiện:
  ```
  Bạn vừa thay đổi các thông tin:
  • Cước phí: 0 → 250,000
  • Trạng thái thanh toán: Báo giá sau → Đã thanh toán
  ```
- **WHEN** admin bấm OK
- **THEN** `bills.shipping_fee = 250000`, `bills.payment_status = "paid"`, `bill_code` giữ `05SGA02`, `delivery_status` giữ `pending`

#### Scenario: Admin huỷ trong popup

- **WHEN** modal hiển thị diff, admin bấm Cancel
- **THEN** form vẫn ở state đã sửa (không revert), không UPDATE DB

#### Scenario: Bill_code readonly

- **GIVEN** admin đang ở form sửa bill `05SGA02`
- **WHEN** admin cố nhập gì vào field `bill_code`
- **THEN** input không nhận input (disabled)

## ADDED Requirements

### Requirement: Branch selector theo role

`currentBranch` trên form intake SHALL được điều khiển theo role:
- `member` → readonly, lock theo `loggedBranch` (lấy từ session).
- `admin` → hiển thị `<select>` cho phép chọn SG / GL, default = `loggedBranch`.
- `boss` → KHÔNG được vào tab tạo đơn; hiển thị thông báo "Boss không tạo đơn".

#### Scenario: Member ở SG mở form

- **GIVEN** user role = `member`, `loggedBranch = "SG"`
- **WHEN** mở form tạo đơn
- **THEN** field branch hiển thị "Sài Gòn (SG)" readonly, không click được

#### Scenario: Admin chọn branch GL

- **GIVEN** user role = `admin`, `loggedBranch = "SG"`
- **WHEN** admin mở form, đổi branch sang GL
- **THEN** `currentBranch = "GL"`, `reserveBillCode` query counter của GL
- **AND** khi submit, `bills.branch_id` lưu GL

#### Scenario: Boss vào tab Tạo Đơn

- **GIVEN** user role = `boss`
- **WHEN** mở tab tạo đơn
- **THEN** hiển thị "Boss không có quyền tạo đơn. Vui lòng xem chi tiết qua các tab khác."

### Requirement: Ngày gửi override + Ngày có hàng dự kiến derived

Form intake SHALL có 2 date field:

1. **Ngày gửi** (`sendDate`):
   - Default = `session.business_date` (fetch từ `branch_sessions` — change `add-server-session`).
   - `admin` → editable (cho phép backdate hoặc forward-date).
   - `member` → readonly.
   - Persist vào `bills.business_date`.

2. **Ngày có hàng dự kiến** (`expectedDeliveryDate`):
   - Derived = `sendDate + 1 ngày` (tính trên UI).
   - Readonly cho mọi role.
   - Tự cập nhật khi `sendDate` thay đổi.
   - KHÔNG persist vào DB.
   - Hiển thị trên form và bill in.

> Phụ thuộc: change `add-server-session` cung cấp bảng `branch_sessions` + cột `bills.business_date`.

#### Scenario: Member tạo đơn — Ngày gửi readonly = session

- **GIVEN** `session.businessDate = "2026-07-01"` (đã Xuất Bến hôm 30/6)
- **WHEN** member mở form
- **THEN** field "Ngày gửi" hiển thị `01/07/2026` readonly
- **AND** field "Ngày có hàng dự kiến" hiển thị `02/07/2026` readonly

#### Scenario: Admin backdate

- **GIVEN** `session.businessDate = "2026-07-01"`
- **WHEN** admin đổi "Ngày gửi" thành `28/06/2026`
- **THEN** "Ngày có hàng dự kiến" tự đổi thành `29/06/2026`
- **AND** khi submit, `bills.business_date = "2026-06-28"`
- **AND** mã đơn vẫn dùng counter của session hiện tại (không bị ảnh hưởng bởi sendDate backdate)

### Requirement: Bill snapshot columns cho tên/SĐT người gửi/nhận

`bills` SHALL có 4 cột snapshot:
- `sender_name_text` TEXT NOT NULL
- `sender_phone_text` TEXT NULL
- `receiver_name_text` TEXT NOT NULL
- `receiver_phone_text` TEXT NULL

3 đường code (`executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`) SHALL ghi 4 cột này theo giá trị `senderName`/`senderPhone`/`receiverName`/`receiverPhone` user nhập.

4 cột snapshot là **source of truth** cho mọi UI hiển thị bill (list, detail, preview, bill in PDF). Code render bill KHÔNG được JOIN `clients`/`client_phones` để lấy tên hoặc SĐT.

FK `sender_id`/`receiver_id`/`sender_phone_id`/`receiver_phone_id` CHỈ dùng cho autocomplete khi tạo đơn mới, KHÔNG dùng để render.

#### Scenario: Tạo bill — snapshot trùng input

- **WHEN** user tạo bill với sender "Trần A" SĐT "0909000111"
- **THEN** `bills.sender_name_text = "Trần A"`, `bills.sender_phone_text = "0909000111"`

#### Scenario: Render bill cũ sau khi đổi tên khách

- **GIVEN** bill cũ `sender_name_text = "Trần A"`, `sender_id = 123`
- **AND** admin đổi `clients.fullname` của khách 123 thành "Trần Anh"
- **WHEN** render bill cũ
- **THEN** vẫn hiển thị "Trần A" (snapshot, không bị ảnh hưởng)

#### Scenario: Bill không có sender phone

- **WHEN** user tạo bill với sender "Nguyễn X", SĐT trống
- **THEN** `bills.sender_id = NULL`, `bills.sender_phone_id = NULL`
- **AND** `bills.sender_name_text = "Nguyễn X"`, `bills.sender_phone_text = NULL`
- **AND** UI render bill vẫn hiển thị "Nguyễn X" (không bị mất tên dù không có FK)
