# Capability: Revenue Reporting

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (useMemo tính `totalRevenue`/`totalExpense`/`netRevenue`, hàm `handleAddExpense`).
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng.

## Purpose

Hiển thị doanh thu, chi phí và lợi nhuận ròng theo chi nhánh, theo ngày / tháng / năm. Cho phép admin nhập các khoản chi phí phát sinh.

## Domain model

- Doanh thu = `SUM(bills.shipping_fee)` của các bill `payment_status = "paid"` trong khoảng thời gian.
- Chi phí = `SUM(expenses.amount)` của các expense `is_delete = false` trong khoảng thời gian.
- Lợi nhuận ròng = Doanh thu - Chi phí.
- Phép tính chạy **client-side** trong `useMemo`, trên toàn bộ `bills` + `expenses` đã fetch về.

Bảng `expenses(id, amount, note, branch_id, created_at, is_delete)`.

## Requirements

### Requirement: Quyền truy cập tab Doanh Thu
Tab Doanh Thu SHALL chỉ truy cập được bởi role `admin` hoặc `boss`; sidebar MUST ẩn nút "Quản Lý Doanh Thu" khi role = `"member"`.

#### Scenario: Member không thấy menu
- **WHEN** user role = `"member"` đăng nhập
- **THEN** sidebar không có mục "Quản Lý Doanh Thu"

### Requirement: Sub-tab chi nhánh và chế độ lọc thời gian
Tab Doanh Thu SHALL có 2 sub-tab chi nhánh (SG, GL) và 3 chế độ lọc thời gian (ngày, tháng, năm). Sub-tab mặc định MUST = chi nhánh đăng nhập (`loggedBranch`).

#### Scenario: Lọc theo ngày
- **WHEN** user chọn filter type = `"day"`, ngày = `"2026-06-24"`
- **THEN** doanh thu = tổng `shipping_fee` của bill `payment_status = "paid"`, thuộc chi nhánh sub-tab đang chọn, và `(delivery_date || created_at).slice(0,10) === "2026-06-24"`

#### Scenario: Lọc theo tháng
- **WHEN** user chọn filter type = `"month"`, tháng = `"2026-06"`
- **THEN** doanh thu = tổng `shipping_fee` của bill paid mà `(delivery_date || created_at).slice(0,7) === "2026-06"`

#### Scenario: Lọc theo năm
- **WHEN** filter type = `"year"`, năm = `"2026"`
- **THEN** doanh thu = tổng `shipping_fee` mà `(delivery_date || created_at).slice(0,4) === "2026"`

### Requirement: Doanh thu tính theo shipping_fee, không phải tiền thực thu
Doanh thu SHALL được tính dựa trên `shipping_fee`, KHÔNG phải số tiền thực thu (`bill_payment_details.amount_paid`).

Code dùng: `paid.reduce((s, b) => s + Number(b.shipping_fee || 0), 0)`.

> ⚠️ **Cần anh confirm**: với đơn `payOption = "actual"` (thu một phần) — hiện code vẫn cộng đủ `shipping_fee` vào doanh thu, KHÔNG cộng số thực thu. Đơn nợ phần còn lại không được trừ ra. Đây có đúng yêu cầu không? (Nếu sai, công thức đúng có thể là `SUM(bill_payment_details.amount_paid)` cho khoảng thời gian).

#### Scenario: Đơn thu một phần
- **GIVEN** đơn có `shipping_fee = 300000` và `bill_payment_details.amount_paid = 200000`, `payment_status = "paid"`
- **WHEN** tính doanh thu khoảng thời gian chứa `delivery_date` của đơn
- **THEN** doanh thu cộng `300000` (không phải `200000`)

### Requirement: Loại trừ đơn unpaid khỏi doanh thu
Đơn `payment_status = "unpaid"` (công nợ) SHALL không được cộng vào doanh thu.

Filter loại trừ: `if (b.payment_status !== "paid") return false;`.

#### Scenario: Đơn unpaid trong tháng
- **GIVEN** đơn delivered nhưng `payment_status = "unpaid"`
- **WHEN** tính doanh thu tháng đó
- **THEN** đơn không được cộng vào

### Requirement: Loại trừ đơn free khỏi doanh thu
Đơn `payment_status = "free"` SHALL không được cộng vào doanh thu (vì `shipping_fee = 0` và không phải paid).

#### Scenario: Đơn free
- **WHEN** tính doanh thu khoảng có chứa đơn free
- **THEN** đơn không xuất hiện

### Requirement: Chi phí filter theo created_at calendar day
Chi phí SHALL được lọc theo `expenses.created_at` calendar day; hệ thống MUST KHÔNG có khái niệm "ngày phát sinh kinh doanh" cho expense.

#### Scenario: Chi phí trong ngày
- **WHEN** filter type = `"day"`, ngày = `"2026-06-24"`
- **THEN** chỉ cộng expense có `created_at::date == "2026-06-24"` và `is_delete = false` và thuộc chi nhánh

### Requirement: Admin thêm chi phí phát sinh
Admin SHALL thêm được khoản chi phí phát sinh trên tab Doanh Thu. `branch_id` MUST được lấy từ sub-tab đang xem (KHÔNG phải `loggedBranch`).

Form gồm: số tiền + ghi chú.

#### Scenario: Admin SG thêm chi cho kho GL
- **WHEN** admin loggedBranch = `"SG"`, đang xem sub-tab `"GL"`, nhập 500000 + "đổ dầu xe"
- **THEN** insert vào `expenses` với `branch_id = <id của GL>`

#### Scenario: Thiếu số tiền hoặc ghi chú
- **WHEN** user bỏ trống 1 trong 2 trường
- **THEN** form không submit

### Requirement: Không hỗ trợ sửa/xóa chi phí
Hệ thống SHALL không hỗ trợ sửa hoặc xóa chi phí đã ghi nhận (code chỉ có insert; không có nút edit/delete cho expenses).

> ⚠️ **Cần anh confirm**: có cần thêm chức năng sửa/xóa chi phí không?

#### Scenario: Ghi nhầm số tiền
- **WHEN** admin ghi nhầm 5 triệu thay vì 500 nghìn
- **THEN** hiện tại KHÔNG có cách sửa qua UI (phải sửa DB trực tiếp)

### Requirement: Bảng chi tiết bill paid và expense trong khoảng filter
Hệ thống SHALL hiển thị danh sách bill paid và danh sách expense chi tiết trong khoảng filter, bên dưới các số tổng.

Bill paid hiển thị có thêm cột "Số tiền thực thu" đọc từ `bills.actual_amount_paid`.

> ⚠️ **Cảnh báo quan sát được**: cột "Số tiền thực thu" đọc `bills.actual_amount_paid` — field này tồn tại trong schema, được render UI, nhưng **không có chỗ nào trong code ghi giá trị vào**. Hiện luôn hiển thị NULL/0. Anh đã confirm cần persist field này.

#### Scenario: Đơn paid trong bảng chi tiết
- **WHEN** xem chi tiết doanh thu 1 ngày
- **THEN** bảng hiện cột "Số tiền thực thu" cho mỗi bill paid
- **AND** cột này hiện luôn rỗng/0 (vì field chưa bao giờ được ghi)

### Requirement: Filter tab Tổng Hợp Đơn Hàng
Tổng Hợp Đơn Hàng SHALL có filter theo ngày tạo (so với `created_at` calendar day) và ngày giao (so với `delivery_date` calendar day), kèm filter mã bill, SĐT khách, trạng thái giao, trạng thái thanh toán.

#### Scenario: Lọc theo ngày tạo
- **WHEN** user nhập `createdFrom = "2026-06-01"`, `createdTo = "2026-06-30"`
- **THEN** chỉ hiện bills có `created_at::date` trong [2026-06-01, 2026-06-30]

#### Scenario: Lọc theo SĐT khách
- **WHEN** user nhập "0909"
- **THEN** chỉ hiện bills có `sender_phone.phone_number` HOẶC `receiver_phone.phone_number` chứa "0909" (sau khi loại khoảng trắng)

#### Scenario: Sort mặc định
- **WHEN** lọc xong
- **THEN** danh sách sort `created_at` giảm dần (mới nhất trên cùng), bất kể trạng thái
