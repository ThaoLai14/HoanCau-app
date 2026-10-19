# Delta: audit-log (add-client-phone-history)

> Mở rộng capability `audit-log` để track sự kiện đổi số điện thoại khách hàng + thêm section "Lịch sử thay đổi" inline trên form Sửa Khách Hàng.
>
> Cross-ref: capability chính `customer-management` (cùng change) định nghĩa flow đổi số.

## ADDED Requirements

### Requirement: Action client_update payload mở rộng với phone diff keys

Khi admin sửa khách qua tab Quản Lý Khách Hàng (`handleAddClient` ở edit mode), hệ thống MUST insert 1 row audit_log duy nhất với `action='client_update'` chứa diff hợp nhất của cả `clients` fields và `client_phones` operations. Payload `changes` SHALL hỗ trợ 3 key mới riêng cho phone diff:

| Key | Khi nào xuất hiện | Format value |
|---|---|---|
| `phone_primary` | Số chính bị đổi từ X sang Y | `[X, Y]` (cả 2 đều non-null) |
| `phone_secondary` | Số phụ bị đổi từ X sang Y, HOẶC thêm mới (X=null), HOẶC xoá (Y=null) | `[X, Y]` |
| `phone_demoted_to_old` | 1 hoặc nhiều số bị flip type='old' trong cùng save | `[null, <stringOrArray>]` |

Quy tắc gộp `changes`:
- 1 lần Save thành công = đúng 1 row audit_log (không phân tách thành nhiều entry).
- Nếu không có field nào đổi (admin bấm Lưu nhưng form không khác state cũ) → KHÔNG insert audit_log.
- Field `clients.*` diff dùng helper `diffObjects()` đã có sẵn (compatible với pattern bill_update).
- `phone_demoted_to_old` chứa danh sách `phone_number` string của các row vừa bị flip — không chứa `id`.
- Nếu cùng 1 save vừa demote số chính cũ vừa demote số phụ cũ → `phone_demoted_to_old: [null, ["0909-A", "0988-B"]]` (value là array 2 phần tử).
- Nếu chỉ demote 1 số → `phone_demoted_to_old: [null, "0909-A"]` (value là string đơn).

#### Scenario: Đổi Số chính → 2 key trong changes

- **WHEN** admin đổi Số chính từ `"0909-A"` → `"0912-NEW"` (không đổi gì khác)
- **THEN** insert audit_log với `changes = {"phone_primary": ["0909-A", "0912-NEW"], "phone_demoted_to_old": [null, "0909-A"]}`
- **AND** entity_type=`'client'`, entity_id=`<clientId>`, action=`'client_update'`

#### Scenario: Sửa chỉ tên + địa chỉ — KHÔNG có phone key

- **WHEN** admin đổi fullname và address, KHÔNG đụng số
- **THEN** `changes = {"fullname": [oldName, newName], "address": [oldAddr, newAddr]}`
- **AND** KHÔNG có `phone_primary` / `phone_secondary` / `phone_demoted_to_old`

#### Scenario: Đổi cả 2 số + xoá phụ trong 1 save

- **WHEN** admin đổi primary `"0909-A"` → `"0912-NEW"` AND xoá phụ `"0988-B"`
- **THEN** `changes` chứa:
  - `phone_primary: ["0909-A", "0912-NEW"]`
  - `phone_secondary: ["0988-B", null]`
  - `phone_demoted_to_old: [null, ["0909-A", "0988-B"]]`

#### Scenario: Bấm Lưu nhưng không đổi gì

- **WHEN** admin mở khách, không sửa field nào, bấm Lưu
- **THEN** KHÔNG insert row audit_log
- **AND** main flow vẫn chạy (form đóng, toast hiện) — KHÔNG fail

#### Scenario: Thêm Số phụ lần đầu

- **GIVEN** khách "Trần A" hiện chỉ có primary, KHÔNG có secondary
- **WHEN** admin gõ Số phụ mới `"0977-NEW"` rồi Lưu
- **THEN** `changes = {"phone_secondary": [null, "0977-NEW"]}`
- **AND** KHÔNG có `phone_demoted_to_old` (không có row nào bị demote)

### Requirement: Field labels cho phone diff trong auditLabels.js

File `src/auditLabels.js` SHALL có 3 entry mới trong `FIELD_LABELS`:

- `phone_primary: 'Số điện thoại chính'`
- `phone_secondary: 'Số điện thoại phụ'`
- `phone_demoted_to_old: 'Số chuyển thành cũ'`

Helper `renderChanges()` MUST render đúng các label tiếng Việt này. Khi value là array nhiều phần tử (vd `phone_demoted_to_old: [null, ["0909-A", "0988-B"]]`), render dạng comma-separated: `"Số chuyển thành cũ: 0909-A, 0988-B"`.

#### Scenario: Render phone_primary diff trong section history

- **GIVEN** entry với `changes = {"phone_primary": ["0909-A", "0912-NEW"]}`
- **WHEN** `renderChanges()` xử lý entry
- **THEN** output bullet `"• Số điện thoại chính: 0909-A → 0912-NEW"`

#### Scenario: Render phone_demoted_to_old multi-value

- **GIVEN** entry với `changes = {"phone_demoted_to_old": [null, ["0909-A", "0988-B"]]}`
- **WHEN** `renderChanges()` xử lý
- **THEN** output `"• Số chuyển thành cũ: 0909-A, 0988-B"`

#### Scenario: Render phone_demoted_to_old single value

- **GIVEN** entry với `changes = {"phone_demoted_to_old": [null, "0909-A"]}`
- **WHEN** `renderChanges()` xử lý
- **THEN** output `"• Số chuyển thành cũ: 0909-A"`

#### Scenario: Render phone_secondary xoá (Y=null)

- **GIVEN** entry với `changes = {"phone_secondary": ["0988-B", null]}`
- **WHEN** `renderChanges()` xử lý
- **THEN** output `"• Số điện thoại phụ: 0988-B → (xoá)"` (hoặc format tương đương biểu thị "đã xoá")

### Requirement: Section "Lịch sử thay đổi" inline trong form Sửa Khách Hàng (admin/boss)

Tab Quản Lý Khách Hàng SHALL có 1 **section read-only "📜 Lịch sử thay đổi"** hiển thị ngay dưới form Sửa Khách Hàng (cùng cột với form, dưới nút Lưu/Huỷ). Section MUST chỉ hiển thị khi tất cả các điều kiện sau đều đúng:

1. `userRole ∈ {admin, boss}` (member KHÔNG bao giờ thấy section).
2. `editingClientId !== null` (chỉ ở chế độ Sửa, KHÔNG hiển thị ở chế độ Thêm Mới).

Section render bảng 3 cột:

| Ngày | Nhân viên | Thay đổi |
|---|---|---|
| `dd/MM HH:mm` (format compact) | `<username> (<role>)` | bullet list các diff |

Quy tắc:
- Entries sắp xếp NEWEST → OLDEST.
- Filter: `entity_type='client' AND entity_id=editingClientId`.
- Cell "Thay đổi" render từ `renderChanges(entry.changes)` (helper từ `auditLabels.js`) — cùng pattern với BillHistorySection.
- Mỗi action mapping prefix trong cell "Thay đổi":
  - `client_create` → `🆕 Tạo khách` + danh sách field khởi tạo.
  - `client_update` → `✏️ Sửa` + bullet diff list.
  - `client_delete` → `🗑️ Xoá khách`.
  - `client_blacklist` → `⛔ Blacklist` (đổi `is_blacklist`).
- Empty state: `"Chưa có lịch sử thay đổi."`.
- Loading state: `"Đang tải lịch sử..."`.
- Auto-refresh sau mỗi save thành công trên khách đó (vd component remount khi `historyRefreshKey` tăng).

Layout khác với BillHistorySection (timeline) — ở đây dùng **table 3 cột rõ ràng** vì user yêu cầu cụ thể format "Ngày | Nhân viên | Thay đổi".

#### Scenario: Admin xem lịch sử khách

- **GIVEN** khách "Trần A" có 4 entry trong audit_log (1 create + 3 update)
- **WHEN** admin click row "Trần A" trong bảng QLKH
- **THEN** form autofill + section "Lịch sử thay đổi" hiển thị
- **AND** section render bảng 3 cột với 4 dòng (mới nhất trên cùng)

#### Scenario: Member KHÔNG thấy section

- **GIVEN** user role = `member`
- **WHEN** member vào tab QLKH (form có thể hiển thị nhưng disabled)
- **THEN** KHÔNG thấy section "Lịch sử thay đổi" (ẩn hoàn toàn)

#### Scenario: Form ở chế độ Add → ẩn section

- **GIVEN** admin đang ở Add mode, `editingClientId === null`
- **WHEN** admin xem form
- **THEN** KHÔNG thấy section "Lịch sử thay đổi" (chỉ form + nút Lưu)

#### Scenario: Khách mới chưa có entry update nào

- **GIVEN** khách "Lê B" vừa được tạo (1 entry `client_create`), chưa update lần nào
- **WHEN** admin click row "Lê B"
- **THEN** section hiển thị bảng với 1 dòng:
  - Ngày: `<thời gian create>`
  - Nhân viên: `<username>`
  - Thay đổi: `🆕 Tạo khách` + danh sách field khởi tạo (`Họ tên: Lê B`, `Số điện thoại chính: 0909-B`, ...)

#### Scenario: Khách rất cũ chưa từng có audit (pre-audit-log)

- **GIVEN** khách "Phạm Cũ" tồn tại từ trước khi triển khai add-audit-log → 0 row audit_log
- **WHEN** admin click row "Phạm Cũ"
- **THEN** section hiển thị `"Chưa có lịch sử thay đổi."`

#### Scenario: Auto-refresh sau khi Lưu sửa khách

- **GIVEN** admin đang xem section với 2 entry cho khách "Trần A"
- **WHEN** admin đổi địa chỉ + bấm Lưu thành công
- **THEN** section tự refetch và hiển thị 3 entry (entry mới `client_update` trên cùng)
- **AND** admin không cần F5

#### Scenario: Render cell "Thay đổi" với multi-field diff

- **GIVEN** entry `client_update` có `changes = {"fullname": ["Trần A", "Trần Anh"], "phone_primary": ["0909-A", "0912-NEW"], "phone_demoted_to_old": [null, "0909-A"]}`
- **WHEN** section render dòng này
- **THEN** cell "Thay đổi" hiển thị 4 dòng:
  - `✏️ Sửa`
  - `• Họ tên: Trần A → Trần Anh`
  - `• Số điện thoại chính: 0909-A → 0912-NEW`
  - `• Số chuyển thành cũ: 0909-A`
