# Capability: Delivery & Payment Collection

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (hàm `handleSavePaymentAndDelivery`).
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng.

## Purpose

Chốt 1 đơn pending thành delivered: ghi nhận ai nhận hàng (chính chủ / nhận giùm / giao tận nhà), số tiền thực thu, đồng thời đẩy đơn ra khỏi danh sách chờ giao.

## Domain model

Các cột `bills` được ghi tại bước delivery:
- `delivery_status` → `"delivered"`
- `payment_status` → giữ `"free"` nếu free; ngược lại set theo lựa chọn user (`"paid"` hoặc `"unpaid"`)
- `delivery_date` = `new Date().toISOString()` (thời điểm bấm Lưu, không cho user nhập tay)
- `recipient_type` ∈ {`"self"`, `"helper"`, `"home"`}
- `actual_recipient_name`, `actual_recipient_phone` (chỉ khi `recipient_type = "helper"`)
- `delivered_by` = `users.id` của người đang đăng nhập

Bảng `bill_payment_details(id, bill_id, amount_paid, branch_id, created_at)` — insert 1 row mỗi lần ghi nhận thu tiền.

## Requirements

### Requirement: Bắt buộc chọn recipient_type
Form Hoàn Tất SHALL bắt buộc chọn `recipient_type` (1 trong 3 lựa chọn Chính chủ / Nhận giùm / Giao tận nhà) trước khi submit.

#### Scenario: Submit thiếu recipientType
- **WHEN** user bấm Lưu mà chưa chọn người nhận hàng
- **THEN** toast lỗi "Vui lòng chọn người nhận hàng..."

#### Scenario: Nhận giùm thiếu tên/SĐT
- **WHEN** `recipientType = "helper"` và `repName` hoặc `repPhone` trống
- **THEN** toast lỗi "Vui lòng nhập Họ tên và SĐT người nhận giùm!"

### Requirement: Đơn free bỏ qua phần thanh toán
Đơn `payment_status = "free"` SHALL bỏ qua phần thanh toán khi chốt giao: giữ nguyên `payment_status = "free"` và KHÔNG insert row vào `bill_payment_details`.

#### Scenario: Hoàn tất đơn free
- **GIVEN** đơn `02SGA02` đang pending + free
- **WHEN** user chốt giao với recipientType = self
- **THEN** `delivery_status = "delivered"`, `payment_status = "free"`, `delivery_date = now`
- **AND** KHÔNG insert vào `bill_payment_details`

### Requirement: Đơn không free phải chọn payOption
Đơn không free SHALL bắt buộc chọn 1 trong 3 `payOption`: `full` (thu đủ cước) / `actual` (thu một phần) / `unpaid` (chưa thu).

#### Scenario: Thu đủ
- **GIVEN** đơn pending + unpaid với `shipping_fee = 300000`
- **WHEN** user chọn `payOption = "full"` và Lưu
- **THEN** `bills.payment_status = "paid"`
- **AND** insert `bill_payment_details(bill_id, amount_paid = 300000, branch_id)`

#### Scenario: Thu một phần (actual)
- **WHEN** user chọn `payOption = "actual"`, nhập `actualAmountPaid = 200000`
- **THEN** `bills.payment_status = "paid"`
- **AND** insert `bill_payment_details(amount_paid = 200000)`

> ⚠️ **Cảnh báo quan sát được**: code set `payment_status = "paid"` ngay cả khi `actual < shipping_fee`. Đơn thiếu nợ vẫn nhãn "paid". Bảng `bills.actual_amount_paid` tồn tại trong schema nhưng KHÔNG được code ghi vào — chỉ được đọc tại Doanh Thu. Cần anh confirm xử lý nợ thiếu thế nào.

#### Scenario: Chưa thu
- **WHEN** user chọn `payOption = "unpaid"`
- **THEN** `bills.payment_status = "unpaid"`, `delivery_status = "delivered"`
- **AND** KHÔNG insert `bill_payment_details`
- **AND** đơn trở thành "công nợ"

#### Scenario: Thu actual số tiền không hợp lệ
- **WHEN** `payOption = "actual"` và `actualAmountPaid <= 0` hoặc không phải số
- **THEN** toast lỗi "Vui lòng nhập số tiền trả thực tế hợp lệ!"

### Requirement: delivery_date = thời điểm bấm Lưu
`delivery_date` SHALL luôn = thời điểm khi user bấm Lưu (`new Date().toISOString()` từ client); user MUST KHÔNG có quyền sửa.

> ⚠️ **Lưu ý**: dùng `Date.now()` ở client là sai-lệch-nhỏ với giờ Postgres, nhưng acceptable cho domain này.

#### Scenario: Lưu hoàn tất
- **WHEN** user bấm Lưu lúc 2026-06-24 16:42:11 local
- **THEN** `bills.delivery_date` = ISO string của thời điểm đó (đã convert UTC)

### Requirement: delivered_by = user đang đăng nhập
`delivered_by` SHALL được set = `users.id` của người đang đăng nhập; không có UI cho phép chọn nhân viên khác.

> ⚠️ **Cảnh báo quan sát được**: theo anh trao đổi, **người giao hàng có thể khác người thu tiền**. `bill_payment_details` hiện chưa có cột `collected_by`. Cần thêm cột này nếu phải phân biệt.

#### Scenario: Member chốt đơn
- **WHEN** user `member` Trần A (id=U1) bấm Lưu giao 1 đơn
- **THEN** `bills.delivered_by = U1`

### Requirement: actual_recipient_* chỉ ghi khi recipient_type = helper
Khi `recipient_type = "helper"`, hệ thống SHALL ghi `actual_recipient_name` và `actual_recipient_phone`; các loại khác MUST để NULL.

#### Scenario: Helper
- **WHEN** `recipientType = "helper"`, `repName = "Nguyễn B"`, `repPhone = "0909..."`
- **THEN** `actual_recipient_name = "Nguyễn B"`, `actual_recipient_phone = "0909..."`

#### Scenario: Self
- **WHEN** `recipientType = "self"`
- **THEN** `actual_recipient_name = NULL`, `actual_recipient_phone = NULL`

#### Scenario: Home delivery
- **WHEN** `recipientType = "home"`
- **THEN** `actual_recipient_name = NULL`, `actual_recipient_phone = NULL`

### Requirement: Sub-tab Hoàn Tất hiển thị đơn pending để chốt
Tab Phiếu Gửi Hàng có sub-tab "Hoàn Tất" SHALL hiển thị các đơn `delivery_status = "pending"` của chi nhánh hiện tại để chốt.

Admin/boss có thể sửa đơn này; member chỉ chốt giao.

#### Scenario: Member mở sub-tab Hoàn Tất
- **WHEN** member chọn 1 đơn pending trong sub-tab Hoàn Tất
- **THEN** form Hoàn Tất hiện, member chốt được giao
- **AND** member KHÔNG có nút Sửa hay Hủy đơn pending

### Requirement: Reset form sau chốt giao thành công
Sau khi chốt giao thành công, form SHALL reset state và quay về sub-tab Tạo Đơn.

#### Scenario: Chốt xong
- **WHEN** user chốt giao 1 đơn thành công
- **THEN** state `selectedBill = null`, `activeSubTab = "create"`
- **AND** toast "Đã cập nhật trạng thái phát hàng thành công!"
- **AND** `fetchData()` chạy lại để refresh danh sách
