# Proposal: Hoàn hàng & Tiêu hủy (return / destroy flow)

## Status

🟢 **READY** — scope chốt 2026-10-20 sau explore.

## Why

Khi hàng đã vận chuyển (vd GL→SG) nhưng khách nhận từ chối nhận, hiện hệ thống chỉ có
"Hủy Đơn" — mà hủy đơn lại **loại khoản thu khỏi doanh thu** (`delivery_status='cancelled'`
bị filter bỏ). Thực tế hàng ĐÃ đi, nên **vẫn phải thu cước**. Cần một luồng riêng:

- **Quay đầu (returned):** chở hàng ngược về người gửi (GL), thu cước. Có thể phát sinh
  **cước chiều về** (optional, free cho khách quen).
- **Tiêu hủy (destroyed):** hiếm, chỉ khi hàng đã trả tiền và người gửi không muốn nhận lại.

## 3 trường hợp (chốt với user)

| TH | Gốc | Hành động | Thu tại GL |
|----|-----|-----------|------------|
| 1 | `unpaid` | Quay đầu | cước đi + về |
| 2 | `paid`   | Quay đầu | cước về (đi đã trả) |
| 3 | `paid`   | Tiêu hủy | — (đã trả, không thu thêm) |

**Không tồn tại "Tiêu hủy + chưa thanh toán"**: đơn chưa trả luôn được Quay đầu để thu tiền.

## What changes

### R1. 2 trạng thái mới `delivery_status`
Thêm `returned`, `destroyed` vào CHECK + các RLS policy filter theo `delivery_status`.
Hai trạng thái này **KHÔNG bị loại khỏi doanh thu** (khác `cancelled`).

### R2. 2 cột mới trên `bills`
- `return_fee` INTEGER DEFAULT 0 — cước chiều về (chỉ dùng khi Quay đầu).
- `current_branch_id` UUID NULL REFERENCES `branches(id)` — chi nhánh đang GIỮ/xử lý hàng,
  **DB-only, không hiện UI**. Dùng để danh sách Bốc Xếp hiện đúng chuyến về.
- `return_confirmed_at` TIMESTAMPTZ NULL — mốc GL xác nhận đã nhận lại hàng (2 bước).

### R3. Công thức nợ cước (áp chung cả 3 TH)
`nợ = (shipping_fee + return_fee) − actual_amount_paid`

### R4. Nút "Hoàn hàng" trên đơn `pending` (chi nhánh đang giữ hàng)
Popup 2 lựa chọn:
- **Quay đầu:** nhập `return_fee` + **lý do (bắt buộc)** → `delivery_status='returned'`,
  `current_branch_id` = chi nhánh đang giữ (SG), `business_date` = ngày bấm, audit.
- **Tiêu hủy:** CHỈ bật khi đơn không còn nợ (`paid`/`free`). Nhập **lý do (bắt buộc)** →
  `delivery_status='destroyed'`, audit. KHÔNG đổi business_date, KHÔNG dòng tiền mới.

### R5. Quay đầu 2 bước sau đó
- **GL "Xác nhận đã hoàn hàng thành công":** set `return_confirmed_at=now`,
  `current_branch_id` = GL (gốc). Audit.
- **GL "Thu tiền hoàn hàng":** thu `(shipping_fee + return_fee) − actual_amount_paid` →
  insert `bill_payment_details(branch_id = chi nhánh thu, created_at = now)` →
  `payment_status='paid'`. Audit. Doanh thu về chi nhánh thu + ngày thu (cơ chế hiện có).

### R6. Công Nợ
`returned` (chưa trả) và `destroyed` (chưa trả — trên lý thuyết không xảy ra) được đưa vào
dataset công nợ; nợ tính theo R3 (cộng `return_fee`).

### R7. Bốc Xếp
Lọc theo `COALESCE(current_branch_id, branch_id)` thay vì `branch_id` → chuyến về (current=SG)
hiện trong Bốc Xếp SG; luồng thường không đổi.

### R8. Tổng Hợp Đơn Hàng
Thêm badge trạng thái "Quay đầu" / "Tiêu hủy" + filter theo 2 status mới.

## Non-goals

- Không đụng luồng Hủy Đơn + hoàn tiền hiện tại (TH khách lấy lại hàng trong ngày chưa xuất bến).
- Không làm "xuất bến chuyến về" thành quy trình riêng — tái dùng Bốc Xếp qua `current_branch_id`.
- Không tách payment thành 2 row đi/về (breakdown nằm trên bill qua `shipping_fee`/`return_fee`).

## Phân quyền

Theo gating đơn hàng hiện có: chi nhánh đang giữ/được thao tác trên đơn + `sys_admin` bypass.
