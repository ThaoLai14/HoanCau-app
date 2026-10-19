## MODIFIED Requirements

### Requirement: Sub-tab chi nhánh và chế độ lọc thời gian
Tab Doanh Thu SHALL có sub-tab chi nhánh (SG, GL, và "Tổng 2 chi nhánh" chỉ hiển thị với role `boss`) và 3 sub-tab chế độ thời gian (Ngày, Tháng, Năm) với bố cục riêng cho mỗi kỳ. Sub-tab chi nhánh mặc định MUST = chi nhánh đăng nhập (`loggedBranch`); sub-tab thời gian mặc định = Ngày.

#### Scenario: Ba chế độ thời gian là sub-tab riêng
- **WHEN** user mở tab Doanh Thu
- **THEN** thấy 3 sub-tab Ngày / Tháng / Năm, mỗi tab có bố cục riêng (không phải một dropdown gộp chung)

#### Scenario: Lọc theo ngày
- **WHEN** user chọn sub-tab Ngày, ngày = `"2026-06-24"`
- **THEN** doanh thu = tổng `bill_payment_details.amount_paid` thuộc chi nhánh đang chọn, `toVNDate(created_at) === "2026-06-24"`, loại bill `is_delete` và (tùy quyết định D11) bill `cancelled`

#### Scenario: Lọc theo tháng
- **WHEN** user chọn sub-tab Tháng = `"2026-06"`
- **THEN** doanh thu = tổng `amount_paid` mà `toVNDate(created_at).slice(0,7) === "2026-06"`

#### Scenario: Lọc theo năm
- **WHEN** user chọn sub-tab Năm = `"2026"`
- **THEN** doanh thu = tổng `amount_paid` mà `toVNDate(created_at).slice(0,4) === "2026"`

### Requirement: Chi phí filter theo created_at calendar day
Chi phí `period_type = 'day'` SHALL được lọc theo ngày (calendar day của ngày nghiệp vụ đã gán); chi phí `period_type = 'month'` SHALL được gom theo `period_month`, KHÔNG theo `created_at`. Màn Ngày MUST chỉ cộng phiếu chi `period_type = 'day'` của đúng ngày.

#### Scenario: Chi phí ngày trong màn Ngày
- **WHEN** sub-tab Ngày, ngày = `"2026-10-05"`
- **THEN** chỉ cộng `expenses` có `period_type = 'day'`, ngày = `"2026-10-05"`, `is_delete = false`, thuộc chi nhánh

#### Scenario: Phiếu chi tháng không hiện ở màn Ngày
- **GIVEN** phiếu chi lương `period_type = 'month'`, `period_month = "2026-10-01"`
- **WHEN** xem màn Ngày bất kỳ trong tháng 10
- **THEN** phiếu chi lương KHÔNG được cộng vào bất kỳ ngày nào

### Requirement: Admin thêm chi phí phát sinh
Admin SHALL thêm được khoản chi phí trên tab Doanh Thu, bắt buộc chọn **category** và **loại kỳ** (theo ngày / theo tháng). `branch_id` MUST được lấy từ sub-tab chi nhánh đang xem. Phiếu chi theo ngày MUST tuân quy tắc chặn backdate; phiếu chi theo tháng MUST tuân cửa sổ ân hạn / khóa sổ.

#### Scenario: Thêm phiếu chi ngày có category
- **WHEN** admin nhập 200000, category "tiền xe", loại = theo ngày, hôm nay
- **THEN** insert `expenses` với `period_type = 'day'`, `category_id = <tiền xe>`, `branch_id = <chi nhánh sub-tab>`

#### Scenario: Thêm phiếu chi tháng
- **WHEN** admin nhập 30000000, category "tiền lương", loại = theo tháng, tháng = `"2026-10"`
- **THEN** insert `expenses` với `period_type = 'month'`, `period_month = "2026-10-01"`

#### Scenario: Thiếu category hoặc số tiền
- **WHEN** user bỏ trống category hoặc số tiền
- **THEN** form không submit

## ADDED Requirements

### Requirement: Chặn backdate phiếu chi ngày
admin / boss SHALL chỉ tạo được phiếu chi `period_type = 'day'` cho **ngày hôm nay**. Chỉ role `sys_admin` SHALL thêm hoặc sửa phiếu chi ngày cho ngày quá khứ. Mọi thao tác backdate MUST ghi audit log.

#### Scenario: Admin không nhập được cho hôm qua
- **WHEN** admin cố thêm phiếu chi ngày cho ngày hôm qua
- **THEN** hệ thống chặn

#### Scenario: sys_admin nhập bù ngày quá khứ
- **WHEN** `sys_admin` thêm phiếu chi ngày cho ngày trong quá khứ
- **THEN** phiếu chi được lưu
- **AND** audit log ghi lại hành động kèm user và thời điểm

### Requirement: Báo cáo tháng gom chi theo category
Màn Tháng SHALL hiển thị tổng thu, tổng chi (phiếu chi ngày trong tháng + phiếu chi tháng), lợi nhuận, và một bảng chi gom theo **category** của riêng tháng đó.

#### Scenario: Bảng chi theo category trong tháng
- **WHEN** xem sub-tab Tháng = `"2026-10"`, chi nhánh SG
- **THEN** hiển thị mỗi category một dòng với tổng chi của category đó trong tháng 10 SG
- **AND** tổng chi = tổng các dòng category

### Requirement: Báo cáo năm — thu theo tháng, chi theo category
Màn Năm SHALL hiển thị: (1) thu tổng hợp theo từng tháng (12 dòng) kèm tổng thu năm; (2) chi gom theo category với tổng cả năm cho mỗi category; (3) lợi nhuận năm = tổng thu − tổng chi.

#### Scenario: Báo cáo năm
- **WHEN** xem sub-tab Năm = `"2026"`, chi nhánh SG
- **THEN** bảng thu có 12 dòng (tháng 1–12) + tổng thu năm
- **AND** bảng chi có mỗi category một dòng = tổng chi category đó cả năm 2026 SG
- **AND** lợi nhuận năm = tổng thu năm − tổng chi năm

### Requirement: Tab tổng gộp hai chi nhánh cho boss
Tab Doanh Thu SHALL có sub-tab chi nhánh "Tổng 2 chi nhánh" chỉ hiển thị với role `boss`, cộng gộp doanh thu và chi phí của cả SG và GL trong kỳ đang chọn (read-only, không có form nhập phiếu chi).

#### Scenario: Boss xem tổng hai chi nhánh
- **WHEN** boss chọn sub-tab "Tổng 2 chi nhánh", kỳ = tháng `"2026-10"`
- **THEN** tổng thu = thu SG + thu GL; tổng chi = chi SG + chi GL cho tháng 10
- **AND** không hiển thị form thêm phiếu chi

#### Scenario: Admin không thấy tab tổng
- **WHEN** user role = `admin`
- **THEN** sub-tab "Tổng 2 chi nhánh" không hiển thị
