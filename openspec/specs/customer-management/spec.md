# Capability: Customer Management

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (tab Quản Lý Khách Hàng) và `src/ClientAutocomplete.jsx`.
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng.

## Purpose

Lưu trữ thông tin khách gửi và khách nhận, hỗ trợ tra cứu nhanh khi tạo phiếu gửi hàng, đánh dấu khách hàng cần thận trọng (blacklist).

## Domain model

- `clients(id, fullname, address, is_blacklist, blacklist_reason, is_delete)`
- `client_phones(id, client_id, phone_number, type)` với `type ∈ {"primary", "secondary"}` (mỗi khách tối đa 2 số trong UI; DB không hạn chế).
- Liên kết tới bills qua `bills.sender_id` / `bills.receiver_id` và `bills.sender_phone_id` / `bills.receiver_phone_id`.

## Requirements

### Requirement: Thêm khách hàng mới
Hệ thống SHALL hỗ trợ thêm khách hàng mới với tối thiểu họ tên và 1 số điện thoại chính.

Tab Quản Lý Khách Hàng có form thêm khách với các trường: họ tên (bắt buộc), SĐT chính (bắt buộc), SĐT phụ (tuỳ chọn), địa chỉ (tuỳ chọn), checkbox blacklist + lý do.

#### Scenario: Thêm khách hợp lệ
- **WHEN** admin nhập họ tên + SĐT chính và bấm Lưu
- **THEN** hệ thống insert 1 row vào `clients` với `is_delete = false`, `is_blacklist = false`
- **AND** insert 1 row vào `client_phones` với `type = "primary"`
- **AND** nếu có SĐT phụ thì insert thêm row `type = "secondary"`

#### Scenario: Thiếu họ tên hoặc SĐT chính
- **WHEN** admin bấm Lưu mà thiếu họ tên hoặc SĐT chính
- **THEN** hệ thống KHÔNG gửi request và form không submit

### Requirement: Sửa khách hàng — xóa và insert lại SĐT
Khi user chỉnh sửa, hệ thống MUST update `clients` rồi `DELETE FROM client_phones WHERE client_id = ?` rồi insert lại SĐT chính (và phụ nếu có).

> ⚠️ **Cảnh báo quan sát được**: hành vi này **đổi `client_phones.id`** sau mỗi lần sửa. Các bill đã tham chiếu `sender_phone_id` / `receiver_phone_id` cũ sẽ trỏ tới row không còn tồn tại → **orphan FK**. Cần anh xác nhận đây là intended behavior hay phải đổi cách lưu.

#### Scenario: Sửa địa chỉ khách
- **WHEN** admin mở khách trong danh sách, đổi địa chỉ rồi Lưu
- **THEN** hệ thống update `clients.address`
- **AND** xóa toàn bộ row trong `client_phones` của khách đó
- **AND** insert lại row primary (và secondary nếu form còn nhập) với `id` mới
- **AND** mọi bill cũ tham chiếu `phone_id` cũ sẽ trỏ tới row đã bị xóa

#### Scenario: Sửa khách có blacklist
- **WHEN** admin tick "Blacklist" và nhập lý do rồi Lưu
- **THEN** hệ thống update `clients.is_blacklist = true` và `clients.blacklist_reason = <lý do>`

#### Scenario: Bỏ blacklist
- **WHEN** admin uncheck "Blacklist" rồi Lưu
- **THEN** hệ thống update `clients.is_blacklist = false` và `clients.blacklist_reason = ""` (chuỗi rỗng, không phải NULL)

### Requirement: Soft-delete khách hàng
Hệ thống SHALL chỉ soft-delete khách hàng bằng cách set `clients.is_delete = true`; row không bị xóa cứng.

#### Scenario: Xóa khách
- **WHEN** admin bấm nút xóa và xác nhận
- **THEN** hệ thống update `clients.is_delete = true`
- **AND** khách biến mất khỏi danh sách
- **AND** các bill cũ vẫn giữ liên kết `sender_id` / `receiver_id` tới khách đó

### Requirement: Autocomplete theo tên hoặc số điện thoại
ClientAutocomplete SHALL gợi ý khách hàng dựa trên cả họ tên VÀ số điện thoại trong cùng 1 input, tối đa 8 khách mỗi lần. Mỗi khách hiển thị 1 lần với header (tên + badge blacklist nếu có), rồi liệt kê **tất cả số điện thoại active** của khách đó bên dưới dưới dạng các dòng con clickable.

Người dùng nhập 1 keyword. Component truy vấn `clients` (`is_delete = false`) join `client_phones`, lọc local theo keyword khớp `fullname` (case-insensitive, ilike) HOẶC khớp `phone_number` (case-insensitive contains). Với mỗi khách có ít nhất 1 hit, hiển thị tất cả số phone match; nếu match bằng tên → hiển thị toàn bộ số phone của khách; nếu match bằng số → chỉ hiển thị các số cụ thể đã match.

Chỉ những phone có `type ∈ {'primary', 'secondary'}` được suggest. Row `type='old'` MUST bị loại (số cũ chỉ dùng để giữ FK cho bill cũ, không phải số liên lạc hiện hành).

Trong cùng 1 khách, dòng phone `primary` SHALL sắp xếp trước `secondary`. Mỗi dòng phone hiển thị:
- Số điện thoại (font mono).
- Badge nhãn: `chính` (cam) cho `primary`, `phụ` (xám) cho `secondary`.

Khi user click 1 dòng phone → form điền tên khách + đúng số phone đã click (KHÔNG mặc định số chính).

#### Scenario: Gõ tên khách có 2 số → 1 group, 2 dòng phone
- **GIVEN** khách "Nguyễn Văn A" có 2 số: `0909-A` (primary), `0988-B` (secondary)
- **WHEN** user gõ "Nguyen" vào ô tên
- **THEN** dropdown hiện 1 group cho "Nguyễn Văn A"
- **AND** dưới header khách hiện 2 dòng phone:
  - `0909-A · chính` (cam)
  - `0988-B · phụ` (xám)

#### Scenario: Gõ số phụ → chỉ hiện dòng phone match
- **GIVEN** khách "Nguyễn Văn A" có primary `0909-A`, secondary `0988-B`
- **WHEN** user gõ "0988"
- **THEN** dropdown hiện 1 group "Nguyễn Văn A" với **chỉ 1 dòng phone**: `0988-B · phụ`
- **AND** dòng `0909-A` KHÔNG hiển thị (vì không match keyword)

#### Scenario: Click dòng số phụ → form điền đúng số phụ
- **GIVEN** dropdown đang hiện group "Nguyễn Văn A" với dòng `0988-B · phụ`
- **WHEN** user click dòng phone đó
- **THEN** ô tên = "Nguyễn Văn A"
- **AND** ô SĐT = "0988-B" (KHÔNG phải số chính `0909-A`)

#### Scenario: Click dòng số chính → form điền số chính
- **GIVEN** dropdown đang hiện group với dòng `0909-A · chính`
- **WHEN** user click dòng đó
- **THEN** ô tên = "Nguyễn Văn A", ô SĐT = "0909-A"

#### Scenario: Số cũ (type='old') KHÔNG suggest
- **GIVEN** khách "Nguyễn Văn A" có primary `0912-NEW`, và 1 phone `type='old'` với số `0909-A`
- **WHEN** user gõ "0909"
- **THEN** dropdown KHÔNG hiện group nào cho khách này (số `0909` là old, không được match)
- **AND** khi user gõ "Nguyen" → group "Nguyễn Văn A" chỉ có 1 dòng phone `0912-NEW · chính` (không có dòng nào cho số old)

#### Scenario: Khách bị blacklist hiển thị badge cảnh báo
- **WHEN** khách trong dropdown có `is_blacklist = true`
- **THEN** header khách hiển thị icon ⚠️ + badge "BLACKLIST" + tooltip `blacklist_reason`
- **AND** vẫn có thể click 1 dòng phone của khách này để tạo đơn (blacklist KHÔNG chặn tạo bill)

> ⚠️ **Cần anh confirm**: hành vi "blacklist không chặn tạo bill" là intended (chỉ cảnh báo trực quan), hay phải chặn hẳn?
