# Design: Hoàn hàng & Tiêu hủy

## State machine

```
                     ┌─────────┐
          (cross-branch, hàng tới chi nhánh nhận, khách từ chối)
                     │ pending │
                     └────┬────┘
            ┌─────────────┼───────────────────┐
     Quay đầu            Tiêu hủy          (giao bình thường)
   (any payment)     (chỉ paid/free)              │
            ▼                 ▼                     ▼
     ┌────────────┐     ┌────────────┐       ┌───────────┐
     │  returned  │     │ destroyed  │       │ delivered │
     │ return_fee │     │ (terminal) │       └───────────┘
     │ current=SG │     └────────────┘
     │ bdate=today│
     └─────┬──────┘
   GL "Xác nhận đã về"
           │ return_confirmed_at=now, current=GL
           ▼
     ┌────────────┐
     │ returned   │  GL "Thu tiền" → payment → payment_status=paid
     │ (đã về)    │───────────────────────────────────────────▶ paid
     └────────────┘
```

## Dòng tiền (3 trường hợp)

| TH | shipping_fee | return_fee | đã trả | thu tại GL | doanh thu |
|----|--------------|------------|--------|------------|-----------|
| 1 unpaid→quay đầu | F | R | 0 | F + R | GL, ngày thu |
| 2 paid→quay đầu   | F | R | F | R | GL, ngày thu |
| 3 paid→tiêu hủy   | F | 0 | F | — | (F đã ghi lúc tạo) |

**Nợ = `(shipping_fee + return_fee) − actual_amount_paid`.**

## Quyết định thiết kế

### D1. Vì sao status mới thay vì tái dùng `cancelled`
Doanh thu filter `delivery_status !== 'cancelled'`. Hàng đã vận chuyển → cước là doanh thu thật.
`returned`/`destroyed` phải KHÁC `cancelled` để không bị loại.

### D2. `current_branch_id` (DB-only) cho Bốc Xếp
Doanh thu tính theo `bill_payment_details.branch_id` (chi nhánh thu), KHÔNG theo `bill.branch_id`
→ có thể để `bill.branch_id` nguyên gốc (GL). Nhưng Bốc Xếp lọc theo `branch_id`. Thêm
`current_branch_id` (mặc định NULL = dùng `branch_id`); khi Quay đầu set = chi nhánh đang giữ (SG)
để chuyến về hiện trong Bốc Xếp SG. Không hiển thị field này trên UI (tránh rối).
Bốc Xếp đổi filter sang `COALESCE(current_branch_id, branch_id)`.

### D3. 2 bước Quay đầu bằng `return_confirmed_at`
Không thêm status thứ 3. `returned` + `return_confirmed_at IS NULL` = đang về;
`return_confirmed_at IS NOT NULL` = đã về GL (cho phép Thu tiền).

### D4. `return_fee` riêng thay vì ghi đè `shipping_fee`
Giữ cước đi gốc (cần cho Tiêu hủy "cước 1 đầu" + báo cáo tách đi/về). Tổng cước hiển thị =
`shipping_fee + return_fee`.

### D5. Thu tiền hoàn hàng tái dùng `bill_payment_details`
1 payment row = `(shipping_fee + return_fee) − actual_amount_paid`, `branch_id` = chi nhánh thu,
note rõ. Chạy chung công thức doanh thu hiện có.

### D6. Rule bật Tiêu hủy
Chỉ bật khi `payment_status ∈ {paid, free}` (không còn nợ). Đơn `unpaid` → chỉ Quay đầu.

### D7. 14.56 (khóa sửa/hủy) không bị ảnh hưởng
Nút Sửa/Hủy chỉ hiện khi `delivery_status==='pending'`. Đơn `returned` → nút đó ẩn → đổi
`business_date` sang hôm nay không "mở khóa" gì.

## Điểm tích hợp (code)

| Vùng | Thay đổi |
|------|----------|
| `fetchData` bills select | thêm `return_fee`, `current_branch_id`, `return_confirmed_at`, join `current_branch` |
| Revenue useMemo | không đổi filter (status mới không bị loại); công thức không đổi (dựa payment) |
| `groupBillsByCustomer` (công nợ) | thêm `returned`/`destroyed` vào dataset; nợ cộng `return_fee` |
| `warehouseFilteredBills` + tab count + print | lọc theo `COALESCE(current_branch_id, branch_id)` |
| Bill detail action bar | nút "Hoàn hàng" (pending, chi nhánh giữ); "Xác nhận đã về" (returned chưa confirmed, GL); "Thu tiền hoàn" (returned confirmed, chưa paid) |
| Tổng Hợp filter + badge | thêm `returned`/`destroyed` |
| `auditLabels` | enum `returned`/`destroyed`; action `bill_returned`/`bill_destroyed`/`bill_return_confirmed` |

## Migration

```sql
ALTER TABLE bills ADD COLUMN IF NOT EXISTS return_fee INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS current_branch_id UUID REFERENCES branches(id);
ALTER TABLE bills ADD COLUMN IF NOT EXISTS return_confirmed_at TIMESTAMPTZ;
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_delivery_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_delivery_status_check
  CHECK (delivery_status IN ('pending','delivered','draft','cancelled','returned','destroyed'));
-- + nới các RLS policy đang IN (...) delivery_status để thêm 'returned','destroyed'.
```
