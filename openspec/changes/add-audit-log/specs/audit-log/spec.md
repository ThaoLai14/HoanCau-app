# Delta: audit-log (add-audit-log)

> New capability — toàn bộ là ADDED requirements.

## ADDED Requirements

### Requirement: Append-only audit_log table

Hệ thống SHALL có 1 bảng `audit_log` lưu mọi sự kiện mutation đáng track. Bảng này là **append-only**: không có UI/code path nào được UPDATE hoặc DELETE row sau khi đã insert.

Schema tối thiểu:
- `id` BIGSERIAL primary key
- `created_at` TIMESTAMPTZ NOT NULL DEFAULT now()
- `user_id` UUID FK to `users(id)` ON DELETE SET NULL
- `username` TEXT NOT NULL (snapshot)
- `user_role` TEXT NOT NULL (snapshot, ∈ {admin, member, boss})
- `entity_type` TEXT NOT NULL (∈ {bill, client, expense, session})
- `entity_id` UUID (nullable cho session events)
- `entity_label` TEXT (tên hiển thị, vd bill_code)
- `action` TEXT NOT NULL (enum kín — xem requirement "Sự kiện được log")
- `changes` JSONB (diff cũ → mới, dạng `{field: [old, new]}`)
- `note` TEXT (ghi chú tự do)

#### Scenario: Insert row mới sau khi sửa bill

- **WHEN** admin sửa bill `05SGA02` (cước 0 → 250000)
- **THEN** insert 1 row vào `audit_log` với `entity_type='bill'`, `entity_id=<uuid>`, `action='bill_update'`, `changes={"shipping_fee": [0, 250000]}`

#### Scenario: User bị xoá — username snapshot còn

- **GIVEN** audit_log có row của user "Linh" (admin)
- **AND** sau đó user "Linh" bị xoá khỏi `users`
- **WHEN** đọc audit_log row đó
- **THEN** `user_id = NULL` (ON DELETE SET NULL), `username = "Linh"`, `user_role = "admin"` vẫn đọc được

#### Scenario: KHÔNG có UPDATE/DELETE policy

- **WHEN** bất kỳ user nào (kể cả admin) cố UPDATE hoặc DELETE row audit_log
- **THEN** request bị reject (RLS không có policy cho UPDATE/DELETE)

### Requirement: Sự kiện được log (action enum kín)

`audit_log.action` SHALL chỉ nhận 1 trong các giá trị sau (CHECK constraint):

| `action` | Trigger |
|---|---|
| `bill_create` | Tạo bill mới (cả `pending` lẫn `draft`) |
| `bill_update` | Admin sửa bill pending hoặc convert draft → pending |
| `bill_cancel` | Huỷ bill (cả draft DELETE lẫn pending soft-cancel) |
| `bill_delivered` | Đánh dấu giao xong (`delivery_status` → `delivered`) |
| `bill_payment_received` | Thu cước cho đơn `unpaid` → `paid` |
| `client_create` | Tạo khách mới (qua intake hoặc tab QLKH) |
| `client_update` | Sửa thông tin khách qua tab QLKH (trừ blacklist toggle) |
| `client_delete` | Soft-delete khách |
| `client_blacklist` | Đánh blacklist hoặc bỏ blacklist |
| `expense_create` | Thêm chi phí phát sinh |
| `expense_update` | Admin sửa chi phí (amount / note / created_at) |
| `expense_delete` | Admin soft-delete chi phí (`expenses.is_delete = true`) |
| `refund_created` | Tự động khi cancel bill có payment (auto-INSERT expense hoàn tiền) |
| `session_departure` | Xuất bến (rollover business_date trên `branch_sessions`) |

Các thao tác KHÔNG được log: login, autocomplete query, mở form, xem dữ liệu (read events).

#### Scenario: Tạo bill mới — log bill_create

- **WHEN** user submit form intake thành công
- **THEN** 1 row audit_log với `action='bill_create'` được insert
- **AND** `entity_label = bill.bill_code` (hoặc `'Nháp'` nếu là draft)

#### Scenario: Login — KHÔNG log

- **WHEN** user đăng nhập thành công
- **THEN** KHÔNG có row mới trong audit_log

#### Scenario: Xuất bến — log session_departure

- **WHEN** admin bấm Xuất Bến cho SG
- **THEN** insert audit_log với `action='session_departure'`, `entity_type='session'`, `entity_id=NULL`, `entity_label='SG - 25/06/2026 → 26/06/2026'`

### Requirement: logAudit() helper KHÔNG block luồng chính

Helper `logAudit()` SHALL được gọi SAU KHI mutation chính thành công. Nếu `logAudit()` fail (mạng, RLS, schema mismatch), MUST KHÔNG throw lên main flow — chỉ `console.warn`.

Lý do: audit là phụ trợ. User không được mất kết quả nghiệp vụ chỉ vì log lỗi.

#### Scenario: Insert audit fail vì mất mạng

- **GIVEN** user vừa sửa bill thành công (UPDATE bills OK)
- **WHEN** call `logAudit()` lỗi (network timeout)
- **THEN** main flow tiếp tục: toast "Đã cập nhật đơn 05SGA02", form đóng
- **AND** console.warn `[audit] insert failed: ...`
- **AND** KHÔNG hiển thị lỗi cho user

#### Scenario: Session expired giữa chừng

- **GIVEN** `localStorage['hc_session']` bị xoá giữa lúc submit
- **WHEN** `logAudit()` được gọi
- **THEN** skip insert + warn `[audit] no session, skip log`
- **AND** main flow KHÔNG bị ảnh hưởng

### Requirement: Diff field cũ → mới được lưu dạng JSONB

`audit_log.changes` SHALL có dạng `{field_name: [old_value, new_value], ...}` cho `action` thuộc `*_update` hoặc transition (vd `bill_delivered`).

Quy tắc:
- Mỗi key = tên cột raw (snake_case, vd `shipping_fee`, `payment_status`).
- Mỗi value = array `[old, new]`. Cả `old` và `new` đều là giá trị raw (chưa format).
- Nếu không có field nào thay đổi → KHÔNG insert audit_log (skip).
- Field FK (vd `sender_id`) KHÔNG track — track snapshot text columns thay vì (vd `sender_name_text`).
- Diff `'' ↔ null` được coi là không đổi (skip).

Đối với action **`bill_create`** (và các action create khác như `expense_create`, `client_create`, `session_departure`): `changes` SHALL chứa snapshot toàn bộ field quan trọng ở dạng `{field: [null, newValue]}` để section Lịch sử inline có thể render danh sách field khởi tạo mà KHÔNG cần extra query đến `bills`/`expenses`/...

Action `bill_cancel`, `client_delete` → `changes = NULL` (chỉ cần `note` để giải thích).

Các field nào vào snapshot `bill_create` (giữ tối thiểu nhưng đủ để admin/boss đọc hiểu đơn lúc tạo):
- `shipping_fee`, `payment_status`, `business_date`
- `sender_name_text`, `sender_phone_text`, `sender_address`
- `receiver_name_text`, `receiver_phone_text`, `receiver_address`
- `package_count`, `goods_description`
- `order_note` (nếu có)

Các action không cần diff (`bill_cancel`, `client_delete`) → `changes = NULL`.

#### Scenario: Update bill nhiều field

- **GIVEN** bill có `shipping_fee=0`, `payment_status='quote_later'`
- **WHEN** admin sửa thành `shipping_fee=250000`, `payment_status='paid'`
- **THEN** `audit_log.changes = {"shipping_fee": [0, 250000], "payment_status": ["quote_later", "paid"]}`

#### Scenario: Update KHÔNG đổi gì — skip log

- **GIVEN** bill `05SGA02`
- **WHEN** admin mở form, KHÔNG sửa gì, bấm Lưu
- **THEN** KHÔNG có row mới trong audit_log
- **AND** main flow vẫn complete bình thường

#### Scenario: Diff `null ↔ ''` — skip

- **GIVEN** bill có `order_note = ''`
- **WHEN** admin sửa form (UI hiển thị input rỗng → set state null)
- **THEN** field `order_note` KHÔNG vào `changes` (coi như không đổi)

### Requirement: Section "Lịch sử đơn" inline trong Bill Detail (admin/boss)

Bill Detail screen SHALL có 1 **section read-only "📜 Lịch sử đơn"** luôn hiển thị (KHÔNG phải modal, không cần click nút mở). Section render timeline tất cả audit_log entries của bill đó.

Quy tắc UI:
- Section HIỂN THỊ khi `userRole ∈ {admin, boss}`. Member KHÔNG thấy section.
- Vị trí: cuối Bill Detail screen (sau section "Thanh toán & Giao nhận").
- Entries sắp xếp NEWEST → OLDEST (mới nhất ở trên cùng).
- Mỗi entry hiển thị: icon (theo `action`), thời gian `dd/MM/yyyy HH:mm`, `username (user_role)`, mô tả action tiếng Việt.
- Nếu entry có `changes` → render mỗi field 1 dòng bullet `"• <FieldLabel>: <oldFormatted> → <newFormatted>"`.
  - Nếu `old = null` và `new` có giá trị (case `bill_create` hoặc set field lần đầu): render `"• <FieldLabel>: <newFormatted>"` (không có mũi tên).
- Nếu entry có `note` → hiển thị italic dưới changes: `"Ghi chú: <note>"`.
- Empty state: "Chưa có lịch sử cho đơn này."
- Loading state: "Đang tải lịch sử...".
- Auto-refresh sau mỗi mutation trên bill (vd sau "Hoàn tất giao hàng", section refetch).

#### Scenario: Admin xem lịch sử bill

- **GIVEN** bill `05SGA02` có 4 entry trong audit_log
- **WHEN** admin mở Bill Detail
- **THEN** section "Lịch sử đơn" hiển thị ngay (không cần click)
- **AND** 4 entry sắp xếp từ mới → cũ
- **AND** entry mới nhất ở trên cùng

#### Scenario: Member KHÔNG thấy section Lịch sử

- **GIVEN** user role = `member`
- **WHEN** member mở Bill Detail
- **THEN** KHÔNG thấy section "Lịch sử đơn" (ẩn hoàn toàn)

#### Scenario: Bill vừa tạo - 1 entry bill_create

- **GIVEN** bill mới tạo, chưa từng sửa
- **WHEN** admin mở Bill Detail
- **THEN** section lịch sử hiển thị 1 entry `bill_create` với danh sách field khởi tạo

#### Scenario: Bill không có entry nào (edge case)

- **GIVEN** bill tạo lúc audit log fail vì mat mạng → 0 row trong audit_log
- **WHEN** admin mở Bill Detail
- **THEN** section hiển thị "Chưa có lịch sử cho đơn này."

#### Scenario: Render bill_create với list field

- **GIVEN** entry `bill_create` có `changes = {"shipping_fee": [null, 250000], "sender_name_text": [null, "Trần A"], "receiver_name_text": [null, "Lê B"], "package_count": [null, 3]}`
- **WHEN** section render entry này
- **THEN** hiển thị header `"🆕 30/06/2026 17:00 — Thạch (admin) tạo đơn"`
- **AND** dưới header: 4 dòng bullet:
  - `"• Cước phí: 250,000 VND"`
  - `"• Tên người gửi: Trần A"`
  - `"• Tên người nhận: Lê B"`
  - `"• Số kiện: 3"`

#### Scenario: Render diff cước phí tiếng Việt

- **GIVEN** entry `bill_update` có `changes = {"shipping_fee": [0, 250000]}`
- **WHEN** section render entry này
- **THEN** hiển thị dòng `"• Cước phí: 0 VND → 250,000 VND"` (có mũi tên vì old ≠ null)

#### Scenario: Render diff payment_status tiếng Việt

- **GIVEN** entry có `changes = {"payment_status": ["quote_later", "paid"]}`
- **WHEN** section render
- **THEN** hiển thị `"• Trạng thái TT: Báo giá sau → Đã thanh toán"`

#### Scenario: Auto-refresh sau mutation

- **GIVEN** admin mở Bill Detail của `05SGA02`, section lịch sử đang hiển thị 2 entry
- **WHEN** admin bấm "Hoàn tất giao hàng" → tạo entry `bill_delivered` mới
- **THEN** section lịch sử tự refetch và hiển thị 3 entry (entry mới trên cùng)
- **AND** UI bị stale state được giải quyết mà user không cần F5

### Requirement: Field/enum/action labels có file constants tập trung

Code SHALL có 3 map constants ở `src/auditLabels.js`:
- `FIELD_LABELS`: technical field name → tiếng Việt label.
- `ENUM_LABELS`: field name → { enum_value → label tiếng Việt }.
- `ACTION_LABELS`: action → { text, icon, color }.

UI section render diff MUST đọc từ 3 map này. KHÔNG hardcode label trong component.

Lý do: khi thêm field/enum/action mới, chỉ phải sửa 1 chỗ.

#### Scenario: Thêm enum mới — chỉ update auditLabels.js

- **GIVEN** team thêm `payment_status` value mới `'partial_paid'` ở change tương lai
- **WHEN** dev thêm `partial_paid: 'TT 1 phần'` vào `ENUM_LABELS.payment_status`
- **THEN** section tự render đúng label, KHÔNG cần sửa component

#### Scenario: Field chưa có trong FIELD_LABELS — fallback raw

- **GIVEN** audit_log entry có `changes` chứa field `xyz_unknown` chưa map
- **WHEN** section render
- **THEN** hiển thị `"xyz_unknown: ..."` (fallback raw name, không crash)

### Requirement: Audit log chỉ admin/boss đọc được (UI-enforced)

`audit_log` SHALL chỉ được query bởi role `admin` hoặc `boss`. Member MUST KHÔNG thấy nút truy cập audit và MUST KHÔNG được fetch endpoint audit.

Best-effort enforcement do app dùng custom auth (chưa có Supabase Auth):
- **UI level**: ẩn section "Lịch sử đơn" trong Bill Detail khi `userRole = 'member'`.
- **Code level**: helper `fetchAuditLog()` check role trước khi query.

Strict DB-level RLS sẽ áp dụng sau khi migrate sang Supabase Auth (change riêng).

#### Scenario: Member cố gọi fetchAuditLog

- **GIVEN** user role = `member`
- **WHEN** code path gọi `fetchAuditLog()` (vd qua devtool)
- **THEN** helper throw "Chỉ admin/boss được xem audit log" hoặc trả [] (tuỳ implementation)
- **AND** UI không gọi đến helper này cho member

#### Scenario: Admin query audit_log

- **GIVEN** user role = `admin`
- **WHEN** admin mở Bill Detail → section Lịch sử auto-fetch
- **THEN** query thành công, trả về entries
