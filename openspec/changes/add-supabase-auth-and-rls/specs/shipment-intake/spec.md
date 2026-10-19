# Delta: shipment-intake (add-supabase-auth-and-rls)

> Modifies capability `shipment-intake`. Đổi hành vi hủy đơn nháp: từ hard-delete sang soft-cancel, đồng nhất với hủy đơn pending. Lý do: giữ audit trail đầy đủ cho production data thật (không cho phép mất dấu vết ai hủy draft và lý do gì).

## MODIFIED Requirements

### Requirement: Hủy đơn theo trạng thái

Hủy đơn SHALL bắt buộc nhập lý do. Cả draft lẫn pending khi hủy SHALL cùng dùng UPDATE `delivery_status = "cancelled"` và prepend lý do hủy vào `order_note`. Hệ thống SHALL KHÔNG hard-delete row `bills` trong bất kỳ trường hợp nào (RLS DELETE bills = deny cho mọi role).

Sau khi hủy, hệ thống SHALL ghi 1 row `audit_log` với `action = 'bill_cancel'`, `user_id = auth.uid()`, `changes = { delivery_status: [<old_status>, 'cancelled'] }`, `note = <lý do hủy đã trim>`.

#### Scenario: Hủy đơn nháp

- **GIVEN** user mở 1 draft (`delivery_status = 'draft'`, chưa có `bill_code`)
- **WHEN** user bấm Hủy, nhập lý do "khách đổi ý"
- **THEN** `bills.delivery_status = 'cancelled'`
- **AND** `bills.order_note = '[LÝ DO HỦY]: khách đổi ý'` (nếu note gốc rỗng) hoặc prepend nếu note gốc có sẵn
- **AND** row KHÔNG bị xóa khỏi `bills`
- **AND** `audit_log` có row mới `{ action: 'bill_cancel', entity_type: 'bill', entity_id: <bill_id>, entity_label: 'Nháp', changes: { delivery_status: ['draft', 'cancelled'] }, note: 'khách đổi ý' }`

#### Scenario: Hủy đơn pending

- **GIVEN** đơn pending có `order_note = "Khách yêu cầu giao buổi sáng"`
- **WHEN** user hủy với lý do "Hàng hỏng"
- **THEN** `delivery_status = "cancelled"`
- **AND** `order_note = "[LÝ DO HỦY]: Hàng hỏng\n\n[Ghi chú gốc]: Khách yêu cầu giao buổi sáng"`
- **AND** `bill_code` giữ nguyên
- **AND** `audit_log` có row mới với `changes = { delivery_status: ['pending', 'cancelled'] }`

#### Scenario: Hủy không nhập lý do → block

- **WHEN** user để trống ô lý do rồi bấm xác nhận hủy
- **THEN** hệ thống hiển thị toast "Vui lòng nhập lý do hủy đơn!" và KHÔNG update DB

#### Scenario: Ai cố hard-delete bill (bypass UI)

- **WHEN** bất kỳ role nào chạy `supabase.from('bills').delete().eq('id', ...)` từ DevTools
- **THEN** RLS deny (không có DELETE policy)
- **AND** dữ liệu KHÔNG bị mất