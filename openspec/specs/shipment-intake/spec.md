# Capability: Shipment Intake

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (form Tạo Đơn, các hàm `handleStartCreateBill`, `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`).
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng.

## Purpose

Cho phép nhân viên nhập 1 phiếu gửi hàng mới (sender, receiver, hàng hóa, cước, các flag rủi ro) và lưu xuống DB. Hỗ trợ lưu nháp để hoàn thiện sau.

## Domain model

Cột `bills` được ghi tại bước intake:
- `bill_code` (NULL nếu draft, có giá trị nếu pending)
- `branch_id`, `sender_id`, `sender_phone_id`, `receiver_id`, `receiver_phone_id`
- `goods_type`, `goods_value`, `package_count`, `shipping_fee`, `special_stars`
- `is_home_delivery`, `delivery_address`
- `payment_status` ∈ {`paid`, `unpaid`, `free`}
- `delivery_status` ∈ {`pending`, `draft`}
- `require_id_check`
- `self_packed`, `risk_warning`, `no_declared_value`, `export_vat`
- `order_note`, `goods_location` = `"out"` (default lúc intake)
- `created_by`, `created_at` (Postgres default `now()`)

## Requirements

### Requirement: Trường bắt buộc tối thiểu khi submit
Form tạo đơn SHALL yêu cầu tối thiểu họ tên người gửi, họ tên người nhận, loại hàng, số kiện ≥ 1.

Các trường khác có quy tắc riêng theo tổ hợp flag (xem các requirement dưới).

#### Scenario: Submit thiếu tên người gửi
- **WHEN** user bấm Lưu mà thiếu `senderName`
- **THEN** hệ thống hiển thị toast lỗi "Vui lòng nhập tên người gửi và người nhận!" và KHÔNG gửi request

#### Scenario: Submit `package_count = 0`
- **WHEN** user nhập số kiện = 0 hoặc để trống
- **THEN** hệ thống hiển thị toast lỗi "Vui lòng nhập số kiện hàng (tối thiểu 1)!"

### Requirement: Cước phí và các flag thanh toán loại trừ nhau
Cước phí SHALL bắt buộc TRỪ KHI đơn là "miễn phí" (`isFreeShipping`) hoặc "báo giá sau" (`feeQuoteLater`). Ba checkbox `isFreeShipping`, `feeQuoteLater`, `isPaidImmediately` MUST loại trừ nhau ở UI.

#### Scenario: Đơn thường, không nhập cước
- **WHEN** `isFreeShipping = false` và `feeQuoteLater = false` và `shippingFee` trống
- **THEN** form không submit, toast "Vui lòng nhập cước phí!"

#### Scenario: Đơn miễn phí
- **WHEN** `isFreeShipping = true`
- **THEN** `payment_status = "free"`, `shipping_fee = 0` được ghi vào DB
- **AND** KHÔNG insert row vào `bill_payment_details`

#### Scenario: Báo giá sau
- **WHEN** `feeQuoteLater = true`
- **THEN** `payment_status = "unpaid"`, `shipping_fee = 0` được ghi vào DB
- **AND** đơn này có thể được admin sửa lại sau (vẫn pending + unpaid) để điền cước

> Ghi chú: "Báo giá sau" KHÔNG được lưu thành 1 cột riêng. Hệ thống re-derive flag này từ `shipping_fee == 0 && payment_status == "unpaid"`.

#### Scenario: Thanh toán ngay
- **WHEN** `isPaidImmediately = true` và `shippingFee = 200000`
- **THEN** `bills.payment_status = "paid"`, `bills.shipping_fee = 200000`
- **AND** insert 1 row `bill_payment_details(bill_id, amount_paid = 200000, branch_id)`

### Requirement: delivery_address phụ thuộc isHomeDelivery
Khi `isHomeDelivery = true` thì `deliveryAddress` SHALL bắt buộc và được ghi vào `bills.delivery_address`. Khi `isHomeDelivery = false` thì `delivery_address` MUST = NULL bất kể UI có nhập gì.

#### Scenario: Giao tận nơi, thiếu địa chỉ
- **WHEN** `isHomeDelivery = true` và `deliveryAddress` trống
- **THEN** form không submit, toast "Vui lòng nhập địa chỉ giao hàng!"

#### Scenario: Không giao tận nơi
- **WHEN** `isHomeDelivery = false`
- **THEN** `bills.delivery_address = NULL` dù `deliveryAddress` có giá trị

### Requirement: special_stars auto-derive từ goodsValue
`special_stars` SHALL tự derive từ `goodsValue` theo ngưỡng: ≥10M → 2 sao, ≥5M → 1 sao, else → 0; user MAY override tay.

Khi user chọn tay (set `starsManual = true`), auto-derivation tắt cho lần submit hiện tại.

#### Scenario: Hàng có giá trị 12 triệu
- **WHEN** user nhập `goodsValue = 12000000`, không can thiệp sao
- **THEN** `special_stars = 2` được ghi vào DB

#### Scenario: Override tay xuống 0 sao
- **WHEN** user nhập `goodsValue = 12000000` rồi tự chọn `0 sao`
- **THEN** `special_stars = 0` được ghi vào DB

### Requirement: no_declared_value ép giá trị về 0
Khi `no_declared_value = true`, hệ thống SHALL ép `goods_value = 0` và `special_stars = 0` bất kể user nhập gì.

#### Scenario: Không khai giá trị
- **WHEN** `noDeclaredValue = true` (kể cả user có nhập `goodsValue = 8000000` trước đó)
- **THEN** `bills.goods_value = 0`, `bills.special_stars = 0`, `bills.no_declared_value = true`

### Requirement: Ghi chú đơn hàng — required khi có CCCD, ẩn khi in

Form intake CHỈ có 1 ô textarea "Ghi chú" (`order_note`), KHÔNG có ô riêng cho CCCD hay VAT. Thông tin CCCD SHALL được nhập chung vào `order_note`. Thông tin VAT không bắt buộc nhập vào ghi chú vì thực tế khách gửi thông tin/ảnh qua Zalo cho staff.

Ô "Ghi chú" SHALL trở thành **required** CHỈ khi `require_id_check = true`. Trong các trường hợp khác (kể cả khi `export_vat = true`), ghi chú giữ nguyên optional.

Placeholder của ô ghi chú SHALL đổi tuỳ theo checkbox:
- `require_id_check = true` → hint nhập số CCCD + tên người đối chiếu.
- Còn lại → "Nhập ghi chú tuỳ ý cho đơn hàng...".

Khi **in bill**, dòng "Ghi chú" trong section "Lưu ý" SHALL bị **ẩn** CHỈ khi `require_id_check = true` (thông tin nhạy cảm về nhân thân). Với các case còn lại (bao gồm `export_vat = true` không có CCCD), dòng "Ghi chú" hiển thị bình thường nếu có nội dung. Dòng "Yêu cầu xuất hóa đơn VAT" và "Yêu cầu cung cấp CCCD khi nhận hàng" vẫn hiện như flag báo cho staff.

Khi **mở lại bill để xem chi tiết** (bill detail view), section warning "⚠️ Đơn hàng đặc biệt — Yêu cầu xuất trình CCCD" SHALL vẫn hiển thị khi `require_id_check = true`, với nội dung đọc từ `order_note`.

Cột DB `bills.expected_id_info` đã bị DROP. Mọi thông tin CCCD lưu trực tiếp vào `order_note`.

#### Scenario: Check CCCD → ghi chú trở thành required
- **GIVEN** form intake đang mở, ghi chú trống, không check checkbox nào
- **WHEN** user bấm check `⚠️ YÊU CẦU ĐỐI CHIẾU CCCD KHI NHẬN HÀNG`
- **THEN** label ghi chú hiển thị dấu `*` (required)
- **AND** placeholder đổi thành hint nhập số CCCD + họ tên người đối chiếu

#### Scenario: Check VAT → ghi chú vẫn optional
- **GIVEN** form intake, ghi chú trống, chưa check gì
- **WHEN** user bấm check `Xuất hóa đơn VAT`
- **THEN** label ghi chú KHÔNG có dấu `*` (vẫn optional)
- **AND** placeholder giữ nguyên "Nhập ghi chú tuỳ ý..."

#### Scenario: Submit không có ghi chú khi CCCD được check → block
- **GIVEN** `requireIdCheck = true`, `orderNote = ""`
- **WHEN** user bấm Submit
- **THEN** hiển thị toast "Vui lòng nhập thông tin CCCD vào ô Ghi chú!"
- **AND** KHÔNG insert bill

#### Scenario: Submit không ghi chú khi CHỈ có VAT → OK
- **GIVEN** `requireIdCheck = false`, `exportVat = true`, `orderNote = ""`
- **WHEN** user bấm Submit
- **THEN** bill được tạo bình thường với `order_note = NULL`

#### Scenario: Bill với CCCD, ghi chú KHÔNG in ra phiếu
- **GIVEN** bill có `require_id_check = true`, `order_note = "CCCD: 012345678, Nguyễn Văn A"`, các cờ khác false
- **WHEN** user xem preview in bill
- **THEN** section "Lưu ý" hiện dòng "Yêu cầu cung cấp CCCD khi nhận hàng"
- **AND** KHÔNG hiện dòng "Ghi chú: CCCD: 012345678, Nguyễn Văn A" (ẩn thông tin nhạy cảm)

#### Scenario: Bill với VAT có ghi chú → in bình thường
- **GIVEN** bill có `export_vat = true`, `require_id_check = false`, `order_note = "Giao trước 10h"`
- **WHEN** in bill
- **THEN** hiện dòng "Yêu cầu xuất hóa đơn VAT"
- **AND** hiện dòng "Ghi chú: Giao trước 10h"

#### Scenario: Bill không có VAT/CCCD, có ghi chú → in bình thường
- **GIVEN** bill có `require_id_check = false`, `export_vat = false`, `order_note = "Giao buổi sáng"`
- **WHEN** in bill
- **THEN** hiện dòng "Ghi chú: Giao buổi sáng" trong section Lưu ý

#### Scenario: Bill detail view — warning CCCD vẫn xuất hiện
- **GIVEN** bill có `require_id_check = true`, `order_note = "CCCD 012, Nguyễn A"`
- **WHEN** user mở bill detail
- **THEN** section warning "⚠️ Đơn hàng đặc biệt — Yêu cầu xuất trình CCCD" hiển thị nội dung `"CCCD 012, Nguyễn A"` (đọc từ `order_note`)

### Requirement: Lưu nháp chỉ cần tên sender/receiver
Lưu nháp SHALL chỉ yêu cầu họ tên người gửi và họ tên người nhận; các trường khác MAY trống.

Draft có `bill_code = NULL`, `delivery_status = "draft"`.

`shipping_fee` khi lưu nháp SHALL lưu `NULL` nếu user để trống ô cước, KHÔNG lưu `0`. Lưu `0` chỉ khi user tick `isFreeShipping` hoặc `feeQuoteLater`. Lý do: nếu lưu `0` cho draft trống, khi mở lại để convert draft → pending, ô cước sẽ hiển thị "0" → validation `!shippingFee` xem "0" là truthy → skip → bill được submit với cước 0 nhầm.

Khi mở lại 1 draft có `shipping_fee IS NULL OR shipping_fee = 0` VÀ `payment_status NOT IN ('free','quote_later')`, form SHALL hiển thị ô Cước phí **trống** để buộc user nhập lại trước khi convert.

#### Scenario: Lưu nháp tối giản
- **WHEN** user nhập `senderName` + `receiverName`, bấm "Lưu nháp"
- **THEN** insert bill với `delivery_status = "draft"`, `bill_code = NULL`, các field khác ghi theo giá trị form hiện tại
- **AND** `shipping_fee = NULL` (nếu user không nhập cước và không tick miễn phí/báo giá sau)

#### Scenario: Convert draft trống cước → block
- **GIVEN** draft có `shipping_fee = NULL`, `payment_status = "unpaid"`
- **WHEN** user mở draft, KHÔNG nhập cước, KHÔNG tick miễn phí/báo giá sau, bấm Submit
- **THEN** toast "Vui lòng nhập cước phí!" hiển thị
- **AND** KHÔNG update DB

#### Scenario: Reopen draft báo giá sau
- **GIVEN** draft có `shipping_fee = 0`, `payment_status = "quote_later"`
- **WHEN** user mở draft
- **THEN** ô Cước phí trống, checkbox "Báo giá sau" tick sẵn
- **AND** user có thể convert draft → pending mà không cần nhập cước

### Requirement: Resolve khách hàng không nhất quán giữa 3 đường code
Hệ thống MUST được coi là đang resolve khách hàng theo cách KHÔNG nhất quán giữa 3 đường code.

Quan sát được 3 logic match khác nhau khi xử lý sender/receiver:

| Đường | Hàm | Logic match |
|---|---|---|
| Tạo đơn mới | `executeCreateBill` | `ilike(fullname)` + check phone trong `client_phones` của các match → match cả **tên + SĐT** |
| Update draft | `executeUpdateDraft` | `eq(phone_number)` → match **chỉ SĐT** (lấy `client_id` từ phone) |
| Convert draft → pending | `executeConvertDraftToBill` | `eq(phone_number)` → match **chỉ SĐT** |

> ⚠️ **Cần anh confirm**: đây là intended design (vì draft đã có context, không sợ trùng tên) hay là bug phải đồng nhất?

#### Scenario: Tạo đơn mới — khách trùng tên khác SĐT
- **WHEN** đã tồn tại khách "Trần A" với SĐT 0909-A
- **AND** user nhập sender "Trần A" với SĐT 0909-B
- **THEN** `executeCreateBill` KHÔNG match khách cũ, tạo client mới + phone mới

#### Scenario: Convert draft — khách khác tên cùng SĐT
- **WHEN** draft có receiver "Lê B" với SĐT 0909-C
- **AND** đã tồn tại khách "Lê Bê" với SĐT 0909-C
- **WHEN** user convert draft thành pending
- **THEN** `executeConvertDraftToBill` match khách "Lê Bê" và dùng `client_id` đó, bỏ qua "Lê B"

### Requirement: Lưu address cho receiver mới khi giao tận nơi
Khi tạo khách mới qua intake, hệ thống SHALL lưu `clients.address` cho receiver nếu `isHomeDelivery = true`, bỏ trống nếu false. Sender MUST luôn được tạo với `address = ""`.

#### Scenario: Receiver mới, giao tận nơi
- **WHEN** `isHomeDelivery = true`, `deliveryAddress = "123 Trần Phú"`, receiver chưa có trong DB
- **THEN** `clients.address = "123 Trần Phú"` cho khách receiver mới

#### Scenario: Sender mới
- **WHEN** sender chưa có trong DB
- **THEN** `clients.address = ""` cho sender mới (bất kể isHomeDelivery)

### Requirement: Admin/boss sửa được đơn pending+unpaid
Admin và boss SHALL sửa được đơn pending+unpaid, giữ nguyên `bill_code` và `delivery_status = "pending"`. Member MUST KHÔNG được sửa đơn pending qua UI.

#### Scenario: Admin sửa cước cho đơn báo-giá-sau
- **GIVEN** đơn `05SGA02` đang `pending` + `unpaid` với `shipping_fee = 0` (báo giá sau)
- **WHEN** admin mở đơn, nhập `shippingFee = 250000`, bấm Lưu
- **THEN** `bills.shipping_fee = 250000`, `bill_code` giữ nguyên `05SGA02`, `delivery_status` giữ `pending`

### Requirement: Hủy đơn theo trạng thái
Hủy đơn SHALL bắt buộc nhập lý do. Cách hủy phụ thuộc trạng thái: draft → DELETE row (xóa cứng); pending → update `delivery_status = "cancelled"` và prepend lý do vào `order_note`.

> ⚠️ **Cần anh confirm**: cách "prepend lý do vào `order_note`" làm mất tính atomic. Có muốn tách cột `cancel_reason` riêng không?

#### Scenario: Hủy đơn nháp
- **WHEN** user mở 1 draft và bấm Hủy, nhập lý do "khách đổi ý"
- **THEN** row bị xóa cứng khỏi `bills`

#### Scenario: Hủy đơn pending
- **GIVEN** đơn pending có `order_note = "Khách yêu cầu giao buổi sáng"`
- **WHEN** user hủy với lý do "Hàng hỏng"
- **THEN** `delivery_status = "cancelled"`
- **AND** `order_note = "[LÝ DO HỦY]: Hàng hỏng\n\n[Ghi chú gốc]: Khách yêu cầu giao buổi sáng"`
- **AND** `bill_code` giữ nguyên
