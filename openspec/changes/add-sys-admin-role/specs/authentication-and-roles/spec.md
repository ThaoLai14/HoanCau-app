# Delta: authentication-and-roles (add-sys-admin-role)

> Modifies existing capability `authentication-and-roles`. Thêm role `sys_admin` vào hierarchy. Thêm cơ chế disable/delete user với hiệu ứng lockout tức thời qua `current_role()`.

## MODIFIED Requirements

### Requirement: Role hierarchy

Hệ thống SHALL định nghĩa 4 role trong `profiles.role` (CHECK constraint):

| Role | Semantic | Access |
|---|---|---|
| `sys_admin` | Quản trị hệ thống — chủ app / IT | Full: mọi bảng, user + branch mgmt |
| `admin` | Trưởng chi nhánh | Chi nhánh + cross-branch delivery/collect |
| `member` | Nhân viên chi nhánh | Chi nhánh + cross-branch delivery/collect |
| `boss` | CEO / observer | Read-only tất cả |

`sys_admin` là superset của `admin` về quyền edit business data, PHẢI qua PIN gate (§sys-admin-panel) trước khi thao tác mutation.

#### Scenario: Menu sidebar theo role

- **WHEN** user login với role `X`
- **THEN** sidebar hiện các item sau:
  - Khách Hàng: X ∈ {`sys_admin`, `admin`, `boss`}
  - Đơn Hàng: X ∈ {`sys_admin`, `admin`, `member`}
  - Danh Sách Bốc Xếp: X ∈ {`sys_admin`, `admin`, `member`}
  - Tổng Hợp Đơn Hàng: X ∈ {`sys_admin`, `admin`, `member`, `boss`}
  - Quản Lý Doanh Thu: X ∈ {`sys_admin`, `admin`, `boss`}
  - Công Nợ: X ∈ {`sys_admin`, `admin`, `boss`}
  - Tài khoản của tôi: mọi role
  - ⚙️ Quản Trị Hệ Thống: X = `sys_admin` ONLY

## ADDED Requirements

### Requirement: Cơ chế disable/delete user với lockout tức thời

Bảng `profiles` SHALL có 2 flag boolean:
- `is_disabled` — tạm khóa, có thể enable lại.
- `is_deleted` — xóa vĩnh viễn, không enable lại được từ UI (phải qua SQL).

Function `current_role()` SHALL trả về NULL khi:
- `auth.uid()` không tồn tại trong `profiles`, HOẶC
- `profiles.is_disabled = true`, HOẶC
- `profiles.is_deleted = true`.

Vì mọi RLS policy check `current_role() IN (...)`, NULL sẽ fail check → user bị block khỏi mọi bảng.

Ngoài ra, khi disable/delete, Edge Function SHALL gọi `auth.admin.updateUserById({ban_duration:'876000h'})` để revoke JWT refresh (defense-in-depth).

Client-side interceptor SHALL detect lỗi RLS-style hoặc profile-not-found và force `signOut()`.

#### Scenario: User đang online bị disable → auto logout

- **GIVEN** user X đang login, đang xem tab Đơn Hàng
- **WHEN** sys_admin disable user X qua Edge Function
- **THEN** `profiles.is_disabled = true` cho X
- **AND** `auth.users.banned_until` cho X = future (via ban_duration)
- **AND** next query của X (VD refetch bills mỗi khi filter đổi) trả `permission denied`
- **AND** client interceptor gọi `supabase.auth.signOut()`
- **AND** X thấy toast "Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên."
- **AND** X bị redirect về LoginScreen
- **AND** thời gian từ lúc disable đến lúc X thấy logout: < 60 giây

#### Scenario: User bị delete không hiện trong list quản lý

- **GIVEN** user X `is_deleted = true`
- **WHEN** sys_admin mở tab Người dùng trong Quản Trị Hệ Thống
- **THEN** X KHÔNG xuất hiện trong list default
- **AND** filter "Trạng thái = Đã xóa" hiển thị X (để reference)

#### Scenario: User bị disabled hiện trong list với badge

- **GIVEN** user X `is_disabled = true`
- **WHEN** sys_admin mở tab Người dùng
- **THEN** X xuất hiện trong list với badge màu đỏ "🚫 Đã khóa"
- **AND** row action button "Enable" thay cho "Disable"

### Requirement: Anti-lockout cho sys_admin

Hệ thống MUST ngăn sys_admin tự khóa mình ra khỏi hệ thống:

- **R1**: Edge Function `admin-users` action `disable`, `delete`, `update_profile` (khi role thay đổi) MUST reject nếu `target_id = caller_id`.
- **R2**: Edge Function action `disable`, `delete`, hoặc `update_profile` (demote khỏi sys_admin) MUST reject nếu target là sys_admin duy nhất còn active (`COUNT WHERE role='sys_admin' AND is_disabled=false AND is_deleted=false = 1`).
- **R3**: RLS policy `profiles_update` MUST block `UPDATE is_disabled=true / is_deleted=true / role != 'sys_admin' WHERE id = auth.uid()` (defense-in-depth nếu Edge Function bị bypass).

Bootstrap fallback: nếu race condition hoặc bug làm sys_admin last bị lockout, phải resort về `scripts/add-user.mjs --role sys_admin` để tạo mới.

#### Scenario: Sys_admin tự disable → deny

- **GIVEN** sys_admin A đang login
- **WHEN** A gửi request `POST /admin-users {action:'disable', target_id:A.id}`
- **THEN** Edge Function reject với 403 "Không thể tự disable chính mình"
- **AND** audit log ghi `user_disable_self_attempt`

#### Scenario: Disable sys_admin last → deny

- **GIVEN** hệ thống có 2 sys_admin: A và B; A `is_disabled=false`, B `is_disabled=true`
- **AND** sys_admin C login (C là admin bình thường? no, phải là sys_admin khác — hoặc là chính A cố disable A tự mình, xem R1)
- **WHEN** yêu cầu disable A → count sys_admin active = 1 (chỉ A)
- **THEN** Edge Function reject với 403 "Không thể disable sys_admin cuối cùng còn hoạt động"

### Requirement: MFA (TOTP) bắt buộc cho sys_admin

Role `sys_admin` MUST enroll MFA TOTP factor trước khi thao tác. App SHALL check `supabase.auth.getAuthenticatorAssuranceLevel()` sau login:
- Nếu role = sys_admin và `currentLevel = aal1` + `nextLevel = aal2` (chưa verify TOTP) → block toàn bộ mutation, chỉ mở modal enroll/verify.
- Nếu role = sys_admin và không có factor nào → force enroll flow.

Role khác (admin/member/boss) MFA optional.

#### Scenario: Sys_admin login lần đầu

- **GIVEN** sys_admin A vừa được tạo qua CLI, chưa enroll MFA
- **WHEN** A login với password đúng
- **THEN** modal enroll MFA hiện ngay
- **AND** hiển thị QR code từ `supabase.auth.mfa.enroll`
- **AND** A scan bằng Google Authenticator / Authy
- **AND** A nhập mã 6 số verify
- **AND** session được nâng lên aal2
- **AND** A vào được Quản Trị Hệ Thống

#### Scenario: Sys_admin login lần thứ n

- **GIVEN** sys_admin A đã enroll TOTP
- **WHEN** A login với password đúng
- **THEN** modal nhập TOTP hiện ngay sau login
- **AND** A nhập 6 số từ authenticator
- **AND** verify OK → aal2 → full access

### Requirement: Session TTL riêng cho sys_admin

Sys_admin session SHALL tự động logout sau **15 phút không tương tác** (mousemove/keydown/click). Role khác TTL 8 giờ.

App SHALL track `lastInteraction` timestamp; interval 30s check nếu quá TTL → force `signOut()` + toast.

#### Scenario: Sys_admin AFK 15 phút

- **GIVEN** sys_admin A đang login, đang xem tab User
- **WHEN** A không tương tác chuột/bàn phím trong 15 phút
- **THEN** app tự động `signOut()`
- **AND** hiện toast "Phiên đăng nhập đã hết hạn"
- **AND** redirect LoginScreen

## MODIFIED Requirements

### Requirement: Đăng nhập bằng Supabase Auth với email nội bộ

App SHALL đăng nhập qua `supabase.auth.signInWithPassword({ email, password })` với email được ghép từ username: `<username>@hoancau.internal`.

**Bổ sung cho sys_admin**: Sau khi `signInWithPassword` success, app SHALL check role qua `select role from profiles where id = auth.uid()`. Nếu role = sys_admin:
- Check MFA factor: nếu chưa có → force enroll modal.
- Nếu có factor: check AAL level; nếu aal1 → force verify modal.
- Chỉ khi aal2 mới cho vào ứng dụng.

Role khác không bị force MFA.

Nếu profile không tồn tại HOẶC `is_disabled=true` HOẶC `is_deleted=true` → tự động `signOut()` + hiển thị lỗi generic "Tên đăng nhập hoặc mật khẩu không đúng" (không tiết lộ user status).
