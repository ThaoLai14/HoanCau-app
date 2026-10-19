# Proposal: Revamp payment & revenue model around `bill_payment_details`

## Status

🟢 **READY** — scope chốt 2026-06-30. Tách thành 1 change duy nhất (gộp A+B của split cũ). Phần "trả trước lúc gửi" (case 2 cũ) và màn Thu Nợ (case 5/6) **deferred** sang change tương lai.

## Decisions chốt 2026-06-30

| # | Quyết định |
|---|---|
| D1 | **Tách 2 nút giao + thu**: 1 nút "Hoàn tất giao hàng" cho bill `pending`; sau đó bill `delivered + unpaid` thì hiện nút "Xác nhận thanh toán" (cùng vị trí) để chốt payment riêng. Bill state machine ở `design.md` §9. |
| D2 | **Case `actual` (trả thiếu lúc giao)**: `bills.payment_status = paid`, doanh thu cộng đúng số thực thu. KHÔNG tạo trạng thái `partial` mới. (Trả lời open Q1 cũ.) |
| D3 | **Branch của payment** = chi nhánh nhân viên đang login lúc bấm "Đã thanh toán" (KHÔNG dùng `bill.branch_id`). Áp dụng cho cả case khách gom nhiều bill trả 1 lượt. (Trả lời open Q3 cũ.) |
| D4 | **`bills.actual_amount_paid` được persist**: mỗi lần insert `bill_payment_details` thì update `bills.actual_amount_paid = SUM(bill_payment_details.amount_paid)`. Doanh thu đọc từ `bill_payment_details`, `actual_amount_paid` chỉ là denormalized cache. |
| D5 | **Doanh thu = `bill_payment_details.created_at` calendar day + `branch_id`**. KHÔNG dùng `business_date` cho doanh thu. → Phần task 6 của change `add-server-session` được rút ra, handover hoàn toàn cho change này. |
| D6 | **KHÔNG cho phép sửa info người nhận giùm + ngày giao** sau khi đã `delivered`. Form delivery section sau giao = read-only display. |
| D7 | **Field mới `bills.actual_recipient_role`**: lưu "vai trò người nhận giùm" (Shipper / Người thân / Đồng nghiệp / Hàng xóm / Khác). UI input chỉ hiện khi `recipient_type = helper`. |
| D8 | **Field mới `bill_payment_details.note`** + **`bill_payment_details.collected_by`**: lưu ghi chú tự do mỗi lần thu (vd "khách gom 3 đơn") và ID nhân viên thực thu (có thể ≠ `delivered_by`). |
| D9 | **Sau save**: stay ở Bill Detail screen, không nhảy về form Tạo Đơn. Bill state đã update; button đổi theo state machine. User tự bấm "← Quay lại" hoặc menu khác. |
| D10 | **Đơn `delivered + free`** hiện section giao nhận đầy đủ (read-only sau khi giao xong). Nút "Hoàn tất" KHÔNG hiện trên đơn đã ở trạng thái terminal (`delivered + (paid \| free)`). |

Open questions cũ Q2 (FIFO + manual override) và Q4 (field "trả trước" intake) — **deferred** sang change `add-debt-collection` (chưa tạo).

## Why

Hệ thống có bảng `bill_payment_details` được thiết kế để track "1 bill có thể có N lần thu tiền", với schema `(id, bill_id, amount_paid, branch_id, created_at)`. Phân tích cho thấy:

1. Bảng này hiện là **write-only dead table** — không có chỗ nào trong `App.jsx` SELECT/SUM từ nó. Grep toàn repo chỉ ra 2 chỗ INSERT (`executeCreateBill` line 1300, `handleSavePaymentAndDelivery` line 1388), 0 chỗ đọc.
2. Mọi báo cáo doanh thu hiện tính từ `SUM(bills.shipping_fee WHERE payment_status='paid')` — **SAI cho 4/6 case nghiệp vụ thực tế** (xem `design.md` để biết 6 case + mapping).
3. Code ghi vào bảng này không nhất quán: `executeConvertDraftToBill` (convert draft → đơn paid) **KHÔNG insert**; `executeUpdateDraft` (admin sửa đơn pending tick paid) **KHÔNG insert** → audit gãy.
4. Khi build tab Công Nợ (đã chốt scope trong vòng discussion trước, ghi trong `system-overview.md` repo memory), bắt buộc dùng `bill_payment_details` làm nguồn truth → các bug hiện tại sẽ nổ thành sai số công nợ.

Anh đã liệt kê 6 case thanh toán thực tế (case 1 trả full lúc gửi, case 2 trả 1 phần lúc gửi + nốt lúc nhận, ..., case 6 gom nợ trả thiếu). Map 6 case này vào schema cho thấy `bill_payment_details` là nguồn truth duy nhất khả dĩ.

## What changes (in-scope chốt)

Re-architect mô hình thanh toán + doanh thu quanh `bill_payment_details`:

1. **State machine 2 nút**: tách logic giao hàng và thu tiền thành 2 hành động riêng — `pending → delivered` (nút "Hoàn tất giao hàng") và `delivered+unpaid → delivered+paid` (nút "Xác nhận thanh toán"). Không cho ghi đè `delivery_date`/`delivered_by`/`recipient_*` sau khi đã giao. (D1, D6, D10)
2. **Schema additions**: 
   - `bill_payment_details.collected_by UUID` (FK `users.id`).
   - `bill_payment_details.note TEXT`.
   - `bills.actual_recipient_role TEXT` (nullable).
3. **Doanh thu chuyển sang `SUM(bill_payment_details.amount_paid)`** group by `branch_id, date_trunc('day', created_at)`. Bỏ logic cũ `SUM(bills.shipping_fee WHERE paid)`. (D5)
4. **`bills.actual_amount_paid` persist** mỗi lần insert payment (app-level update, không trigger). Doanh thu vẫn đọc từ payment_details là nguồn truth. (D4)
5. **`branch_id` của payment** = chi nhánh login của nhân viên bấm "Đã thanh toán". (D3)
6. **`payOption = actual`**: insert payment_details với `amount_paid = số thực thu`; `bills.payment_status = paid`. KHÔNG có status `partial`. (D2)
7. **Insert payment row trong mọi đường code khi tick paid** (vá I-2, I-3 đã flag ở intake audit — `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`).
8. **UI input `actual_recipient_role`** (select / text) khi `recipient_type = helper`, default rỗng. (D7)
9. **UX**: sau save, stay ở Bill Detail screen với state cập nhật; nút Save thay đổi theo state. (D9)

## Capabilities affected

- `shipment-intake` — MODIFIED (insert payment row đúng trong mọi flow paid)
- `delivery-and-payment` — MODIFIED (state machine 2 nút, `actual_recipient_role`, branch login, freeze info sau giao)
- `revenue-reporting` — MODIFIED (nguồn dữ liệu `bill_payment_details`, group theo `created_at + branch_id`)

## Deferred to future change

Những thứ chưa làm trong change này, sẽ tạo change mới sau:

| Item | Lý do defer | Change name tương lai (suggested) |
|---|---|---|
| Field "Số tiền trả trước" trên intake (case 2 cũ) | Cần discuss UX riêng + edge cases (trả trước nhưng sau đó cancel?) | `add-intake-prepayment` |
| Màn Thu Nợ — gom nợ + FIFO + manual override (case 5/6 cũ) | Là feature mới hoàn toàn, scope lớn, cần wireframe | `add-debt-collection` |
| `bill_payment_details.payment_method` (tiền mặt / chuyển khoản) | User chưa request | `add-payment-method` |

## Non-goals

- KHÔNG đụng intake bugs không liên quan payment (I-1, I-5, I-6, I-8 — ở change `fix-shipment-intake-issues`).
- KHÔNG fix bill_code race (I-9 — sẽ ở change riêng).
- KHÔNG fix expense tracking / edit / delete.
- KHÔNG đụng `business_date` (đã có change `add-server-session` in-flight — chỉ rút phần revenue ra).
- KHÔNG fix bug security (plaintext password).
- KHÔNG support refund / rollback payment row.

## Interactions với change khác

| Change | Trạng thái | Tương tác |
|---|---|---|
| `add-server-session` | in-progress | Rút task 6 (revenue) khỏi change đó. Phần `business_date` cho mã bill + warehouse + ngày gửi giữ nguyên. |
| `add-audit-log` | in-progress 0/35 | Đảm bảo audit log capture `bill_delivered`, `bill_payment_received` thành 2 events riêng. Section "Lịch sử đơn" inline (xem update của change đó). |
| `fix-shipment-intake-issues` | no-tasks | Độc lập, không conflict. |

## References

- 6 case + map schema + bug analysis → `design.md`
- Intake audit gốc → repo memory `system-overview.md`
- Change song hành: `add-server-session` (rename từ `add-business-date-to-bills`), `fix-shipment-intake-issues`

---

## Addendum V2 (chốt 2026-07-01 sau review bug màn Doanh Thu)

Sau khi review sâu màn Doanh Thu, 7 hạng mục sau được gộp vào change này (thay vì tạo change mới):

### D11 — Loại trừ bill cancelled khỏi doanh thu (bug REV-1)

Doanh thu MUST filter thêm điều kiện `bills.delivery_status !== 'cancelled'` (join với `bill_payment_details.bill_id`). Bill bị cancel sau khi đã thu tiền → payment row cũ vẫn tồn tại; doanh thu ngày cũ KHÔNG được cộng row này.

Cùng với D12 (auto-refund), doanh thu net = revenue - expense = 0 cho case cancel-after-paid.

### D12 — Auto-tạo expense hoàn tiền khi cancel bill đã thu

Khi user (admin) cancel 1 bill có `bill_payment_details` (tức đã thu ≥ 1 lần), hệ thống MUST tự động INSERT 1 row `expenses`:
- `amount = SUM(bill_payment_details.amount_paid)` cho bill đó (1 row tổng, không phải N row).
- `note = "Hoàn tiền cho bill <bill_code>"`.
- `branch_id = bills.branch_id` (chi nhánh gửi của bill — KHÔNG phải chi nhánh login của user cancel).
- `created_at = now()`.
- `created_by = session.userId`.
- Không hiển thị popup xác nhận — silent, log ra toast "Đã tạo phiếu hoàn tiền ...".

Row expense này có thể được nhân viên edit/xoá sau (theo D14).

Case chỉ có draft (chưa có payment): KHÔNG tạo expense.

### D13 — Timezone helper `toVNDate(ts)`

Tạo helper `toVNDate(ts)` chuyển 1 timestamptz thành `YYYY-MM-DD` theo giờ VN (UTC+7). Apply thay cho mọi chỗ hiện dùng `(x || "").slice(0, 10)` — sai lệch ngày khi ts ở khoảng 17:00–00:00 UTC (0:00–7:00 VN sáng hôm sau).

```js
export const toVNDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
};
```

Áp dụng: filter doanh thu, filter expense, cột "Ngày thu" bảng detail, cột "Ngày Gửi" tab Tổng Hợp (đối với `business_date` thì đã là DATE nên không cần).

### D14 — Expense edit + soft-delete (admin only, audit log)

Bảng chi phí thêm 2 nút mỗi row: `✏️ Sửa` và `🗑️ Xoá`. Hiển thị chỉ khi:
- `session.role = 'admin'` (member/boss KHÔNG thấy)
- `revenueTab === session.branch_code` (admin chỉ edit chi nhánh mình — xem D15)

`✏️ Sửa`: mở modal edit `amount` + `note` + `created_at` (date only). Cập nhật vào DB. Log audit `expense_update` với payload `changes: { amount: [old, new], note: [old, new], date: [old, new] }`.

`🗑️ Xoá`: soft-delete via `expenses.is_delete = true`, `deleted_at = now()`, `deleted_by = session.userId`. Log audit `expense_delete` với payload `entity_label: note (hoặc "expense <amount>")`, `changes: { is_delete: [false, true] }`.

Không có hard-delete UI. Không có restore UI (nếu cần, edit qua Supabase Studio).

### D15 — Role gating màn Doanh Thu

Sub-tab | Member | Admin (branch A) | Boss
--- | --- | --- | ---
Menu "Doanh Thu" | Ẩn khỏi navigation | Hiện | Hiện
Tab Tổng Hợp | KHÔNG truy cập được | Full (SG + GL) | Full (SG + GL)
Tab Doanh Thu SG | KHÔNG truy cập được | Nếu A=SG: full CRUD chi phí. Nếu A=GL: read-only (nút edit/xoá + form thêm chi phí ẩn) | Read-only (ẩn CRUD)
Tab Doanh Thu GL | KHÔNG truy cập được | Ngược lại tab SG | Read-only (ẩn CRUD)

Ngăn truy cập URL/deep-link: nếu member load thẳng screen doanh thu (vd qua reload sau update role), MUST redirect về trang chính + toast "Không có quyền".

### D16 — Bảng breakdown Month/Year + so sánh kỳ

Khi filter type = `month`:
- Bảng breakdown TỪNG NGÀY trong tháng (rows: ngày 01..31 tháng đó), cols: ngày, revenue, expense, net.
- Hiển thị so sánh với tháng liền trước: `Tháng này 15tr | Tháng trước 12tr (+25%)`.

Khi filter type = `year`:
- Bảng breakdown TỪNG THÁNG trong năm (rows: tháng 01..12), cols giống trên.
- So sánh với năm liền trước.

Rows có revenue=0 và expense=0 vẫn hiển thị (để thấy ngày "trắng"). Format: dd/MM hoặc mm/yyyy.

### D17 — Nút refresh thủ công

Trên header màn Doanh Thu, thêm nút `🔄 Cập nhật`. Bấm → gọi lại `fetchData()` (re-fetch bills, expenses, payments). Toast "Đã cập nhật" sau khi xong.

Lý do: staff cần thấy số liệu ngay khi vừa tạo bill/thu tiền mà không phải F5 cả app.

---

## What changes (V2 addendum — bổ sung vào scope)

10. Filter `delivery_status !== 'cancelled'` khỏi doanh thu (D11).
11. Auto INSERT expense refund khi cancel bill có payment (D12).
12. Helper `toVNDate(ts)` + apply thay `slice(0, 10)` (D13).
13. Expense edit + soft-delete UI (admin only) + audit log (D14).
14. Role gating màn Doanh Thu (member ẩn menu, admin chỉ edit own branch, boss read-only) (D15).
15. Bảng breakdown Month/Year + period-over-period compare (D16).
16. Nút `🔄 Cập nhật` (D17).

## Capabilities affected (V2 addendum)

- `revenue-reporting` — thêm requirements: filter cancelled, expense CRUD, role gating, breakdown table, refresh button, timezone helper.
- `audit-log` (change riêng `add-audit-log`) — thêm 2 actions `expense_update`, `expense_delete`, 1 action `refund_created` (auto khi cancel).

