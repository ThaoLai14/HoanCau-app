# Delta: shipment-intake (revamp-payment-and-revenue-model)

> Áp dụng decisions D3, D8 cho capability `shipment-intake` — phần payment row trong flow intake.
> Vá lỗi I-2, I-3: luôn INSERT `bill_payment_details` (với `branch_id = session.branch_id`, `collected_by = session.userId`) trong mọi đường code khi bill được set `payment_status = 'paid'`.

## ADDED Requirements

### Requirement: Mọi flow tạo bill paid đều INSERT bill_payment_details

Khi bất kỳ flow nào (intake create / update draft / convert draft → pending) SET `bills.payment_status = 'paid'`, hệ thống SHALL INSERT 1 row vào `bill_payment_details` với:
- `bill_id` = id của bill vừa tạo/update
- `amount_paid` = `bills.shipping_fee`
- `branch_id` = `session.branch_id` (chi nhánh nhân viên đang login)
- `collected_by` = `session.userId`
- `note` = NULL (hoặc gợi ý "Thu cước lúc tạo bill" — implementation choice)
- `created_at` = NOW (DB default)

Đồng thời update `bills.actual_amount_paid = shipping_fee`.

Vá bug I-2 (executeUpdateDraft không insert payment khi tick paid) và I-3 (executeConvertDraftToBill không insert payment) đã flag trong audit intake gốc.

#### Scenario: executeCreateBill với isPaidImmediately=true

- **GIVEN** user login SG, đang ở form Tạo Đơn
- **WHEN** nhập đầy đủ + tick "Thanh toán ngay" + submit
- **THEN** INSERT `bills(payment_status='paid', ...)` thành công
- **AND** INSERT `bill_payment_details(amount_paid=shipping_fee, branch_id=SG, collected_by=<user SG>)`
- **AND** `bills.actual_amount_paid = shipping_fee`

#### Scenario: executeUpdateDraft - chuyển từ unpaid → paid

- **GIVEN** draft `bills.payment_status = 'unpaid'`, KHÔNG có row `bill_payment_details`
- **WHEN** user mở draft, tick "Thanh toán ngay", submit
- **THEN** UPDATE `bills.payment_status = 'paid'`
- **AND** INSERT `bill_payment_details` (branch=login, collected_by=login user)
- **AND** `bills.actual_amount_paid` được update

#### Scenario: executeConvertDraftToBill với paid

- **GIVEN** draft, user bấm "Tạo Hóa Đơn" với `isPaidImmediately = true`
- **WHEN** convert thành công (draft → pending+paid)
- **THEN** INSERT `bill_payment_details` (branch=login, collected_by=login user)

#### Scenario: Convert draft KHÔNG paid - không insert payment

- **GIVEN** draft, user bấm "Tạo Hóa Đơn" với `isPaidImmediately = false`
- **WHEN** convert (draft → pending+unpaid)
- **THEN** KHÔNG INSERT `bill_payment_details`

### Requirement: payment_details.branch_id = chi nhánh login (không phải bill.branch_id)

Mọi INSERT `bill_payment_details` trong flow intake SHALL dùng `session.branch_id`, KHÔNG dùng `bills.branch_id`.

Hai giá trị thường trùng nhau (vì intake bình thường nhân viên ở chi nhánh login tạo bill cho chính chi nhánh đó). Nhưng nếu admin tạo bill cho chi nhánh khác (giả định feature tương lai), giá trị có thể khác → branch của payment vẫn phải = nhân viên thực thu.

#### Scenario: Intake bình thường - 2 branch giống nhau

- **GIVEN** user login SG tạo bill SG, tick paid
- **THEN** `bills.branch_id = SG` AND `bill_payment_details.branch_id = SG`

### Requirement: payment_details có collected_by ngay từ intake

Khi INSERT `bill_payment_details` từ flow intake, `collected_by` SHALL = `session.userId`. KHÔNG nullable cho row mới (chỉ row backfill cũ có thể nullable).

#### Scenario: Intake create

- **GIVEN** user U1 login, tạo bill paid
- **WHEN** INSERT payment_details
- **THEN** `bill_payment_details.collected_by = U1`

## MODIFIED Requirements

### Requirement: executeCreateBill insert payment khi tick paid

`executeCreateBill` SHALL INSERT `bill_payment_details` khi `data.isPaidImmediately = true`, với `branch_id = session.branch_id` (KHÔNG `bills.branch_id`), `collected_by = session.userId`, `amount_paid = data.shipping_fee`.

> Thay đổi so với main spec: thêm yêu cầu `branch_id` và `collected_by` phải đúng.

Đồng thời update `bills.actual_amount_paid = data.shipping_fee` sau insert thành công.

#### Scenario: Create bill paid

- **WHEN** user login SG tạo bill mới + tick "Thanh toán ngay" với cước 250000
- **THEN** insert bills thành công
- **AND** insert `bill_payment_details(amount_paid=250000, branch_id=SG, collected_by=<user SG>)`
- **AND** `bills.actual_amount_paid = 250000`

#### Scenario: Create bill unpaid - không insert payment

- **WHEN** user tạo bill mới KHÔNG tick "Thanh toán ngay"
- **THEN** KHÔNG insert payment_details
- **AND** `bills.actual_amount_paid = 0` (default)
