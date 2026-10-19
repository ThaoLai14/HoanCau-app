## MODIFIED Requirements

### Requirement: Chống trùng bill_code bằng UNIQUE constraint + modal confirm
Database SHALL enforce duy nhất `bill_code` trong cùng chi nhánh thông qua constraint `UNIQUE (branch_id, bill_code)` trên bảng `bills`. NULL trong constraint này KHÔNG xung đột với NULL khác (theo behavior mặc định của PostgreSQL UNIQUE) → nhiều draft cùng có `bill_code = NULL` vẫn được phép.

Hàm insert/convert bill SHALL áp dụng quy trình "optimistic insert + modal confirm" để xử lý race condition khi 2 thiết bị cùng chi nhánh reserve trùng mã:

1. Insert/Update với `bill_code` đã preview trên UI.
2. Nếu DB trả về lỗi `23505` trên constraint `bills_branch_code_uniq` → gọi `reserveBillCode(branch_id)` để tính mã mới dựa trên state DB hiện tại.
3. Hiển thị modal confirm với nội dung: `"Đã tồn tại mã <oldCode>. Mã mới được cập nhật: <newCode>."` và 1 nút `[OK]`.
4. Khi user bấm OK → cập nhật `reservedBillCode` trên state UI thành `newCode`, sau đó re-submit insert/update với `bill_code = newCode`.
5. Lặp tối đa 5 lần. Nếu vẫn duplicate lần 5 → throw error "Không reserve được mã đơn sau 5 lần thử. Vui lòng thử lại."

Quy trình này áp dụng cho cả `executeCreateBill` (insert) và `executeConvertDraftToBill` (update từ draft NULL sang pending có mã thật).

> Lưu ý implementation: KHÔNG được dùng "silent retry" (tự đổi mã không thông báo) vì user đã thấy mã preview cũ trên UI và có thể đã in/giao cho khách trước khi submit. Phải dừng lại confirm để user biết mã đã đổi.

#### Scenario: 2 thiết bị cùng chi nhánh, cùng lúc — máy submit sau bị đổi mã
- **GIVEN** thiết bị A và B cùng mở form lúc seq hiện tại = 7, cùng preview mã `08SGA07`
- **WHEN** thiết bị A submit trước → DB insert thành công với `bill_code = "08SGA07"`
- **AND** thiết bị B submit ngay sau → DB trả lỗi 23505 vì violate `bills_branch_code_uniq`
- **THEN** thiết bị B gọi lại `reserveBillCode("SG")` → nhận `newCode = "09SGA07"`
- **AND** modal hiển thị `"Đã tồn tại mã 08SGA07. Mã mới được cập nhật: 09SGA07."` với nút [OK]
- **AND** sau khi user thiết bị B bấm OK → re-submit với `bill_code = "09SGA07"` → insert thành công
- **AND** UI thiết bị B cập nhật hiển thị mã `09SGA07` thay vì `08SGA07`

#### Scenario: Convert draft → pending bị trùng mã
- **GIVEN** thiết bị A đang convert draft thành pending với `bill_code = "10SGA07"`
- **AND** thiết bị B vừa insert đơn mới với `bill_code = "10SGA07"`
- **WHEN** thiết bị A submit UPDATE
- **THEN** DB trả lỗi 23505
- **AND** thiết bị A gọi `reserveBillCode("SG")` → `"11SGA07"`, hiển thị modal confirm
- **AND** sau OK → UPDATE lại với `bill_code = "11SGA07"` thành công

#### Scenario: Draft KHÔNG bị chặn bởi UNIQUE
- **WHEN** 5 thiết bị cùng tạo draft (insert bill với `delivery_status = "draft"`, `bill_code = NULL`)
- **THEN** cả 5 insert đều thành công (PostgreSQL UNIQUE coi NULL khác NULL)
- **AND** KHÔNG có thiết bị nào bị lỗi 23505

#### Scenario: 5 lần liên tiếp đều race → báo lỗi
- **WHEN** thiết bị A submit và bị duplicate 5 lần liên tiếp (do nhiều thiết bị khác cùng submit đồng thời)
- **THEN** sau lần thứ 5 vẫn duplicate, hệ thống KHÔNG retry nữa
- **AND** hiển thị toast lỗi `"Không reserve được mã đơn sau 5 lần thử. Vui lòng thử lại."`
- **AND** bill KHÔNG được insert

#### Scenario: Lỗi DB khác (không phải duplicate) — propagate ngay
- **WHEN** insert bill bị lỗi DB khác (vd FK violation, schema error)
- **THEN** hệ thống KHÔNG retry, KHÔNG hiển thị modal mã đơn
- **AND** propagate error gốc lên UI như thông thường
