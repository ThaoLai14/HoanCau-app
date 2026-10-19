# Sys_admin Role — Deployment & Operations Guide

Hướng dẫn triển khai + vận hành cho tính năng `sys_admin` role + Trang Quản Trị Hệ Thống.

## 📦 Tổng quan components

Change này thêm:

- **Role mới `sys_admin`** — quyền edit toàn bộ business data + quản lý user + config chi nhánh.
- **Trang Quản Trị Hệ Thống** — 2 tabs Chi nhánh (address/hotline) + Người dùng (CRUD).
- **PIN gate** — sys_admin phải nhập PIN 6 số trước khi sửa bill/expense (TTL 5 phút).
- **MFA (TOTP) bắt buộc cho sys_admin** — Google Authenticator, 8 recovery codes.
- **Auto lockout** — user bị disable/delete → auto logout trong < 60s trên mọi tab.
- **Idle session TTL** — sys_admin 15 phút, role khác 8 giờ.
- **Trang Tài khoản của tôi** — mọi role đổi password + sys_admin đổi PIN + regenerate recovery codes.

## 🚀 Deployment Order (BẮT BUỘC theo thứ tự)

### Bước 1: Deploy Edge Functions

Cần trước migration để endpoint sẵn sàng khi trang UI test.

```powershell
# Login vào Supabase CLI (mở browser)
npx supabase login

# Link project (chỉ chạy 1 lần)
npx supabase link --project-ref <YOUR_PROJECT_REF>

# Deploy 2 functions
npx supabase functions deploy admin-users --no-verify-jwt
npx supabase functions deploy mfa-recovery --no-verify-jwt
```

`YOUR_PROJECT_REF` = chuỗi 20 ký tự trên Supabase Dashboard → Project Settings → Reference ID.

`--no-verify-jwt`: tự verify trong function (cho phép response 401/403 rõ ràng thay vì generic error).

Verify deploy thành công:

```powershell
curl -X POST "https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/admin-users" `
  -H "Authorization: Bearer <invalid>" `
  -H "Content-Type: application/json" `
  -d '{"action":"create"}'
```

Kỳ vọng: `401 {"error":"Invalid JWT"}`.

### Bước 2: Chạy migration SQL

Vào Supabase Studio → SQL editor → paste toàn bộ nội dung file [add-sys-admin-role.sql](../add-sys-admin-role.sql) → Run.

Verify (chạy trong SQL editor):

```sql
-- 1. CHECK constraint có sys_admin
SELECT pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.profiles'::regclass AND contype = 'c';
-- Kỳ vọng: CHECK (role IN ('sys_admin','admin','member','boss'))

-- 2. profiles có cột mới
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='profiles'
  AND column_name IN ('is_disabled','is_deleted','sys_admin_pin_hash','disabled_at','disabled_by');
-- Kỳ vọng: 5 rows

-- 3. mfa_recovery_codes table tồn tại
SELECT count(*) FROM mfa_recovery_codes;
-- Kỳ vọng: 0 (chưa có ai)

-- 4. Chưa có sys_admin nào
SELECT count(*) FROM profiles WHERE role='sys_admin';
-- Kỳ vọng: 0
```

Nếu có lỗi → xem section Rollback ở cuối file SQL.

### Bước 3: Bootstrap sys_admin đầu tiên

Chạy script từ máy local có `scripts/.env.migration.local` (chứa SERVICE_ROLE_KEY):

```powershell
node scripts/add-user.mjs `
  --username sys `
  --password Abc12345XYZ `
  --role sys_admin `
  --pin 123456 `
  --fullname "System Admin"
```

Script sẽ print:
- ✅ Success + auth user id + profile info
- 🔐 GHI NHỚ block với username, password, PIN — lưu ngay vào password manager.

### Bước 4: Deploy Frontend

```powershell
npm run build
# Deploy dist/ theo cách hiện tại (Vercel/Netlify/manual FTP...)
```

Nếu dev thì `npm run dev` cũng OK để test.

### Bước 5: Sys_admin login lần đầu + setup MFA

1. Truy cập app → Login với username=`sys`, password vừa set.
2. App tự động hiện modal **"Enroll MFA cho Sys_admin"**:
   - Mở Google Authenticator / Authy trên điện thoại
   - Scan QR code (hoặc nhập secret bằng tay từ dropdown)
   - Nhập mã 6 số hiện tại từ authenticator → Verify
3. Modal recovery codes hiện — **8 codes chỉ hiển thị 1 LẦN**:
   - Copy hết vào password manager
   - Hoặc in ra giấy cất tủ két
   - Tick "Tôi đã lưu" → Đóng
4. Vào Quản Trị Hệ Thống → tab Người dùng → verify thấy user `sys` (chính mình) trong list.

**Nếu chưa làm bước này thì mọi thao tác sys_admin đều bị block (aal1 chưa đủ)**.

## 🧪 Smoke test scenarios (Option C)

Sau deploy, run các test này thủ công:

### T1: Sys_admin quản lý user

- [ ] T1.1 — Sys_admin login → thấy tab "⚙️ Quản Trị Hệ Thống" trong menu.
- [ ] T1.2 — Vào Chi nhánh → sửa hotline SG → Lưu → verify DB.
- [ ] T1.3 — Vào Người dùng → tạo `member` mới (VD: `linh`, role=`member`, branch=`SG`) → success.
- [ ] T1.4 — Login `linh` ở tab riêng → verify login OK, thấy menu Bills.
- [ ] T1.5 — Sys_admin disable `linh` → `linh` tab bên kia tự động logout trong < 60s.
- [ ] T1.6 — Sys_admin enable `linh` → `linh` login lại được.
- [ ] T1.7 — Sys_admin delete `linh` (2-step confirm nhập username) → `linh` biến mất khỏi list default.
- [ ] T1.8 — Filter Trạng thái = "Đã xóa" → thấy `linh`.

### T2: Anti-lockout

- [ ] T2.1 — Sys_admin cố disable chính mình → toast error "Không thể disable chính mình".
- [ ] T2.2 — Sys_admin cố demote role của mình → error tương tự (defence in depth qua RLS).
- [ ] T2.3 — Tạo sys_admin thứ 2 (`sys2`) → disable `sys2` OK. Rồi cố disable `sys` (còn duy nhất) → error "sys_admin cuối cùng".

### T3: MFA + Recovery

- [ ] T3.1 — Sys_admin logout → login lại → hiện modal verify TOTP.
- [ ] T3.2 — Nhập TOTP đúng → vào app.
- [ ] T3.3 — Nhập TOTP sai → toast error, không cho vào.
- [ ] T3.4 — Bấm link "Mất điện thoại? Dùng recovery code" → nhập 1 code → success → force logout → login lại → force enroll TOTP mới.
- [ ] T3.5 — Vào Tài khoản → MFA section → regenerate codes → hiện 8 codes mới → codes cũ invalid.

### T4: PIN gate

- [ ] T4.1 — Sys_admin vào Bill Detail → bấm "Sửa Đơn" → modal PIN hiện.
- [ ] T4.2 — Nhập PIN đúng → mở form edit.
- [ ] T4.3 — Sửa bill khác trong vòng 5 phút → KHÔNG hỏi PIN (còn TTL).
- [ ] T4.4 — Đợi 5 phút không thao tác → sửa bill → modal PIN hiện lại.
- [ ] T4.5 — Sai PIN 3 lần liên tiếp → modal lock 5 phút countdown.

### T5: Session TTL

- [ ] T5.1 — Sys_admin AFK 15 phút → auto logout + toast "Phiên đăng nhập hết hạn do không hoạt động".
- [ ] T5.2 — Member/admin AFK 15 phút → KHÔNG logout (TTL 8h).

### T6: RLS còn hoạt động

- [ ] T6.1 — Member login → không thấy tab Quản Trị Hệ Thống.
- [ ] T6.2 — Member cố truy cập direct URL/state 'sys-admin' → auto redirect + toast deny.
- [ ] T6.3 — Admin cũ (chưa có sys_admin) → app hoạt động bình thường, không break.

## 🔧 Troubleshooting

### Sys_admin quên PIN
- Login với password.
- Vào Tài khoản → Đổi PIN → bỏ trống ô "PIN cũ" nếu không có → nhập PIN mới → Lưu.
- (Chỉ hoạt động khi profile.sys_admin_pin_hash là NULL. Nếu có sẵn thì phải nhập đúng PIN cũ.)
- Nếu vẫn kẹt: dùng CLI script chạy `UPDATE profiles SET sys_admin_pin_hash = NULL WHERE username='sys'` qua Supabase Studio, rồi setup PIN lại từ Tài khoản.

### Sys_admin quên password
- Vào Supabase Studio → Authentication → Users → tìm user → click "Send password recovery" (Supabase gửi email — nếu domain @hoancau.internal không tồn tại thì fail. Fallback: click "Reset password" và set manually).
- Hoặc tạo sys_admin mới qua CLI: `node scripts/add-user.mjs --role sys_admin ...`

### Sys_admin mất điện thoại (mất TOTP)
1. Dùng 1 recovery code → login → xong.
2. Nếu đã dùng hết codes → phải mở Supabase Studio:
   ```sql
   -- Xóa MFA factor
   DELETE FROM auth.mfa_factors WHERE user_id = '<sys_admin_user_id>';
   ```
   Sau đó login lại, app force enroll TOTP mới.

### Edge Function trả 500 hoài
- Check env vars: `npx supabase secrets list`
- Kỳ vọng có `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (Supabase tự set 2 var này khi deploy).
- Check logs: `npx supabase functions logs admin-users`.

### User bị disable không tự logout ngay
- Client-side check chạy interval 30s → tối đa 60s để phát hiện.
- Có thể force user reload trang.
- Sau khi JWT expire (Supabase default 1h) thì absolute không login được nữa.

## 🔒 Security notes

- **PIN gate KHÔNG phải security layer chính** — attacker chiếm JWT của sys_admin có thể bypass PIN gate bằng cách gọi Supabase JS API trực tiếp từ DevTools. Security thực dựa vào MFA + audit log + session TTL ngắn.
- **PIN + password + MFA phải khác nhau** — nếu 1 trong 3 bị lộ, 2 cái còn lại bảo vệ.
- **Recovery codes phải cất offline** — password manager là OK, screenshot lên iCloud là KHÔNG OK.
- **Không share SERVICE_ROLE_KEY** — key này bypass toàn bộ RLS, chỉ dùng cho Edge Function env và CLI script (offline).
- **Audit log immutable** — không ai xóa được kể cả sys_admin. Recovery mọi hành động qua `SELECT * FROM audit_log WHERE is_sys_admin_action=true`.

## 📊 Kiểm tra sức khỏe hệ thống

Chạy định kỳ (VD hàng tuần):

```sql
-- 1. Sys_admin đang active
SELECT username, full_name, created_at
FROM profiles WHERE role='sys_admin' AND is_disabled=false AND is_deleted=false;
-- Kỳ vọng: 1-2 sys_admin.

-- 2. Recovery codes còn của mỗi sys_admin
SELECT p.username, COUNT(mrc.id) AS remaining
FROM profiles p LEFT JOIN mfa_recovery_codes mrc
  ON mrc.user_id = p.id AND mrc.used_at IS NULL
WHERE p.role='sys_admin' AND p.is_disabled=false AND p.is_deleted=false
GROUP BY p.username;
-- Kỳ vọng: 8 codes/sys_admin. Nếu < 3 → nên regenerate.

-- 3. Log hoạt động sys_admin 7 ngày qua
SELECT created_at, username, action, entity_type, entity_label, changes
FROM audit_log
WHERE is_sys_admin_action = true
  AND created_at > now() - interval '7 days'
ORDER BY created_at DESC;
```

## 📝 Rollback

Nếu muốn revert hoàn toàn (chưa có user sys_admin nào production):

1. Xóa sys_admin qua CLI: `DELETE FROM profiles WHERE role='sys_admin'` (Supabase Studio SQL).
2. Chạy block Rollback SQL ở cuối [add-sys-admin-role.sql](../add-sys-admin-role.sql).
3. Xóa Edge Functions: `npx supabase functions delete admin-users`, `npx supabase functions delete mfa-recovery`.
4. Deploy frontend cũ (rollback commit).

Nếu đã có data production dùng sys_admin (VD user_disabled_by trỏ tới sys_admin) → cần thận trọng backup DB trước rollback.
