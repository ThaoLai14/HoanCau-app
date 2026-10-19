# Design: Payment & revenue model refactor

> Status: **READY**. Decisions chốt 2026-06-30. Xem `proposal.md` cho tóm tắt decisions D1–D10.

## 1. Background: 6 case thanh toán anh đã liệt kê

| # | Case | Mô tả |
|---|---|---|
| 1 | Gửi → trả full ngay | Khách đến gửi hàng, trả full tiền cước luôn |
| 2 | Gửi trả 1 phần → giao trả nốt | Khách trả 1 phần lúc gửi, phần còn lại lúc nhận |
| 3 | Giao → trả full | Khách trả full khi đến nhận hàng |
| 4 | Giao → trả thiếu | Vd cước 60k, khách chỉ trả 50k. Có field "Số tiền khách trả thực tế" |
| 5 | Giao trước → gom nợ → trả full | Khách nhận hàng nhưng chưa trả, gom nhiều đơn lại trả 1 lần, đủ |
| 6 | Giao trước → gom nợ → trả thiếu | Giống 5 nhưng thiếu (vd nợ 3 đơn = 670k, trả 650k) |

### Rule doanh thu anh chốt

- Trả full lúc gửi → cộng vào doanh thu của **ngày gửi** (= `business_date`).
- Trả full lúc giao → cộng vào doanh thu của **ngày giao** (= `delivery_date::date`).
- Trả thiếu → ghi đúng số thực nhận (không ghi cước).
- Trả sau → cộng vào doanh thu của **ngày khách thực trả**.
- Doanh thu tính **theo chi nhánh** (= chi nhánh thực thu).

## 2. Map 6 case vào schema (đề xuất)

| Case | `bills.payment_status` cuối | Số rows `bill_payment_details` | `branch_id` của row | `created_at` của row |
|---|---|---|---|---|
| 1 | `paid` | 1 row, amount = `shipping_fee` | chi nhánh login lúc tạo bill | thời điểm tạo bill |
| 2 | (deferred) | (deferred) | (deferred) | (deferred) |
| 3 | `unpaid` (sau intake) → `paid` (sau payment) | 1 row, amount = `shipping_fee` | chi nhánh login lúc bấm "Đã thanh toán" | thời điểm bấm "Đã thanh toán" |
| 4 | `paid` (D2) | 1 row, amount = số thực thu | chi nhánh login | thời điểm thu |
| 5 | (deferred — màn Thu Nợ chuyên dụng) | (deferred) | (deferred) | (deferred) |
| 6 | (deferred) | (deferred) | (deferred) | (deferred) |

> **Case 2, 5, 6 deferred** sang change tương lai (`add-intake-prepayment`, `add-debt-collection`). Change này chỉ hỗ trợ case 1, 3, 4.

## 3. "Vũ trụ tiền" sau refactor

```
                      ┌─────────────────────┐
                      │   1 BILL (cước X)   │
                      └──────────┬──────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            ▼                    ▼                    ▼
       Lúc TẠO BILL          Lúc GIAO HÀNG       Lúc THU NỢ SAU
       (intake)              (delivery)          (debt collect)
            │                    │                    │
            ▼                    ▼                    ▼
       bill_payment_details (0..N rows, 1 row mỗi LẦN thu tiền)
            │
            └─► amount_paid: số tiền của LẦN này
                created_at:  ngày thực sự thu tiền
                branch_id:   chi nhánh thực sự thu tiền
                bill_id:     đơn nào

DOANH THU THEO NGÀY/CHI NHÁNH:
   SUM(bill_payment_details.amount_paid)
   WHERE branch_id = ? AND created_at::date = ?
```

## 4. Bug hiện tại lộ ra từ 6 case

### 4.1. `bill_payment_details` write-only → doanh thu sai trong 4/6 case

Code revenue [App.jsx#L1545-L1559](../../../src/App.jsx#L1545-L1559):
```js
const paid = bills.filter(b => b.payment_status === "paid" ...);
const rev = paid.reduce((s, b) => s + Number(b.shipping_fee || 0), 0);
```

Doanh thu = SUM(shipping_fee các bill paid), KHÔNG phải SUM(amount_paid).

| Case | Hiện trạng | Sai ở đâu |
|---|---|---|
| 1 | ✓ Vô tình đúng | (trả full, status paid, fee = thực thu) |
| 2 | ✗ SAI | Row 1 trả 30k ngày gửi → vẫn `unpaid` → doanh thu ngày gửi = 0. Trả nốt → cả 60k tính vào ngày giao. Lệch 30k giữa 2 ngày |
| 3 | ✓ Vô tình đúng | (giống case 1) |
| 4 | ✗ SAI | Khách trả 50k → doanh thu báo 60k. Thừa 10k |
| 5 | ✗ Chưa build UI | — |
| 6 | ✗ Chưa build UI | — |

### 4.2. `branch_id` của payment đang sai

[App.jsx#L1391](../../../src/App.jsx#L1391):
```js
branch_id: selectedBill.branch_id   // ← branch của BILL (= chi nhánh gửi)
```

Bill gửi từ SG, giao tại GL, khách trả 60k tại GL → row payment ghi `branch_id = SG` → doanh thu báo cáo cho SG thay vì GL.

→ Phải đổi thành chi nhánh thực thu = `loggedBranch` của nhân viên đang thu (xem open Q3).

### 4.3. Status `paid` không thể hiện "thu thiếu" (case 4, 6)

Code [App.jsx#L1346](../../../src/App.jsx#L1346):
```js
payment_status: isFreeBill ? "free" : (payOption === "unpaid" ? "unpaid" : "paid"),
```

Cả `payOption='full'` và `payOption='actual'` đều ra `paid` → mất khả năng phân biệt "trả đủ" vs "trả thiếu nhưng xong rồi" vs "còn nợ tiếp". Xem open Q1.

### 4.4. Case 5, 6 (gom nợ trả 1 lần) chưa có UI

Cần feature mới:
- Màn "Thu nợ khách" (nằm trong tab Khách Hàng hoặc tab Công Nợ mới).
- Chọn khách → liệt kê tất cả bill `unpaid` của khách (theo `sender_id` hoặc `receiver_id`).
- Nhập tổng tiền thu → phân bổ vào các bill.
- Phân bổ: **FIFO theo `created_at` cũ nhất trước** + cho phép manual override (xem open Q2).
- Mỗi bill có row payment riêng (cùng `created_at` = lúc thu, cùng `branch_id` = nơi thu).

### 4.5. Case 2 (trả trước lúc gửi) chưa hỗ trợ ở form intake

UI hiện chỉ có checkbox `isPaidImmediately` → trả full hoặc không. Không có ô "trả trước bao nhiêu".

→ Cần thêm field text "Số tiền trả trước" trên form Tạo Đơn (xem open Q4).

## 5. Liên hệ với `bills.actual_amount_paid` (denormalized field)

Cột `bills.actual_amount_paid` tồn tại trong schema, được read ở revenue detail screen [App.jsx#L1988](../../../src/App.jsx#L1988):
```js
{formatVND(bill.actual_amount_paid || bill.shipping_fee)}
```

Nhưng **KHÔNG bao giờ được app ghi**. Anh đã chốt trước đó (system-overview round 1): "BOTH — persist on bills AND derive from SUM(bill_payment_details.amount_paid). Persist for fast reads/reports; derivation is the source of truth."

→ Khi refactor, mỗi lần insert/update `bill_payment_details` phải update `bills.actual_amount_paid = SUM` của bill đó (qua trigger hoặc app-level).

## 6. Scope của change này (gộp A+B, defer C)

Quyết định 2026-06-30: giữ làm **1 change duy nhất**, KHÔNG tách thành 3 sub-change như đề xuất ban đầu. Lý do: state machine 2 nút (D1) luôn viết payment row đúng → sub-change A+B không tách được trong thực tế code.

```
   ┌───────────────────────────────────────────────────┐
   │  THIS CHANGE: revamp-payment-and-revenue-model    │
   │                                                   │
   │  • State machine 2 nút (giao / thu) + freeze      │
   │    delivery fields sau giao                       │
   │  • Schema add: collected_by, note,                │
   │    actual_recipient_role                          │
   │  • Branch payment = login branch                  │
   │  • actual_amount_paid persist (denorm)            │
   │  • Revenue = SUM(payment_details)                 │
   │  • Always-insert payment row khi paid             │
   │    (mọi flow: intake create/update/convert/       │
   │    delivery / thu nợ sau)                         │
   │  • Stay-on-page sau save                          │
   └───────────────────────────────────────────────────┘

   ┌───────────────────────────────────────────────────┐
   │  DEFERRED (future change):                        │
   │                                                   │
   │  add-intake-prepayment   (case 2)                 │
   │  add-debt-collection     (case 5, 6)              │
   │  add-payment-method      (cash / transfer)        │
   └───────────────────────────────────────────────────┘
```

## 7. Decisions (đóng cửa 2026-06-30)

| # | Quyết định | Loại |
|---|---|---|
| D1 | Tách 2 nút "Hoàn tất giao hàng" / "Xác nhận thanh toán" theo state machine | UX |
| D2 | Case 4 (trả thiếu) → status `paid`, doanh thu cộng số thực thu | Domain |
| D3 | Branch payment = chi nhánh login (`session.branch_id`) | Schema |
| D4 | `actual_amount_paid` persist + revenue đọc từ `bill_payment_details` | Domain |
| D5 | Doanh thu = `payment_details.created_at` calendar day; KHÔNG dùng `business_date` | Domain |
| D6 | Freeze info giao (delivery_date, delivered_by, recipient_*) sau khi delivered | Domain |
| D7 | Field mới `bills.actual_recipient_role` (lưu vai trò người nhận giùm) | Schema |
| D8 | Field mới `bill_payment_details.collected_by`, `.note` | Schema |
| D9 | Stay-on-page sau save (không nhảy về form Tạo Đơn) | UX |
| D10 | Section giao nhận luôn hiện cho đơn free; nút Save ẩn trên state terminal | UX |

## 8. Open questions (deferred — chờ change tương lai)

| # | Câu hỏi | Change đồ về |
|---|---|---|
| Q-DEF-1 | Case 2 (trả trước lúc gửi): UX field "Số tiền trả trước" trong intake | `add-intake-prepayment` |
| Q-DEF-2 | Case 5/6 (gom nợ): UI màn Thu Nợ, phân bổ FIFO, manual override | `add-debt-collection` |
| Q-DEF-3 | `payment_method` (tiền mặt / chuyển khoản) | `add-payment-method` |
| Q-DEF-4 | Refund / rollback payment row khi ghì nhầm | Chưa có plan |
| Q-DEF-5 | Update `actual_amount_paid` qua trigger Postgres hay app-level? | App-level cho đơn giản; trigger là nice-to-have sau |

## 9. Bill state machine (D1)

```
                  ┌──────────┐
                  │ pending  │
                  │ + unpaid │   (hoặc + free, hoặc + paid nếu intake đã thu)
                  └────┬─────┘
                       │
           ┌────────┼─────────────────────┐
           │        │                      │
  payOption=unpaid    payOption=full|actual  payment_status=free
  (đơn công nợ)        (thu liền lúc giao)   (đơn miễn phí)
           │        │                      │
           ▼        ▼                      ▼
   ┌──────────┐  ┌──────────┐         ┌──────────┐
   │delivered │  │delivered │         │delivered │
   │ + unpaid │  │  + paid  │         │  + free  │
   │ (công nợ)│  │ (final) │         │ (final) │
   └────┬────┘  └──────────┘         └──────────┘
        │
        │ Nút "✅ Xác nhận thanh toán" hiện thay vào chỗ
        │ nút "✅ Hoàn tất giao hàng" trước đó
        ▼
   ┌──────────┐
   │delivered │
   │  + paid  │
   └──────────┘
```

### Nút hiển thị theo state

| Bill state | Nút | Hành động khi click |
|---|---|---|
| `pending + unpaid` (hoặc `+ paid` từ intake / `+ free`) | "✅ Hoàn tất giao hàng" | Update delivery_status='delivered', delivery_date=now, delivered_by, recipient_type, actual_recipient_*; nếu payOption=full|actual thì thêm update payment_status + insert payment_details |
| `delivered + unpaid` | "✅ Xác nhận thanh toán" | CHỈ update payment_status (→ paid), insert payment_details (branch=login, collected_by=login user); KHÔNG đụng delivery_date/delivered_by/recipient_* |
| `delivered + paid` | (Ẩn) | Read-only |
| `delivered + free` | (Ẩn) | Read-only |
| `cancelled` | (Ẩn) | Read-only |

### Form section behavior

- **Bill `pending`**: 2 section editable — "Trạng thái thanh toán" và "Thông tin phát hàng".
- **Bill `delivered + unpaid`**: section "Thông tin phát hàng" → **read-only** (hiển thị tên người ký nhận, vai trò, ngày giao, người giao); section "Trạng thái thanh toán" → vẫn editable để chọn full/actual.
- **Bill `delivered + paid|free`**: cả 2 section read-only.

### Vì sao tách 2 nút?

1. **Audit rõ ràng**: mỗi action → 1 row audit_log. Hiện tại 1 nút update 2 thứ cùng lúc → audit không phân biệt được "đã giao" vs "đã thu".
2. **Tránh ghi đè** (BUG-A gốc): code cũ `delivered + unpaid` → user bấm "Hoàn tất" lần 2 → `delivery_date`, `delivered_by`, `recipient_*` bị overwrite bằng thời điểm thu nợ.
3. **Branch đúng theo hành động**: `delivered_by` = người giao (bấm nút 1); `collected_by` và `branch_id` của payment_details = người thu (bấm nút 2). 2 người có thể ở 2 chi nhánh khác nhau.

## 10. Schema changes

```sql
-- Migration: revamp-payment-and-revenue.sql
ALTER TABLE bill_payment_details
  ADD COLUMN collected_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN note TEXT;

ALTER TABLE bills
  ADD COLUMN actual_recipient_role TEXT;

-- Backfill collected_by cho row cũ: nhận bằng delivered_by của bill (nếu có)
UPDATE bill_payment_details bpd
SET collected_by = b.delivered_by
FROM bills b
WHERE bpd.bill_id = b.id
  AND bpd.collected_by IS NULL
  AND b.delivered_by IS NOT NULL;

-- Backfill bills.actual_amount_paid từ SUM hiện có (lần 1, idempotent)
UPDATE bills b
SET actual_amount_paid = COALESCE(s.total, 0)
FROM (
  SELECT bill_id, SUM(amount_paid) AS total
  FROM bill_payment_details
  GROUP BY bill_id
) s
WHERE b.id = s.bill_id;

CREATE INDEX IF NOT EXISTS idx_payment_branch_created
  ON bill_payment_details(branch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payment_bill
  ON bill_payment_details(bill_id);
```

### Quy tắc cho `actual_recipient_role`

- Nullable. Chỉ ghi giá trị khi `recipient_type = 'helper'`. Khi `recipient_type ∈ {self, home}` → NULL.
- KHÔNG enum DB-level (lúc này). UI gợi ý: `Shipper / Người thân / Đồng nghiệp / Hàng xóm / Khác`. User có thể gõ tự do (input với datalist suggestion).

### Quy tắc cho `actual_amount_paid` (app-level)

Mỗi lần INSERT vào `bill_payment_details` thành công → ngay lập tức:

```js
await supabase.rpc('refresh_bill_actual_paid', { p_bill_id: billId });
// HOẶC app-level:
await supabase.from('bills').update({
  actual_amount_paid: <sum_from_details>
}).eq('id', billId);
```

Có race condition nếu 2 nhân viên insert payment cùng lúc (hiếm) → chấp nhận (eventual consistency). Doanh thu đọc từ `payment_details` vẫn đúng.

### Quy tắc cho `note` và `collected_by`

- `collected_by` = `session.userId` tại thời điểm insert. KHÔNG nullable trong code path mới (cho row cũ backfill, cho row mới bắt buộc).
- `note` nullable, default NULL. UI có input optional "Ghi chú thanh toán" ở form Xác nhận Thanh Toán. Khi insert lúc intake/delivery mà không có input → NULL.

## 11. Revenue query (D5)

Thay code cũ:
```js
const rev = paid.reduce((s, b) => s + Number(b.shipping_fee || 0), 0);
```

Bằng:
```js
// fetchPaymentDetails() trong fetchData()
const { data: payments } = await supabase
  .from('bill_payment_details')
  .select('id, bill_id, amount_paid, branch_id, created_at, collected_by, note, branch:branches!branch_id(branch_code)');

// trong useMemo({ totalRevenue, ... }):
const rev = payments
  .filter(p => p.branch?.branch_code === revenueTab && inRange(p.created_at.slice(0,10)))
  .reduce((s, p) => s + Number(p.amount_paid || 0), 0);
```

Lưu ý:
- KHÔNG join với `bills.payment_status` nữa — row payment_details tồn tại = tiền đã về.
- `branch_id` của payment là chi nhánh thu, không phải chi nhánh bill.
- `created_at` của payment là ngày thu, không phải ngày giao / ngày tạo bill.

### Màn Doanh Thu detail (liệt kê đơn)

Mỗi row hiển thị = 1 row `bill_payment_details` (KHôNG phải 1 bill). 1 bill có thể xuất hiện nhiều lần nếu có nhiều lần thu. Hiển thị:
- `bill_code` (link sang bill detail)
- Tên người gửi / nhận (snapshot từ bill)
- `amount_paid` (số tiền lần này)
- `branch.branch_code` (chi nhánh thu)
- `collected_by` → tên nhân viên
- `created_at` (thời điểm thu)
- `note`

## 12. UX: stay on page (D9)

Sau khi `handleSavePaymentAndDelivery` hoặc `handleConfirmPayment` thành công:
- KHÔNG `setSelectedBill(null)`.
- KHÔNG `setActiveSubTab('create')`.
- KHÔNG `fetchData()` chạy lại toàn bộ — thay bằng patch local state (update `bills[i]` với field mới + push payment row vào `payments[]`).
- Toast "Đã cập nhật".
- Bill detail render lại với state mới:
  - `pending+unpaid` → `delivered+unpaid`: nút đổi sang "✅ Xác nhận thanh toán", section giao nhận chuyển sang read-only.
  - `delivered+unpaid` → `delivered+paid`: nút ẩn, cả form read-only.
- Nút "← Quay lại" giữ nguyên — user tự bấm để về `previousTab` (warehouse / all-bills / etc).

## 13. Liest kê code changes (hướng dẫn tổng quan)

- `src/App.jsx`:
  - Thêm state `repRole`, `paymentNote`.
  - Tách `handleSavePaymentAndDelivery` thành 2 hiệu: `handleConfirmDelivery` (pending→delivered) và `handleConfirmPayment` (delivered+unpaid→delivered+paid).
  - Render nút conditional theo state machine §9.
  - Render section giao nhận read-only khi `delivered`.
  - Bug input "Vai trò người nhận giùm" hiện khi `recipientType = 'helper'`.
  - `useEffect` map `selectedBill → form state`: thêm `setRepRole(selectedBill.actual_recipient_role || '')`.
  - `executeCreateBill`: luôn insert `bill_payment_details` khi `isPaidImmediately = true`, với `branch_id = session.branch_id`, `collected_by = session.userId`.
  - `executeUpdateDraft`, `executeConvertDraftToBill`: insert `bill_payment_details` nếu chuyển từ non-paid → paid.
  - Revenue useMemo: đổi nguồn dữ liệu sang `payments[]`.
  - Xóa state `deliveryDate` UI (không dùng), xóa state `repRole` default "Shipper" (thay bằng "").
- `src/auditLabels.js` (qua change `add-audit-log`):
  - Thêm `actual_recipient_role: 'Vai trò người nhận giùm'` vào `FIELD_LABELS`.
  - Thêm `bill_payment_received` đã có sẵn — vẫn dùng.
- File migration: `revamp-payment-and-revenue.sql` tại repo root (theo style có sẵn).
