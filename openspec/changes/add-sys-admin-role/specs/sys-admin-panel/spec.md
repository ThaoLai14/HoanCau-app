# Delta: sys-admin-panel (add-sys-admin-role) — NEW capability

> New capability `sys-admin-panel`. Trang quản trị hệ thống + PIN gate + Edge Function `admin-users` cho sys_admin quản lý user và branch config trong app.

## ADDED Requirements

### Requirement: Screen "Quản Trị Hệ Thống" — sys_admin only

App SHALL có menu item "⚙️ Quản Trị Hệ Thống" trong sidebar, chỉ hiện khi `session.role = 'sys_admin'`. Screen có 2 sub-tabs:

- **🏢 Chi nhánh**: quản lý config chi nhánh (address, hotline).
- **👥 Người dùng**: quản lý profiles (CRUD, đổi password, disable/enable).

Guard: nếu user với role ≠ sys_admin cố access URL / state của screen này → redirect về Đơn Hàng + toast "Bạn không có quyền truy cập".

#### Scenario: Sys_admin thấy menu

- **GIVEN** user login với role = sys_admin
- **THEN** sidebar hiện item "⚙️ Quản Trị Hệ Thống" ở cuối menu

#### Scenario: Admin thấy KHÔNG có menu

- **GIVEN** user login với role = admin
- **THEN** sidebar KHÔNG hiện item "⚙️ Quản Trị Hệ Thống"

### Requirement: Tab "Chi nhánh" — inline edit address + hotline

Tab SHALL render 2 rows (SG, GL) từ bảng `branches`. Mỗi row có input inline cho `address` và `hotline`. Button "💾 Lưu" per row → UPDATE branches.

`branch_code` là readonly.

Sau UPDATE thành công → log audit `branch_updated` với diff.

#### Scenario: Sys_admin đổi address chi nhánh SG

- **GIVEN** sys_admin A mở tab Chi nhánh
- **WHEN** A sửa address SG từ `"Số 1 Nguyễn Trãi"` thành `"Số 2 Nguyễn Trãi"` và bấm Lưu
- **THEN** UPDATE branches thành công
- **AND** toast "Đã cập nhật thông tin chi nhánh SG"
- **AND** audit_log ghi `branch_updated` với changes `{address: ["Số 1...", "Số 2..."]}`

### Requirement: Tab "Người dùng" — list + CRUD user

Tab SHALL render table profiles (loại trừ `is_deleted=true` mặc định). Filter bar:
- Role: dropdown (all, sys_admin, admin, member, boss).
- Branch: dropdown (all, SG, GL).
- Trạng thái: dropdown (all, active, disabled, deleted).
- Search: input search theo `username` hoặc `full_name`.

Table columns: STT, username, full_name, role (badge màu), branch, trạng thái (badge), created_at, actions.

Actions per row:
- ✏️ Sửa (full_name, role, branch_id) — modal form → Edge `update_profile`.
- 🔑 Đổi mật khẩu — modal 2 field new + confirm → Edge `reset_password`.
- 🚫 Disable / ✅ Enable — confirm dialog → Edge `disable`/`enable`.
- 🗑️ Delete — 2-step confirm (nhập chính xác username để xác nhận) → Edge `delete`.

Nếu row là chính sys_admin đang login → disable actions Disable/Delete + hiển thị tooltip "Không thể thao tác trên chính mình".

Button "➕ Thêm user" ở đầu tab → modal form: username, full_name, role dropdown, branch dropdown, password + confirm → Edge `create`.

#### Scenario: Sys_admin tạo member mới

- **GIVEN** sys_admin A mở tab Người dùng
- **WHEN** A bấm "➕ Thêm user"
- **AND** nhập username=`hoa`, full_name=`Nguyễn Thị Hoa`, role=`member`, branch=`GL`, password=`Abc12345`
- **THEN** Edge `create` được gọi
- **AND** `auth.users` insert row mới với email `hoa@hoancau.internal`
- **AND** trigger `handle_new_auth_user` insert profiles
- **AND** modal đóng + toast "Đã tạo user hoa"
- **AND** table refetch, row mới xuất hiện

#### Scenario: Sys_admin disable user bị hack

- **GIVEN** sys_admin A phát hiện user `linh` bị hack
- **WHEN** A bấm 🚫 Disable trên row của linh
- **AND** confirm dialog "Bạn có chắc muốn khóa user linh?"
- **THEN** Edge `disable` được gọi
- **AND** `profiles.is_disabled = true` cho linh
- **AND** `auth.users.banned_until` cho linh = 100 năm sau
- **AND** table refresh, row của linh hiện badge "🚫 Đã khóa"
- **AND** button đổi thành "✅ Enable"

#### Scenario: 2-step confirm cho Delete

- **GIVEN** sys_admin A bấm 🗑️ Delete cho user `linh`
- **WHEN** modal hiện: "Nhập chính xác `linh` để xác nhận xóa vĩnh viễn"
- **AND** A nhập `linh` và bấm "Xóa vĩnh viễn"
- **THEN** Edge `delete` được gọi
- **AND** `profiles.is_deleted = true, disabled_at = now(), disabled_by = A.id`
- **AND** user `linh` bị ban permanent trong auth.users
- **AND** row biến mất khỏi list

### Requirement: PIN gate cho sys_admin trên business screens

Khi `session.role = 'sys_admin'`, mọi mutation trên business screens (tạo/sửa/xóa bill, expense, client, xác nhận giao/thanh toán) MUST wrap qua helper `requireSysAdminUnlock()`:

1. Nếu `sysAdminUnlocked = true` và `now() - sysAdminUnlockedAt < 5 phút` → proceed ngay.
2. Nếu chưa unlock hoặc đã expire → mở modal PIN.
3. User nhập PIN 6 số → gọi Edge `verify_pin`.
4. PIN đúng → `sysAdminUnlocked = true`, `sysAdminUnlockedAt = now()`, proceed action.
5. PIN sai → toast lỗi, tăng counter. Sau 3 lần sai liên tiếp → lock modal 5 phút.
6. Sau 5 phút không có mutation → `sysAdminUnlocked = false`.

Handler nào cần wrap (không đầy đủ, cần grep khi implement):
- `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`
- `handleConfirmDelivery`, `handleConfirmPayment`
- `handleConfirmCancelBill`, `handleAddExpense`, `handleUpdateExpense`, `handleDeleteExpense`
- `handleAddClient`, `handleBlacklist`, `handleUpdateLocationCounts`

Role ≠ sys_admin: KHÔNG bị PIN gate, chạy như hiện tại.

#### Scenario: Sys_admin sửa bill lần đầu trong session

- **GIVEN** sys_admin A vừa login, `sysAdminUnlocked = false`
- **WHEN** A bấm "Sửa Đơn" trên bill detail
- **THEN** modal PIN hiện
- **AND** A nhập 6 số PIN
- **AND** Edge `verify_pin` trả success
- **AND** `sysAdminUnlocked = true, sysAdminUnlockedAt = now()`
- **AND** form Sửa Đơn mở
- **AND** audit_log ghi `sys_admin_pin_verify_success`

#### Scenario: Sys_admin thao tác nhiều lần trong 5 phút

- **GIVEN** sys_admin A vừa unlock lúc 10:00
- **WHEN** A sửa bill khác lúc 10:03
- **THEN** KHÔNG hỏi PIN nữa (còn trong TTL)
- **AND** form mở ngay

#### Scenario: PIN sai 3 lần → lock

- **GIVEN** sys_admin A bấm sửa bill
- **WHEN** A nhập PIN sai 3 lần liên tiếp
- **THEN** modal lock 5 phút
- **AND** hiển thị countdown "Còn 4:59"
- **AND** audit_log ghi 3 entry `sys_admin_pin_verify_fail`
- **AND** Sau 5 phút, modal unlock, cho nhập lại

#### Scenario: TTL expire sau 5 phút không tương tác

- **GIVEN** sys_admin A unlock lúc 10:00
- **WHEN** A không mutation gì đến 10:06
- **AND** A bấm sửa expense
- **THEN** modal PIN hiện lại (TTL expired)

### Requirement: Edge Function `admin-users`

Deploy Supabase Edge Function tại `/functions/v1/admin-users` với các đặc điểm:

- POST only. Body JSON `{action: "<action>", ...args}`.
- Header `Authorization: Bearer <user_jwt>` bắt buộc.
- Middleware verify JWT + query `select role from profiles where id = <auth_uid>` → deny nếu ≠ `sys_admin`.
- Rate limit: 30 requests/phút/user (in-memory Map).
- Sau mỗi action: insert audit_log với `is_sys_admin_action = true` và `user_id = <caller_id>`.
- Response format: `{success: bool, data?: any, error?: string}`.

Actions hỗ trợ:

| action | body args | Effect |
|---|---|---|
| `create` | username, full_name, role, branch_code, password | `auth.admin.createUser` với metadata → trigger tạo profile |
| `update_profile` | target_id, full_name?, role?, branch_id? | UPDATE profiles (chỉ các field truyền) |
| `reset_password` | target_id, new_password | `auth.admin.updateUserById({password})` |
| `disable` | target_id | UPDATE profiles.is_disabled=true, disabled_at, disabled_by + ban_duration 100 năm |
| `enable` | target_id | UPDATE profiles.is_disabled=false, disabled_at=null, disabled_by=null + unban |
| `delete` | target_id | Tương tự disable + is_deleted=true |
| `verify_pin` | pin | Bcrypt compare với profiles.sys_admin_pin_hash của caller |
| `set_pin` | new_pin (+ old_pin nếu đang có PIN) | Bcrypt hash + UPDATE profiles.sys_admin_pin_hash của caller |

Anti-lockout enforce trong function:
- `disable`, `delete`, `update_profile` (thay đổi role): reject nếu `target_id = caller_id`.
- `disable`, `delete`, `update_profile` (demote khỏi sys_admin): reject nếu target là sys_admin last active.

#### Scenario: Non-sys_admin call Edge → 403

- **GIVEN** admin B call POST `/admin-users {action:'create', ...}`
- **THEN** Edge trả 403 "Chỉ sys_admin mới có quyền"
- **AND** audit_log ghi `sys_admin_action_unauthorized_attempt`

#### Scenario: Rate limit exceeded

- **GIVEN** sys_admin A gửi 31 requests trong 1 phút
- **THEN** request thứ 31 trả 429 "Rate limit exceeded"

### Requirement: Screen "Tài khoản của tôi"

App SHALL có menu item "👤 Tài khoản" trong sidebar, hiện cho mọi role. Screen có các section:

- **Thông tin**: hiển thị username, full_name, role, branch, ngày tạo (readonly).
- **Đổi mật khẩu**: nhập current password + new password + confirm → gọi `supabase.auth.updateUser({password})`.
- **Đổi PIN** (chỉ sys_admin): nhập PIN cũ (nếu có) + PIN mới + confirm → Edge `set_pin`.
- **MFA** (chỉ sys_admin): xem/quản lý TOTP factor + regenerate recovery codes. Unenroll yêu cầu re-auth password + TOTP.

Không cho phép sửa username, full_name, role, branch từ screen này (phải qua sys_admin).

#### Scenario: Sys_admin đổi PIN

- **GIVEN** sys_admin A đã có PIN
- **WHEN** A mở Tài khoản → section Đổi PIN → nhập PIN cũ đúng, PIN mới `123456`
- **THEN** Edge `set_pin` verify PIN cũ, bcrypt hash PIN mới, UPDATE profiles
- **AND** toast "Đổi PIN thành công"
- **AND** audit_log ghi `sys_admin_pin_changed`

#### Scenario: User (member) đổi password

- **GIVEN** member B login
- **WHEN** B mở Tài khoản → Đổi mật khẩu → nhập current + new + confirm
- **THEN** re-verify current password (re-sign-in tạm)
- **AND** `supabase.auth.updateUser({password})` thành công
- **AND** toast "Đã đổi mật khẩu"

### Requirement: Bootstrap sys_admin đầu tiên qua CLI

Script `scripts/add-user.mjs` SHALL support flag `--role sys_admin` kèm `--pin <6-digit>` (required cho sys_admin). Flag `--branch` optional cho sys_admin, default = `SG` nếu không truyền.

Sau khi tạo auth user + profile qua trigger:
- Bcrypt hash PIN
- UPDATE profiles.sys_admin_pin_hash = <hash>
- Print recap: username, password, PIN (an toàn offline).

Không có UI để tạo sys_admin đầu tiên (chicken-and-egg vì RLS block INSERT profiles.role='sys_admin' khi chưa có sys_admin nào).

#### Scenario: Bootstrap sys_admin đầu tiên

- **WHEN** anh chạy `node scripts/add-user.mjs --username sys --full-name "System Admin" --role sys_admin --branch SG --password Abc12345 --pin 123456`
- **THEN** script tạo auth user
- **AND** profile được tạo với role='sys_admin', branch_id=SG
- **AND** UPDATE sys_admin_pin_hash
- **AND** print recap
- **AND** anh login username=`sys`, password=`Abc12345`
- **AND** app force MFA enrollment
- **AND** app force nhập PIN khi bấm sửa business data

### Requirement: MFA recovery codes cho sys_admin

Sau khi sys_admin enroll TOTP thành công lần đầu, hệ thống MUST tự động generate 8 recovery codes và hiển thị 1 lần duy nhất trong modal. Modal có checkbox "Tôi đã lưu recovery codes ở nơi an toàn" — user phải tick trước khi đóng modal.

Recovery codes lưu bcrypt hash vào bảng mới `mfa_recovery_codes`:

```sql
CREATE TABLE mfa_recovery_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,   -- bcrypt hash
  used_at TIMESTAMPTZ,       -- NULL nếu chưa dùng
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

RLS: user chỉ SELECT được recovery codes của mình (không có INSERT/UPDATE/DELETE từ client — mọi thao tác qua Edge Function).

**Recovery flow (khi mất TOTP)**:
1. User login normal (password ok).
2. Modal MFA verify hiện.
3. Click link "Dùng recovery code thay TOTP" → input field 10 chars.
4. Edge Function `mfa-recovery` verify:
   - Bcrypt compare với tất cả `code_hash` của user WHERE `used_at IS NULL`.
   - Nếu match → UPDATE `used_at = now()` cho code đó → cấp aal2 cho session.
   - Nếu không match → 401 + audit log.
5. Sau login thành công qua recovery code, banner warning "Bạn còn N recovery codes. Cân nhắc regenerate + enroll lại TOTP" cho đến khi user regenerate.

**Regenerate flow (voluntary)**:
- Tài khoản của tôi → section MFA → "Regenerate recovery codes".
- Yêu cầu re-auth: nhập password + TOTP hiện tại.
- Edge Function xóa toàn bộ codes cũ (DELETE FROM mfa_recovery_codes WHERE user_id) → generate 8 codes mới → return + hiển thị 1 lần.

Nếu user dùng hết 8 codes + mất TOTP → sys_admin chấp nhận friction: liên hệ dev để xóa factor qua Supabase Studio (rare).

#### Scenario: Enroll TOTP → hiển thị recovery codes

- **GIVEN** sys_admin A đang trong flow enroll MFA lần đầu
- **WHEN** A verify TOTP 6 số OK → factor enrolled
- **THEN** modal recovery codes hiện với 8 codes random (VD `xk3h-9m2p-...`)
- **AND** button "Đóng" bị disable
- **AND** khi A tick checkbox "Tôi đã lưu" → button "Đóng" enable
- **AND** codes bcrypt hash lưu vào mfa_recovery_codes
- **AND** audit_log ghi `sys_admin_mfa_enrolled`

#### Scenario: Recovery code dùng thay TOTP

- **GIVEN** sys_admin A mất điện thoại, còn nhớ 1 recovery code
- **WHEN** A login password ok → modal MFA
- **AND** A click "Dùng recovery code" → nhập code
- **AND** Edge verify OK → session aal2
- **THEN** A vào được app
- **AND** banner warning hiện
- **AND** code đã dùng có `used_at != NULL`
- **AND** audit_log ghi `sys_admin_recovery_code_used`

#### Scenario: Recovery code dùng lại → deny

- **GIVEN** code X đã có `used_at != NULL`
- **WHEN** A cố login với code X
- **THEN** Edge trả 401 "Recovery code đã sử dụng hoặc không hợp lệ"
