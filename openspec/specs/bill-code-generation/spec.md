# Capability: Bill Code Generation

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (các hàm `getDayCode`, `getDayCounterFromStorage`, `advanceDepartureSession`, `reserveBillCode`).
> Đây là phần đang có **bug đã được anh xác nhận** (xem cảnh báo bên dưới), nhưng bản spec này mô tả hành vi HIỆN TẠI để làm baseline. Sửa bug sẽ được track bằng change `add-business-date-to-bills`.

## Purpose

Sinh mã đơn hàng có dạng `{seq2}{branch}{LetterNN}` (ví dụ `01SGA02`) duy nhất theo chi nhánh và theo từng "chuyến" (phiên xuất bến). Mã phải dự đoán được trước khi user bấm Lưu (mã preview = mã thật).

## Domain model

- Mã bill: `<seq:2 chữ số><branch:SG|GL><dayLetter:A..Z><dayNumber:01..99>`. Ví dụ `01SGA02`, `27GLB07`.
- `dayCode` = chữ cái + số (`A01`..`A99`, rồi `B01`..`B99`, ..., `Z99`). Hàm `getDayCode(n)` map index 1..2574 → ký hiệu đó.
- `seq` = số thứ tự đơn TRONG cùng phiên của 1 chi nhánh, đếm từ `01`.
- State được lưu ở `localStorage[hoanCauDayCounter_<branch>]` = `{ date: "YYYY-MM-DD", counter: number, sessionStart: ISO_string }`.
  - `counter` = chỉ số dayCode hiện tại (chuyển qua `getDayCode` để hiển thị).
  - `sessionStart` = mốc thời gian bắt đầu phiên hiện tại; dùng để đếm `seq` bằng SQL `WHERE created_at >= sessionStart`.

## Requirements

### Requirement: dayCounter và sessionStart độc lập theo chi nhánh
Mỗi chi nhánh SHALL có dayCounter và sessionStart riêng biệt trong localStorage; thao tác trên 1 chi nhánh KHÔNG ảnh hưởng chi nhánh còn lại.

Key `hoanCauDayCounter_SG` và `hoanCauDayCounter_GL` lưu độc lập.

#### Scenario: Cùng máy, làm việc cho cả 2 chi nhánh
- **WHEN** user (admin) xuất bến kho SG
- **THEN** chỉ `hoanCauDayCounter_SG` thay đổi
- **AND** `hoanCauDayCounter_GL` giữ nguyên

### Requirement: Auto-roll khi qua ngày mới
Khi truy cập lần đầu trong ngày calendar mới, hệ thống SHALL tự tăng `counter` lên 1 đơn vị và đặt `sessionStart` về `<today>T00:00:00`.

Cơ chế "auto-roll" áp dụng độc lập cho từng chi nhánh khi đọc localStorage của chi nhánh đó.

#### Scenario: Mở app sáng hôm sau, chưa bấm Xuất Bến tối qua
- **GIVEN** localStorage có `{date: "2026-06-23", counter: 5, sessionStart: "2026-06-23T08:00:00"}` (chi nhánh SG, mã ngày A05)
- **WHEN** user mở app vào 2026-06-24
- **THEN** `getDayCounterFromStorage("SG")` trả `{date: "2026-06-24", counter: 6, sessionStart: "2026-06-24T00:00:00"}`
- **AND** mã đơn tiếp theo bắt đầu từ `01SGA06`

### Requirement: Xuất Bến mở phiên mới ngay lập tức
Bấm "Xuất Bến" SHALL kết thúc phiên hiện tại của chi nhánh đó và mở phiên mới ngay lập tức: `counter` tăng 1, `sessionStart` = thời điểm hiện tại (ISO now), `date` = ngày calendar hiện tại.

#### Scenario: Xuất bến ban ngày
- **GIVEN** localStorage SG `{date: "2026-06-24", counter: 6, sessionStart: "2026-06-24T00:00:00"}`
- **WHEN** user bấm Xuất Bến lúc 14:30 ngày 2026-06-24
- **THEN** localStorage SG → `{date: "2026-06-24", counter: 7, sessionStart: "2026-06-24T14:30:xx"}`
- **AND** mã đơn tiếp theo `01SGA07`

#### Scenario: Đơn tạo trước Xuất Bến giữ mã cũ
- **WHEN** đã có đơn `01SGA06`, `02SGA06` được tạo trước khi bấm Xuất Bến
- **THEN** chúng không bị đổi mã sau khi Xuất Bến
- **AND** đơn kế tiếp tạo sau Xuất Bến nhận mã `01SGA07`

> ⚠️ **Bug đã xác nhận**: hành vi này CHỈ FIX mã bill. `bills.created_at` của các đơn sau Xuất Bến vẫn là `now()` của Postgres trong CÙNG ngày calendar. Hệ quả: tab Kho và tab Doanh Thu (đang filter theo `created_at::date`) hiển thị các đơn "thuộc chuyến mai" trên ngày HÔM NAY. Xem change `add-business-date-to-bills` để track việc thêm cột `business_date`.

### Requirement: Mã preview = mã thật
Mã preview hiển thị trên form tạo đơn SHALL bằng mã thực sẽ được ghi vào `bills.bill_code` khi user bấm Lưu.

Khi mở form, `reserveBillCode()` query DB đếm số bill của chi nhánh có `created_at >= sessionStart`, cộng 1, sinh ra mã `{seq}{branch}{dayCode}` và hiển thị. Khi submit, mã reserve được dùng trực tiếp.

#### Scenario: Mở form lần đầu trong phiên
- **WHEN** user mở form tạo đơn, chưa có bill nào trong phiên SG hiện tại
- **THEN** `reservedBillCode = "01SGA07"` (giả sử counter = 7)
- **AND** khi user bấm Lưu, `bills.bill_code` = `"01SGA07"`

#### Scenario: Tạo 2 đơn liên tiếp trong cùng phiên
- **WHEN** user tạo xong đơn `01SGA07`
- **THEN** hệ thống gọi lại `reserveBillCode()` → `02SGA07`
- **AND** đồng thời tăng `billSeq` ở state UI để đỡ phải đợi DB

### Requirement: Draft không có mã
Đơn nháp (`delivery_status = "draft"`) SHALL không được cấp mã; `bill_code = NULL`. Chỉ khi convert draft → pending mới sinh mã.

#### Scenario: Lưu nháp
- **WHEN** user bấm "Lưu nháp"
- **THEN** insert bill với `bill_code = NULL` và `delivery_status = "draft"`

#### Scenario: Convert nháp thành đơn chính thức
- **WHEN** user mở 1 draft và bấm "Lưu" (submit chính thức)
- **THEN** hệ thống dùng `reservedBillCode` đang hiển thị (hoặc tính lại nếu trống) làm `bill_code`
- **AND** update `delivery_status = "pending"`

### Requirement: Không có cơ chế chống trùng bill_code server-side
Hệ thống MUST được coi là KHÔNG có cơ chế tránh trùng `bill_code` ở server-side; toàn bộ logic sinh mã chạy ở client với localStorage + 1 lần query DB.

Hai nhân viên cùng chi nhánh, mở 2 thiết bị cùng lúc có thể reserve cùng 1 mã.

> ⚠️ **Cần anh quyết định**: chấp nhận rủi ro này, hay phải thêm unique constraint + retry / sequence ở Postgres. Hiện tại anh trả lời "chưa có ý kiến" → để mở.

#### Scenario: 2 thiết bị cùng chi nhánh, cùng lúc
- **WHEN** thiết bị A và B cùng mở form lúc seq hiện tại = 7
- **AND** cả 2 đều reserve `08SGA07`
- **AND** cả 2 cùng submit
- **THEN** DB sẽ có 2 bills cùng `bill_code = "08SGA07"` (vì không có UNIQUE constraint)
