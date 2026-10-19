# Change: add-client-phone-history

> **Status**: 🟢 READY — chốt scope 2026-06-30.
> **Capabilities**: `customer-management` (chính), `audit-log` (phụ — UI inline section).
> **Cross-ref**: phụ thuộc `add-audit-log` cho helper `logAudit()` / `fetchAuditLog()`.

## Why

Bug đã được flag từ lâu trong [main spec `customer-management`](../../specs/customer-management/spec.md) (Requirement "Sửa khách hàng — xóa và insert lại SĐT", line 22-37) nhưng chưa fix:

```
handleAddClient (edit mode) hiện tại:
  1. UPDATE clients SET fullname, address, is_blacklist, blacklist_reason
  2. DELETE FROM client_phones WHERE client_id = editingClientId   ⚠️
  3. INSERT lại client_phones từ form
```

Hậu quả:
- Mọi bill cũ có `sender_phone_id` / `receiver_phone_id` trỏ tới row vừa bị DELETE → **orphan FK**.
- Bill Detail của bill cũ JOIN trả NULL → SĐT người gửi/nhận trống.
- Bug xảy ra **kể cả khi admin chỉ sửa tên** (không đụng số) — vì code vẫn DELETE phone rows.
- Khi khách thật sự đổi số (chuyển sim mới): code hiện tại không bảo toàn lịch sử — admin không tra cứu được "trước đây khách dùng số nào".

Cùng lúc, anh muốn:
- UI rõ ràng có **3 ô SĐT**: Chính (required) / Phụ / Cũ (list read-only).
- Section "📜 Lịch sử thay đổi" inline ngay dưới form Sửa Khách Hàng (giống pattern BillHistorySection trong change `add-audit-log`).
- Click row khách → auto-fill form, scroll lên đầu trang, giữ phân trang.

## Decisions (chốt 2026-06-30)

**D1**: `client_phones.type` mở rộng thành 3 giá trị: `primary | secondary | old`. Bổ sung `'old'`.

**D2**: Logic save **TUYỆT ĐỐI KHÔNG DELETE** `client_phones` row. Chỉ:
  - INSERT row mới (cho số chính/phụ mới).
  - UPDATE `type` (flip `primary`/`secondary` → `old` khi số cũ bị thay).
  - Riêng case typo thuần tuý (xem D5 + design §3 quyết định) → vẫn KHÔNG UPDATE `phone_number` — luôn INSERT mới + flip cũ.

**D3**: Bill cũ luôn JOIN được row gốc (vì row không bao giờ bị xoá); chỉ `type` bị flip sang `'old'`. FK `bills.sender_phone_id` / `receiver_phone_id` được bảo toàn vĩnh viễn.

**D4**: UI form có 3 vùng SĐT:
  - **Số chính** *(REQUIRED)*: 1 input.
  - **Số phụ** *(optional)*: 1 input.
  - **Số cũ**: list read-only (không cho admin nhập tay; chỉ auto-populate khi đổi số chính/phụ trong cùng phiên edit hoặc khi load từ DB).

**D5**: Khi user đổi Số chính → bấm Lưu → hệ thống PROMPT modal đơn giản:
```
Số chính đã được thay đổi
Cũ: <số cũ>    Mới: <số mới>
[ Huỷ ]    [ Xác nhận ]
```
Sau khi Xác nhận: số cũ tự động được flip type='old' trong DB. UI form refresh hiển thị nó trong vùng "Số cũ".

KHÔNG có 2 radio "typo vs đổi số" — luôn coi là đổi số (an toàn cho bill cũ).

**D6**: Số phụ thay đổi/xoá → tự động flip type='old' không cần modal (số phụ ít trường hợp typo, và admin nhiều khi chỉ muốn dọn dẹp).

**D7**: Section thêm khách / sửa khách dùng **CHUNG 1 form** (toggle title 🆕 Thêm / ✏️ Sửa — như hiện tại).

**D8**: Click vào row khách trong bảng:
  - `window.scrollTo({ top: 0, behavior: 'smooth' })` (đã có).
  - Focus ô **Họ tên** (mới — chưa có).
  - **KHÔNG** đụng state `clientPage` (giữ phân trang — đã đúng trong code hiện tại, ghi rõ làm requirement để không bị regress).

**D9**: Bên dưới form Sửa Khách Hàng (CHỈ khi `editingClientId !== null`) hiện section "📜 Lịch sử thay đổi" — bảng 3 cột (Ngày | Nhân viên | Thay đổi). UI inline tương tự `BillHistorySection` của change `add-audit-log`. Yêu cầu UI chính thức được mô tả ở delta spec `audit-log` (cross-ref).

**D10**: Migration: thêm CHECK constraint `client_phones.type IN ('primary','secondary','old')`. KHÔNG cần data backfill (chưa có row `'old'` nào).

**D11**: Audit log action: dùng action sẵn có `client_update`; mở rộng payload `changes` để chứa diff phone:
  - `phone_primary: [oldNumber, newNumber]` khi số chính đổi.
  - `phone_secondary: [oldNumber, newNumber]` khi số phụ đổi.
  - `phone_demoted_to_old: [null, "<số>"]` khi 1 số bị flip xuống 'old'.
  - 1 lần Save = 1 audit_log entry (cộng tất cả diff vào 1 changes JSONB).

**D12**: `clients.address`, `is_blacklist`, `blacklist_reason` không đổi semantics. Vẫn được UPDATE bình thường trong cùng save.

## In-scope

1. DB migration: ALTER TABLE `client_phones` ADD CHECK constraint `type IN ('primary','secondary','old')`.
2. `handleAddClient` rewrite theo logic compare-and-diff (xem design §3).
3. `handleStartEditClient`: populate `newClientOldPhones` từ DB; scroll + focus ô Họ tên; KHÔNG đụng pagination.
4. UI form: thêm vùng "📜 Số cũ" read-only list bên dưới số phụ.
5. Modal confirm khi đổi Số chính (D5).
6. `logAudit()` call cho mọi save khách với payload phone diffs (D11).
7. Cross-capability: delta spec `audit-log` thêm requirement "Section Lịch sử khách hàng inline trên form Sửa Khách Hàng".
8. Render section Lịch sử khách hàng dưới form (chỉ edit mode).

## Out of scope

- Bulk import phones từ CSV.
- UI cho admin nhập tay vào "Số cũ" (số cũ chỉ tự sinh).
- Cross-client phone merging (1 số dùng cho 2 khách).
- Khôi phục số `'old'` về `'primary'` (vd khách quay lại số cũ) — phải xử lý tay qua DB.
- Audit log cho client KHI tạo qua intake (`resolveOrCreateClient`) — đã thuộc change `add-audit-log` task §4.1.

## Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Admin gõ nhầm số chính → bấm Xác nhận modal → số sai bị lưu vào "Số cũ" | Trade-off chấp nhận. Số sai trong "Số cũ" vô hại (bill cũ vẫn đúng vì FK trỏ row gốc). Admin có thể xử lý tay nếu cần. |
| R2 | Bill rất cũ (đã orphan trước migration) | Query find orphan FK trước migration, log ra; xử lý thủ công. Không tự fix được. |
| R3 | Khách quay lại số `'old'` cũ → admin muốn promote lên primary | Out of scope. Workaround: admin xoá số chính hiện tại (modal demote nó xuống 'old'), nhập lại số cũ vào ô chính → tạo row mới (ID khác với row cũ đã 'old'). Trùng `phone_number` nhưng khác id — DB cho phép vì không có UNIQUE constraint trên `phone_number`. |
| R4 | Performance: 1 khách có quá nhiều số 'old' (vd 10+) | Không vấn đề thực tế. UI render list scroll. |

## Interactions

| Change | Quan hệ |
|---|---|
| `add-audit-log` | **DEPENDENCY** — tận dụng `logAudit()`, `fetchAuditLog()`, `auditLabels.js`, table `audit_log`. Inline section Lịch sử khách hàng được mô tả trong delta `audit-log` của change này (extends pattern của BillHistorySection). |
| `fix-shipment-intake-issues` | **INDEPENDENT, COMPATIBLE** — change đó lo intake-side (KHÔNG sửa khách cũ); change này lo QLKH-side. `resolveOrCreateClient` của intake không chạm `'old'` rows (vẫn match trên tất cả `client_phones` JOIN clients — xem R5 dưới). |

**R5**: `resolveOrCreateClient` của intake hiện match key = `(LOWER(fullname), phone_number)` trên tất cả rows `client_phones` (loại `is_delete`). Sau migration, các row `type='old'` vẫn nằm trong join → **vẫn match được nếu nhân viên gõ số cũ**. Hành vi này hợp lý: khách dùng số cũ tới gửi hàng → tìm ra đúng client cũ → tạo bill liên kết về client cũ + phone_id (kể cả là row 'old'). Bill mới có thể trỏ về row 'old' — chấp nhận được vì row vẫn tồn tại, hiển thị OK.

> Note: hệ quả là khách dùng số cũ tạo bill mới → bill mới trỏ vào row 'old'. Khi xem Bill Detail, badge "(cũ)" có thể hiển thị (hoặc không) — tuỳ UI decision, không ảnh hưởng DB.
