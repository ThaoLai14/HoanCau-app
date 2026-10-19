# Delta: row-level-security (add-sys-admin-role)

> Modifies existing capability `row-level-security`. Mọi policy hiện đang gate theo `admin` phải cho phép cả `sys_admin`. Thêm cột lockout cho `profiles` và policy mới cho user management.

## MODIFIED Requirements

### Requirement: RLS policies cho các bảng business

Mọi RLS policy hiện đang có clause `current_role() = 'admin'` SHALL đổi thành `current_role() IN ('sys_admin', 'admin')`.

Áp dụng cho các bảng:
- `clients`, `client_phones`
- `bills` (INSERT, UPDATE, và policy `bills_update_admin`)
- `bill_payment_details` (INSERT, UPDATE, SELECT admin branch)
- `expenses` (INSERT, UPDATE admin, DELETE)
- `branches` (UPDATE)
- `branch_sessions` (INSERT, UPDATE admin)
- `audit_log` (SELECT admin/boss/sys_admin)

Sys_admin KHÔNG bypass các check branch (VD `bpd_insert` yêu cầu `new.branch_id = current_branch_id()` cho member); sys_admin ứng xử như admin — không bị ràng buộc branch, được UPDATE mọi row.

#### Scenario: Sys_admin update bill của chi nhánh khác

- **GIVEN** sys_admin A có `profiles.branch_id = SG`
- **AND** bill Y có `branch_id = GL`
- **WHEN** A UPDATE bill Y qua Supabase JS client
- **THEN** policy `bills_update_admin` cho phép (vì `current_role() IN ('sys_admin','admin')`)
- **AND** UPDATE thành công

#### Scenario: Sys_admin thao tác nhanh trên bill nhưng chưa unlock PIN → UI block

- **GIVEN** sys_admin A đăng nhập, `sysAdminUnlocked = false`
- **WHEN** A bấm "Sửa Đơn" trên bill detail
- **THEN** UI mở modal PIN, KHÔNG gọi API update
- **AND** chỉ khi verify PIN thành công → `sysAdminUnlocked = true` (TTL 5 phút) → cho vào edit form

Note: đây là guard client-side, KHÔNG phải RLS layer. Sys_admin bypass PIN bằng cách gọi thẳng Supabase từ DevTools vẫn đi qua RLS bình thường (được phép). Đây là trade-off có ý thức — xem design.md D5.

## ADDED Requirements

### Requirement: RLS policy cho bảng `profiles` — sys_admin CRUD user

Bảng `profiles` SHALL có các policy sau:

**SELECT**:
- Sys_admin, admin, boss: xem tất cả profiles (kể cả disabled/deleted).
- Member: xem profile của chính mình.

**INSERT**: DENY cho mọi role. Chỉ trigger `handle_new_auth_user` (SECURITY DEFINER) mới INSERT được, khi có row mới trong `auth.users`.

**UPDATE**:
- Sys_admin: UPDATE mọi row, mọi cột. NHƯNG với chính mình (target_id = auth.uid()):
  - MUST KHÔNG được UPDATE `is_disabled = true`.
  - MUST KHÔNG được UPDATE `is_deleted = true`.
  - MUST KHÔNG được UPDATE `role` thành khác `'sys_admin'`.
- Admin/member/boss: chỉ UPDATE profile của mình, chỉ được sửa `full_name`. KHÔNG được sửa `role`, `branch_id`, `is_disabled`, `is_deleted`, `sys_admin_pin_hash`.

**DELETE**: DENY cho mọi role. Xóa profile qua UPDATE `is_deleted = true` từ Edge Function.

#### Scenario: Sys_admin tạo user mới

- **GIVEN** sys_admin A gọi Edge Function `admin-users` action `create`
- **WHEN** Edge Function chạy `supabase.auth.admin.createUser()` với SERVICE_ROLE_KEY
- **THEN** trigger `handle_new_auth_user` INSERT profiles với SECURITY DEFINER (bypass RLS)
- **AND** RLS `profiles_insert` không cản trở

#### Scenario: Sys_admin tự demote → deny

- **GIVEN** sys_admin A login
- **WHEN** A gửi `UPDATE profiles SET role = 'admin' WHERE id = auth.uid()`
- **THEN** RLS `profiles_update_self_role_lock` reject → 0 rows affected
- **AND** A vẫn là sys_admin

#### Scenario: Member tự sửa full_name

- **GIVEN** member B login
- **WHEN** B `UPDATE profiles SET full_name = 'New Name' WHERE id = auth.uid()`
- **THEN** RLS cho phép (chỉ `full_name`)

#### Scenario: Member sửa role của mình → deny

- **GIVEN** member B login
- **WHEN** B `UPDATE profiles SET role = 'admin' WHERE id = auth.uid()`
- **THEN** RLS reject → 0 rows

### Requirement: RLS policy cho bảng `branches` — sys_admin sửa address/hotline

Policy `branches_update` SHALL cho phép `sys_admin` UPDATE bất kỳ cột nào của `branches` (address, hotline, branch_code). Role khác chỉ SELECT.

Riêng cột `branch_code` được coi là immutable — nếu bị sửa sẽ break bill_code generation. Edge Function client validate; RLS không enforce.

#### Scenario: Sys_admin đổi hotline chi nhánh

- **GIVEN** sys_admin A mở tab Chi nhánh trong panel
- **WHEN** A sửa `hotline` của SG từ `"0111"` thành `"0999"` và bấm Lưu
- **THEN** UPDATE branches thành công
- **AND** audit log ghi `branch_updated` với diff

### Requirement: Function `current_role()` respect is_disabled + is_deleted

Function `public.current_role()` SHALL query như sau:

```sql
SELECT role FROM public.profiles 
WHERE id = auth.uid()
  AND COALESCE(is_disabled, false) = false
  AND COALESCE(is_deleted, false)  = false
```

User bị disable/delete → function trả NULL → mọi RLS policy fail.

#### Scenario: Query của user bị disable

- **GIVEN** user X `is_disabled = true`, JWT vẫn hợp lệ
- **WHEN** X gọi `select * from bills limit 1`
- **THEN** RLS `bills_select` check `current_role() IN ('admin','sys_admin','boss') OR (current_role() = 'member' AND ...)` = NULL vs any → false
- **AND** query trả `[]` (không rows) hoặc `permission denied`

### Requirement: Cột `audit_log.is_sys_admin_action`

Bảng `audit_log` SHALL có cột `is_sys_admin_action BOOLEAN DEFAULT false`. Cột này được set:
- `true` cho mọi Edge Function `admin-users` action.
- `true` cho mọi mutation từ frontend nếu `session.role = 'sys_admin'`.

CHECK constraint `audit_log.action` SHALL mở rộng cho các action mới:
`sys_admin_pin_verify_success`, `sys_admin_pin_verify_fail`, `user_created`, `user_disabled`, `user_enabled`, `user_deleted`, `user_password_reset`, `user_profile_updated`, `branch_updated`.

#### Scenario: Filter audit log theo sys_admin actions

- **GIVEN** sys_admin A tra cứu lịch sử
- **WHEN** A query `SELECT * FROM audit_log WHERE is_sys_admin_action = true ORDER BY created_at DESC LIMIT 100`
- **THEN** trả về mọi action sys_admin đã làm

### Requirement: RLS `audit_log_insert` cho phép mọi authenticated

Policy INSERT của `audit_log` MUST cho phép mọi authenticated user tự log. Cột `is_sys_admin_action` được set từ client (không trust được 100% nhưng cross-check với `user_role` cột và audit real time).

Cột `user_role` trong audit_log là snapshot lúc log, KHÔNG phải reference đến profiles hiện tại. Cho phép trace lịch sử role của user.
