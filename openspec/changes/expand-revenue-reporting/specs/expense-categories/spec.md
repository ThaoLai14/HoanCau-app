## ADDED Requirements

### Requirement: Bảng danh mục chi phí dùng chung
Hệ thống SHALL có bảng `expense_categories(id, name, is_active, created_at)` chứa danh mục chi phí **dùng chung cho cả hai chi nhánh** SG và GL. Danh sách khởi tạo MUST gồm: tiền ăn, tiền mua vật dụng, tiền lương, tiền thuê văn phòng, tiền xe, tiền trà nước lái xe, và một category mặc định "Chưa phân loại".

#### Scenario: Danh mục áp dụng cho cả hai chi nhánh
- **WHEN** admin SG và admin GL mở form nhập phiếu chi
- **THEN** cả hai thấy cùng một danh sách category từ `expense_categories` có `is_active = true`

### Requirement: Chỉ sys_admin quản lý danh mục
Chỉ role `sys_admin` SHALL được thêm, sửa, hoặc xoá category. admin / boss / member MUST KHÔNG có quyền chỉnh sửa danh mục.

#### Scenario: Admin không thấy chức năng quản lý category
- **WHEN** user role = `admin` mở màn quản lý
- **THEN** không có nút thêm/sửa/xoá category

#### Scenario: sys_admin thêm category mới
- **WHEN** `sys_admin` thêm category tên "tiền bốc xếp"
- **THEN** insert vào `expense_categories` với `is_active = true`
- **AND** category xuất hiện trong form nhập phiếu chi của cả hai chi nhánh

### Requirement: Chặn xoá category còn dính phiếu chi
Hệ thống SHALL chỉ cho xoá category KHÔNG được tham chiếu bởi bất kỳ phiếu chi nào. Nếu category còn dính `expenses` → thao tác xoá MUST bị chặn và hiển thị thông báo "đang có phiếu chi liên quan".

#### Scenario: Xoá category đang dùng
- **WHEN** `sys_admin` xoá category "tiền xe" đang có phiếu chi tham chiếu
- **THEN** hệ thống chặn và báo "đang có phiếu chi liên quan"
- **AND** category không bị xoá

#### Scenario: Xoá category chưa dùng
- **WHEN** `sys_admin` xoá category chưa có phiếu chi nào tham chiếu
- **THEN** category bị xoá (hoặc set `is_active = false`) thành công

### Requirement: Sửa tên category áp dụng cho cả phiếu chi cũ
Khi `sys_admin` đổi tên một category, tên mới SHALL áp dụng cho **cả phiếu chi cũ lẫn mới**, vì phiếu chi tham chiếu `category_id` chứ không lưu bản sao tên.

#### Scenario: Đổi tên category đang có lịch sử
- **WHEN** `sys_admin` đổi "tiền ăn" thành "tiền ăn uống"
- **THEN** mọi phiếu chi cũ thuộc category đó hiển thị tên mới trong báo cáo tháng/năm

### Requirement: Mỗi phiếu chi bắt buộc có category
Mỗi bản ghi `expenses` SHALL tham chiếu đúng một category qua `category_id` (NOT NULL). Form nhập phiếu chi (cả theo ngày lẫn theo tháng) MUST bắt buộc chọn category trước khi lưu. Phiếu chi cũ chưa có category MUST được gán mặc định "Chưa phân loại".

#### Scenario: Nhập phiếu chi thiếu category
- **WHEN** admin nhập số tiền + ghi chú nhưng không chọn category
- **THEN** form không cho submit

#### Scenario: Backfill phiếu chi cũ
- **WHEN** migration thêm cột `category_id` cho dữ liệu `expenses` hiện có
- **THEN** mọi phiếu chi cũ được gán category "Chưa phân loại"
