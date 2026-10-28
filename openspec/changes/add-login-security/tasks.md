# Tasks: Login security — Giai đoạn 1

## 1. Database

- [x] 1.1 [add-login-security.sql](../../../add-login-security.sql) — bảng `login_events` (user, event_type login/logout, reason, created_at, user_agent) + 2 index.
- [x] 1.2 profiles thêm cột `failed_login_count INT`, `is_locked BOOLEAN`, `locked_at TIMESTAMPTZ`.
- [x] 1.3 RLS `login_events`: insert own (logout), select sys_admin (`public.current_role()='sys_admin'`).
- [x] 1.4 Hàm `profile_id_by_email(text)` SECURITY DEFINER (edge function tra uid từ email), REVOKE khỏi anon/authenticated.
- [ ] 1.5 **(User chạy)** Chạy file SQL trên Supabase SQL Editor.

## 2. Edge function auth-login (khóa 3 lần, đếm server-side)

- [x] 2.1 [supabase/functions/auth-login/index.ts](../../../supabase/functions/auth-login/index.ts) — action `login`: resolve email → tra uid → check disabled/locked → `signInWithPassword` (anon) → sai thì tăng `failed_login_count`, đủ 3 → `is_locked=true` + audit `login_failed`/`login_locked` → đúng thì reset + ghi `login_events` + trả `{access_token, refresh_token, profile}`.
- [x] 2.2 KHÔNG tiết lộ số lần còn lại; thông báo generic.
- [x] 2.3 Rate limit mềm theo email + IP (bổ sung rate-limit sẵn có của Supabase).
- [ ] 2.4 **(User deploy)** `npx supabase functions deploy auth-login --no-verify-jwt`.

## 3. admin-users: action unlock

- [x] 3.1 [supabase/functions/admin-users/index.ts](../../../supabase/functions/admin-users/index.ts) — `actionUnlock` reset `is_locked/failed_login_count/locked_at` + audit `user_unlocked`; case `unlock` trong dispatcher.
- [ ] 3.2 **(User deploy)** redeploy `admin-users`.

## 4. Client — đăng nhập qua auth-login

- [x] 4.1 [src/supabaseClient.js](../../../src/supabaseClient.js) — `callAuthLogin(username, password)` (anon key, apikey header).
- [x] 4.2 [src/LoginScreen.jsx](../../../src/LoginScreen.jsx) — gọi `callAuthLogin` → `supabase.auth.setSession(tokens)` → `onLogin(profile)`. Bỏ `signInWithPassword` trực tiếp. Giữ thông báo lỗi từ server (khóa/disabled/sai).

## 5. Timeout 2h + ghi logout

- [x] 5.1 [src/SessionMonitor.jsx](../../../src/SessionMonitor.jsx) — idle staff 8h → **2h** (sys_admin giữ 15 phút).
- [x] 5.2 [src/App.jsx](../../../src/App.jsx) — `recordLogout(reasonCode)` insert `login_events` trước `signOut`; `handleLogout(reasonCode)` (nút = `logout_button`); `handleForceLogout` map idle→`idle_timeout`, disabled→`forced`. Sửa `onClick={() => handleLogout()}`.
- [x] 5.3 [src/SessionMonitor.jsx](../../../src/SessionMonitor.jsx) + [src/App.jsx](../../../src/App.jsx) — idle 2h áp cả khi ĐÓNG BROWSER rồi mở lại: lưu `hc_last_activity` (localStorage, ghi mỗi ~20s); mount SessionMonitor nếu `now - last > IDLE_MS` → force logout ngay. Set mốc khi login, xóa khi logout. (Đóng browser không phải logout — session vẫn ở localStorage; đây là cách enforce "2h không hoạt động" xuyên suốt.)
- [x] 5.4 **Đóng trình duyệt = đăng xuất** (user yêu cầu): [src/supabaseClient.js](../../../src/supabaseClient.js) cấu hình `auth.storage = sessionStorage` → phiên Supabase tự mất khi đóng tab/trình duyệt. Chuyển `hc_session` + `hc_last_activity` từ localStorage → **sessionStorage** ở App.jsx, auditLog.js, SessionMonitor.jsx. F5/reload cùng tab vẫn giữ; đóng tab → mở lại = phải đăng nhập lại. Lưu ý: mỗi tab là 1 phiên riêng (mở tab mới phải đăng nhập lại); sau khi deploy mọi user đang login sẽ bị out 1 lần.

## 6. Nhật ký đăng nhập + mở khóa (SysAdminPanel)

- [x] 6.1 [src/SysAdminPanel.jsx](../../../src/SysAdminPanel.jsx) — tab mới "🔒 Nhật ký đăng nhập" (`LoginLogTab`): lọc theo ngày (VN) + tìm nhân viên, gom theo user, đếm số lần đăng nhập/ngày, timeline giờ + lý do.
- [x] 6.2 UsersTab — select thêm cột lockout; badge "🔒 Khóa (sai MK)"; nút "🔓 Mở khóa" gọi action `unlock`.

## 7. Verify

- [x] 7.1 `npm run build` pass (client).
- [ ] 7.2 **(Sau khi user chạy SQL + deploy)** test: đăng nhập đúng/sai, khóa sau 3 lần, mở khóa, nhật ký hiển thị, idle 2h.

## 8. Fix phát sinh khi test recovery (tài khoản có 2FA)

- [x] 8.1 [src/ResetPasswordScreen.jsx](../../../src/ResetPasswordScreen.jsx) — tài khoản bật 2FA: đổi mật khẩu đòi phiên AAL2 ("AAL2 session is required... when MFA is enabled"). Thêm ô nhập mã TOTP → `mfa.challenge` + `mfa.verify` nâng AAL2 trước khi `updateUser({password})`. Chỉ hiện ô khi `getAuthenticatorAssuranceLevel().nextLevel==='aal2'`.
- [x] 8.2 **(User đã làm)** Supabase URL Configuration (Site URL + Redirect URLs = https://hoan-cau-app.vercel.app) → link recovery đã vào đúng màn đặt lại MK.
- [ ] 8.3 **(User deploy)** Push lên Vercel để site production có ô nhập 2FA ở màn đặt lại mật khẩu.

## Giai đoạn 2 (chưa làm — chờ user)

- [ ] G2 Bắt buộc 2FA (TOTP) cho sys_admin/admin — xử lý OTP trong edge function auth-login cho ăn khớp với luồng đăng nhập server-side.
