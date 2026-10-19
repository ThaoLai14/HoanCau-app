# Tasks: add-client-phone-history

## 1. Database migration

- [x] 1.1 Tạo file `add-client-phone-old-type.sql` ở root repo với nội dung trong design §2.
- [ ] 1.2 Chạy migration trên Supabase staging, verify CHECK constraint tồn tại bằng `\d+ client_phones`. — **anh chạy**
- [ ] 1.3 Chạy 2 query find-orphan FK (design §2 comment), log kết quả. Xử lý thủ công nếu có (vd manual UPDATE bills.sender_phone_id = NULL). — **anh chạy**
- [ ] 1.4 Chạy migration trên Supabase production. — **anh chạy**

## 2. State + form fields

- [x] 2.1 Thêm state `const [newClientOldPhones, setNewClientOldPhones] = useState([])` trong `App.jsx`.
- [x] 2.2 Update `resetClientForm()` thêm `setNewClientOldPhones([])`.
- [x] 2.3 Thêm attribute `data-client-form-fullname` vào `<input>` Họ tên trong UI form.

## 3. handleStartEditClient (autofill + scroll + focus)

- [x] 3.1 Refactor `handleStartEditClient(c)` theo design §5:
  - Tách `primary`, `secondary`, `olds` từ `c.client_phones` theo `type`.
  - `setNewClientOldPhones(olds.map(p => p.phone_number))`.
  - Giữ `window.scrollTo({ top: 0, behavior: 'smooth' })`.
  - Thêm `setTimeout(() => document.querySelector('input[data-client-form-fullname]')?.focus(), 100)`.
  - **KHÔNG** call `setClientPage(...)` (giữ phân trang — D8).

## 4. UI form — vùng "Số cũ"

- [x] 4.1 Thêm khu vực mới trong form section, sau ô "Số điện thoại phụ", trước ô "Địa chỉ":
  - Title `📜 Số điện thoại cũ`.
  - List read-only render từ `newClientOldPhones`.
  - Empty state ẩn hoàn toàn (chỉ render khi `newClientOldPhones.length > 0`).
  - Note text "Không sửa được — đây là lịch sử, được dùng để bảo toàn bill cũ."

## 5. handleAddClient — compare-and-diff rewrite

- [x] 5.1 Trước khi save: nếu `editingClientId && initial.primary && newClientPhone !== initial.primary.phone_number`, gọi `askConfirm({ title: 'Số chính đã được thay đổi', message: 'Cũ: <X>\nMới: <Y>', confirmText: 'Xác nhận' })`. Nếu user huỷ → return.
- [x] 5.2 Snapshot `initial` từ `clients` list state (đã có): tìm theo `editingClientId` → `{ primary, secondary, olds }`.
- [x] 5.3 Validate: số chính ≠ số phụ (nếu cả 2 đều có giá trị).
- [x] 5.4 Build `ops` array theo design §3 (case Add mới và case Edit). — **Impl inline (không thực sự array, làm trực tiếp vì số nhánh ít).**
- [x] 5.5 Execute ops tuần tự (UPDATE clients đầu, sau đó UPDATE_TYPE và INSERT phones theo thứ tự trong ops). KHÔNG có DELETE.
- [x] 5.6 Show toast `"Đã cập nhật khách hàng!"` hoặc `"Đã lưu Khách Hàng mới thành công!"`.
- [x] 5.7 `fetchData()` + `resetClientForm()` (như hiện tại).
- [x] 5.8 Update `newClientOldPhones` ngay sau khi user confirm modal (UI hiển thị số cũ rớt xuống before save), KHÔNG đợi `fetchData()`. — **Optimistic append primary + secondary demote.**

## 6. ClientHistorySection inline

> **SKIP: chờ add-audit-log merge.** Tất cả task ở §6-8 cần `fetchAuditLog`, `logAudit`, `auditLabels.js`, `renderChanges` — những thứ do change `add-audit-log` cung cấp. Khi change đó merge, quay lại unblock §6-8. Placeholder TODO comment đã add trong `handleAddClient` (App.jsx).

- [x] 6.1 Tạo component `src/ClientHistorySection.jsx` với props `{ clientId, refreshKey, userRole }`.
- [x] 6.2 Component fetch `fetchAuditLog({ entityType: 'client', entityId: clientId })` on mount + on `refreshKey` change (thay vì `key={}` remount vì hiệu năng tốt hơn).
- [x] 6.3 Render danh sách entry inline (không phải bảng 3 cột — dùng card layout thống nhất với BillHistorySection): mỗi entry hiện icon action + username + role + text action + bullet diff + note italic + timestamp `dd/MM/yyyy HH:mm`. Ký hiệu action lấy từ `ACTION_LABELS`.
- [x] 6.4 Empty state: "Chưa có lịch sử thay đổi."
- [x] 6.5 Loading state: "Đang tải lịch sử..."
- [x] 6.6 Sort NEWEST → OLDEST (đã ORDER BY created_at DESC trong `fetchAuditLog`).

## 7. Wire ClientHistorySection vào UI

- [x] 7.1 Trong screen `currentTab === 'clients'`, dưới `<form>` (cùng cột trái), đã embed:
  ```jsx
  {editingClientId && userRole !== 'member' && (
    <ClientHistorySection clientId={editingClientId} refreshKey={clientHistoryRefreshKey} userRole={userRole} />
  )}
  ```
- [x] 7.2 Thêm state `const [clientHistoryRefreshKey, setClientHistoryRefreshKey] = useState(0)` (trong cụm state Bill Detail).
- [x] 7.3 Sau khi `handleAddClient` save thành công, `setClientHistoryRefreshKey(k => k + 1)` để force refetch.

## 8. Audit labels & logAudit integration

- [x] 8.1 Trong `src/auditLabels.js` (từ change `add-audit-log`), đã thêm:
  - `FIELD_LABELS.phone_primary = 'Số điện thoại chính'`
  - `FIELD_LABELS.phone_secondary = 'Số điện thoại phụ'`
  - `FIELD_LABELS.phone_demoted_to_old = 'Số chuyển thành cũ'`
- [x] 8.2 Trong `handleAddClient` (Add mode): gọi `logAudit({ action: 'client_create', ... })` với snapshot fullname/address/phone_primary/phone_secondary/is_blacklist.
- [x] 8.3 Trong `handleAddClient` (Edit mode): compute diff clients fields + phone changes, action `client_blacklist` nếu chỉ đổi is_blacklist, else `client_update`. Skip log nếu không có gì đổi.
- [x] 8.4 `phone_demoted_to_old` emit array giá trị (VD `[null, ['0909-A']]`) — `formatValue` trong auditLabels.js đã handle array (join ", ").

## 9. Smoke test

> **anh test** tất cả case sau khi chạy migration §1 xong.

- [ ] 9.1 Tạo khách mới có chính + phụ → bấm Lưu → toast hiện → audit log section (chưa hiện vì chưa edit mode) — kiểm tra DB có 2 row primary + secondary.
- [ ] 9.2 Click khách vừa tạo → form scroll lên, focus Họ tên, phân trang giữ nguyên.
- [ ] 9.3 Sửa tên → bấm Lưu → KHÔNG có modal (vì chưa đổi số chính) → audit section hiện 1 entry `Sửa: Họ tên: X → Y`.
- [ ] 9.4 Đổi Số chính → bấm Lưu → modal hiện "Cũ: X / Mới: Y" → bấm Xác nhận → DB:
  - Row primary cũ: `type='old'` (KHÔNG bị xoá, phone_number giữ nguyên).
  - Row mới: `type='primary'`, phone mới.
  - audit_log có entry `client_update` với `phone_primary` + `phone_demoted_to_old`.
- [ ] 9.5 Mở Bill Detail của 1 bill cũ trỏ vào số cũ → SĐT người gửi/nhận vẫn hiển thị đúng số cũ (JOIN OK).
- [ ] 9.6 Xoá Số phụ → bấm Lưu → KHÔNG modal → DB: row secondary cũ `type='old'`. Audit log entry `phone_demoted_to_old`.
- [ ] 9.7 Đổi Số chính, modal Huỷ → không có thay đổi nào trong DB.
- [ ] 9.8 Form Sửa Khách Hàng đang edit khách A → admin scroll xuống thấy bảng "Lịch sử thay đổi" 3 cột. Bảng ẩn khi user huỷ edit (về Add mode).
- [ ] 9.9 Khách trên page 3 — click row → scroll lên đầu, phân trang vẫn ở page 3 (KHÔNG reset về page 1).
- [ ] 9.10 Member login → vào tab QLKH → form hiện nhưng disabled (như hiện tại); section "Lịch sử thay đổi" KHÔNG hiện.
- [ ] 9.11 Sửa khách + tắt mạng → toast lỗi → state không lỗi nặng.

## 10. Documentation

- [ ] 10.1 Update README (nếu có) ghi tóm tắt: client_phones có 3 type, không bao giờ DELETE.
- [x] 10.2 Comment trong code `handleAddClient` link tới `openspec/changes/add-client-phone-history/design.md`.

## 12. Bug fix — Danh sách khách hàng hiển thị sai label SĐT (2026-07-02)

Bug: Cell SĐT trong table danh sách chỉ phân biệt `primary` vs "Phụ", khiến `type='old'` bị mislabel là "Phụ". Ngoài ra không sort, số chính có thể xuất hiện cuối cell nếu bị demote/insert lại.

- [x] 12.1 Sort `client_phones` theo priority `primary(0) → secondary(1) → old(2)` trước khi render (không mutate array gốc — dùng spread copy).
- [x] 12.2 Map 3 label riêng: `primary → "Chính"`, `secondary → "Phụ"`, `old → "Cũ"`.
- [x] 12.3 Style badge phân biệt visually: Chính = nền cam nhạt + text cam đậm; Phụ = nền xám + text xám đậm; Cũ = nền trắng + text xám nhạt + italic (đánh dấu là lịch sử).
- [x] 12.4 Search theo SĐT vẫn match cả 3 loại (kể cả `old`) — không đổi logic search hiện tại.
- [x] 12.5 Add requirement mới trong `specs/customer-management/spec.md`: "Danh sách khách hàng hiển thị SĐT theo loại đúng thứ tự" + 3 scenario (3 loại đầy đủ / primary + old / search theo số cũ).
- [ ] 12.6 [ANH TEST] Mở QLKH → khách "Chị Lan Cà Phê" phải thấy Chính trên, Phụ giữa, Cũ dưới (label đúng).

## 11. Archive

- [ ] 11.1 Verify tất cả requirements trong delta specs pass smoke test.
- [ ] 11.2 Chạy `openspec validate add-client-phone-history --strict`.
- [ ] 11.3 Anh review & approve → chạy `openspec archive add-client-phone-history` để merge delta vào main specs.
