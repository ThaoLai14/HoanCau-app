# Delta spec: revenue-reporting

> **Scope note**: Change này (`add-server-session`) chỉ lo phần **Tab Tổng Hợp Đơn Hàng** filter theo `business_date`. Sub-tab **Doanh Thu** (revenue calc) được handover hoàn toàn cho change `revamp-payment-and-revenue-model` (D5: doanh thu tính theo `bill_payment_details.created_at`, KHÔNG dùng `business_date`).

## MODIFIED Requirements

### Requirement: Filter tab Tổng Hợp Đơn Hàng theo ngày gửi
Tab Tổng Hợp Đơn Hàng MUST có filter theo ngày gửi (so với `business_date`) và ngày giao (so với `delivery_date` calendar day theo VN timezone), kèm filter mã bill, SĐT khách, trạng thái giao, trạng thái thanh toán.

UI:
- Label "Ngày tạo từ/đến" MUST đổi thành "Ngày gửi từ/đến".
- Tiêu đề cột table "Ngày Tạo" MUST đổi thành "Ngày Gửi", hiển thị `business_date` format `dd/MM/yyyy`.
- Cột `created_at` MUST KHÔNG hiện trong table Tổng Hợp (chỉ hiện trong Bill Detail).

Filter logic: `b.business_date >= businessFrom && b.business_date <= businessTo`.

#### Scenario: Lọc theo ngày gửi
- **WHEN** user nhập `businessFrom = 2026-07-01`, `businessTo = 2026-07-31`
- **THEN** chỉ hiện bills có `business_date` trong [2026-07-01, 2026-07-31]

#### Scenario: Cột table "Ngày Gửi"
- **GIVEN** bill có `business_date = 2026-07-02`, `created_at = 2026-07-01T15:00`
- **WHEN** bill hiển thị trong table Tổng Hợp
- **THEN** cột "Ngày Gửi" hiện `'02/07/2026'`
- **AND** không hiện `created_at` ở table này

#### Scenario: Chi tiết bill hiện cả 2
- **WHEN** user mở chi tiết bill ở trên
- **THEN** "Ngày gửi" = `'02/07/2026'`
- **AND** "Thời gian tạo" = `'01/07/2026 15:00'`
