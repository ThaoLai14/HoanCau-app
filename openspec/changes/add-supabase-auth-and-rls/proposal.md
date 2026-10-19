# Proposal: Add Supabase Auth + real RLS

## Status

🟡 **DRAFT** — waiting for anh review. Chưa code gì. Deadline production: **~2 tuần nữa (đầu 09/2026)**.

## Why

App sắp lên production với **real client data** (khách hàng thật, doanh thu thật, số điện thoại thật). Kiểm tra lại security posture hiện tại thì phát hiện **lỗ hổng nghiêm trọng chứ không chỉ là warning UI của Supabase**:

1. **`public.users` chưa bật RLS + `password_hash` lưu plaintext** — bất kỳ ai có anon key (public trong bundle JS đã deploy) có thể chạy `SELECT username, password_hash FROM users` → lấy toàn bộ mật khẩu nhân viên. Xem [src/LoginScreen.jsx](../../../src/LoginScreen.jsx#L19-L34).
2. **7 bảng public còn lại (`users`, `branches`, `clients`, `client_phones`, `bills`, `bill_payment_details`, `expenses`) chưa bật RLS** — bất kỳ ai có anon key CRUD được mọi thứ, kể cả xóa cứng `bills`, sửa `bill_payment_details`, đọc toàn bộ số điện thoại khách hàng.
3. **Role check hiện tại chỉ ở UI layer** (ẩn button, `disabled` input) — attacker bypass UI dễ dàng bằng cách gọi thẳng Supabase JS client trong DevTools.
4. **Session lưu ở `localStorage['hc_session']` với `role`, `branch_id` do client tự khai** — user có thể sửa localStorage thành `role: 'admin'` và ứng dụng tin ngay.

Các fix mang tính "band-aid" (RPC `verify_login`, hash password, bật RLS permissive) **không giải quyết được vấn đề gốc**: anon key là public + không có JWT tin cậy được ở phía DB. Chỉ có Supabase Auth (JWT ký bởi Supabase, DB decode và tin `auth.uid()`) mới bảo vệ được dữ liệu ở tầng database.

## What Changes

### Auth layer — chuyển sang Supabase Auth

- **BREAKING**: bỏ so sánh plaintext password trong `src/LoginScreen.jsx`.
- Login: `supabase.auth.signInWithPassword({ email, password })` — email được ghép nội bộ từ username: `<username>@hoancau.internal` (Supabase Auth chấp nhận domain không tồn tại, không verify).
- Session: dùng JWT do Supabase phát, quản lý qua `supabase.auth.getSession()` + `onAuthStateChange`. Bỏ `localStorage['hc_session']` tự khai.
- Logout: `supabase.auth.signOut()`.
- **KHÔNG có** flow quên mật khẩu, KHÔNG có force change password lần đầu. Admin đổi mật khẩu bằng cách vào Supabase Auth dashboard hoặc chạy SQL `UPDATE auth.users`.

### Bảng `public.users` → `public.profiles`

- **BREAKING**: rename `users` → `profiles`. Cột `id UUID` không còn tự sinh — bắt buộc `REFERENCES auth.users(id) ON DELETE CASCADE` (1-1 với `auth.users`).
- Bỏ cột `password_hash` (Supabase Auth giữ password đã bcrypt trong `auth.users.encrypted_password`).
- Giữ: `username, full_name, role, branch_id`.
- Thêm: `created_at TIMESTAMPTZ DEFAULT now()`.

### RLS thật cho toàn bộ 8 bảng public

Bật RLS với policy dựa trên `auth.uid()` + role/branch từ `profiles`, KHÔNG dùng `USING (true)`:

| Bảng | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `profiles` | mọi user authenticated đọc profile của mình; admin/boss đọc tất cả | deny (chỉ trigger tự tạo khi có `auth.users` mới) | user sửa profile mình (trừ role/branch_id); admin sửa tất cả | admin only |
| `branches` | mọi authenticated | admin | admin | admin |
| `clients` | mọi authenticated (chưa lọc theo branch — xem Notes) | admin, member | admin (member ko sửa được sau khi tạo — cần confirm) | admin (soft-delete only, hard-delete deny) |
| `client_phones` | mọi authenticated | admin, member | admin | admin |
| `bills` | admin/boss xem tất cả; member chỉ xem `branch_id = <profile.branch_id>` | admin, member (chỉ được insert với `branch_id` = branch của mình) | admin sửa mọi bill; member chỉ sửa bill draft của mình | deny cho mọi role (hủy draft = soft-cancel giống pending) |
| `bill_payment_details` | admin/boss all; member cùng branch | admin, member cùng branch với bill | admin | deny |
| `expenses` | admin/boss all; member cùng branch | admin, member cùng branch | admin, hoặc member sửa expense mình tạo trong ngày | admin only (soft-delete) |
| `branch_sessions` | mọi authenticated | admin (seed) | admin, member cùng branch (để rollover businessDate) | deny |
| `audit_log` | admin, boss | mọi authenticated (log tự do) | deny | deny |

Role `boss` = read-only ở DB layer: **KHÔNG có** INSERT/UPDATE/DELETE policy nào cho boss trên bất kỳ bảng operational (`bills`, `clients`, `expenses`, `bill_payment_details`).

### Helper functions (SQL)

- `public.current_profile() RETURNS profiles` — `SECURITY DEFINER`, đọc `auth.uid()` → trả `profiles`. Dùng trong policy để tránh subquery lặp.
- `public.current_role() RETURNS TEXT` — shortcut.
- `public.current_branch_id() RETURNS UUID` — shortcut.

### Fresh install (không migrate user cũ)

Anh quyết định wipe toàn bộ data test trước migration (chỉ giữ bảng `branches`). Do đó KHÔNG cần script migrate user hay backfill FK. Bảng `public.users` cũ bị DROP CASCADE, không có row nào cần chuyển qua `auth.users`. Sau khi migration chạy xong, admin dùng `scripts/add-user.mjs` để tạo user mới hoàn toàn.

### Helper script cho admin thêm user

Tạo `scripts/add-user.mjs` để admin thêm nhân viên từ terminal, tránh phải gõ metadata JSON tay trên Supabase dashboard (dễ sai UUID branch_id).

Usage:
```
node scripts/add-user.mjs --username linh --password Abc12345 --role member --branch SG --fullname "Nguyễn Linh"
```

Script tự resolve `branch_id` từ `branch_code` (SG/GL), gọi `supabase.auth.admin.createUser` với metadata đầy đủ, trigger tự tạo profile. Dùng service_role key từ `scripts/.env.migration.local` (git-ignored).

### Code changes trong `src/App.jsx` (~4700 dòng)

- `LoginScreen.jsx`: thay `.from('users').select(...)` + so sánh plaintext bằng `supabase.auth.signInWithPassword`.
- Bootstrap `App.jsx`: `useEffect` gọi `supabase.auth.getSession()` + `onAuthStateChange` để set `session` state. Bỏ đọc `localStorage['hc_session']`.
- Logout button: `supabase.auth.signOut()` + clear session state.
- Tất cả chỗ pass `session.id` xuống query (audit log, `created_by`, `updated_by`, `delivered_by`, `collected_by`): thay bằng `(await supabase.auth.getUser()).data.user.id` HOẶC lấy từ session state đã sync từ auth.
- `auditLog.js` `logAudit`: dùng `auth.uid()` snapshot từ session state; giữ nguyên field `user_id` trong `audit_log` (đã đúng type UUID).
- Bỏ tất cả check `if (session.role === 'admin')` ở client như là security → giữ như là **UX gate** (ẩn button cho đẹp) nhưng KHÔNG dựa vào để bảo mật. RLS chịu trách nhiệm bảo mật thật.

### Rotate anon key (optional nhưng recommend)

Rotate anon key trước khi go-live để đảm bảo key cũ (đã lộ trong repo git history) không xài được nữa.

## Capabilities

### New Capabilities

- `supabase-auth`: quy tắc xác thực bằng Supabase Auth với email nội bộ `<username>@hoancau.internal`, quản lý session bằng JWT, không có forgot-password/self-service.
- `row-level-security`: quy tắc RLS policy cho 8 bảng public, dựa trên `auth.uid()` + role/branch từ `profiles`. Bao gồm `boss` = read-only DB layer.

### Modified Capabilities

- `authentication-and-roles`: thay đổi cơ bản — bỏ plaintext compare, bỏ localStorage self-declared session, đổi bảng `users` → `profiles`, giữ nguyên semantics role & branch. **BREAKING** cho spec hiện tại.
- `shipment-intake`: đổi hành vi hủy đơn nháp từ hard-delete sang soft-cancel (UPDATE `delivery_status = 'cancelled'`), giữ audit trail đầy đủ. **BREAKING** cho scenario "Hủy đơn nháp" trong spec cũ.

## Impact

**Code**:
- `src/LoginScreen.jsx` — rewrite `handleSubmit` dùng `supabase.auth.signInWithPassword({ email, password })` với email nội bộ `<username>@hoancau.internal`, fetch profile qua RLS-guarded SELECT, trả session shape cũ lên App.
- `src/App.jsx` — thêm `useEffect` sync với `supabase.auth.getSession()` + subscribe `onAuthStateChange('SIGNED_OUT')` để clear cache khi session hết hạn hoặc logout từ tab khác. `handleLogout` gọi `supabase.auth.signOut()` trước khi clear cache. Rewrite nhánh hủy draft trong `handleConfirmCancelBill` từ `.delete()` sang `.update({ delivery_status: 'cancelled', order_note: ... })` — giờ soft-cancel giống pending. Cache `localStorage['hc_session']` GIỮ như 1 client-side cache (source of truth = Supabase Auth), nhờ vậy `auditLog.js` và các chỗ đọc `session.id/role/branch_id` KHÔNG cần sửa.
- `src/auditLog.js` — không cần đổi (đọc cache localStorage vẫn dùng được, `user_id` giờ = `auth.uid()` do đã sync từ Auth).
- `src/supabaseClient.js` — không đổi (client vẫn dùng anon key, chỉ khác là sau login có JWT tự attach).

**Database**:
- 1 SQL migration file: `add-supabase-auth-and-rls.sql` ở root repo. Bao gồm: idempotent seed `branches` (SG, GL), tạo `profiles`, trigger `on_auth_user_created`, 2 helper function (`current_role`, `current_branch_id`), thêm lại FK cho các cột UUID cũ trỏ về `profiles`, bật RLS + policy cho 9 bảng.
- 1 script Node `scripts/add-user.mjs` — helper cho admin tạo user mới sau go-live. Dùng service_role key từ `.env.migration.local` (git-ignored).
- Không có script migrate legacy user (đã wipe hết).

**Testing**:
- Smoke test manual sau khi anh chạy migration + tạo user thật: login từng role, tạo bill test, thử soft-cancel bill test.
- Test tấn công cơ bản trong DevTools: logout xong gọi `supabase.from('bills').select()` → phải fail (RLS deny anon). Login member SG rồi gọi `.from('bills').update()` cho bill GL → phải fail.

**Ops**:
- Reset password của user được thực hiện bằng SQL trực tiếp trên `auth.users` HOẶC qua Supabase Auth dashboard. Admin không có UI trong app.
- Không có forgot-password flow — user quên phải liên hệ admin.

**Rủi ro chính**:
- RLS policy sai → app chết ngay khi deploy. Mitigation: migration là `BEGIN...COMMIT` — nếu SQL fail giữa chừng, transaction rollback tự động. Nếu policy sai mà migration thành công, dùng phần `-- ROLLBACK` trong file để revert nhanh.
- Test data đã wipe → rủi ro migrate user gần như không còn.
