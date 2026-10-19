# Delta spec: shipment-intake

## ADDED Requirements

### Requirement: Bill ghi business_date từ session DB
Khi insert hoặc update 1 bill (cả draft, pending mới, convert draft→pending), payload MUST bao gồm cột `business_date` lấy từ `session.business_date` (fetch từ `branch_sessions`).

`business_date` đại diện ngày kinh doanh (chuyến xe) của bill, độc lập với `created_at` (thời điểm thực tế bấm Lưu).

Session MUST được re-fetch NGAY TRƯỚC khi insert/update để đảm bảo đúng.

#### Scenario: Tạo bill mới trong phiên hôm nay
- **GIVEN** `branch_sessions.SG.business_date = 2026-07-01`
- **WHEN** user submit form tạo đơn lúc 10:00 sáng 2026-07-01
- **THEN** `bills.business_date = '2026-07-01'`
- **AND** `bills.created_at` ≈ `'2026-07-01T10:00:xx+07:00'`

#### Scenario: Tạo bill sau Xuất Bến
- **GIVEN** session sau Xuất Bến lúc 14:30 → `business_date = '2026-07-02'`
- **WHEN** user submit form tạo đơn lúc 15:00 ngày 2026-07-01
- **THEN** `bills.business_date = '2026-07-02'`
- **AND** `bills.created_at` ≈ `'2026-07-01T15:00:xx+07:00'` (vẫn là hôm nay)

#### Scenario: Convert draft → pending re-stamp business_date
- **GIVEN** 1 draft tạo hôm 2026-06-30 (lúc đó session `business_date = 2026-06-30`)
- **WHEN** user mở draft đó vào 2026-07-01 và bấm "Lưu" (chính thức)
- **THEN** `bills.business_date` update thành `'2026-07-01'` (theo session hiện tại)
- **AND** `bills.bill_code` sinh theo session hiện tại (mã mới)

#### Scenario: Update draft giữ nguyên draft — re-stamp business_date
- **GIVEN** draft tạo hôm trước
- **WHEN** user mở draft hôm nay, sửa rồi "Lưu nháp"
- **THEN** `bills.business_date` update thành session hiện tại

## MODIFIED Requirements

### Requirement: Bill code retry khi race
`executeCreateBill` và `executeConvertDraftToBill` MUST catch error `23505` từ UNIQUE(branch_id, bill_code) và retry: re-fetch `branch_sessions` → compute `bill_code` mới → INSERT/UPDATE lại. Max 3 lần retry. Retry silent (không modal).

Race window: 2 client insert đồng thời với cùng `bill_seq`.

#### Scenario: Retry thành công lần 2
- **WHEN** client A và B cùng insert `05SGA05`
- **AND** A thành công, B nhận 23505
- **THEN** B refetch → thấy `bill_seq = 6` → insert `06SGA05` → thành công
- **AND** không hiển thị modal cho user B
