# Tasks: refine-shipment-intake-round-2

Ordering theo dependency. Group 4 (RPC) trước — vì các group khác sẽ dùng RPC.
Nhưng bên trong mỗi group tasks có thể chạy song song.

Tổng: 34 tasks.

## Group 4: Data integrity (foundation — làm trước)

### 4.1. RPC atomic bill + audit_log

- [ ] 4.1.1. Migration `create-bill-rpc.sql`: tạo function
      `create_bill_with_audit(bill_data JSONB, audit_data JSONB) RETURNS UUID`
      — INSERT `bills` + `audit_log` + (nếu paid) `bill_payment_details`.
- [ ] 4.1.2. Migration `update-bill-rpc.sql`: tạo function
      `update_bill_with_audit(target_bill_id UUID, bill_data JSONB, audit_data JSONB)`
      — UPDATE `bills` + INSERT `audit_log` với diff.
- [ ] 4.1.3. Migration `cancel-bill-rpc.sql`: tạo function
      `cancel_bill_with_audit(target_bill_id UUID, cancel_reason TEXT, audit_data JSONB)`
      — UPDATE `delivery_status='cancelled'` + (nếu paid) INSERT `expenses` refund
      + INSERT `audit_log`.
- [ ] 4.1.4. Migration `soft-delete-draft-rpc.sql`: tạo function
      `soft_delete_draft_with_audit(target_bill_id UUID, cancel_reason TEXT, audit_data JSONB)`
      — UPDATE `is_delete=true` + INSERT `audit_log`.
- [ ] 4.1.5. Test 4 RPC bằng psql/Supabase SQL editor với sample data (paid,
      unpaid, quote_later, free — mỗi case).

### 4.2. ClientAutocomplete filter 'old'

- [ ] 4.2.1. Update query trong `src/ClientAutocomplete.jsx` thêm
      `AND cp.type IN ('primary','secondary')`.
- [ ] 4.2.2. Test manual: khách có primary + secondary + old → gõ số 'old' →
      không suggest; gõ tên khách → suggest chỉ hiển primary + secondary.

## Group 1: Role & permissions

### 1.1. Bỏ backdate

- [ ] 1.1.1. Trong `src/App.jsx` form intake: đổi `sendDate` input thành
      `disabled` cho MỌI role (bỏ điều kiện `role === 'admin'`).
- [ ] 1.1.2. Update helper `getBusinessDate()` để LUÔN dùng
      `session.business_date` khi submit, bỏ path đọc từ `sendDate` state.
- [ ] 1.1.3. Test: admin login mở form → field "Ngày gửi" xám, không nhập được.

### 1.2. Member sửa/hủy được draft/pending

- [ ] 1.2.1. Bỏ check `role !== 'member'` ở nút "Sửa" và "Hủy" trong bill detail.
- [ ] 1.2.2. Add check `bills.branch_id === session.branch_id` — chặn cross-branch.
- [ ] 1.2.3. Add check `payment_status !== 'paid'` cho nút "Sửa" — disabled + tooltip.
- [ ] 1.2.4. RPC functions (4.1.2, 4.1.3) enforce cùng check server-side.

### 1.3. Boss KHÔNG sửa/hủy

- [ ] 1.3.1. Trong bill detail: role='boss' → nút "Sửa" và "Hủy" ẩn hoàn toàn.
- [ ] 1.3.2. RPC functions reject nếu `session.role = 'boss'`.

### 1.4. Admin KHÔNG cross-branch sửa

- [ ] 1.4.1. Đã cover ở 1.2.2 (dùng chung check).
- [ ] 1.4.2. Test: admin login SG mở bill của GL → nút Sửa/Hủy disabled.

### 1.5. Bill paid KHÔNG sửa

- [ ] 1.5.1. Đã cover ở 1.2.3.
- [ ] 1.5.2. Add tooltip trên nút Sửa disabled: "Bill đã thu tiền, muốn thay
      đổi vui lòng hủy đơn".

## Group 2: Cancel flow

### 2.1. Draft cancel = soft delete

- [ ] 2.1.1. Trong `src/App.jsx` handler hủy draft: đổi từ
      `DELETE FROM bills WHERE id=?` sang gọi RPC `soft_delete_draft_with_audit`.
- [ ] 2.1.2. Filter list nháp trong UI: thêm `WHERE is_delete=false`.
- [ ] 2.1.3. Test: hủy 1 draft → row vẫn còn trong DB (`is_delete=true`), UI
      không hiển; audit_log có row action='bill_draft_cancel'.

### 2.2. Field "lý do hủy" trên UI + audit_log

- [ ] 2.2.1. Modal Hủy đơn (cả draft + pending): thêm text input "Lý do hủy"
      (required, maxLength=200).
- [ ] 2.2.2. Handler submit: truyền `cancel_reason` vào RPC.
- [ ] 2.2.3. Bỏ code prepend `order_note` (base spec cũ).
- [ ] 2.2.4. Section "Lịch sử đơn" (audit UI) render `diff.reason` cho action
      `bill_cancel` và `bill_draft_cancel` với label "Lý do hủy".

### 2.3. Hủy đơn paid → auto expense refund

- [ ] 2.3.1. Function `cancel_bill_with_audit` (task 4.1.3) tự check
      `payment_status='paid'` → INSERT `expenses(amount = -actual_amount_paid, ...)`.
- [ ] 2.3.2. Client không cần thao tác gì thêm — chỉ hiển toast "Đã hủy đơn
      + hoàn cước <số tiền>".
- [ ] 2.3.3. Test: hủy 1 bill paid 250k → `delivery_status='cancelled'`,
      `expenses` có row `amount=-250000`, `source_bill=<bill_id>`.
- [ ] 2.3.4. Tab Doanh thu hiển expense refund cộng dồn với revenue theo dấu.

## Group 3: Form UI/UX

### 3.1. Bỏ `expected_id_info` — dual-purpose `order_note`

- [ ] 3.1.1. Migration `merge-expected-id-into-order-note.sql`:
      - Backfill: `UPDATE bills SET order_note = ... WHERE expected_id_info IS NOT NULL`
        (rule concat + truncate 200).
      - Log rows bị truncate.
      - `ALTER TABLE bills DROP COLUMN expected_id_info`.
      - `ALTER TABLE bills ADD CONSTRAINT bills_order_note_length_check
        CHECK (char_length(order_note) <= 200)`.
- [ ] 3.1.2. UI form: bỏ input `expectedIdInfo`, bỏ state `[expectedIdInfo, setExpectedIdInfo]`.
- [ ] 3.1.3. `orderNote` input: thêm `maxLength=200`, hiển counter "N/200".
- [ ] 3.1.4. Conditional required + placeholder + error message:
      - Compute từ `requireIdCheck` + `exportVat`.
      - Placeholder + error text theo bảng D4 (design.md).
- [ ] 3.1.5. Validation submit: nếu required + trống → toast lỗi tương ứng.
- [ ] 3.1.6. `auditLabels.js`: bỏ label `expected_id_info`.

### 3.2. Auto-populate địa chỉ receiver

- [ ] 3.2.1. Handler resolve receiver: khi match cũ + có `clients.address` →
      set `setDeliveryAddress(clients.address)`.
- [ ] 3.2.2. Chỉ populate khi form đang tạo mới hoặc load draft; KHÔNG override
      khi load bill cũ (dùng snapshot `bills.delivery_address`).
- [ ] 3.2.3. Test: chọn receiver cũ có address → input tự fill; sửa address →
      save → `clients.address` update (kết hợp write-back fix §N-13).

### 3.3. Tick paid ở Lưu nháp → popup confirm

- [ ] 3.3.1. Trong handler "Lưu nháp" (`handleSaveDraft`): check
      `isPaidImmediately=true` → mở modal confirm "Bill đã thanh toán là bill
      chính thức, không thể là nháp. Bạn muốn chuyển sang Lưu đơn?".
- [ ] 3.3.2. `[Đồng ý]` → gọi `executeCreateBill` (flow Lưu đơn).
- [ ] 3.3.3. `[Hủy]` → đóng modal, giữ form.
- [ ] 3.3.4. Test: tick paid + bấm Lưu nháp → popup; đồng ý → tạo bill chính
      thức có `bill_code`; hủy → không có gì xảy ra.

### 3.4. Nút "Xem bill in"

- [ ] 3.4.1. Extract component `<BillPreview bill={...} />` từ code render hiện tại.
- [ ] 3.4.2. Nút "Xem bill in" trong bill detail: hiện cho MỌI bill có
      `bill_code` (kể cả cancelled).
- [ ] 3.4.3. Sau Lưu đơn thành công: state chuyển sang "submitted", hiện nút
      "Xem bill in" thay vì "Lưu đơn".
- [ ] 3.4.4. Modal preview: dùng snapshot columns cho tên/SĐT.
- [ ] 3.4.5. Bill cancelled: overlay watermark "ĐÃ HỦY" chéo màu đỏ 30% opacity.
- [ ] 3.4.6. Nút "In" trong modal: `window.print()` + CSS `@media print` ẩn app chrome.

### 3.5. Double-click guard

- [ ] 3.5.1. Add state `submitting` cho mỗi form: create bill, edit bill,
      cancel bill, save draft.
- [ ] 3.5.2. Wrap handler với pattern check `if (submitting) return`.
- [ ] 3.5.3. Nút disabled khi `submitting=true`.
- [ ] 3.5.4. Race check: trước cancel/update, refetch bill state — nếu đã bị
      mutate → toast "Đơn đã được cập nhật bởi người khác" + refresh.

### 3.6. No-change save → skip modal + toast

- [ ] 3.6.1. Trong handler edit save: nếu `computeDiff().length === 0` →
      toast "Không có thay đổi để lưu", return (không mở modal, không RPC).

## Verification

- [ ] V.1. Chạy toàn bộ manual checklist v2 (từ conversation 2026-07-06) —
      pass hết trước khi archive change.
- [ ] V.2. Verify audit_log có row cho MỌI mutation trong test suite.
- [ ] V.3. Verify không còn call trực tiếp `supabase.from('bills').insert/update/delete`
      cho write path — chỉ dùng RPC.
- [ ] V.4. Verify migration DROP `expected_id_info` không mất data (row count
      + spot check 10 bill với old `expected_id_info` không NULL).
