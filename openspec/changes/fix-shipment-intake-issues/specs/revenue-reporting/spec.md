# Delta: revenue-reporting (fix-shipment-intake-issues)

> Áp dụng N-11 cho capability `revenue-reporting`: hiển thị nhãn riêng cho cột "Cước phí" theo `payment_status` thay vì chỉ số tiền.

## ADDED Requirements

### Requirement: Cột cước phí hiển thị nhãn theo payment_status

Mọi bảng tổng hợp đơn / báo cáo doanh thu SHALL hiển thị cột "Cước phí" theo `bills.payment_status`:

| `payment_status` | Hiển thị |
|---|---|
| `paid` | Số tiền `shipping_fee` formatted (vd `"200,000 VND"`) |
| `unpaid` | Số tiền `shipping_fee` formatted (vd `"200,000 VND"`) |
| `free` | Label `"Miễn phí"` (text, không phải số) |
| `quote_later` | Label `"Chưa có cước"` (text, không phải số) |

Áp dụng cho:
- Bảng "Tổng hợp đơn" (toàn bộ sub-tab: chờ giao, đã giao, đã huỷ, draft).
- Bảng chi tiết doanh thu (nếu có).
- Bảng tổng hợp công nợ (chỉ list đơn `unpaid` → cột hiển thị số tiền).

Phép tính tổng doanh thu KHÔNG đổi: vẫn `SUM(shipping_fee) WHERE payment_status = "paid"`.

#### Scenario: Bảng tổng hợp đơn — đơn quote_later

- **GIVEN** đơn `05SGA02` có `payment_status = "quote_later"`, `shipping_fee = 0`
- **WHEN** render bảng tổng hợp đơn
- **THEN** cột "Cước phí" của row này hiển thị `"Chưa có cước"` (text)
- **AND** KHÔNG hiển thị `"0 VND"` hay số 0

#### Scenario: Bảng tổng hợp đơn — đơn free

- **GIVEN** đơn `05SGB01` có `payment_status = "free"`, `shipping_fee = 0`
- **WHEN** render bảng tổng hợp đơn
- **THEN** cột "Cước phí" hiển thị `"Miễn phí"` (text)

#### Scenario: Bảng tổng hợp đơn — đơn unpaid (công nợ)

- **GIVEN** đơn có `payment_status = "unpaid"`, `shipping_fee = 250000`
- **WHEN** render bảng tổng hợp đơn
- **THEN** cột "Cước phí" hiển thị `"250,000 VND"` (số tiền formatted)

#### Scenario: Bảng tổng hợp đơn — đơn paid

- **GIVEN** đơn có `payment_status = "paid"`, `shipping_fee = 200000`
- **WHEN** render bảng
- **THEN** cột "Cước phí" hiển thị `"200,000 VND"`

#### Scenario: Tổng doanh thu — không tính bill quote_later

- **GIVEN** tháng 6/2026 có:
  - 10 bill `paid`, tổng `shipping_fee = 3,000,000`
  - 2 bill `quote_later`, `shipping_fee = 0`
  - 1 bill `free`, `shipping_fee = 0`
- **WHEN** filter type = `"month"`, tháng = `"2026-06"`
- **THEN** `totalRevenue = 3,000,000` (chỉ tính bill paid, đúng như rule cũ)
