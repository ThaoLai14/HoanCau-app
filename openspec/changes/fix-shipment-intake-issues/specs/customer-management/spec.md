# Delta: customer-management (fix-shipment-intake-issues)

> Áp dụng I-6 (intake không sửa khách cũ) + N-12 (không SĐT → không tạo client) + N-13 (address là exception) cho capability `customer-management`.

## ADDED Requirements

### Requirement: Form intake KHÔNG được sửa dữ liệu khách cũ (trừ address)

Quy trình Tạo Đơn (`executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`) SHALL chỉ có 2 hành vi với `clients` và `client_phones`:

1. **Tìm và dùng lại** khách cũ nếu combo `(LOWER(fullname), phone_number)` khớp 1 row trong `clients` join `client_phones` (loại `is_delete = true`).
2. **Tạo khách mới** (insert `clients` + insert `client_phones`) nếu không match và có cả `fullname` + `phone` (xem requirement "Không tạo client nếu không có SĐT").

Form intake MUST KHÔNG bao giờ chạy UPDATE/DELETE lên các field sau của khách cũ:
- `clients.fullname`
- `clients.is_blacklist`, `clients.blacklist_reason`
- `clients.is_delete`
- Row `client_phones` (không UPDATE, không DELETE, không INSERT thêm SĐT cho khách cũ).

**Exception (N-13)**: `clients.address` của khách cũ CÓ THỂ được UPDATE qua intake — xem requirement riêng "Address là exception".

Mọi việc sửa các field bị cấm trên SHALL chỉ được thực hiện qua tab Quản Lý Khách Hàng bởi role `admin`.

> Lý do: tách rõ ownership giữa flow Tạo Đơn (chỉ tham chiếu) và flow Quản Lý Khách Hàng (chịu trách nhiệm sửa metadata khách). Address được phép update qua intake vì nó là dữ liệu giao hàng có giá trị nghiệp vụ cao, thay đổi tự nhiên theo từng lần khách yêu cầu giao địa chỉ khác.

#### Scenario: Khách cũ — không đổi fullname dù user gõ khác

- **GIVEN** khách `clients.fullname = "Trần A"` SĐT `"0909-A"` (match được)
- **WHEN** nhân viên gõ `senderName = "Trần Anh"` (dấu khác hoa thường khác) + SĐT `"0909-A"`
- **THEN** combo match được vì `LOWER("Trần Anh") != LOWER("Trần A")` → KHÔNG match → tạo client mới "Trần Anh"
- **AND** khách cũ "Trần A" KHÔNG bị đổi tên thành "Trần Anh"

> Note: ví dụ trên thực tế là không match nên không có conflict. Trường hợp combo khớp đúng → dùng client cũ, name không đổi.

#### Scenario: Khách cũ trong blacklist — không tự bỏ blacklist

- **GIVEN** khách "Lê C" có `is_blacklist = true`, `blacklist_reason = "khất cước"`
- **WHEN** nhân viên tạo đơn với "Lê C" (match được) — bỏ qua cảnh báo
- **THEN** `is_blacklist` và `blacklist_reason` KHÔNG đổi
- **AND** bill được tạo bình thường (cảnh báo blacklist là warning-only)

#### Scenario: Khách cũ — không thêm SĐT phụ qua intake

- **GIVEN** khách "Lê B" có 1 row `client_phones` với `"0909-B"`
- **WHEN** nhân viên tạo đơn với sender "Lê B" + SĐT mới `"0909-X"`
- **THEN** combo `(lê b, 0909-X)` KHÔNG match khách cũ → tạo MỚI client "Lê B" (client thứ 2 cùng tên)
- **AND** insert `client_phones` mới với `"0909-X"` cho client thứ 2
- **AND** khách cũ "Lê B" giữ nguyên 1 phone `"0909-B"`

### Requirement: Address là exception — được update qua intake

Khi `resolveOrCreateClient()` match được khách cũ AND `isReceiver = true` AND `isHomeDelivery = true` AND `deliveryAddress` (đã trim) KHÔNG rỗng AND khác `clients.address` cũ, hệ thống SHALL UPDATE `clients.address = deliveryAddress` (silent — không hỏi user) và `bills.delivery_address` snapshot vẫn ghi giá trị user gõ.

Các trường hợp KHÁC: KHÔNG đụng `clients.address`:
- Khách match nhưng `isReceiver = false` (sender) — KHÔNG đụng.
- Khách match nhưng `isHomeDelivery = false` — KHÔNG đụng.
- Khách match nhưng `deliveryAddress` rỗng — KHÔNG đụng.
- Khách match và `deliveryAddress` trùng `clients.address` — không có gì để làm.

Khi khách mới + receiver + `isHomeDelivery = true`: `clients.address = deliveryAddress` (insert mới — đã cover trong requirement chính).
Khi khách mới + sender: `clients.address = ""` (sender không có address).

> Rủi ro: admin gõ nhầm địa chỉ → khách cũ bị ghi đè silent. Chấp nhận trade-off này.

#### Scenario: Receiver match khách cũ + địa chỉ mới — auto update

- **GIVEN** khách "Trần A" SĐT `"0909-A"` có `clients.address = "10 Lê Lợi"`
- **WHEN** nhân viên tạo đơn với receiver "Trần A" SĐT `"0909-A"` + `isHomeDelivery = true` + `deliveryAddress = "999 Nguyễn Huệ"`
- **THEN** `clients.address` của "Trần A" được UPDATE thành `"999 Nguyễn Huệ"`
- **AND** `bills.delivery_address = "999 Nguyễn Huệ"`

#### Scenario: Sender match khách cũ + isHomeDelivery = true — KHÔNG đụng address của sender

- **GIVEN** khách "Trần A" có `clients.address = "10 Lê Lợi"`
- **WHEN** nhân viên tạo đơn với sender "Trần A" (match được) + `isHomeDelivery = true` + `deliveryAddress = "999 Nguyễn Huệ"` (đây là địa chỉ giao cho receiver)
- **THEN** `clients.address` của sender "Trần A" GIỮ NGUYÊN `"10 Lê Lợi"`
- **AND** chỉ địa chỉ của receiver mới được xét cập nhật

#### Scenario: Receiver match + isHomeDelivery = false — không động address

- **GIVEN** khách "Vũ D" có `clients.address = "5 Cách Mạng"`
- **WHEN** nhân viên tạo đơn với receiver "Vũ D" (match được) + `isHomeDelivery = false`
- **THEN** `clients.address` GIỮ NGUYÊN `"5 Cách Mạng"`

#### Scenario: Receiver match + địa chỉ trùng — không UPDATE

- **GIVEN** khách "Phạm E" có `clients.address = "20 Hai Bà Trưng"`
- **WHEN** nhân viên tạo đơn với receiver "Phạm E" + `isHomeDelivery = true` + `deliveryAddress = "20 Hai Bà Trưng"`
- **THEN** KHÔNG có request UPDATE lên `clients.address` (không cần thiết)

#### Scenario: Receiver match + deliveryAddress rỗng — KHÔNG xoá address cũ

- **GIVEN** khách "Phạm E" có `clients.address = "20 Hai Bà Trưng"`
- **WHEN** nhân viên tạo đơn với receiver "Phạm E" + `isHomeDelivery = true` + `deliveryAddress = ""` (user xoá rỗng — về lý là invalid vì isHomeDelivery = true required address)
- **THEN** form validation chặn submit (theo rule isHomeDelivery)
- **AND** nếu vì lý do nào đó vẫn lọt qua → KHÔNG xoá `clients.address` cũ

### Requirement: KHÔNG tạo client nếu không có SĐT

Khi `resolveOrCreateClient()` được gọi với `phone` rỗng/trắng, hệ thống MUST KHÔNG insert vào `clients` và MUST KHÔNG insert vào `client_phones`. Áp dụng cho cả sender lẫn receiver.

Chi tiết hành vi:

- KHÔNG insert vào `clients`.
- KHÔNG insert vào `client_phones`.
- Trả về `{ clientId: null, phoneId: null }`.
- `bills.sender_id` (hoặc `receiver_id`) được set NULL.
- `bills.sender_phone_id` (hoặc `receiver_phone_id`) được set NULL.
- `bills.sender_name_text` (hoặc `receiver_name_text`) vẫn được lưu = tên user gõ (snapshot — xem spec `shipment-intake`).

Lý do: khách không có SĐT không thể search/tra cứu/liên hệ → tạo row trong `clients` chỉ làm rác DB. Bill cần lưu được tên người để in chứng từ → dùng snapshot column thay vì FK.

#### Scenario: Tạo bill — receiver không SĐT

- **WHEN** user tạo bill với receiver "Nguyễn Z" + SĐT trống + `isHomeDelivery = false`
- **THEN** `bills.receiver_id = NULL`, `bills.receiver_phone_id = NULL`
- **AND** KHÔNG có row mới trong `clients` / `client_phones`
- **AND** `bills.receiver_name_text = "Nguyễn Z"`, `bills.receiver_phone_text = NULL`

#### Scenario: Tạo bill — receiver không SĐT + isHomeDelivery = true

- **WHEN** user tạo bill với receiver "Nguyễn Z" + SĐT trống + `isHomeDelivery = true` + `deliveryAddress = "5 Hùng Vương"`
- **THEN** form được phép submit (address required là theo `isHomeDelivery`, phone không required)
- **AND** `bills.receiver_id = NULL`, `bills.delivery_address = "5 Hùng Vương"`
- **AND** KHÔNG insert `clients` cho "Nguyễn Z"
- **AND** `clients.address` không được tạo (vì client không được tạo)

#### Scenario: Khách mới có SĐT — tạo client như cũ

- **WHEN** user tạo bill với receiver "Trần Mới" SĐT `"0909-NEW"`, không match
- **THEN** INSERT `clients` mới + INSERT `client_phones` mới
- **AND** `bills.receiver_id` và `bills.receiver_phone_id` trỏ tới các row vừa insert
- **AND** toast "Đã lưu khách mới Trần Mới vào danh sách khách hàng"

### Requirement: Tạo khách mới qua intake hiện toast thông báo

Khi quy trình Tạo Đơn tạo client mới (vì combo không match và có cả `fullname` + `phone`), hệ thống SHALL hiển thị toast `"Đã lưu khách mới <tên> vào danh sách khách hàng"` ngay sau khi submit thành công.

Quy tắc:
- Toast hiện cho cả sender lẫn receiver nếu cả 2 đều là khách mới.
- Toast KHÔNG hiện khi resolve dùng được khách cũ.
- Toast KHÔNG hiện khi `phone` rỗng (không tạo client, không có gì để toast).
- Toast chỉ hiện sau khi insert thành công vào `clients`.

#### Scenario: Đơn mới — cả sender và receiver đều mới có SĐT

- **WHEN** user tạo đơn với sender "Phạm C" + SĐT mới, receiver "Vũ D" + SĐT mới, submit thành công
- **THEN** hiển thị toast `"Đã lưu khách mới Phạm C vào danh sách khách hàng"` và `"Đã lưu khách mới Vũ D vào danh sách khách hàng"`

#### Scenario: Đơn mới — sender cũ, receiver mới

- **WHEN** sender match khách cũ, receiver "Vũ E" + SĐT mới
- **THEN** chỉ hiển thị toast cho "Vũ E"

#### Scenario: Cả 2 đều cũ — không toast

- **WHEN** cả sender và receiver đều match khách cũ
- **THEN** KHÔNG hiển thị toast "đã lưu khách mới"

#### Scenario: Sender không SĐT — không toast

- **WHEN** user tạo đơn với sender "Nguyễn Z" SĐT trống, receiver match khách cũ
- **THEN** KHÔNG hiển thị toast (không có client mới được tạo)
