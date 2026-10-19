# Delta: supabase-auth (add-supabase-auth-and-rls)

> New capability — toàn bộ là ADDED requirements. Định nghĩa chi tiết cơ chế xác thực dùng Supabase Auth, thay thế custom auth trong `LoginScreen.jsx`.

## ADDED Requirements

### Requirement: Đăng nhập bằng Supabase Auth với email nội bộ

Hệ thống SHALL dùng `supabase.auth.signInWithPassword({ email, password })` để xác thực. Email đưa vào Auth SHALL được ghép từ username theo công thức `<username>@hoancau.internal`. User chỉ nhập username thô ở UI; app tự ghép domain trước khi gọi Auth.

Password SHALL được lưu và kiểm tra bởi Supabase Auth (bcrypt trong `auth.users.encrypted_password`). App KHÔNG được đọc `auth.users` trực tiếp và KHÔNG được so sánh password ở client.

#### Scenario: Đăng nhập thành công

- **WHEN** user nhập `username = "linh"` và `password = "abc123"`
- **AND** `auth.users` có row với `email = "linh@hoancau.internal"` và password khớp
- **THEN** `supabase.auth.signInWithPassword({ email: "linh@hoancau.internal", password: "abc123" })` trả về `session` object có JWT
- **AND** app fetch profile từ `public.profiles` bằng `auth.uid()`
- **AND** chuyển sang màn hình chính, tab mặc định là **Phiếu Gửi Hàng**

#### Scenario: Username có chứa ký tự đặc biệt

- **WHEN** user nhập username có khoảng trắng đầu/cuối, hoặc chữ hoa
- **THEN** app SHALL `.trim().toLowerCase()` trước khi ghép email
- **AND** kết quả là email hợp lệ theo Auth (không có khoảng trắng, không có ký tự invalid)

#### Scenario: Sai mật khẩu

- **WHEN** `supabase.auth.signInWithPassword` trả về error `{ message: "Invalid login credentials" }`
- **THEN** LoginScreen hiển thị "Tên đăng nhập hoặc mật khẩu không đúng" (KHÔNG tiết lộ user có tồn tại hay không)
- **AND** KHÔNG chuyển màn hình

#### Scenario: Username không tồn tại

- **WHEN** không có row `auth.users` với email `<username>@hoancau.internal`
- **THEN** Auth trả về cùng error "Invalid login credentials"
- **AND** app hiển thị thông báo lỗi giống trường hợp sai password

### Requirement: Không có forgot-password / self-service reset

Hệ thống SHALL KHÔNG hiển thị link "quên mật khẩu" trên LoginScreen. Hệ thống SHALL KHÔNG cung cấp UI đổi mật khẩu cho user. Việc đặt và đổi mật khẩu SHALL do admin thực hiện qua Supabase Auth dashboard hoặc chạy SQL trực tiếp trên `auth.users`.

Setting `Enable email confirmations` trên Supabase Auth SHALL được tắt (email `<username>@hoancau.internal` không tồn tại thật, không nhận được confirm email).

#### Scenario: LoginScreen không có link forgot-password

- **WHEN** user mở LoginScreen
- **THEN** UI chỉ có 2 input (username + password) và 1 button "Đăng nhập"
- **AND** KHÔNG có link "Quên mật khẩu" / "Reset password" / "Đăng ký"

#### Scenario: Admin đổi mật khẩu cho user

- **WHEN** admin cần đổi mật khẩu cho user "linh"
- **THEN** admin vào Supabase dashboard → Authentication → Users → tìm `linh@hoancau.internal` → "Send magic link / Change password"
- **OR** admin chạy SQL: `SELECT auth.admin_update_user_by_id('<uuid>', '{"password": "new_pw"}'::jsonb)` (hoặc dùng service_role qua script Node).

### Requirement: Session state đồng bộ với Supabase Auth

App SHALL đọc session từ `supabase.auth.getSession()` khi khởi động, và subscribe `supabase.auth.onAuthStateChange` để cập nhật session khi có event `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `USER_UPDATED`.

App KHÔNG được đọc session từ `localStorage['hc_session']` hoặc bất kỳ storage tự khai nào. `localStorage['hc_session']` SHALL bị xoá trong migration nếu tồn tại (client cũ).

Sau khi có session Auth, app SHALL fetch profile từ `public.profiles WHERE id = auth.uid()` và cache trong React state với các field: `{ id, username, full_name, role, branch_id, branch_code }`. `branch_code` lấy qua join `branches`.

#### Scenario: Refresh trang giữ session

- **GIVEN** user đã đăng nhập trước đó
- **WHEN** user refresh trình duyệt
- **THEN** `supabase.auth.getSession()` trả về session đang có
- **AND** app fetch profile và show màn hình chính, KHÔNG show LoginScreen

#### Scenario: JWT expire → auto refresh

- **GIVEN** access token gần hết hạn
- **WHEN** Supabase JS client tự động gọi refresh
- **THEN** `onAuthStateChange` fire event `TOKEN_REFRESHED`
- **AND** app cập nhật session state, KHÔNG interrupt user

#### Scenario: Refresh token invalid → force logout

- **WHEN** Supabase Auth trả về event `SIGNED_OUT` do refresh token hết hạn / bị revoke
- **THEN** app clear profile state
- **AND** chuyển về LoginScreen ngay lập tức

### Requirement: Đăng xuất qua `supabase.auth.signOut()`

Khi user bấm Đăng Xuất, app SHALL gọi `supabase.auth.signOut()` để invalidate session ở tất cả tab của cùng browser. App KHÔNG được chỉ clear React state (làm vậy sẽ để lại JWT hợp lệ trong localStorage).

#### Scenario: Đăng xuất

- **WHEN** user bấm nút Đăng Xuất
- **THEN** `supabase.auth.signOut()` được gọi
- **AND** `onAuthStateChange` fire `SIGNED_OUT`
- **AND** app xoá profile state và chuyển về LoginScreen
- **AND** localStorage keys của Supabase Auth (`sb-<project>-auth-token`) bị xoá

#### Scenario: Đăng xuất từ 1 tab → tab khác cũng out

- **GIVEN** user mở 2 tab, cả 2 đang đăng nhập
- **WHEN** user bấm Đăng Xuất ở tab A
- **THEN** tab A về LoginScreen ngay
- **AND** tab B trong ~vài giây (khi Supabase client detect qua storage event) cũng chuyển về LoginScreen

### Requirement: Bảng `public.profiles` là single source of truth cho role và branch

Hệ thống SHALL có bảng `public.profiles`:

```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','member','boss')),
  branch_id UUID NOT NULL REFERENCES branches(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`profiles.id` SHALL luôn khớp 1-1 với `auth.users.id`. Không có row `profiles` nào tồn tại mà không có row tương ứng trong `auth.users`.

App SHALL đọc `role`, `branch_id`, `full_name`, `username` từ `profiles`, KHÔNG từ session state tự khai hoặc từ JWT claims trực tiếp (vì JWT claims chưa được customize).

#### Scenario: Trigger auto-create profile khi Auth user mới

- **GIVEN** admin gọi `supabase.auth.admin.createUser({ email: "linh@hoancau.internal", password: "abc", user_metadata: { username: "linh", full_name: "Nguyễn Linh", role: "member", branch_id: "<sg-uuid>" } })`
- **WHEN** row mới insert vào `auth.users`
- **THEN** trigger `after_auth_user_created` tự insert row vào `profiles` với `id = auth.users.id`, các field lấy từ `raw_user_meta_data`
- **AND** admin không cần INSERT thủ công vào `profiles`

#### Scenario: DELETE auth user → cascade delete profile

- **WHEN** admin xoá row trong `auth.users`
- **THEN** row tương ứng trong `profiles` bị xoá qua `ON DELETE CASCADE`

### Requirement: Bỏ bảng `public.users` cũ sau migration

Sau khi migrate xong, bảng `public.users` SHALL bị rename thành `public.users_legacy_backup` (giữ 1 tuần để rollback), rồi DROP.

App code SHALL KHÔNG còn tham chiếu `public.users` ở bất kỳ query nào. Mọi FK cũ trỏ `users(id)` SHALL được chuyển sang trỏ `profiles(id)`.

#### Scenario: Query cũ tới users → bị lỗi

- **WHEN** ai đó chạy `SELECT * FROM users` sau migration (bảng đã bị DROP)
- **THEN** Postgres trả về error `relation "users" does not exist`

#### Scenario: Bill audit log giữ được username sau khi profile bị xoá

- **GIVEN** audit_log có row với `user_id = <linh_uuid>`, `username = "linh"`
- **WHEN** admin xoá profile "linh" (kéo theo cascade `auth.users` bị xoá)
- **THEN** `audit_log.user_id` phải là `NULL` (FK cũ ON DELETE SET NULL vẫn giữ)
- **AND** `audit_log.username` = "linh" đọc được cho báo cáo lịch sử
