# Delta: audit-log (add-sys-admin-role)

> Modifies existing capability `audit-log`. Thêm cột `is_sys_admin_action` + mở rộng CHECK constraint action.

## MODIFIED Requirements

### Requirement: `audit_log` schema và actions

Bảng `audit_log` SHALL có cột mới `is_sys_admin_action BOOLEAN DEFAULT false`. Cột này được set:
- `true` khi Edge Function `admin-users` chạy bất kỳ action.
- `true` khi frontend log audit và `session.role = 'sys_admin'` (ví dụ: bill_update từ sys_admin qua PIN gate).

CHECK constraint `audit_log.action` SHALL mở rộng chấp nhận thêm các action mới:

- `sys_admin_pin_verify_success`
- `sys_admin_pin_verify_fail`
- `sys_admin_pin_changed`
- `sys_admin_action_unauthorized_attempt`
- `user_created`
- `user_disabled`
- `user_enabled`
- `user_deleted`
- `user_disable_self_attempt`
- `user_password_reset`
- `user_profile_updated`
- `branch_updated`

`user_role` trong audit_log tiếp tục là snapshot lúc log (không phải reference profiles hiện tại).

#### Scenario: Sys_admin sửa bill → audit ghi is_sys_admin_action=true

- **GIVEN** sys_admin A đã unlock PIN, đang sửa bill Y
- **WHEN** A submit form update
- **THEN** frontend gọi Supabase UPDATE bills (RLS pass vì sys_admin)
- **AND** frontend gọi `logAudit({action: 'bill_update', changes, is_sys_admin_action: true})`
- **AND** row audit_log lưu với `is_sys_admin_action = true, user_role = 'sys_admin'`

#### Scenario: Filter audit log để review sys_admin actions

- **WHEN** sys_admin A query `SELECT * FROM audit_log WHERE is_sys_admin_action = true AND created_at > now() - interval '7 days' ORDER BY created_at DESC`
- **THEN** trả về toàn bộ hoạt động sys_admin 7 ngày qua

### Requirement: Audit log immutable

Bảng `audit_log` MUST không cho phép UPDATE hoặc DELETE từ mọi role, kể cả sys_admin. Chỉ INSERT.

`is_sys_admin_action` được set lúc INSERT, không thể sửa sau đó.

RLS policies `audit_log_update` và `audit_log_delete` SHALL luôn deny.

#### Scenario: Sys_admin cố xóa audit log → deny

- **GIVEN** sys_admin A phát hiện audit log có action sai
- **WHEN** A gửi `DELETE FROM audit_log WHERE id = X`
- **THEN** RLS reject
- **AND** 0 rows affected

Nếu cần "xóa" (VD data compliance), phải qua Supabase Studio với SERVICE_ROLE_KEY.
