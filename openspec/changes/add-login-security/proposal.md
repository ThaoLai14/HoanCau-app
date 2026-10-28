# Proposal: Login security (lịch sử đăng nhập + timeout 2h + khóa 3 lần)

## Status

🟢 **GIAI ĐOẠN 1 ĐÃ IMPLEMENT** (2026-10-28). Giai đoạn 2 (bắt buộc 2FA) để sau khi user yêu cầu.

## Why

Trang Quản Trị cần thêm 3 lớp bảo mật theo yêu cầu chủ hệ thống:
1. **Lịch sử đăng nhập** mỗi user mỗi ngày — login/logout lúc nào (ngày giờ cụ thể), mấy lần.
2. **Tự đăng xuất sau 2h không hoạt động**.
3. **Khóa tài khoản sau 3 lần đăng nhập sai**, phải nhờ sys_admin mở lại.

## Decisions

| # | Quyết định |
|---|---|
| D1 | Khóa 3 lần đếm **ở server** (edge function `auth-login`) để client không lách được. Đổi luồng đăng nhập: client gọi `auth-login` thay vì gọi thẳng `signInWithPassword`. |
| D2 | Lockout tách khỏi `is_disabled` (admin chủ động) — thêm cột riêng `failed_login_count`, `is_locked`, `locked_at`. Đúng mật khẩu khi đang khóa vẫn bị chặn tới khi sys_admin mở. |
| D3 | **KHÔNG tiết lộ số lần còn lại** khi sai (tránh hacker đoán ngưỡng khóa). Thông báo generic "Tên đăng nhập hoặc mật khẩu không đúng". |
| D4 | Idle timeout: staff **2h**, sys_admin giữ **15 phút** (chặt hơn). |
| D5 | Lịch sử: bảng mới `login_events`. Login ghi ở server (chính xác). Logout ghi ở client khi: bấm Đăng xuất / hết phiên 2h / bị buộc (disabled). **Đóng tab không ghi** (F5 cũng tính là đóng → gây nhiễu, nên bỏ để nhật ký đáng tin). |
| D6 | RLS: chỉ sys_admin đọc `login_events`; user chỉ insert logout của chính mình; login insert bằng service role (edge function). |
| D7 | Giai đoạn 2 (2FA bắt buộc) tách riêng, làm sau — vì đụng critical path và cần xử lý OTP trong edge function cho ăn khớp với D1. |

## What changes

- **DB**: `add-login-security.sql` — bảng `login_events` + RLS; profiles cột lockout; hàm `profile_id_by_email`.
- **Edge functions**: `auth-login` (mới) đăng nhập + đếm khóa + ghi login; `admin-users` thêm action `unlock`.
- **Client**: `LoginScreen` gọi `auth-login`; `SessionMonitor` idle 2h; `App.jsx` ghi logout; `SysAdminPanel` tab "Nhật ký đăng nhập" + nút Mở khóa.

## Deploy (user tự làm)

1. Chạy `add-login-security.sql` trên Supabase SQL Editor.
2. `npx supabase functions deploy auth-login --no-verify-jwt`
3. `npx supabase functions deploy admin-users` (redeploy — có action unlock mới)
4. (Khuyến nghị, Dashboard) bật **Leaked password protection** + siết **Rate limit** đăng nhập.
