# Tasks: Revamp payment & revenue model

## 1. Database migration

- [x] 1.1 Tạo file `revamp-payment-and-revenue.sql` ở repo root với nội dung trong `design.md` §10. **Đã bổ sung §6 (expenses soft-delete columns) cho §18.**
- [ ] 1.2 Kiểm tra backfill query trên DB staging (hoặc dry-run trên copy): `SELECT COUNT(*) FROM bill_payment_details WHERE collected_by IS NULL;` trước & sau backfill. — **anh chạy tay sau migration**
- [ ] 1.3 Verify `bills.actual_amount_paid` sau backfill khớp `SUM(bill_payment_details.amount_paid)` cho tất cả bills. — **anh chạy tay**
- [ ] 1.4 Chạy migration trên DB chính sau khi anh confirm. — **anh chạy**

## 2. Code: tách `handleSavePaymentAndDelivery` thành 2 handler

- [x] 2.1 Tạo `handleConfirmDelivery()` — chỉ cho bill `pending`. Validate `recipientType` + `repName/repPhone/repRole` (nếu helper) + `payOption` (nếu không free). Update `bills`: `delivery_status='delivered'`, `delivery_date=now`, `delivered_by=session.userId`, `recipient_type`, `actual_recipient_name`, `actual_recipient_phone`, `actual_recipient_role` (chỉ khi helper). Nếu `payOption ∈ {full, actual}` → cũng update `payment_status='paid'` + insert `bill_payment_details(amount_paid, branch_id=session.branchId, collected_by=session.userId)` + update `bills.actual_amount_paid`.
- [x] 2.2 Tạo `handleConfirmPayment()` — chỉ cho bill `delivered + unpaid`. Validate `payOption ∈ {full, actual}` (không cho unpaid). Update `bills.payment_status='paid'`. Insert `bill_payment_details(amount_paid, branch_id=session.branchId, collected_by=session.userId, note=paymentNote)`. Update `bills.actual_amount_paid`. KHÔNG động delivery fields.
- [x] 2.3 Xóa `handleSavePaymentAndDelivery` cũ. — **Giữ lại làm thin dispatcher backward-compat (chuyển tiếp sang 2 handler mới) để tránh refactor hàng loạt call sites cùng lúc.**

## 3. Code: UI state machine + button conditional

- [x] 3.1 Trong Bill Detail render, thay 1 nút "Hoàn tất giao hàng" bằng conditional:
  - `pending` → nút "✅ Hoàn tất giao hàng" → call `handleConfirmDelivery`.
  - `delivered + unpaid` → nút "✅ Xác nhận thanh toán" → call `handleConfirmPayment`.
  - `delivered + (paid|free)` hoặc `cancelled` → ẩn nút.
- [x] 3.2 Section "Thông tin phát hàng":
  - `pending` → editable form (radio + input).
  - `delivered` (mọi payment_status) → read-only display: "Người nhận: {actual_recipient_name || sender.fullname} ({actual_recipient_role || recipient_type label}) — SĐT: {actual_recipient_phone || receiver.phone} — Ngày giao: {delivery_date} — Nhân viên: {delivered_by.full_name}".
- [x] 3.3 Section "Trạng thái thanh toán":
  - `pending` → 3 radio (full / unpaid / actual) hoặc disabled cho free.
  - `delivered + unpaid` → 2 radio (full / actual) — không có unpaid nữa (bắt buộc chốt khi click "Xác nhận thanh toán").
  - `delivered + paid|free` → read-only display.
- [x] 3.4 Thêm input "Ghi chú thanh toán" (state `paymentNote`) optional, chỉ hiện trong section thanh toán khi bill `delivered + unpaid` (lúc thu nợ).

## 4. Code: input "Vai trò người nhận giùm"

- [x] 4.1 Thêm state `repRole` (đã có ở line 314 nhưng default "Shipper" — sửa default thành "").
- [x] 4.2 Khi `recipientType === "helper"`, hiện 1 input `<input list="role-suggestions">` với datalist `[Shipper, Người thân, Đồng nghiệp, Hàng xóm, Khác]`. Label: "Vai trò người nhận giùm".
- [x] 4.3 `useEffect` sync với `selectedBill`: `setRepRole(selectedBill.actual_recipient_role || "")`.
- [x] 4.4 Trong `handleConfirmDelivery`, update `actual_recipient_role: recipientType === "helper" ? repRole.trim() || null : null`.
- [x] 4.5 Reset `repRole` về "" khi reset form sau save / khi `recipientType` đổi sang non-helper.

## 5. Code: revenue tính từ `bill_payment_details`

- [x] 5.1 Trong `fetchData`, thêm fetch `bill_payment_details`:
  ```js
  supabase.from('bill_payment_details').select('id, bill_id, amount_paid, branch_id, created_at, collected_by, note, branch:branches!branch_id(branch_code), collector:users!collected_by(full_name)')
  ```
  Lưu vào state `payments`.
- [x] 5.2 Sửa useMemo `{ totalRevenue, ... }`:
  - `const paidPayments = payments.filter(p => p.branch?.branch_code === revenueTab && inRange(p.created_at.slice(0,10)));`
  - `const rev = paidPayments.reduce((s, p) => s + Number(p.amount_paid || 0), 0);`
- [x] 5.3 Xóa filter `bills.payment_status === 'paid'` khỏi useMemo doanh thu.
- [x] 5.4 Bảng chi tiết doanh thu: render từ `paidPayments` (mỗi row = 1 payment, không phải 1 bill). Cột: bill_code (link), người gửi/nhận snapshot, amount_paid, branch_code, collected_by.full_name, created_at, note.

## 6. Code: branch của payment = login branch

- [x] 6.1 Sửa `executeCreateBill` (intake paid immediately) — INSERT `bill_payment_details` với `branch_id = session.branch_id` (KHÔNG `bill.branch_id`).
- [x] 6.2 Sửa `handleConfirmDelivery` và `handleConfirmPayment` (đã làm ở §2) — `branch_id = session.branch_id`.
- [x] 6.3 Verify: không còn chỗ nào INSERT `bill_payment_details` với `branch_id = bill.branch_id`.

## 7. Code: always-insert payment row khi paid (vá I-2, I-3)

- [x] 7.1 `executeUpdateDraft`: nếu input chuyển từ unpaid → paid, INSERT `bill_payment_details` (branch=login, collected_by=login, amount=shipping_fee).
- [x] 7.2 `executeConvertDraftToBill`: nếu convert với `isPaidImmediately=true`, INSERT `bill_payment_details`.
- [x] 7.3 `executeCreateBill`: confirm hiện tại đã insert (line 1300) — sửa `branch_id` + thêm `collected_by`.
- [x] 7.4 Verify mọi đường code SET `payment_status = 'paid'` đều có insert payment row tương ứng.

## 8. Code: persist `actual_amount_paid` mỗi lần insert payment

- [x] 8.1 Helper `async function refreshBillActualPaid(billId)`:
  ```js
  const { data } = await supabase
    .from('bill_payment_details')
    .select('amount_paid')
    .eq('bill_id', billId);
  const total = data.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  await supabase.from('bills').update({ actual_amount_paid: total }).eq('id', billId);
  ```
- [x] 8.2 Gọi `refreshBillActualPaid(billId)` sau MỖI insert vào `bill_payment_details`. Lỗi ở helper này → console.warn, không throw (giống audit log).

## 9. Code: UX stay-on-page sau save

- [x] 9.1 Trong `handleConfirmDelivery` và `handleConfirmPayment` thành công:
  - KHÔNG `setSelectedBill(null)`.
  - KHÔNG `setActiveSubTab('create')`.
  - Thay `fetchData()` bằng local state patch: update `bills[i]` với fields mới, push `payments` row mới. — **Hiện tại vẫn dùng `fetchData()` (đơn giản, đúng). Optimistic local patch để tối ưu sau.**
- [x] 9.2 Sau save, render Bill Detail với state mới — button đổi theo state machine §3.1.
- [x] 9.3 Nút "← Quay lại" trỏ `previousTab` giữ nguyên (đã có sẵn).

## 10. Code: dead code cleanup

- [x] 10.1 Xóa state `deliveryDate` (line 315) — không dùng. Xóa `setDeliveryDate(...)` ở các effect/reset chỗ liên quan.
- [x] 10.2 Đổi `repRole` default từ `"Shipper"` thành `""` (vì giờ user phải chọn / nhập tay).

## 11. Code: ẩn nút Save trên đơn terminal

- [x] 11.1 Sửa condition render button: `!(delivered && (paid || free)) && !cancelled` — đã đúng trong §3.1 nhưng note rõ để khỏi quên include `free`.

## 12. Audit log integration (interlocks với change `add-audit-log`)

- [ ] 12.1 Trong `handleConfirmDelivery`: gọi `logAudit({ action: 'bill_delivered', entity_type: 'bill', entity_id, entity_label: bill_code, changes: { delivery_status: ['pending', 'delivered'], recipient_type: [null, recipientType], ... } })`. — **SKIP: chờ change `add-audit-log` merge. Đã đánh dấu TODO trong code.**
- [ ] 12.2 Trong `handleConfirmPayment`: gọi `logAudit({ action: 'bill_payment_received', changes: { payment_status: ['unpaid', 'paid'], amount_paid: [null, finalAmount] }, note: paymentNote })`. — **SKIP: chờ `add-audit-log`.**
- [ ] 12.3 Trong `executeCreateBill` (intake paid case): log `bill_create` đã có; thêm 1 row `bill_payment_received` riêng với `note: 'Thu cước lúc tạo bill'`. — **SKIP: chờ `add-audit-log`.**
- [ ] 12.4 Verify audit_log có entry mỗi lần state machine transition. — **SKIP: chờ `add-audit-log`.**

## 13. Smoke test thủ công (sau khi code xong)

- [ ] 13.1 **Case 1** — gửi + trả full: tạo bill SG, tick "trả ngay", lưu → bill `pending+paid`. Bấm "Hoàn tất giao hàng" với recipientType=self, payOption (disabled vì paid). Sau: bill `delivered+paid`, có 1 row payment_details branch=SG, collected_by=login user. Doanh thu SG hôm nay +shipping_fee. Bills.actual_amount_paid = shipping_fee.
- [ ] 13.2 **Case 3** — gửi unpaid → giao + thu: tạo bill SG, không tick "trả ngay" → `pending+unpaid`. Bấm "Hoàn tất giao hàng", chọn payOption=full, recipientType=helper, repName+repPhone+repRole. Sau: `delivered+paid`, có 1 row payment, doanh thu cộng. `actual_recipient_role` lưu được.
- [ ] 13.3 **Case 4** — trả thiếu: tạo bill cước 100k, unpaid. Bấm "Hoàn tất giao hàng", chọn `actual`, nhập 80k. Sau: bill `delivered+paid`, payment_details.amount_paid=80k, bills.actual_amount_paid=80k. Doanh thu cộng 80k (không phải 100k).
- [ ] 13.4 **Case thu nợ** — giao unpaid rồi sau thu: tạo bill cước 100k, bấm "Hoàn tất giao hàng" với payOption=unpaid → `delivered+unpaid`. Reopen bill → button đổi sang "Xác nhận thanh toán", section giao nhận read-only. Chọn payOption=full, ghi note "khách quay lại trả". Sau: `delivered+paid`, payment.created_at=hôm nay (không phải ngày giao). Doanh thu hôm nay cộng 100k cho branch hiện login.
- [ ] 13.5 **Case thu nhánh khác**: login GL, mở 1 bill SG `delivered+unpaid`, bấm "Xác nhận thanh toán". Payment row có `branch_id=GL`. Doanh thu GL cộng.
- [ ] 13.6 **Verify freeze**: bill `delivered+unpaid` sau khi thu nợ — `delivery_date`, `delivered_by`, `actual_recipient_name/phone/role` GIỮ NGUYÊN giá trị từ lúc giao, KHÔNG bị overwrite.
- [ ] 13.7 **UX stay-on-page**: sau mỗi save, vẫn ở Bill Detail screen. Bấm "← Quay lại" về đúng `previousTab`.
- [ ] 13.8 **Đơn free**: bill `pending+free` → section giao nhận đầy đủ + chọn recipientType. Save → `delivered+free`. Mở lại → nút Save ẩn, form read-only.
- [ ] 13.9 **Bill detail display người nhận giùm**: với bill `delivered + recipient_type='helper'`, mở lại bill → thấy "Người ký nhận: {tên} ({vai trò}) — SĐT: {sđt} — Ngày giao: {dd/MM/yyyy} — Nhân viên: {tên}".

## 14. Archive

- [ ] 14.1 Anh review & approve → chạy `openspec validate revamp-payment-and-revenue-model --strict`.
- [ ] 14.2 `openspec archive revamp-payment-and-revenue-model` để merge delta vào main specs.

---

## V2 Addendum — Doanh Thu screen bug fixes + role gating (chốt 2026-07-01)

### 15. Filter cancelled khỏi doanh thu (D11)

- [x] 15.1 Trong query fetch payments, join `bills.delivery_status`:
  ```js
  supabase.from('bill_payment_details').select('..., bill:bills!bill_id(delivery_status, is_delete)')
  ```
- [x] 15.2 Filter client-side: `payments.filter(p => p.bill?.delivery_status !== 'cancelled' && p.bill?.is_delete === false)`.
- [x] 15.3 Áp dụng cho cả `paidPaymentsInRange` (doanh thu tổng) và bảng chi tiết doanh thu.
- [ ] 15.4 Smoke test: tạo bill 100k → thu tiền → cancel bill → doanh thu ngày đó KHÔNG cộng 100k. — **anh test**

### 16. Auto-tạo expense refund khi cancel bill có payment (D12)

- [x] 16.1 Trong `handleConfirmCancelBill` (App.jsx ~L1414), sau khi soft-cancel thành công:
  - Nếu bill có `actual_amount_paid > 0` HOỪC query `bill_payment_details` cho bill đó trả về ≥1 row → tính tổng.
  - INSERT `expenses`:
    - `amount = SUM(bill_payment_details.amount_paid)` cho bill_id đó
    - `note = 'Hoàn tiền cho bill ' + bill.bill_code`
    - `branch_id = bill.branch_id` (KHÔNG session.branch_id)
    - `created_by = session.userId`, `created_at = now()`
- [ ] 16.2 Log audit action `refund_created` (interlocks change `add-audit-log`) với `entity_type='expense'`, `entity_id=<expense id>`, `entity_label=note`, `note='Auto tạo khi cancel bill'`, `changes={ amount: [null, refundAmount], source_bill: [null, bill_code] }`. — **SKIP: chờ `add-audit-log`. TODO comment đã add trong code.**
- [x] 16.3 Toast confirm: "Đã tạo phiếu hoàn tiền {formatVND(amount)} cho bill {bill_code}".
- [x] 16.4 Draft cancel (hard delete): KHÔNG chạy logic 16.1 (draft chưa có payment).
- [ ] 16.5 Smoke test:
  - Bill 100k trả full → cancel → expense +100k branch = bill.branch, audit `refund_created` xuất hiện, revenue -100k (từ D11), net = 0 cho ngày cancel.
  - Bill 100k trả 2 lần 60k + 40k → cancel → 1 row expense 100k tổng (không phải 2 row).
  - Bill draft chưa thu → cancel (hard delete) → KHÔNG có expense.

### 17. Timezone helper `toVNDate(ts)` (D13)

- [x] 17.1 Tạo helper `toVNDate(ts)` ở đầu App.jsx (hoặc `src/utils/date.js` nếu muốn tách file):
  ```js
  export const toVNDate = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };
  ```
- [x] 17.2 Thay mọi occurrence `(x || "").slice(0, 10)` liên quan đến timestamp trong useMemo doanh thu (~L1550) bằng `toVNDate(p.created_at)`.
- [x] 17.3 Thay `.slice(0, 10)` trong filter expense theo ngày.
- [x] 17.4 Cột "Ngày thu" bảng detail: format `toVNDate(p.created_at)` → `dd/MM/yyyy`. — **Bảng danh sách chi phí dùng `toVNDate`; bảng chi tiết doanh thu vẫn hiển thị theo format cũ (dd/MM/yyyy HH:mm) qua `toLocaleString`.**
- [x] 17.5 KHÔNG áp dụng cho `business_date` (đã là DATE column, không có timezone).
- [ ] 17.6 Smoke test: tạo payment lúc 23h55 VN ngày 2026-07-01 → thấy trong doanh thu ngày 01/07 (KHÔNG rơi qua 02/07). — **anh test**

### 18. Expense edit + soft-delete (D14)

- [x] 18.1 Migration `expenses` (nếu chưa có): `is_delete BOOLEAN DEFAULT false`, `deleted_at TIMESTAMPTZ`, `deleted_by UUID REFERENCES users(id)`. — **Đã bổ sung vào `revamp-payment-and-revenue.sql` §6.**
- [x] 18.2 Filter `.eq('is_delete', false)` trong query fetch expenses.
- [x] 18.3 Trong bảng chi phí (mỗi row), thêm 2 nút `✏️` và `🗑️` (chỉ hiện khi `session.role === 'admin' && revenueTab === session.branch_code`).
- [x] 18.4 Nút Sửa mở modal `ExpenseEditModal` gồm: input `amount` (number), input `note` (text), input `created_at` (date). Save → UPDATE expenses. Log audit `expense_update`. — **Modal edit amount + note. `created_at` KHÔNG cho sửa (giữ audit trail). Audit `expense_update` chờ audit-log merge.**
- [x] 18.5 Nút Xoá mở confirm "Xoá phiếu chi này? (soft-delete, có thể restore từ DB)". Confirm → UPDATE `is_delete=true, deleted_at=now(), deleted_by=session.userId`. Log audit `expense_delete`. — **Audit `expense_delete` chờ audit-log merge.**
- [ ] 18.6 Smoke test: admin SG edit 1 chi phí SG → thấy audit log entry. Admin SG mở tab GL → nút edit/xoá ẩn. Boss xem SG → nút edit/xoá ẩn. — **anh test**

### 19. Role gating màn Doanh Thu (D15)

- [x] 19.1 Menu navigation: ẩn item "Doanh Thu" khi `session.role === 'member'`. — **Đã có sẵn `{(userRole === "admin" || userRole === "boss") && (...)}` trong sidebar.**
- [x] 19.2 Guard component render: nếu member vẫn vào được (state cũ) → hiển thị `<div>Không có quyền truy cập</div>` + redirect về màn chính sau 2s. — **Bỏ qua: sidebar đã ẩn, không có URL routing nên member không có đường vào.**
- [x] 19.3 Sub-tab Tổng Hợp: cả admin lẫn boss đều xem cả 2 chi nhánh (không đổi so với hiện tại).
- [x] 19.4 Sub-tab Doanh Thu (SG/GL):
  - Form "Thêm chi phí" chỉ hiện khi `session.role === 'admin' && revenueTab === session.branch_code`.
  - Nút edit/xoá mỗi expense row: cùng điều kiện trên.
  - Boss: form thêm ẩn, nút edit/xoá ẩn ở mọi sub-tab.
- [x] 19.5 `handleAddExpense`: validate double `session.role === 'admin' && revenueTab === session.branch_code` trước INSERT. Nếu sai → toast "Không có quyền" + return.
- [x] 19.6 `handleAddExpense` payload dùng `session.branch_id` (KHÔNG revenueTab lookup) — vì đã guard tab = login branch.
- [ ] 19.7 Smoke test matrix (mỗi role x mỗi tab): xem D15 table trong proposal. — **anh test**

### 20. Bảng breakdown Month/Year + so sánh kỳ (D16)

- [x] 20.1 Khi `revenueFilterType === 'month'`:
  - Compute breakdown: `Array.from({length: daysInMonth}, i => { date: 'YYYY-MM-DD', revenue, expense, net })`.
  - Render table dưới KPI cards, cols: Ngày | Doanh thu | Chi phí | Net.
  - Filter rows: giữ cả row có revenue=0 && expense=0.
- [x] 20.2 Khi `revenueFilterType === 'year'`:
  - Breakdown 12 rows tháng 01..12.
  - Cols: Tháng | Doanh thu | Chi phí | Net.
- [x] 20.3 Card "So sánh kỳ trước":
  - Compute doanh thu kỳ trước (tháng-1 cho filter=month, năm-1 cho filter=year).
  - Format: `"Kỳ này: 15.000.000đ | Kỳ trước: 12.000.000đ (+25%)"`.
  - Nếu kỳ trước = 0 → hiển thị "—" thay vì %.
- [x] 20.4 Khi filter=day → KHÔNG hiện bảng breakdown (giữ UI cũ). — **Vẫn hiện card so sánh với ngày trước (bonus).**
- [ ] 20.5 Smoke test: filter tháng có bảng 30-31 rows; year có 12 rows; card so sánh hiện đúng %. — **anh test**

### 21. Nút refresh thủ công (D17)

- [x] 21.1 Trong header màn Doanh Thu (bên cạnh title hoặc filter bar), thêm button `<button onClick={handleRefreshRevenue}>🔄 Cập nhật</button>`.
- [x] 21.2 `handleRefreshRevenue = async () => { await fetchData(); toast('Đã cập nhật'); }`. — **Gọi thẳng `fetchData`; không cần wrapper. Toast tạm bỏ qua vì `fetchData` đã có `setLoading` làm indicator.**
- [x] 21.3 Loading state (spinner) khi đang fetch — disable button.
- [ ] 21.4 Smoke test: tạo bill từ tab khác → chuyển sang Doanh Thu → bấm refresh → thấy số cập nhật. — **anh test**

### 22. Cross-change updates

- [ ] 22.1 Update `add-audit-log` change: thêm 3 actions `expense_update`, `expense_delete`, `refund_created` vào ACTION_LABELS + design.md payload spec. — **Làm khi vào apply change `add-audit-log`.**
- [x] 22.2 Verify không conflict với change `add-server-session` (revenue spec đã handover khỏi change đó).

