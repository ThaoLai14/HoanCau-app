# Capability: Authentication & Roles

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/LoginScreen.jsx` và `src/App.jsx` (đọc tại commit hiện tại).
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng. CHƯA có thay đổi code nào tại thời điểm tạo spec này.

## Purpose

Cho phép nhân viên Hoàn Cầu đăng nhập bằng username + password, gắn người dùng với 1 chi nhánh (SG hoặc GL) và 1 role (`admin` | `member` | `boss`) để giới hạn quyền thao tác trên từng tab.

## Domain model

- Table `users(id, username, password_hash, full_name, role, branch_id)`.
- Table `branches(id, branch_code)` với `branch_code ∈ {"SG", "GL"}`.
- Phiên đăng nhập lưu ở `localStorage["hc_session"]` (JSON), KHÔNG có server-side session.
- Không có Supabase Auth — toàn bộ kiểm tra mật khẩu chạy ở client.

## Requirements

### Requirement: Plaintext password comparison
Hệ thống SHALL xác thực người dùng bằng cách so sánh chuỗi `password` nhập vào với `users.password_hash` đúng theo ký tự (không hashing, không salting).

Người dùng nhập `username` và `password` trên màn hình đăng nhập. Hệ thống truy vấn `public.users` theo `username`, sau đó so sánh trực tiếp.

> ⚠️ Đây là hành vi quan sát được trong code (`LoginScreen.jsx`). Cột tên `password_hash` nhưng **giá trị thực tế đang lưu là plaintext**. Cần anh xác nhận đây có phải hành vi mong muốn hay là bug bảo mật phải sửa.

#### Scenario: Đăng nhập thành công
- **WHEN** người dùng nhập `username` tồn tại trong `users` (với `is_delete` = false) và `password` khớp `users.password_hash`
- **THEN** hệ thống tạo object session `{ id, username, full_name, role, branch_code }` và lưu vào `localStorage["hc_session"]`
- **AND** chuyển sang màn hình chính, tab mặc định là **Phiếu Gửi Hàng** (`bills`)

#### Scenario: Sai mật khẩu
- **WHEN** `password` nhập vào không trùng `users.password_hash`
- **THEN** hệ thống hiển thị thông báo lỗi và KHÔNG ghi gì vào `localStorage`

#### Scenario: Username không tồn tại
- **WHEN** không tìm thấy `users` nào có `username` đó (hoặc `is_delete = true`)
- **THEN** hệ thống hiển thị thông báo lỗi giống trường hợp sai mật khẩu (không tiết lộ user có tồn tại hay không)

### Requirement: User gắn cứng 1 chi nhánh
Mỗi user SHALL được gắn cứng với đúng 1 chi nhánh khi đăng nhập; `branch_code` đó trở thành `loggedBranch` và là chi nhánh mặc định trên tất cả tab.

#### Scenario: User chi nhánh SG đăng nhập
- **WHEN** user có `branch_code = "SG"` đăng nhập thành công
- **THEN** `currentBranch = "SG"` trong form tạo đơn
- **AND** tab kho mặc định `warehouseBranch = "SG"`
- **AND** tab Tổng Hợp Đơn Hàng mặc định `allBillsTab = "SG"`
- **AND** tab Doanh Thu mặc định `revenueTab = "SG"`

### Requirement: Phân quyền 3 role
Hệ thống SHALL phân 3 role với quyền truy cập tab khác nhau, dựa trên `users.role`. Việc kiểm soát quyền chỉ thực hiện ở client (ẩn nút, disable input).

| Tab | admin | member | boss |
|---|---|---|---|
| Quản Lý Khách Hàng | đầy đủ | KHÔNG thấy menu | xem được, mọi input bị `disabled` |
| Phiếu Gửi Hàng | đầy đủ | tạo đơn + xem chi tiết, KHÔNG sửa/hủy đơn pending | đầy đủ |
| Danh Sách Bốc Xếp | đầy đủ | đầy đủ | đầy đủ |
| Tổng Hợp Đơn Hàng | đầy đủ | đầy đủ | đầy đủ |
| Quản Lý Doanh Thu | đầy đủ | KHÔNG thấy menu | đầy đủ |

> ⚠️ **Cần anh confirm**: hiện code KHÔNG có role-gate trên nút **Xuất Bến** (member bấm được), trên nút **Sửa / Hủy đơn pending** trong Bills tab (boss bấm được), và trên thao tác **Thêm chi phí phát sinh** trong Doanh Thu (boss bấm được). Đây có đúng ý anh không?

#### Scenario: Member không nhìn thấy menu Khách Hàng và Doanh Thu
- **WHEN** user có `role = "member"` đăng nhập
- **THEN** sidebar chỉ hiển thị 3 mục: Phiếu Gửi Hàng, Danh Sách Bốc Xếp, Tổng Hợp Đơn Hàng

#### Scenario: Boss vào tab Khách Hàng ở chế độ chỉ đọc
- **WHEN** user có `role = "boss"` mở tab Quản Lý Khách Hàng
- **THEN** mọi `<input>`, `<button>` thêm/sửa/blacklist/xóa đều có thuộc tính `disabled`
- **AND** boss vẫn xem được toàn bộ danh sách khách hàng

#### Scenario: Admin có toàn quyền operational
- **WHEN** user có `role = "admin"` đăng nhập
- **THEN** sidebar hiển thị đủ 5 mục
- **AND** có thể tạo / sửa / hủy đơn, sửa khách hàng, xuất bến, ghi chi phí

### Requirement: Phiên đăng nhập không hết hạn
Hệ thống SHALL giữ phiên đăng nhập trên thiết bị cho đến khi user bấm Đăng Xuất; không có cơ chế expiration tự động.

#### Scenario: Reload trang vẫn còn đăng nhập
- **WHEN** user đã đăng nhập, refresh trình duyệt
- **THEN** ứng dụng đọc lại `localStorage["hc_session"]` và bỏ qua màn hình đăng nhập

#### Scenario: Đăng xuất
- **WHEN** user bấm nút Đăng Xuất
- **THEN** hệ thống xóa key `hc_session` khỏi `localStorage`
- **AND** quay về `LoginScreen`

#### Scenario: localStorage bị xóa thủ công
- **WHEN** user xóa `localStorage["hc_session"]` qua DevTools rồi refresh
- **THEN** ứng dụng hiển thị `LoginScreen`
