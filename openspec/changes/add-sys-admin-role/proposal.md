# Proposal: Add `sys_admin` role + Admin Panel

## Status

🟡 **DRAFT** — chờ anh review artifacts trước khi code.

## Why

Sau khi bật Supabase Auth + RLS, hệ thống có 3 role: `admin` (thực chất là "branch manager"), `member` (nhân viên), `boss` (CEO read-only). **Không role nào có quyền quản lý user + branch config**. Hiện tại muốn thêm/sửa/xóa user phải:
- Chạy `scripts/add-user.mjs` từ máy anh với SERVICE_ROLE_KEY, hoặc
- Vào Supabase Studio thao tác thủ công (kém friendly cho non-tech).

Đồng thời:
- **Config chi nhánh** (address, hotline) muốn sửa cũng phải chạy SQL.
- **Không có cơ chế khóa user tức thời** khi phát hiện account bị hack — hiện tại chỉ có thể vào Studio ban tay.
- Trong giai đoạn early production, cần 1 role cao hơn admin để **sửa data sai** (bill/expense) khi nhân viên thao tác nhầm — không muốn liên tục nhờ dev intervention.

Giải pháp: thêm role `sys_admin` + trang quản trị riêng, kèm nhiều tầng bảo mật vì `sys_admin` compromise = toàn quyền hệ thống.

## What Changes

### Auth layer

- **BREAKING**: CHECK constraint của `profiles.role` mở rộng `IN ('sys_admin', 'admin', 'member', 'boss')`.
- **BREAKING**: `audit_log.user_role` CHECK cũng mở rộng tương tự.
- Function `current_role()` **thêm điều kiện**: trả về NULL khi `profiles.is_disabled = true` hoặc `profiles.is_deleted = true`. Hiệu ứng: user bị disable/delete → toàn bộ 30+ RLS policies fail → không đọc/ghi được gì → auto logout.

### Bảng `profiles` — thêm cột

- `is_disabled BOOLEAN DEFAULT false` — tạm khóa, có thể enable lại.
- `is_deleted BOOLEAN DEFAULT false` — xóa vĩnh viễn, không enable lại được từ UI.
- `disabled_at TIMESTAMPTZ` — timestamp lúc bị disable/delete.
- `disabled_by UUID REFERENCES profiles(id)` — sys_admin nào thao tác.
- `sys_admin_pin_hash TEXT` — bcrypt PIN, chỉ set cho `role = 'sys_admin'`. Dùng cho step-up auth khi sửa business data (§PIN gate).

### RLS policies — cập nhật 30+ policies

Mọi policy hiện đang check `current_role() = 'admin'` sẽ đổi thành `current_role() IN ('sys_admin', 'admin')`. Sys_admin có quyền như admin trên tất cả bảng, cross-branch, không bị ràng buộc branch_id. Xem chi tiết trong delta `row-level-security`.

Riêng bảng `profiles`:
- INSERT/UPDATE role, branch_id, is_disabled, is_deleted, sys_admin_pin_hash → **chỉ sys_admin**.
- Sys_admin KHÔNG được UPDATE `is_disabled = true` hoặc `is_deleted = true` cho chính mình (chống lockout).

### Screen mới: Trang Quản Trị Hệ Thống

Sidebar menu item "⚙️ Quản Trị Hệ Thống" — chỉ hiện khi `role = 'sys_admin'`. Screen có 2 tabs:

**Tab 1 — Chi nhánh**:
- Table 2 rows (SG, GL). Inline edit `address` + `hotline`. Không cho add/delete branch (chỉ 2 chi nhánh cố định).

**Tab 2 — Người dùng**:
- Table list toàn bộ profiles (ẩn `is_deleted = true`).
- Filter: role, branch, trạng thái (active / disabled).
- Cột: username, full_name, role, branch, trạng thái, action.
- Actions per row: ✏️ Sửa (name/role/branch) · 🔑 Đổi mật khẩu · 🚫 Disable / ✅ Enable · 🗑️ Delete (soft, kèm confirm 2 bước).
- Button "➕ Thêm user" mở modal form.

### Screen mới: Tài khoản của tôi

Sidebar menu item "👤 Tài khoản" — mọi role. Cho user tự đổi password bản thân qua `supabase.auth.updateUser({password})`. Không cần role check DB (Supabase Auth tự chỉ cho user đổi password chính mình).

### PIN gate cho sys_admin trên business screens

Sys_admin có `role = 'sys_admin'` → RLS cho phép mọi mutation (như admin). Nhưng UI **bắt buộc nhập PIN** trước khi mở edit form / bấm confirm mutation trên business screens (bills, expenses, clients):

- Client state `sysAdminUnlocked = false` khi login.
- Sys_admin bấm "Sửa Đơn" / "Xóa" / etc → modal PIN.
- Nhập PIN → verify qua Edge Function `verify-sys-admin-pin` (server compare bcrypt) → set flag true, TTL 5 phút.
- Sau 5 phút không hoạt động → flag về false, cần nhập lại.
- Mỗi lần nhập PIN (đúng/sai) → audit log.

PIN là **UX friction** (chống bấm nhầm), KHÔNG phải security layer chính. Security thật dựa vào MFA + audit + RLS.

### Edge Function `admin-users`

Endpoint duy nhất `POST /admin-users` với action trong body:
- `create` — tạo user mới.
- `update_profile` — sửa full_name, role, branch_id.
- `reset_password` — sys_admin reset password của user khác.
- `disable` / `enable` — set `is_disabled`.
- `delete` — set `is_deleted`. Gọi `auth.admin.updateUserById({ban_duration:'permanent'})` để revoke JWT.
- `verify_pin` — cho PIN gate.

Mỗi request:
1. Verify JWT valid.
2. `current_role() = 'sys_admin'` (query profiles bằng auth.uid()).
3. (Cho delete/disable) Chống lockout: target_id ≠ caller_id.
4. Rate limit: max 30 requests/phút/user.
5. Insert audit log với `is_sys_admin_action = true`.
6. Gọi `auth.admin.*` API với SERVICE_ROLE_KEY (chỉ tồn tại trong env Edge Function).

### MFA (TOTP) cho sys_admin

Bật Supabase Auth MFA Level 2 cho tenant. Mỗi sys_admin lần đầu login → force enrollment: scan QR bằng Google Authenticator / Authy → nhập mã 6 số verify → mỗi lần login sau nhập TOTP. Role khác optional.

### Bootstrap sys_admin đầu tiên

Extend `scripts/add-user.mjs` để chấp nhận `--role sys_admin --pin <6-digit>`. Anh chạy 1 lần trên máy có SERVICE_ROLE_KEY để tạo sys_admin đầu tiên (do RLS block INSERT profiles.role='sys_admin' từ UI khi chưa có sys_admin nào).

### Audit log — mở rộng

- Thêm cột `is_sys_admin_action BOOLEAN DEFAULT false` — flag các action từ sys_admin (bao gồm mọi mutation qua PIN gate).
- Thêm action mới: `sys_admin_pin_verify_success`, `sys_admin_pin_verify_fail`, `user_created`, `user_disabled`, `user_enabled`, `user_deleted`, `user_password_reset`, `user_profile_updated`.

## Impact

- **Affected specs**: `authentication-and-roles`, `row-level-security`, `audit-log`.
- **New capability**: `sys-admin-panel`.
- **Affected code (app)**: `src/App.jsx` (menu, guard, PIN modal), new `src/SysAdminPanel.jsx`, new `src/MyAccountScreen.jsx`, `src/supabaseClient.js` (Edge Function wrapper).
- **Affected code (server)**: new `supabase/functions/admin-users/index.ts`.
- **Affected DB**: migrations `add-sys-admin-role.sql`.
- **Affected scripts**: `scripts/add-user.mjs`.

## Not in scope

- Password strength policy (Supabase Auth có default min 6 chars — dùng luôn).
- IP allowlist cho sys_admin (defer, chỉ cần khi có VPN office).
- Email/SMS notification khi có login sys_admin (defer).
- User tự đổi username hoặc full_name (chỉ đổi password — thay đổi khác đi qua sys_admin).
- Recover sys_admin nếu quên MFA (phải xử lý qua Supabase Studio, out of app scope).
- Change history cho branches config.
