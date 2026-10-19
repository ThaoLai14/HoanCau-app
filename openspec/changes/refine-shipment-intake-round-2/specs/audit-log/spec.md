# Delta: audit-log (refine-shipment-intake-round-2)

> Round 2 chuyển mọi mutation bill sang RPC atomic (bill + audit_log 1 transaction), thêm `bill_draft_cancel` vào action enum.
>
> Áp dụng sau khi `add-audit-log` archive.

## MODIFIED Requirements

### Requirement: Sự kiện được log (action enum kín — bổ sung `bill_draft_cancel`)

`audit_log.action` SHALL chỉ nhận 1 trong các giá trị sau (CHECK constraint):

| `action`                | Trigger                                                              |
|-------------------------|----------------------------------------------------------------------|
| `bill_create`           | Tạo bill mới (`pending`, sinh `bill_code`)                           |
| `bill_draft_create`     | Tạo draft (`bill_code=NULL`, `delivery_status='draft'`)              |
| `bill_draft_update`     | Sửa draft (`delivery_status='draft'`, chưa convert)                  |
| `bill_update`           | Sửa bill pending (không đổi status)                                  |
| `bill_convert_from_draft` | Convert draft → pending (sinh `bill_code`, đổi `delivery_status`)  |
| `bill_cancel`           | Hủy bill pending (soft-cancel: `delivery_status='cancelled'`)        |
| `bill_draft_cancel`     | **[MỚI]** Hủy draft (soft-delete: `is_delete=true`)                  |
| `bill_delivered`        | Đánh dấu giao xong (`delivery_status='delivered'`)                   |
| `bill_payment_received` | Thu cước cho đơn `unpaid` → `paid`                                   |
| `client_create`         | Tạo khách mới (qua intake hoặc tab QLKH)                             |
| `client_update`         | Sửa khách qua tab QLKH                                               |
| `client_delete`         | Soft-delete khách                                                    |
| `client_blacklist`      | Đánh blacklist hoặc bỏ blacklist                                     |
| `expense_create`        | Thêm chi phí phát sinh                                               |
| `expense_update`        | Admin sửa chi phí                                                    |
| `expense_delete`        | Admin soft-delete chi phí                                            |
| `refund_created`        | Auto-INSERT expense hoàn tiền khi cancel bill paid                   |
| `session_departure`     | Xuất bến (rollover `business_date` trên `branch_sessions`)           |

**Thay đổi so với add-audit-log**:
- Tách `bill_cancel` (dùng cho draft DELETE + pending soft-cancel) thành 2 action riêng:
  - `bill_cancel` — chỉ cho pending soft-cancel.
  - `bill_draft_cancel` — cho draft soft-delete (round 2 đổi draft từ DELETE cứng sang soft-delete).
- Thêm `bill_draft_create`, `bill_draft_update`, `bill_convert_from_draft` để phân biệt rõ 3 flow write của draft.

Migration: `ALTER TABLE audit_log DROP CONSTRAINT audit_log_action_check`, add lại với enum mới.

#### Scenario: Hủy pending → `bill_cancel`

- **WHEN** admin hủy bill `05SGA02` pending
- **THEN** insert audit_log `action='bill_cancel'`, `diff.reason='<lý do>'`

#### Scenario: Hủy draft → `bill_draft_cancel`

- **WHEN** member hủy 1 draft
- **THEN** insert audit_log `action='bill_draft_cancel'`, `diff.reason='<lý do>'`, `entity_id=<draft_id>`, `entity_label='Nháp'`

#### Scenario: Tạo draft → `bill_draft_create`

- **WHEN** user Lưu nháp
- **THEN** insert audit_log `action='bill_draft_create'`, `entity_label='Nháp'`

#### Scenario: Convert draft → pending → `bill_convert_from_draft`

- **WHEN** user mở draft cũ + bấm Lưu đơn → convert thành pending
- **THEN** insert audit_log `action='bill_convert_from_draft'`, `entity_label=<bill_code mới>`, `diff` bao gồm các field đã đổi (nếu có) + `bill_code` (từ NULL → mới)

## ADDED Requirements

### Requirement: Mọi mutation bill phải qua RPC atomic

Mọi write path lên `bills` (INSERT, UPDATE, soft-delete) MUST được wrap chung với INSERT `audit_log` (và optionally INSERT `bill_payment_details` / `expenses`) trong 1 transaction Postgres qua Supabase RPC function. Client code KHÔNG được gọi trực tiếp `supabase.from('bills').insert/update/delete` cho write path.

Nếu bất kỳ bước nào trong function raise exception → toàn bộ transaction rollback. Client nhận PostgREST error → hiển toast lỗi + form giữ nguyên state để retry.

**Read path** (SELECT) vẫn được phép gọi trực tiếp `supabase.from('bills').select(...)`.

**Rationale**: nếu không atomic, trường hợp INSERT bill OK nhưng INSERT audit_log fail (network drop, RLS reject, JSONB invalid, DB timeout) → audit gap không phát hiện được. Compliance-critical cho nghiệp vụ chành xe.

Function signatures (chi tiết implementation trong migration SQL):

```
create_bill_with_audit(
  bill_data JSONB,        -- toàn bộ payload bills (kể cả snapshot columns)
  audit_data JSONB        -- { actor_user_id, actor_username, actor_role,
                          --   actor_branch_id, diff, note }
) RETURNS UUID            -- bill_id vừa tạo

update_bill_with_audit(
  target_bill_id UUID,
  bill_data JSONB,        -- payload update (chỉ field đã đổi)
  audit_data JSONB        -- audit_data.diff = { field: [old, new] }
) RETURNS VOID

cancel_bill_with_audit(
  target_bill_id UUID,
  cancel_reason TEXT,
  audit_data JSONB
) RETURNS VOID            -- nội bộ tự check payment_status='paid'
                          --   → INSERT expenses refund + audit action='refund_created'
                          -- UPDATE delivery_status='cancelled'
                          -- INSERT audit_log action='bill_cancel'

soft_delete_draft_with_audit(
  target_bill_id UUID,
  cancel_reason TEXT,
  audit_data JSONB
) RETURNS VOID            -- UPDATE bills.is_delete=true
                          -- INSERT audit_log action='bill_draft_cancel'
```

RPC functions SHALL enforce role gate (xem delta `shipment-intake`):
- `update_bill_with_audit` reject nếu:
  - `actor_role='boss'`, HOẶC
  - `bills.branch_id != actor_branch_id`, HOẶC
  - `bills.payment_status='paid'`.
- `cancel_bill_with_audit` reject nếu:
  - `actor_role='boss'`, HOẶC
  - `bills.branch_id != actor_branch_id`.
- `soft_delete_draft_with_audit` reject nếu:
  - `actor_role='boss'`, HOẶC
  - `bills.branch_id != actor_branch_id`, HOẶC
  - `bills.delivery_status != 'draft'`.

#### Scenario: Create bill — atomic thành công

- **GIVEN** user Lưu đơn với đầy đủ field hợp lệ
- **WHEN** client gọi `supabase.rpc('create_bill_with_audit', { bill_data: ..., audit_data: ... })`
- **THEN** function INSERT `bills` + INSERT `audit_log` + (nếu paid) INSERT `bill_payment_details` trong 1 transaction
- **AND** trả về `bill_id` UUID mới
- **AND** client hiển toast thành công + nút "Xem bill in"

#### Scenario: Create bill — audit_log INSERT fail → rollback

- **GIVEN** user Lưu đơn
- **WHEN** RPC chạy: INSERT bills OK, INSERT audit_log fail (VD JSONB `diff` malform)
- **THEN** toàn bộ transaction rollback — bill KHÔNG được lưu
- **AND** client nhận PostgREST error → toast "Lỗi tạo đơn: <chi tiết>" + form giữ nguyên state

#### Scenario: Cancel paid — atomic 3 bước

- **GIVEN** bill `05SGA02` paid 250k
- **WHEN** admin bấm Hủy + nhập lý do → client gọi `cancel_bill_with_audit(...)`
- **THEN** function chạy trong 1 transaction:
  1. UPDATE `bills.delivery_status='cancelled'`
  2. INSERT `expenses(amount=-250000, source_bill=<bill_id>, ...)`
  3. INSERT `audit_log(action='bill_cancel', diff.reason='<lý do>')`
  4. INSERT `audit_log(action='refund_created', entity_type='expense', entity_id=<expense_id>)`
- **AND** nếu bất kỳ bước nào fail → rollback tất cả (bill vẫn pending, không có expense refund, không có audit)

#### Scenario: RPC reject cross-branch

- **GIVEN** admin login SG cố gọi `update_bill_with_audit` cho bill của GL
- **THEN** function raise exception "Cross-branch mutation not allowed"
- **AND** client nhận error, không mutation thành công

#### Scenario: RPC reject boss

- **GIVEN** boss cố gọi `cancel_bill_with_audit`
- **THEN** function raise exception "Boss cannot mutate bills"
- **AND** client nhận error

#### Scenario: RPC reject sửa bill paid

- **GIVEN** admin cố gọi `update_bill_with_audit` cho bill có `payment_status='paid'`
- **THEN** function raise exception "Cannot update paid bill — cancel first"
- **AND** client nhận error

#### Scenario: Read path vẫn dùng direct table access

- **WHEN** UI list bills, list nháp, bill detail, revenue report
- **THEN** vẫn dùng `supabase.from('bills').select(...)` trực tiếp (không cần RPC cho SELECT)

### Requirement: Lý do hủy đơn ghi vào `audit_log.diff.reason`

Khi hủy draft hoặc pending, lý do hủy (user nhập trong modal Hủy) SHALL được lưu vào `audit_log.diff` (JSONB) dưới key `reason`. KHÔNG lưu vào cột riêng của `bills`, KHÔNG prepend vào `bills.order_note`.

Format `audit_log.diff`:
- Hủy pending: `{ "reason": "<lý do user nhập>", "delivery_status": ["pending", "cancelled"] }`.
- Hủy draft: `{ "reason": "<lý do user nhập>", "is_delete": [false, true] }`.
- Hủy paid có refund: audit row `bill_cancel` với `{ "reason": "...", "delivery_status": [...] }` +
  audit row `refund_created` riêng với `{ "amount": -250000, "source_bill": "<bill_id>" }`.

Section "Lịch sử đơn" trong UI bill detail SHALL render lý do hủy với label "Lý do hủy" (tiếng Việt, từ `auditLabels.js`).

**Rationale**: `bills.order_note` giới hạn 200 ký tự cho ghi chú giao hàng — không thể prepend thêm lý do hủy. Audit_log là source of truth cho lịch sử thay đổi → lý do hủy vào `diff.reason` là consistent với `bill_update` cũng ghi diff các field trong `diff.<field>`.

#### Scenario: Modal Hủy — required lý do

- **GIVEN** user bấm nút Hủy trên bill
- **THEN** modal mở với 1 text input "Lý do hủy" (required, maxLength=200)
- **AND** nút OK disabled cho đến khi user nhập text

#### Scenario: Hủy pending — audit ghi reason

- **WHEN** admin hủy bill `05SGA02` với lý do "Hàng hỏng"
- **THEN** audit_log có row:
  ```json
  {
    "action": "bill_cancel",
    "entity_type": "bill",
    "entity_id": "<bill_uuid>",
    "entity_label": "05SGA02",
    "diff": {
      "reason": "Hàng hỏng",
      "delivery_status": ["pending", "cancelled"]
    }
  }
  ```
- **AND** `bills.order_note` KHÔNG bị prepend gì

#### Scenario: Render lịch sử — hiển "Lý do hủy"

- **GIVEN** bill có audit row `bill_cancel` với `diff.reason='Hàng hỏng'`
- **WHEN** admin mở section "📜 Lịch sử đơn"
- **THEN** hiển 1 entry: "🔴 admin Lan hủy đơn — Lý do hủy: Hàng hỏng"
