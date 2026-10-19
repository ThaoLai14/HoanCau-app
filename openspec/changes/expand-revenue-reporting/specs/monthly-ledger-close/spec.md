## ADDED Requirements

### Requirement: Khóa sổ chi phí theo tháng × chi nhánh
Hệ thống SHALL theo dõi trạng thái khóa sổ chi phí cho mỗi cặp (chi nhánh, tháng) qua bảng `monthly_closes(id, branch_id, period_month, status, closed_by, closed_at)` với `status ∈ {open, closed}`. Mỗi chi nhánh MUST được khóa **độc lập** cho cùng một tháng.

#### Scenario: Khóa SG không ảnh hưởng GL
- **WHEN** boss khóa sổ tháng 10 cho chi nhánh SG
- **THEN** tháng 10 của GL vẫn ở trạng thái mở, có thể nhập phiếu chi tháng

### Requirement: Cửa sổ ân hạn 3 ngày cho phiếu chi tháng
Phiếu chi `period_type = 'month'` của tháng `T` SHALL được admin / boss nhập hoặc sửa trong tháng `T` và trong **3 ngày đầu** của tháng `T+1`. Sau mốc đó, hoặc sau khi tháng bị khóa, admin / boss MUST bị chặn.

#### Scenario: Nhập bù lương trong hạn
- **WHEN** admin nhập phiếu chi tháng cho tháng 10 vào ngày 2 tháng 11, tháng 10 chưa khóa
- **THEN** phiếu chi được lưu, tính vào tháng 10

#### Scenario: Quá hạn ân hạn
- **WHEN** admin cố nhập phiếu chi tháng cho tháng 10 vào ngày 5 tháng 11
- **THEN** hệ thống chặn; chỉ `sys_admin` mới nhập được

### Requirement: Nhắc boss hoàn tất doanh thu tháng trước
Khi role `boss` mở app, nếu tháng liền trước của một chi nhánh chưa `closed` và còn trong cửa sổ ân hạn, hệ thống SHALL hỏi "Đã hoàn tất doanh thu tháng {T} chưa?". Bấm "Rồi" MUST set trạng thái `closed` ngay. Bấm "Chưa" MUST nhắc số ngày còn lại và lặp lại prompt ở lần mở app sau, cho tới khi khóa hoặc hết hạn.

#### Scenario: Boss xác nhận đã hoàn tất
- **WHEN** boss mở app ngày 1 tháng 11, chọn "Rồi" cho tháng 10 chi nhánh SG
- **THEN** `monthly_closes` ghi `status = 'closed'`, `closed_by = boss`, `closed_at = now`
- **AND** tháng 10 SG không nhận thêm phiếu chi từ admin/boss

#### Scenario: Boss hoãn lại
- **WHEN** boss chọn "Chưa"
- **THEN** hiển thị "bạn còn N ngày để cập nhật"
- **AND** lần mở app sau vẫn hỏi lại cho tới khi khóa hoặc hết 3 ngày

### Requirement: Chỉ boss được khóa sổ thủ công
Chỉ role `boss` SHALL được khóa sổ một tháng. admin MUST KHÔNG khóa được. boss SHALL có nút khóa sổ thủ công trong tab Tháng để khóa bất cứ lúc nào, không cần chờ prompt.

#### Scenario: Admin không có nút khóa
- **WHEN** admin mở tab Tháng
- **THEN** không thấy nút khóa sổ

#### Scenario: Boss khóa sớm
- **WHEN** boss bấm nút khóa sổ tháng 10 SG vào ngày 28 tháng 10
- **THEN** tháng 10 SG chuyển `closed`; admin/boss không nhập thêm phiếu chi tháng 10 SG

### Requirement: sys_admin bypass khóa sổ
Role `sys_admin` SHALL luôn nhập hoặc sửa phiếu chi cho tháng quá khứ bất kể trạng thái khóa hay cửa sổ ân hạn. Mọi thao tác backdate của `sys_admin` MUST ghi audit log.

#### Scenario: sys_admin sửa tháng đã khóa
- **WHEN** `sys_admin` thêm phiếu chi cho tháng 8 đã khóa từ lâu
- **THEN** phiếu chi được lưu vào tháng 8
- **AND** audit log ghi lại hành động backdate kèm user và thời điểm

### Requirement: Trạng thái khóa là tính toán
Một tháng `T` của chi nhánh `B` SHALL được coi là KHÓA đối với admin / boss khi tồn tại `monthly_closes` row `closed`, HOẶC khi ngày hiện tại vượt quá 3 ngày đầu của tháng `T+1`. Cờ `closed` biểu thị "khóa sớm chủ động"; hết hạn ân hạn biểu thị "khóa tự động".

#### Scenario: Khóa tự động khi hết hạn
- **WHEN** chưa ai bấm khóa tháng 10 SG, và hôm nay là ngày 10 tháng 11
- **THEN** tháng 10 SG coi như đã khóa với admin/boss (chỉ `sys_admin` sửa được)
