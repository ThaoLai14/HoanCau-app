# Delta: shipment-intake (refine-shipment-intake-round-2)

> Round 2 tinh chỉnh flow intake theo review manual 2026-07-06. SUPERSEDES một số requirement từ `fix-shipment-intake-issues` (round 1) và base spec.
>
> Áp dụng sau khi round 1 archive.

## MODIFIED Requirements

### Requirement: Ngày gửi readonly — không backdate cho mọi role

Form intake SHALL có 2 date field:

1. **Ngày gửi** (`sendDate`):
   - Giá trị = `session.business_date` (fetch từ `branch_sessions`).
   - **Readonly cho MỌI role** (member, admin, boss) — không có backdate.
   - Persist vào `bills.business_date` tại thời điểm submit (re-fetch session trước submit).

2. **Ngày có hàng dự kiến** (`expectedDeliveryDate`):
   - Derived = `sendDate + 1 ngày` (tính trên UI).
   - Readonly cho mọi role.
   - Tự cập nhật khi `sendDate` thay đổi (chỉ đổi khi session flip qua Xuất Bến).
   - KHÔNG persist vào DB.
   - Hiển thị trên form và bill in.

**SUPERSEDES**: `fix-shipment-intake-issues §I-4 / N-1` phần "admin editable" — round 2 bỏ hoàn toàn.

#### Scenario: Member mở form — cả 2 field readonly

- **GIVEN** `session.businessDate = "2026-07-01"`
- **WHEN** member mở form intake
- **THEN** "Ngày gửi" hiển `01/07/2026` readonly (input disabled)
- **AND** "Ngày có hàng dự kiến" hiển `02/07/2026` readonly

#### Scenario: Admin mở form — cả 2 field readonly (không backdate được)

- **GIVEN** `session.businessDate = "2026-07-01"`
- **WHEN** admin mở form intake
- **THEN** "Ngày gửi" hiển `01/07/2026` readonly (không cho phép nhập/chọn ngày khác)
- **AND** admin không có UI để backdate/forward-date

#### Scenario: Session flip sau Xuất Bến

- **GIVEN** admin bấm Xuất Bến lúc 14:30 → session `business_date` flip từ `2026-07-01` sang `2026-07-02`
- **WHEN** member tạo đơn lúc 15:00 (vẫn ngày calendar 01/07)
- **THEN** "Ngày gửi" hiển `02/07/2026`, submit → `bills.business_date = '2026-07-02'`

### Requirement: Role gate mở rộng cho edit/cancel bill

Quyền sửa/hủy bill SHALL được điều khiển bởi 3 chiều: role + branch match + payment status. Frontend MUST enforce (disable/ẩn nút); backend RPC function MUST enforce lại (double check).

**Bảng quyền**:

| Role   | Điều kiện        | Sửa draft | Sửa pending (unpaid/free/quote_later) | Sửa pending (paid) | Hủy draft | Hủy pending |
|--------|------------------|:---------:|:--------------------------------------:|:------------------:|:---------:|:-----------:|
| member | cùng chi nhánh   |    ✅     |                  ✅                    |         ❌         |    ✅     |     ✅      |
| member | khác chi nhánh   |    ❌     |                  ❌                    |         ❌         |    ❌     |     ❌      |
| admin  | cùng chi nhánh   |    ✅     |                  ✅                    |         ❌         |    ✅     |     ✅      |
| admin  | khác chi nhánh   |    ❌     |                  ❌                    |         ❌         |    ❌     |     ❌      |
| boss   | mọi chi nhánh    |    ❌     |                  ❌                    |         ❌         |    ❌     |     ❌      |

Quy tắc chi tiết:
- "Cùng chi nhánh" = `bills.branch_id === session.branch_id`.
- Bill `paid` (`payment_status='paid'`) không sửa được. Nếu cần thay đổi → phải hủy (auto-refund qua expense) rồi tạo bill mới.
- Boss chỉ đọc trên toàn hệ thống. Nút "Sửa" và "Hủy" ẩn hoàn toàn.
- Frontend enforce (disable + ẩn nút). Backend enforce qua RPC function reject nếu điều kiện không thoả.
- Mọi mutation ghi audit_log với `actor_user_id = session.userId`, `actor_branch_id = session.branch_id`.

**SUPERSEDES**: `fix-shipment-intake-issues §N-4` (chỉ admin/boss sửa được → mở rộng cho member; boss thu hẹp lại chỉ đọc).

#### Scenario: Member sửa bill của mình (pending + unpaid)

- **GIVEN** member Trần A (SG) tạo bill `05SGA02` (pending + unpaid)
- **WHEN** member Trần A mở bill detail
- **THEN** nút "Sửa" và "Hủy" enable
- **AND** member sửa cước + tick paid → modal diff → OK → UPDATE thành công, audit_log ghi `bill_update`

#### Scenario: Member khác chi nhánh — không sửa

- **GIVEN** bill `05GLA01` của chi nhánh GL
- **WHEN** member SG (Trần A) mở bill detail
- **THEN** nút "Sửa" và "Hủy" disabled với tooltip "Chỉ sửa được bill của chi nhánh mình"

#### Scenario: Bill paid — không sửa

- **GIVEN** bill `05SGA02` (pending + paid, đã thu 250k)
- **WHEN** bất kỳ role nào (member/admin/boss) mở bill detail
- **THEN** nút "Sửa" disabled với tooltip "Bill đã thu tiền, muốn thay đổi vui lòng hủy đơn"
- **AND** nút "Hủy" vẫn enable (cho member/admin cùng chi nhánh)

#### Scenario: Boss — không có nút Sửa/Hủy

- **GIVEN** role = boss
- **WHEN** boss mở bill detail (bất kỳ chi nhánh, bất kỳ status)
- **THEN** nút "Sửa" và "Hủy" ẩn hoàn toàn (không disabled)
- **AND** RPC reject nếu boss cố gọi trực tiếp

#### Scenario: Admin cross-branch — chỉ đọc

- **GIVEN** admin login SG, mở bill `05GLA01` của GL
- **THEN** nút "Sửa" và "Hủy" disabled với tooltip "Không sửa được bill chi nhánh khác"
- **AND** admin vẫn tạo được bill mới cho GL từ form intake (giữ nguyên `fix §I-8`)

### Requirement: Hủy bill — soft delete cho draft, cancel cho pending, auto refund cho paid

Hủy bill SHALL yêu cầu nhập lý do (required, ≤ 200 ký tự). Cách hủy phụ thuộc trạng thái:

- **Draft** (`delivery_status='draft'`): UPDATE `is_delete=true` (soft delete). Row vẫn tồn tại trong DB, không hiển UI (filter `is_delete=false`).
- **Pending unpaid/free/quote_later**: UPDATE `delivery_status='cancelled'`. `bill_code`, `order_note` giữ nguyên.
- **Pending paid**: UPDATE `delivery_status='cancelled'` **VÀ** auto INSERT 1 row `expenses` với `amount = -actual_amount_paid` (refund). Xem delta `delivery-and-payment` cho chi tiết expense.

Lý do hủy MUST ghi vào `audit_log.diff.reason` (JSONB field). KHÔNG prepend vào `order_note`.

Toàn bộ mutation (bill + expense + audit_log) SHALL wrap trong 1 transaction Postgres qua RPC function (`cancel_bill_with_audit` hoặc `soft_delete_draft_with_audit` — xem delta `audit-log`).

**SUPERSEDES**: base `shipment-intake` §"Hủy đơn theo trạng thái" (draft DELETE cứng + pending prepend order_note).

#### Scenario: Hủy draft — soft delete

- **GIVEN** member mở 1 draft, bấm Hủy, nhập lý do "khách đổi ý"
- **WHEN** submit
- **THEN** UPDATE `bills.is_delete=true`, row VẪN CÒN trong DB
- **AND** INSERT audit_log `action='bill_draft_cancel'`, `diff.reason='khách đổi ý'`
- **AND** UI list nháp không còn hiển draft này (filter `is_delete=false`)
- **AND** `order_note` KHÔNG bị prepend gì cả

#### Scenario: Hủy pending unpaid

- **GIVEN** đơn `05SGA02` pending + unpaid, `order_note='Khách yêu cầu giao buổi sáng'`
- **WHEN** admin hủy với lý do "Hàng hỏng"
- **THEN** `delivery_status='cancelled'`
- **AND** `order_note='Khách yêu cầu giao buổi sáng'` (không đổi)
- **AND** `bill_code='05SGA02'` (giữ nguyên)
- **AND** audit_log ghi `action='bill_cancel'`, `diff.reason='Hàng hỏng'`

#### Scenario: Hủy pending paid — auto refund

- **GIVEN** đơn `05SGA02` pending + paid, `actual_amount_paid=250000`
- **WHEN** admin hủy với lý do "Khách trả hàng"
- **THEN** `delivery_status='cancelled'`
- **AND** INSERT `expenses(amount=-250000, source_bill=<bill_id>, note='Hoàn cước bill 05SGA02 do hủy đơn', created_by=<admin_id>)`
- **AND** INSERT audit_log 2 rows: `action='bill_cancel'` + `action='refund_created'`
- **AND** toast "Đã hủy đơn 05SGA02 và hoàn cước 250,000 VND"

#### Scenario: Hủy không nhập lý do

- **WHEN** user bấm OK trong modal Hủy mà không nhập lý do
- **THEN** modal chặn, hiển "Vui lòng nhập lý do hủy"

### Requirement: `order_note` conditional required 200 ký tự — bỏ `expected_id_info`

Cột `bills.expected_id_info` SHALL bị DROP. Thông tin CCCD hoặc thông tin xuất hóa đơn VAT được nhập trực tiếp vào `bills.order_note` với các rule sau.

Schema:
- `order_note` TEXT NULL với CHECK constraint `char_length(order_note) <= 200`.
- Client-side: input `maxLength=200` + counter "N/200".

UI logic (theo tổ hợp `require_id_check` + `export_vat`):

| require_id_check | export_vat | order_note   | placeholder / error message                   |
|:----------------:|:----------:|:------------:|-----------------------------------------------|
| false            | false      | optional     | "Ghi chú thêm nếu cần"                        |
| true             | false      | **required** | "Vui lòng nhập thông tin CCCD"                |
| false            | true       | **required** | "Vui lòng nhập thông tin xuất hóa đơn"        |
| true             | true       | **required** | "Vui lòng nhập thông tin CCCD, VAT"           |

Backfill migration: khi DROP `expected_id_info`, giá trị cũ append vào `order_note` với format `<order_note>\n<expected_id_info>`. Nếu tổng > 200 ký tự → truncate + log warning.

Bill preview (nút "Xem bill in") và biên nhận in giấy SHALL hiển thị `order_note` bao gồm phần CCCD/VAT khi có.

#### Scenario: Không tick flag nào — note optional

- **WHEN** user không tick CCCD, không tick VAT, để ghi chú trống, submit
- **THEN** OK, `order_note=NULL`

#### Scenario: Tick CCCD — note required, message CCCD

- **WHEN** user tick `require_id_check`, để ghi chú trống, submit
- **THEN** form chặn, error "Vui lòng nhập thông tin CCCD"

#### Scenario: Tick cả CCCD + VAT — message combined

- **WHEN** user tick cả 2, để ghi chú trống, submit
- **THEN** form chặn, error "Vui lòng nhập thông tin CCCD, VAT"
- **AND** placeholder input hiển "Vui lòng nhập thông tin CCCD, VAT"

#### Scenario: Note vượt 200 ký tự

- **WHEN** user paste 250 ký tự vào ô ghi chú
- **THEN** input tự truncate hoặc chặn nhập tại 200
- **AND** counter hiển "200/200"

#### Scenario: Migration DROP `expected_id_info`

- **GIVEN** bill cũ có `order_note='Giao sáng'`, `expected_id_info='CCCD 1234'`
- **WHEN** chạy migration
- **THEN** `order_note='Giao sáng\nCCCD 1234'`
- **AND** `expected_id_info` không còn tồn tại

#### Scenario: Migration truncate case

- **GIVEN** bill cũ có `order_note` 150 ký tự + `expected_id_info` 100 ký tự
- **WHEN** chạy migration → combined = 251 ký tự (dư 1 dấu newline)
- **THEN** `order_note` truncate về 200 ký tự
- **AND** log warning ghi lại bill_id + original length

### Requirement: Admin/member sửa bill pending — modal diff + no-change skip

Khi user (member hoặc admin, cùng chi nhánh, bill chưa paid) bấm Lưu trên form sửa, hệ thống SHALL:

1. Compute diff giữa state hiện tại và snapshot lúc mở form.
2. **Nếu diff RỖNG** → skip modal, KHÔNG UPDATE DB, toast "Không có thay đổi để lưu". Trả về (không mở modal).
3. Nếu có diff → hiển modal liệt kê các field đã đổi (label tiếng Việt, format giá trị).
4. OK → gọi RPC `update_bill_with_audit` → UPDATE bills + INSERT audit_log trong 1 transaction → toast "Đã cập nhật đơn <bill_code>".
5. Cancel → giữ nguyên form ở state đã sửa (không revert), KHÔNG UPDATE DB.

Guardrails MUST enforce:

- `bill_code` readonly.
- `branch_id` readonly khi bill đã có `bill_code`.
- `sendDate` readonly (do rule "không backdate" ở trên).
- Đổi `senderName/receiverName/senderPhone/receiverPhone` → re-resolve qua `resolveOrCreateClient()`.
- Đổi `payment_status` KHÔNG được đi từ `paid` sang trạng thái khác (bill paid không sửa — đã enforce ở role gate).

**MODIFIES**: `fix-shipment-intake-issues §N-4`. Thay đổi:
- Bổ sung "skip modal nếu no-change".
- Mở rộng cho member (không chỉ admin/boss).
- Ràng buộc branch match.

#### Scenario: No-change save — skip modal

- **GIVEN** admin mở bill sửa, không đổi field nào
- **WHEN** bấm Lưu
- **THEN** không hiển modal, không UPDATE DB
- **AND** toast "Không có thay đổi để lưu"

#### Scenario: Có diff — modal + UPDATE qua RPC

- **GIVEN** member mở bill `05SGA02` (quote_later), nhập cước 250k + tick paid
- **WHEN** bấm Lưu
- **THEN** modal hiện:
  ```
  Bạn vừa thay đổi các thông tin:
  • Cước phí: 0 → 250,000
  • Trạng thái thanh toán: Báo giá sau → Đã thanh toán
  ```
- **AND** OK → gọi RPC `update_bill_with_audit` → UPDATE bills + INSERT audit_log + INSERT bill_payment_details (do chuyển sang paid) trong 1 transaction

## ADDED Requirements

### Requirement: Auto-populate địa chỉ receiver từ DB lên form

Khi receiver được match qua autocomplete hoặc resolve (khớp combo tên + SĐT với 1 khách cũ trong DB), hệ thống SHALL populate `deliveryAddress` input theo `clients.address` của receiver:

- Nếu `clients.address` không rỗng → set `deliveryAddress` input = `clients.address`.
- Nếu `clients.address` rỗng → giữ input trống, chờ user nhập.
- Auto-populate CHỈ chạy khi tạo bill mới hoặc load draft. KHI LOAD bill cũ (đã có `bill_code`), input lấy từ `bills.delivery_address` (snapshot), KHÔNG từ `clients.address`.

Rule này ghép với write-back đã có ở `fix-shipment-intake-issues §N-13` để tạo flow đầy đủ: đọc DB → user sửa → ghi ngược lại DB.

#### Scenario: Match receiver cũ có address

- **GIVEN** khách "Lê Nhận" có `clients.address='10 Nguyễn Trãi'`
- **WHEN** nhân viên tạo bill mới, chọn "Lê Nhận" từ autocomplete, tick giao tận nơi
- **THEN** input `deliveryAddress` tự fill "10 Nguyễn Trãi"

#### Scenario: Match receiver cũ address rỗng

- **GIVEN** khách "Lê Nhận" có `clients.address=''`
- **WHEN** chọn "Lê Nhận" + tick giao tận nơi
- **THEN** input `deliveryAddress` trống, chờ user nhập
- **AND** khi submit với `deliveryAddress='5 Lê Lợi'` → `clients.address` update thành `'5 Lê Lợi'` (write-back lần đầu)

#### Scenario: User sửa autofill

- **GIVEN** receiver có `clients.address='10 Nguyễn Trãi'`, autofill vào input
- **WHEN** user sửa thành `'15 Nguyễn Trãi'`, submit
- **THEN** `bills.delivery_address='15 Nguyễn Trãi'` (snapshot)
- **AND** `clients.address` update thành `'15 Nguyễn Trãi'` (ghi đè theo N-13)

#### Scenario: Load bill cũ — dùng snapshot, không autofill từ clients

- **GIVEN** bill `05SGA02` có `delivery_address='10 Nguyễn Trãi'` (snapshot)
- **AND** admin sau đó đổi `clients.address` của receiver thành `'15 Nguyễn Trãi'` bên tab QLKH
- **WHEN** member mở bill `05SGA02` để sửa
- **THEN** input `deliveryAddress` hiển `'10 Nguyễn Trãi'` (từ snapshot bill, KHÔNG lấy `'15 Nguyễn Trãi'` từ clients)

### Requirement: Tick paid ở "Lưu nháp" → popup confirm chuyển sang "Lưu đơn"

Khi user tick `isPaidImmediately=true` VÀ bấm nút "Lưu nháp", hệ thống SHALL hiển thị popup confirm trước khi làm bất cứ gì:

- Tiêu đề: "Bill đã thanh toán là bill chính thức"
- Body: "Bill đã thanh toán là bill chính thức, không thể là nháp. Bạn muốn chuyển sang Lưu đơn?"
- 2 nút: `[Đồng ý]` `[Hủy]`

Hành vi:
- `[Đồng ý]` → chuyển sang flow "Lưu đơn" (enforce full validation, sinh `bill_code`, INSERT `bill_payment_details`).
- `[Hủy]` → đóng popup, giữ form nguyên state. User tự untick paid rồi Lưu nháp lại.

#### Scenario: Tick paid + bấm Lưu nháp

- **GIVEN** form intake, user đã điền sender + receiver + cước 200k, tick `isPaidImmediately`
- **WHEN** user bấm "Lưu nháp"
- **THEN** popup hiện với title "Bill đã thanh toán là bill chính thức"

#### Scenario: Đồng ý — chuyển sang Lưu đơn

- **WHEN** user bấm `[Đồng ý]` trong popup
- **THEN** hệ thống chạy flow Lưu đơn: validate đủ field bắt buộc, sinh `bill_code`, INSERT bill với `delivery_status='pending'`, `payment_status='paid'`, INSERT `bill_payment_details`

#### Scenario: Hủy — giữ form

- **WHEN** user bấm `[Hủy]` trong popup
- **THEN** popup đóng, form giữ nguyên state (kể cả checkbox paid vẫn tick)
- **AND** không có mutation nào

### Requirement: Nút "Xem bill in" (preview biên nhận)

Nút "Xem bill in" SHALL hiển thị cho MỌI bill đã có `bill_code` (không phụ thuộc status pending/delivered/cancelled). Draft (`bill_code=NULL`) không có nút này.

Vị trí:
- Ngay sau khi Lưu đơn thành công: nút "Xem bill in" thay thế nút "Lưu đơn" (state form chuyển sang "submitted").
- Trong bill detail (tab tra cứu): nằm cạnh nút "Sửa" / "Hủy".

Modal preview:
- Layout kích thước A5/A6 (~148mm), có thể print A4 ghép 2 bill.
- Data render từ 4 snapshot columns (`sender_name_text`, `sender_phone_text`, `receiver_name_text`, `receiver_phone_text`) — KHÔNG JOIN `clients`/`client_phones`.
- Hiển thị: `bill_code`, ngày gửi, ngày có hàng dự kiến, tên+SĐT sender/receiver, loại hàng, số kiện, giá trị hàng, số sao đặc biệt, cước phí + trạng thái thanh toán, địa chỉ giao (nếu có), ghi chú (bao gồm CCCD/VAT), các flag (rủi ro, tự đóng, không khai giá trị, VAT, CCCD).
- Có barcode Code128 hoặc QR chứa `bill_code`.
- Nút "In" → `window.print()` với CSS `@media print` ẩn app chrome (header, sidebar, footer).
- Nút "Đóng" đóng modal.

Bill cancelled: preview vẫn hiển đầy đủ nhưng overlay watermark chéo "ĐÃ HỦY" màu đỏ 30% opacity.

#### Scenario: Bill vừa tạo — nút thay Lưu đơn

- **GIVEN** user vừa Lưu đơn `05SGA02` thành công
- **THEN** nút "Xem bill in" hiển thị (thay vị trí nút "Lưu đơn")
- **AND** toast "Đã lưu đơn 05SGA02"

#### Scenario: Bill detail — nút cạnh Sửa/Hủy

- **GIVEN** admin mở bill `05SGA02` từ tab tra cứu
- **THEN** thanh action có 3 nút: "Sửa", "Hủy", "Xem bill in"

#### Scenario: Draft — không có nút Xem bill in

- **GIVEN** user mở 1 draft từ list nháp
- **THEN** không có nút "Xem bill in" (draft không có `bill_code`)

#### Scenario: Bill cancelled — watermark ĐÃ HỦY

- **GIVEN** bill `05SGA02` có `delivery_status='cancelled'`
- **WHEN** user click "Xem bill in"
- **THEN** modal preview hiển đầy đủ data
- **AND** có overlay chéo "ĐÃ HỦY" màu đỏ 30% opacity

#### Scenario: Snapshot render — không bị ảnh hưởng bởi đổi tên khách

- **GIVEN** bill `05SGA02` có `sender_name_text='Trần A'`, `sender_id=100`
- **AND** admin đổi `clients.fullname` của khách 100 thành "Trần Anh"
- **WHEN** user click "Xem bill in" cho bill 05SGA02
- **THEN** preview hiển "Trần A" (từ snapshot), KHÔNG hiển "Trần Anh"

### Requirement: Double-click guard cho mọi nút mutation

Mọi nút thực hiện mutation ("Lưu đơn", "Lưu nháp", "Cập nhật", "Hủy") SHALL disabled sau click đầu tiên cho đến khi RPC hoàn tất (thành công hoặc fail). Bấm nhiều lần liên tiếp CHỈ được thực thi 1 lần.

Ngoài ra, trước khi gọi RPC update/cancel, hệ thống SHALL refetch state hiện tại của bill:
- Nếu bill đã bị mutate bởi user khác (VD `delivery_status` đã đổi hoặc `is_delete=true`) → toast "Đơn đã được cập nhật bởi người khác, đang refresh" + refresh UI, KHÔNG mutation lần 2.

#### Scenario: Double-click Lưu đơn

- **WHEN** user bấm nút "Lưu đơn" 3 lần liên tiếp trong 200ms
- **THEN** chỉ có 1 RPC call, chỉ tạo 1 bill

#### Scenario: Double-click Hủy

- **WHEN** user bấm nút "Hủy" trong modal 2 lần liên tiếp
- **THEN** chỉ có 1 RPC call, bill chỉ chuyển sang `cancelled` 1 lần

#### Scenario: Race — bill bị mutate bởi user khác

- **GIVEN** admin A mở bill `05SGA02` để hủy
- **AND** admin B đã hủy bill này trước đó (bill hiện `cancelled`)
- **WHEN** admin A bấm OK trong modal Hủy
- **THEN** refetch phát hiện `delivery_status='cancelled'` rồi
- **AND** toast "Đơn đã được cập nhật bởi người khác, đang refresh"
- **AND** không có RPC cancel_bill_with_audit call thứ 2
- **AND** UI refresh hiển state mới
