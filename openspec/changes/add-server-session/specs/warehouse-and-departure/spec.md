# Delta spec: warehouse-and-departure

## MODIFIED Requirements

### Requirement: Filter danh sách bốc xếp theo chi nhánh và ngày kinh doanh
Tab Danh Sách Bốc Xếp MUST hiển thị các bill thuộc 1 chi nhánh + 1 ngày kinh doanh (`business_date`), loại trừ draft và cancelled. Filter cũ theo `created_at::date` MUST được THAY THẾ HOÀN TOÀN bằng `business_date`.

Filter: `branch_code === warehouseBranch && delivery_status NOT IN ('draft', 'cancelled') && b.business_date === warehouseDate`.

`warehouseDate` default = `toVNDate(new Date())` (hôm nay theo giờ VN).

#### Scenario: Mặc định mở tab Kho
- **WHEN** user mở tab Danh Sách Bốc Xếp
- **THEN** `warehouseDate = toVNDate(now)`, `warehouseBranch = loggedBranch`
- **AND** chỉ hiện bill có `business_date = warehouseDate`, đúng branch, không phải draft/cancelled

#### Scenario: Đơn của chuyến mai không lẫn vào danh sách hôm nay
- **GIVEN** đơn `01SGA02` có `business_date = 2026-07-01`, `created_at = 2026-07-01T10:00`
- **AND** đơn `01SGB01` có `business_date = 2026-07-02`, `created_at = 2026-07-01T15:00` (sau Xuất Bến)
- **WHEN** user mở tab Kho ngày 2026-07-01
- **THEN** danh sách chỉ có `01SGA02`
- **WHEN** đổi date sang 2026-07-02
- **THEN** danh sách chỉ có `01SGB01`

#### Scenario: Badge đếm số đơn
- **WHEN** `warehouseDate = 2026-07-01`
- **THEN** badge mỗi chi nhánh hiện count bill có `business_date = 2026-07-01`, `delivery_status NOT IN ('draft', 'cancelled')`

### Requirement: Xuất Bến gọi server UPDATE
Bấm "Xuất Bến" MUST gọi `advanceDepartureSession(branchId)` (helper) → UPDATE `branch_sessions` trên DB. `localStorage` MUST KHÔNG còn được ghi.

Sau khi server response thành công → toast "Đã xuất bến. Business date mới: dd/mm/yyyy" và refresh cache.

Role `boss` MUST KHÔNG bấm được nút Xuất Bến (button disabled hoặc ẩn).

#### Scenario: Xuất Bến thành công
- **WHEN** admin/member bấm Xuất Bến SG
- **THEN** DB UPDATE `branch_sessions` cho SG
- **AND** cache React state update
- **AND** hiện toast xác nhận

#### Scenario: Boss không thể Xuất Bến
- **GIVEN** user role = boss
- **WHEN** vào tab Warehouse
- **THEN** nút Xuất Bến ẩn hoặc disabled

#### Scenario: DB down
- **WHEN** bấm Xuất Bến và Supabase không phản hồi
- **THEN** toast error "Không kết nối được server, vui lòng thử lại"
- **AND** cache KHÔNG update (giữ session cũ)
