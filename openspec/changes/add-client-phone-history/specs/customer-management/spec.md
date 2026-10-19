# Delta: customer-management (add-client-phone-history)

> Vá bug orphan FK trong flow sửa khách: KHÔNG bao giờ DELETE `client_phones`. Bổ sung khái niệm "Số cũ" (`type='old'`) làm lịch sử số điện thoại của khách.
>
> Cross-ref: section "📜 Lịch sử thay đổi" inline trên form Sửa Khách Hàng thuộc delta `audit-log` của cùng change này (`specs/audit-log/spec.md`).

## REMOVED Requirements

### Requirement: Sửa khách hàng — xóa và insert lại SĐT

**Lý do gỡ**: hành vi cũ (DELETE + INSERT lại `client_phones`) phá orphan FK của mọi bill cũ tham chiếu `sender_phone_id` / `receiver_phone_id`. Cần thay bằng hành vi mới (KHÔNG DELETE, chỉ flip type) — xem requirement ADDED "Sửa khách hàng — không DELETE, chỉ flip type" bên dưới.

## ADDED Requirements

### Requirement: client_phones.type hỗ trợ 3 giá trị primary | secondary | old

Bảng `client_phones.type` SHALL nhận đúng 1 trong 3 giá trị: `'primary'`, `'secondary'`, `'old'`. Hệ thống MUST có CHECK constraint cấp database enforce ràng buộc này.

Ngữ nghĩa từng giá trị:
- `primary`: số điện thoại chính đang dùng. Mỗi khách (không soft-delete) có đúng 1 row primary (UI enforce qua required field).
- `secondary`: số điện thoại phụ. Mỗi khách có 0 hoặc 1 row secondary.
- `old`: số điện thoại đã bị thay thế bởi số mới — chỉ giữ lại để bảo toàn FK của bill cũ. KHÔNG bao giờ được hiển thị như số liên lạc hiện hành. KHÔNG có UI thao tác trực tiếp lên row 'old' (chỉ tự sinh khi flip từ primary/secondary).

UI form Sửa Khách Hàng SHALL hiển thị 3 vùng tách biệt: ô input "Số chính", ô input "Số phụ", list read-only "Số cũ".

#### Scenario: Migration thêm CHECK constraint

- **GIVEN** schema cũ `client_phones.type` không có CHECK
- **WHEN** chạy migration `add-client-phone-old-type.sql`
- **THEN** `\d+ client_phones` hiển thị `CHECK (type IN ('primary','secondary','old'))`
- **AND** mọi INSERT/UPDATE với `type` khác 3 giá trị bị reject

#### Scenario: Insert row với type='old' qua app

- **WHEN** code `handleAddClient` flip 1 phone từ primary sang old
- **THEN** UPDATE `client_phones SET type='old' WHERE id=?` thành công
- **AND** DB CHECK constraint pass

#### Scenario: Insert row với type='archived' (giá trị lạ)

- **WHEN** ai đó cố insert `client_phones` với `type='archived'`
- **THEN** DB reject với CHECK constraint violation
- **AND** mutation fail toàn cục

### Requirement: Sửa khách hàng — không DELETE, chỉ flip type

Khi admin sửa khách hàng qua tab Quản Lý Khách Hàng (handler `handleAddClient` ở edit mode), hệ thống MUST KHÔNG bao giờ chạy `DELETE FROM client_phones`. Hệ thống SHALL chỉ làm 3 loại thao tác trên `client_phones`:

1. INSERT row mới (khi user thêm số chưa từng có trong DB cho khách đó).
2. UPDATE `type` (flip `'primary'` ↔ `'old'` hoặc `'secondary'` ↔ `'old'` khi user thay/xoá số).
3. UPDATE clients (fullname, address, is_blacklist, blacklist_reason) — không liên quan client_phones.

Hệ thống SHALL **KHÔNG BAO GIỜ** chạy `UPDATE client_phones SET phone_number = ?` (số điện thoại của 1 row là bất biến sau khi insert). Mọi thay đổi số đều biểu hiện qua sequence: flip row cũ → INSERT row mới.

Lý do: bảo toàn FK `bills.sender_phone_id` / `bills.receiver_phone_id` của tất cả bill cũ. Bill cũ JOIN về row gốc đúng phone_number (kể cả khi `type` đã chuyển sang `'old'`).

#### Scenario: Sửa chỉ tên khách — KHÔNG đụng client_phones

- **GIVEN** khách "Trần A" có 1 row primary `"0909-A"` (id=100), 0 row khác
- **WHEN** admin mở khách, đổi tên thành "Trần Anh" rồi bấm Lưu (không động ô SĐT)
- **THEN** UPDATE `clients.fullname = 'Trần Anh'` thành công
- **AND** KHÔNG có request DELETE/UPDATE/INSERT nào lên `client_phones`
- **AND** row id=100 vẫn tồn tại với `phone_number='0909-A'` và `type='primary'`

#### Scenario: Đổi Số chính

- **GIVEN** khách có primary `"0909-A"` (id=100), không có secondary, không có old
- **WHEN** admin gõ Số chính mới `"0912-NEW"` + Xác nhận modal + bấm Lưu
- **THEN** UPDATE `client_phones SET type='old' WHERE id=100` (row cũ giữ nguyên phone_number)
- **AND** INSERT `client_phones (client_id, phone_number='0912-NEW', type='primary')` (row mới)
- **AND** KHÔNG có DELETE
- **AND** bill cũ trỏ `sender_phone_id=100` vẫn JOIN ra được `phone_number='0909-A'`

#### Scenario: Xoá Số phụ — silent demote (không modal)

- **GIVEN** khách có primary `"0909-A"`, secondary `"0988-B"` (id=200)
- **WHEN** admin xoá rỗng ô Số phụ rồi bấm Lưu
- **THEN** UPDATE `client_phones SET type='old' WHERE id=200`
- **AND** KHÔNG có modal confirm
- **AND** KHÔNG có DELETE
- **AND** UI sau refresh: Số phụ rỗng, list Số cũ chứa `"0988-B"`

#### Scenario: Đổi cả Số chính lẫn Số phụ trong 1 lần Lưu

- **GIVEN** khách có primary `"0909-A"` (id=100), secondary `"0988-B"` (id=200)
- **WHEN** admin đổi chính → `"0912-NEW"`, đổi phụ → `"0977-NEW"`, Xác nhận modal, Lưu
- **THEN** 4 thao tác diễn ra:
  - UPDATE id=100 type='old'
  - INSERT phone='0912-NEW' type='primary'
  - UPDATE id=200 type='old'
  - INSERT phone='0977-NEW' type='secondary'
- **AND** KHÔNG có DELETE
- **AND** sau save, khách có: 1 primary mới, 1 secondary mới, 2 old (0909-A và 0988-B)

#### Scenario: Save fail giữa chừng — không có DELETE để rollback

- **GIVEN** đang đổi Số chính (cần UPDATE_TYPE + INSERT)
- **WHEN** UPDATE_TYPE thành công nhưng INSERT mới fail (vd network drop)
- **THEN** khách tạm thời có 0 row primary + 1 row 'old' (số cũ vừa bị demote)
- **AND** dữ liệu KHÔNG bị mất vì không có DELETE
- **AND** lần save kế tiếp khi user retry: INSERT primary thành công → state nhất quán lại

### Requirement: Số cũ là lịch sử bảo toàn FK của bill cũ

Khi 1 row `client_phones` chuyển từ `'primary'` hoặc `'secondary'` sang `'old'`, hệ thống MUST giữ nguyên `id` và `phone_number` của row. Hệ thống SHALL KHÔNG bao giờ DELETE row 'old' qua code path UI/app. Hậu quả là FK `bills.sender_phone_id` / `bills.receiver_phone_id` vẫn JOIN ra được số gốc của bill cũ.

UI Bill Detail của bill cũ MUST vẫn hiển thị đúng `phone_number` của row gốc, kể cả khi row đó đã `type='old'`. (Có thể thêm badge `(cũ)` ở UI Bill Detail — tuỳ chọn, out of scope MVP.)

#### Scenario: Bill cũ trỏ row 'old' — Bill Detail vẫn hiển thị số

- **GIVEN** bill `05SGA02` có `sender_phone_id=100` (link tới phone "0909-A")
- **AND** sau đó admin đổi Số chính của khách → row id=100 flip sang type='old'
- **WHEN** user mở Bill Detail của `05SGA02`
- **THEN** SĐT người gửi hiển thị `"0909-A"` (JOIN OK)
- **AND** KHÔNG hiển thị NULL hay placeholder "—"

#### Scenario: Bill mới tạo sau khi đổi số — trỏ row 'primary' mới

- **GIVEN** khách có primary mới id=101 (`"0912-NEW"`) và old id=100 (`"0909-A"`)
- **WHEN** nhân viên tạo bill mới với khách này — autocomplete chọn match `"0912-NEW"`
- **THEN** `bills.sender_phone_id = 101` (trỏ primary mới)

#### Scenario: Số 'old' không được auto-DELETE bởi cron/cleanup

- **GIVEN** khách có 5 row 'old' tích luỹ qua nhiều năm
- **WHEN** không có job nào (vì hệ thống không có cron cleanup)
- **THEN** 5 row 'old' vẫn tồn tại vĩnh viễn trong DB
- **AND** mọi bill cũ trỏ chúng vẫn join được

### Requirement: Modal confirm khi user đổi Số chính

Khi admin sửa khách hàng VÀ giá trị mới của ô "Số chính" khác `phone_number` của row primary hiện tại (đã load từ DB lúc enter edit mode), hệ thống MUST hiển thị 1 modal confirm trước khi thực sự lưu. Modal phải hiển thị cả số cũ và số mới song song.

Modal có nội dung tối thiểu:
- Tiêu đề: `"Số chính đã được thay đổi"`.
- Body 2 dòng: `"Cũ: <oldPhone>"` và `"Mới: <newPhone>"`.
- 2 nút: `[Huỷ]` và `[Xác nhận]`.

Hành vi:
- Bấm `[Huỷ]` → KHÔNG có request nào lên DB, form vẫn giữ giá trị admin đang gõ.
- Bấm `[Xác nhận]` → tiếp tục flow save (flip primary cũ sang 'old', INSERT primary mới).

Modal MUST KHÔNG hiển thị các option khác (radio "typo / đổi số", checkbox, etc.) — UI giữ tối giản.

#### Scenario: Đổi Số chính → modal hiện

- **WHEN** admin sửa Số chính từ `"0909-A"` → `"0912-NEW"` và bấm Lưu
- **THEN** modal pop với title "Số chính đã được thay đổi", body `"Cũ: 0909-A"` `"Mới: 0912-NEW"`

#### Scenario: Bấm Huỷ trong modal

- **GIVEN** modal đang hiển thị
- **WHEN** admin bấm `[Huỷ]`
- **THEN** modal đóng, form GIỮ NGUYÊN giá trị admin đã gõ (chưa save)
- **AND** KHÔNG có request UPDATE/INSERT lên client_phones hoặc clients
- **AND** admin có thể tiếp tục chỉnh hoặc bấm Lưu lại

#### Scenario: Bấm Xác nhận trong modal

- **GIVEN** modal đang hiển thị
- **WHEN** admin bấm `[Xác nhận]`
- **THEN** flow save tiếp tục (UPDATE clients + UPDATE_TYPE old + INSERT primary mới)
- **AND** toast "Đã cập nhật khách hàng!"
- **AND** form reset về Add mode

#### Scenario: Sửa nhưng KHÔNG đổi Số chính → KHÔNG có modal

- **GIVEN** khách có primary `"0909-A"`
- **WHEN** admin chỉ đổi tên hoặc đổi địa chỉ, KHÔNG đụng Số chính, bấm Lưu
- **THEN** KHÔNG có modal
- **AND** flow save chạy thẳng

#### Scenario: Đổi Số phụ → KHÔNG có modal (silent demote)

- **WHEN** admin đổi Số phụ `"0988-B"` → `"0977-NEW"`, KHÔNG đụng Số chính, bấm Lưu
- **THEN** KHÔNG có modal hiện ra
- **AND** flow save chạy thẳng (flip secondary cũ sang 'old', INSERT secondary mới)

### Requirement: Click row khách autofill form, scroll lên đầu, focus ô họ tên, giữ phân trang

Khi admin click vào row trong bảng danh sách khách hàng, hệ thống MUST thực hiện:

1. Populate form Sửa Khách Hàng với dữ liệu của khách (fullname, address, is_blacklist, blacklist_reason).
2. Populate ô Số chính từ row `client_phones` có `type='primary'`.
3. Populate ô Số phụ từ row `client_phones` có `type='secondary'` (rỗng nếu không có).
4. Populate list Số cũ từ tất cả row `client_phones` có `type='old'` (rỗng nếu không có).
5. Set `editingClientId` = id của khách → form chuyển từ Add mode sang Edit mode (title đổi từ "🆕 Thêm" sang "✏️ Sửa").
6. Scroll trang lên đầu (`window.scrollTo({ top: 0, behavior: 'smooth' })`).
7. Focus ô input "Họ tên" sau khi scroll xong (~100ms delay cho safe re-render).

Hệ thống MUST KHÔNG reset state phân trang (`clientPage`) khi click row khách. Nếu admin đang ở page 3 của danh sách thì page sau scroll vẫn là 3.

#### Scenario: Click khách ở page 3

- **GIVEN** danh sách khách hàng có 50 khách (3 page với CLIENTS_PER_PAGE=20), admin đang ở page 3 hiển thị 10 khách cuối
- **WHEN** admin click row khách "Trần A" ở page 3
- **THEN** form Sửa Khách Hàng được autofill với dữ liệu "Trần A"
- **AND** trang scroll lên top
- **AND** ô Họ tên được focus
- **AND** `clientPage` vẫn = 3 (KHÔNG bị reset về 1)
- **AND** sau khi admin scroll xuống lại, page 3 vẫn hiển thị nguyên 10 khách cuối

#### Scenario: Khách có nhiều số 'old'

- **GIVEN** khách "Trần A" có primary `"0912-NEW"`, secondary `"0988-Y"`, và 3 row old (`"0909-A"`, `"0913-OLD2"`, `"0914-OLD3"`)
- **WHEN** admin click row "Trần A"
- **THEN** ô Số chính = `"0912-NEW"`
- **AND** ô Số phụ = `"0988-Y"`
- **AND** list Số cũ hiển thị 3 mục: `"0909-A"`, `"0913-OLD2"`, `"0914-OLD3"` (read-only)

#### Scenario: Member click row → form readonly hoặc không autofill

- **GIVEN** user role = `member`
- **WHEN** member click row khách
- **THEN** hành vi follow logic role hiện tại (form có thể disabled) — KHÔNG đổi do change này

### Requirement: Form Sửa/Thêm khách dùng chung 1 form, toggle title theo editingClientId

Tab Quản Lý Khách Hàng MUST chỉ có 1 component `<form>` cho cả hành vi Thêm Mới và Sửa. Phân biệt giữa 2 chế độ qua state `editingClientId`:

- `editingClientId === null`: chế độ "Thêm Mới". Title `"🆕 Thêm Khách Hàng Mới"`. List Số cũ KHÔNG hiển thị (vì khách chưa tồn tại). Section "📜 Lịch sử thay đổi" KHÔNG hiển thị (cross-ref delta audit-log).
- `editingClientId !== null`: chế độ "Sửa Khách Hàng". Title `"✏️ Sửa Khách Hàng"`. List Số cũ hiển thị nếu khách có row `type='old'`. Section "📜 Lịch sử thay đổi" hiển thị (cho admin/boss).

Form MUST có nút `[Huỷ]` (chỉ hiển thị ở chế độ Sửa) để reset về chế độ Thêm Mới: clear hết state form, set `editingClientId = null`.

#### Scenario: Chuyển từ Add sang Edit mode

- **GIVEN** form đang ở Add mode, title `"🆕 Thêm Khách Hàng Mới"`
- **WHEN** admin click row khách trong bảng
- **THEN** title đổi thành `"✏️ Sửa Khách Hàng"`
- **AND** form autofill dữ liệu khách
- **AND** nút `[Huỷ]` xuất hiện

#### Scenario: Bấm Huỷ trong Edit mode

- **WHEN** admin đang ở Edit mode bấm `[Huỷ]`
- **THEN** form reset: clear hết input, list Số cũ về rỗng
- **AND** `editingClientId = null`
- **AND** title đổi về `"🆕 Thêm Khách Hàng Mới"`
- **AND** nút `[Huỷ]` biến mất

#### Scenario: Save thành công → tự reset về Add mode

- **WHEN** admin lưu sửa khách thành công
- **THEN** form tự reset (như bấm Huỷ)
- **AND** danh sách khách hàng refresh từ DB
- **AND** title về `"🆕 Thêm Khách Hàng Mới"`

### Requirement: Danh sách khách hàng hiển thị SĐT theo loại đúng thứ tự

Cell "Số điện thoại" trong table danh sách khách hàng MUST render mỗi row `client_phones` với label riêng cho 3 loại:

- `type='primary'` → label `"Chính"` (badge accent, ví dụ nền cam nhạt).
- `type='secondary'` → label `"Phụ"` (badge trung tính, nền xám).
- `type='old'` → label `"Cũ"` (badge mờ hơn — text xám nhạt, nền trắng/border xám — để user quét nhanh phân biệt lịch sử vs số đang dùng).

Thứ tự render trong 1 cell MUST luôn là: **Chính → Phụ → Cũ**, không phụ thuộc thứ tự DB trả (thứ tự trong `client_phones` array có thể là `created_at asc` khi số chính bị demote/insert lại → nếu render thô sẽ đẩy số chính xuống cuối).

Trong nhóm `old` (nếu có nhiều số cũ), thứ tự phụ giữ nguyên như DB trả (ổn định theo `id`/`created_at`).

Search khách theo SĐT MUST vẫn match tất cả 3 loại (kể cả `old`) — không đổi hành vi search hiện tại.

#### Scenario: Khách có đủ 3 loại SĐT

- **GIVEN** khách `"Chị Lan Cà Phê"` có 3 row `client_phones`:
  - primary = `"09123456987"`
  - secondary = `"09123456976"`
  - old = `"0912345695"`
- **AND** DB trả về array theo thứ tự [secondary, old, primary] (trường hợp số chính bị demote rồi insert lại nên `created_at` mới nhất)
- **WHEN** admin xem danh sách khách hàng
- **THEN** cell SĐT của row `"Chị Lan Cà Phê"` hiển thị đúng 3 badge theo thứ tự từ trên xuống:
  1. `"Chính: 09123456987"`
  2. `"Phụ: 09123456976"`
  3. `"Cũ: 0912345695"`

#### Scenario: Khách chỉ có primary + nhiều old

- **GIVEN** khách có primary `"0912-NEW"` và 2 row old (`"0909-A"`, `"0913-OLD2"`); không có secondary
- **WHEN** admin xem danh sách
- **THEN** cell hiển thị 3 badge theo thứ tự: `"Chính: 0912-NEW"`, `"Cũ: 0909-A"`, `"Cũ: 0913-OLD2"`
- **AND** KHÔNG có badge `"Phụ"` nào

#### Scenario: Search theo số cũ vẫn match

- **GIVEN** khách `"Chị Lan Cà Phê"` có `old = "0912345695"`
- **WHEN** admin nhập `"0912345695"` vào ô tìm kiếm
- **THEN** row `"Chị Lan Cà Phê"` vẫn xuất hiện trong danh sách
- **AND** cell SĐT vẫn render đủ 3 badge Chính/Phụ/Cũ như bình thường
