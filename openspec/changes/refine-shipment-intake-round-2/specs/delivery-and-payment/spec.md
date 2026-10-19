# Delta: delivery-and-payment (refine-shipment-intake-round-2)

> Round 2 thêm auto-refund flow khi hủy bill đã thanh toán.

## ADDED Requirements

### Requirement: Hủy bill paid → auto INSERT expense refund

Khi 1 bill với `payment_status='paid'` bị hủy (`delivery_status` chuyển từ `pending` sang `cancelled`), hệ thống SHALL tự động INSERT 1 row `expenses` để biểu diễn refund cước cho khách.

Row expense refund:
- `amount = -SUM(bill_payment_details.amount_paid WHERE bill_id = target_bill_id)`
  (số âm — để revenue report sum theo amount ra net revenue chính xác).
- `source_bill = <target_bill_id>` — trace ngược về bill nguồn.
- `branch_id = bills.branch_id` (chi nhánh của bill được hủy).
- `note = 'Hoàn cước bill <bill_code> do hủy đơn'`.
- `created_by = <user_id thực hiện hủy>`.
- `created_at = now()`.
- `is_delete = false`.

Row expense refund này MUST được INSERT TRONG CÙNG 1 transaction với UPDATE `bills.delivery_status='cancelled'` (qua RPC `cancel_bill_with_audit` — xem delta `audit-log`). Nếu bất kỳ bước nào fail → rollback toàn bộ.

Row expense refund KHÔNG cho admin/member sửa hay xóa qua UI (audit-safe). Nếu cần điều chỉnh sai sót → tạo expense mới bù trừ.

#### Scenario: Hủy bill paid — INSERT expense âm

- **GIVEN** bill `05SGA02` (SG) pending + paid, `actual_amount_paid=250000`, `bill_payment_details` có 1 row `amount_paid=250000`
- **WHEN** member SG hủy với lý do "Khách trả hàng"
- **THEN** `bills.delivery_status='cancelled'`
- **AND** `expenses` có row mới: `amount=-250000`, `source_bill=<bill_id>`, `branch_id=SG`, `note='Hoàn cước bill 05SGA02 do hủy đơn'`, `created_by=<member_id>`
- **AND** toast "Đã hủy đơn 05SGA02 và hoàn cước 250,000 VND"

#### Scenario: Hủy bill unpaid — KHÔNG INSERT expense

- **GIVEN** bill `05SGA03` pending + unpaid (chưa thu tiền)
- **WHEN** member hủy
- **THEN** `bills.delivery_status='cancelled'`
- **AND** KHÔNG có row expense mới

#### Scenario: Hủy bill free — KHÔNG INSERT expense

- **GIVEN** bill `05SGA04` pending + free
- **WHEN** member hủy
- **THEN** `bills.delivery_status='cancelled'`
- **AND** KHÔNG có row expense mới (bill free = không thu tiền = không có gì để hoàn)

#### Scenario: Hủy bill paid nhiều lần thu — sum tất cả

- **GIVEN** bill `05SGA05` paid, `bill_payment_details` có 2 rows (thu lần 1 = 100k, thu lần 2 = 150k, total = 250k)
- **WHEN** admin hủy
- **THEN** expense refund có `amount=-250000` (sum tất cả `amount_paid` cho bill này)

#### Scenario: Expense refund không sửa được

- **GIVEN** expense refund `amount=-250000` đã tạo bởi cancel bill flow
- **WHEN** admin cố mở tab Chi Phí và sửa row này
- **THEN** row hiển readonly hoặc không hiện nút Sửa/Xóa
- **AND** nếu bypass qua RPC → RPC reject với check `source_bill IS NOT NULL AND amount < 0` (là expense refund auto)

### Requirement: Revenue report accommodate expense refund âm

Báo cáo doanh thu SHALL cộng dồn `expenses.amount` theo dấu (âm cho refund). Net revenue theo ngày = SUM(bill_payment_details thu vào) + SUM(expenses.amount) — với `expenses.amount` có thể âm (refund) hoặc dương (chi phí thường).

Cột hiển thị:
- "Thu": `bill_payment_details.amount_paid` cộng dồn.
- "Chi": `SUM(CASE WHEN expenses.amount > 0 THEN expenses.amount ELSE 0 END)`.
- "Hoàn cước": `SUM(CASE WHEN expenses.amount < 0 AND source_bill IS NOT NULL THEN -expenses.amount ELSE 0 END)` (hiển positive số).
- "Net": Thu - Chi - Hoàn cước.

#### Scenario: Ngày có 1 bill paid 250k rồi bị hủy

- **GIVEN** ngày 01/07/2026, SG:
  - Bill `05SGA02` paid 250k
  - Sau đó bill `05SGA02` bị hủy → expense refund `amount=-250000`
- **WHEN** admin xem báo cáo doanh thu ngày 01/07 chi nhánh SG
- **THEN**:
  - Thu: 250,000
  - Chi: 0
  - Hoàn cước: 250,000
  - Net: 0

#### Scenario: Ngày có 2 bill paid, 1 bị hủy

- **GIVEN** ngày 01/07, SG:
  - Bill `05SGA02` paid 250k (giao thành công, không hủy)
  - Bill `05SGA03` paid 300k (bị hủy → refund -300k)
  - 1 chi phí thường 50k (đổ xăng)
- **THEN**:
  - Thu: 550,000
  - Chi: 50,000
  - Hoàn cước: 300,000
  - Net: 200,000
