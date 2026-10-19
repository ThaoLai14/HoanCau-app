# Tasks: add-sys-admin-role

## 1. Migration DB

- [ ] 1.1 Tạo `add-sys-admin-role.sql` ở repo root.
- [ ] 1.2 Section A — mở rộng CHECK constraint `profiles.role` sang `IN ('sys_admin','admin','member','boss')`. Idempotent: DROP CONSTRAINT nếu tồn tại, ADD CONSTRAINT mới.
- [ ] 1.3 Section B — mở rộng CHECK constraint `audit_log.user_role` tương tự.
- [ ] 1.4 Section C — ALTER TABLE `profiles` ADD COLUMNS: `is_disabled`, `is_deleted`, `disabled_at`, `disabled_by`, `sys_admin_pin_hash`. Idempotent với `ADD COLUMN IF NOT EXISTS`.
- [ ] 1.5 Section D — sửa function `current_role()`: thêm điều kiện `AND is_disabled = false AND is_deleted = false` trong WHERE clause.
- [ ] 1.6 Section E — mở rộng 30+ RLS policies: từng policy có clause `current_role() = 'admin'` đổi thành `current_role() IN ('sys_admin', 'admin')`. Grep + apply cho: `profiles`, `branches`, `clients`, `client_phones`, `bills`, `bill_payment_details`, `expenses`, `branch_sessions`, `audit_log`.
- [ ] 1.7 Section F — RLS policy mới cho `profiles`:
  - INSERT: chỉ sys_admin (nhưng ưu tiên trigger `handle_new_auth_user` chạy SECURITY DEFINER, bỏ qua RLS).
  - UPDATE role/branch_id/is_disabled/is_deleted/sys_admin_pin_hash: chỉ sys_admin.
  - UPDATE full_name/username: user tự sửa profile mình.
  - Anti-lockout check: `target_id != auth.uid()` khi UPDATE `is_disabled=true` hoặc `is_deleted=true` hoặc `role != 'sys_admin'` cho sys_admin.
- [ ] 1.8 Section G — thêm cột `audit_log.is_sys_admin_action BOOLEAN DEFAULT false`.
- [ ] 1.9 Section H — CHECK constraint `audit_log.action` mở rộng cho các action mới: `sys_admin_pin_verify_success`, `sys_admin_pin_verify_fail`, `user_created`, `user_disabled`, `user_enabled`, `user_deleted`, `user_password_reset`, `user_profile_updated`.
- [ ] 1.10 Section I — comment block Rollback SQL ở cuối file.

## 2. Edge Function `admin-users`

- [ ] 2.1 Tạo `supabase/functions/admin-users/index.ts` với template Deno + serve.
- [ ] 2.2 Setup Supabase client với SERVICE_ROLE_KEY từ env.
- [ ] 2.3 Middleware verify JWT từ `Authorization: Bearer <token>` header.
- [ ] 2.4 Middleware check caller role: `SELECT role FROM profiles WHERE id = auth.uid()`; deny nếu ≠ sys_admin.
- [ ] 2.5 Rate limit: max 30 requests/phút/user (in-memory Map với TTL).
- [ ] 2.6 Action `create`: body {username, full_name, role, branch_code, password}. Resolve branch_id, gọi `auth.admin.createUser` với metadata. Insert audit log.
- [ ] 2.7 Action `update_profile`: body {target_id, full_name?, role?, branch_id?}. Anti-lockout check. Update profiles + audit.
- [ ] 2.8 Action `reset_password`: body {target_id, new_password}. Gọi `auth.admin.updateUserById({password})` + audit.
- [ ] 2.9 Action `disable`: set profiles.is_disabled=true + `auth.admin.updateUserById({ban_duration:'876000h'})` (100 năm) + audit. Anti-lockout.
- [ ] 2.10 Action `enable`: set profiles.is_disabled=false + `auth.admin.updateUserById({ban_duration:'none'})` + audit.
- [ ] 2.11 Action `delete`: set profiles.is_deleted=true, disabled_at=now + ban user + audit. Anti-lockout + check "last sys_admin".
- [ ] 2.12 Action `verify_pin`: body {pin}. Compare bcrypt với `profiles.sys_admin_pin_hash`. Trả về success/fail. Audit cả 2 case.
- [ ] 2.13 Action `set_pin`: body {new_pin}. Chỉ sys_admin đổi PIN của chính mình. Bcrypt hash + UPDATE profiles.
- [ ] 2.14 Deploy: `npx supabase functions deploy admin-users --no-verify-jwt` (tự verify trong function).
- [ ] 2.15 Test manual: cURL cho từng action, verify 200/400/403 đúng.

## 3. Frontend — Screen "Tài khoản của tôi"

- [ ] 3.1 Tạo file `src/MyAccountScreen.jsx`.
- [ ] 3.2 Form đổi password: nhập current password, new password, confirm. Verify current qua re-sign-in tạm rồi `supabase.auth.updateUser({password})`.
- [ ] 3.3 Nếu role=sys_admin: thêm section "Đổi PIN" — nhập PIN cũ + PIN mới. Gọi Edge Function action `set_pin` (verify PIN cũ trước trong function).
- [ ] 3.4 Sidebar item "👤 Tài khoản" — mọi role.

## 4. Frontend — Screen "Quản Trị Hệ Thống"

- [ ] 4.1 Tạo file `src/SysAdminPanel.jsx`.
- [ ] 4.2 Guard: nếu role ≠ sys_admin → redirect + toast.
- [ ] 4.3 Sub-tabs "🏢 Chi nhánh" | "👥 Người dùng".
- [ ] 4.4 Sidebar item "⚙️ Quản Trị Hệ Thống" — chỉ hiện khi role=sys_admin.

### 4.5 Tab Chi nhánh
- [ ] 4.5.1 Fetch từ `branches`: id, branch_code, address, hotline.
- [ ] 4.5.2 Render table 2 rows (SG, GL) với inline edit `address`, `hotline`.
- [ ] 4.5.3 Save button per row → UPDATE branches (RLS cho sys_admin).
- [ ] 4.5.4 Audit log via client-side `logAudit` (action `branch_updated`).

### 4.6 Tab Người dùng
- [ ] 4.6.1 Fetch profiles + join branches, filter default `is_deleted=false`.
- [ ] 4.6.2 Filter bar: role, branch, trạng thái (all / active / disabled). Search theo username / full_name.
- [ ] 4.6.3 Table columns: STT, username, full_name, role badge, branch, trạng thái badge, action.
- [ ] 4.6.4 Row action: ✏️ Sửa (modal form) — call Edge `update_profile`.
- [ ] 4.6.5 Row action: 🔑 Đổi mật khẩu — modal nhập password mới, confirm — call Edge `reset_password`.
- [ ] 4.6.6 Row action: 🚫 Disable / ✅ Enable — confirm dialog — call Edge `disable`/`enable`.
- [ ] 4.6.7 Row action: 🗑️ Delete — 2-step confirm (nhập username để xác nhận) — call Edge `delete`.
- [ ] 4.6.8 Button "➕ Thêm user" mở modal form: username, full_name, role dropdown (sys_admin/admin/member/boss), branch dropdown, password + confirm — call Edge `create`.
- [ ] 4.6.9 Disable các row action nếu target = current user (anti-lockout hiển thị UX).

## 5. Frontend — PIN gate cho business screens

- [ ] 5.1 Thêm state `sysAdminUnlocked = false` + `sysAdminUnlockedAt = null` ở App.jsx.
- [ ] 5.2 Helper `requireSysAdminUnlock()`: nếu role=sys_admin và (không unlocked hoặc unlock quá 5 phút) → mở PIN modal. Return promise resolve khi verified.
- [ ] 5.3 Component `SysAdminPinModal.jsx`: input 6 số, call Edge `verify_pin`, set flag + timestamp khi success. Fail → toast, tăng counter, sau 3 lần sai lock 5 phút.
- [ ] 5.4 Wrap mọi mutation handler business khi role=sys_admin: bill create/update/cancel, expense add/update/delete, client add/update/blacklist, xác nhận giao, xác nhận thanh toán. Tổng ~10 handlers.
- [ ] 5.5 Timer expire: sau 5 phút không có mutation → auto set `sysAdminUnlocked=false`.

## 6. Frontend — Auto logout khi user bị disabled

- [ ] 6.1 Wrap `supabase` client với error interceptor:
  - `PGRST301` (permission denied) hoặc `NEXT_ACTION_FAILED` hoặc `session missing profile` → tự force `supabase.auth.signOut()`.
- [ ] 6.2 Periodic check: mỗi 30s call `supabase.rpc('current_role')` — nếu trả NULL → force logout.
- [ ] 6.3 Sau `signOut` → toast "Tài khoản của bạn đã bị vô hiệu hóa. Vui lòng liên hệ quản trị viên." + redirect login.

## 7. Frontend — Session TTL cho sys_admin

- [ ] 7.1 Track `lastInteraction` state (updated bởi mousemove/keydown listener).
- [ ] 7.2 Interval check mỗi 30s: nếu role=sys_admin và `Date.now() - lastInteraction > 15*60*1000` → force logout + toast.
- [ ] 7.3 Role khác: TTL 8h.

## 8. Frontend — MFA enrollment/verify + recovery codes

- [ ] 8.1 Sau `signInWithPassword`, nếu `role=sys_admin` và không có MFA factor → mở modal enroll.
- [ ] 8.2 Modal enroll: hiển thị QR code từ `supabase.auth.mfa.enroll({factorType:'totp'})`, user scan bằng Google Authenticator, nhập mã 6 số verify.
- [ ] 8.3 Lần login sau: sau `signInWithPassword` check `supabase.auth.getAuthenticatorAssuranceLevel()` — nếu `currentLevel=aal1` và `nextLevel=aal2` → modal nhập TOTP.
- [ ] 8.4 Gọi `supabase.auth.mfa.challengeAndVerify({factorId, code})` → nếu OK, session được nâng lên aal2.
- [ ] 8.5 Nếu sys_admin login mà aal1 → block toàn bộ mutation, chỉ cho vào enroll/verify screen.
- [ ] 8.6 Section "🔐 MFA" trong Tài khoản của tôi: xem factors + unenroll (yêu cầu password + TOTP re-auth).
- [ ] 8.7 Modal MFA verify: thêm link "Dùng recovery code thay TOTP" → mở input 10 chars → Edge `mfa-recovery` verify.
- [ ] 8.8 Sau enroll TOTP thành công: modal recovery codes hiện 8 codes 1 lần, checkbox "Đã lưu" bắt buộc tick.
- [ ] 8.9 Section MFA trong Tài khoản: button "Regenerate recovery codes" — yêu cầu re-auth (password + TOTP hiện tại) → invalidate cũ + generate 8 mới.
- [ ] 8.10 Sau login qua recovery code: hiển thị banner warning "Còn N codes, cân nhắc regenerate".

## 8b. Backend — Recovery codes

- [ ] 8b.1 Migration: tạo bảng `mfa_recovery_codes(id, user_id, code_hash, used_at, created_at)`.
- [ ] 8b.2 RLS `mfa_recovery_codes`: SELECT only own rows (WHERE user_id = auth.uid()); INSERT/UPDATE/DELETE deny cho mọi role (chỉ Edge Function qua SERVICE_ROLE_KEY).
- [ ] 8b.3 Edge Function `admin-users` action `generate_recovery_codes`: caller = sys_admin, delete cũ + insert 8 codes mới (hash) + return plaintext codes 1 lần.
- [ ] 8b.4 Edge Function `mfa-recovery`: verify code (bcrypt compare, check used_at IS NULL, mark used) + cấp aal2. Chỉ dùng khi user đã login aal1 nhưng chưa aal2.

## 9. Frontend — Cập nhật menu + role check

- [ ] 9.1 Sidebar: thêm 2 item mới. Ẩn/hiện theo role như đã thiết kế.
- [ ] 9.2 Grep 45+ chỗ `role === 'admin'` / `userRole === 'admin'`: quyết định chỗ nào cần thêm sys_admin. Rule: nếu là "grant admin access" → thêm sys_admin; nếu là "identify branch admin cụ thể" (rare) → không.
- [ ] 9.3 Sửa `handleDeparture`, edit bill, delete expense, ... → cho phép sys_admin nhưng qua PIN gate.

## 10. Script — extend `scripts/add-user.mjs`

- [ ] 10.1 Thêm flag `--pin <6-digit>` cho role=sys_admin (required).
- [ ] 10.2 Validate role=sys_admin bắt buộc có PIN. Nếu không truyền `--branch` cho sys_admin → default = `SG`.
- [ ] 10.3 Sau khi tạo auth user + profile, bcrypt hash PIN + UPDATE profiles.sys_admin_pin_hash.
- [ ] 10.4 Print PIN + username + password recap để anh lưu (an toàn offline).
- [ ] 10.5 Update `--help` message với ví dụ sys_admin.

## 11. Documentation

- [ ] 11.1 Update `README.md` (nếu có) — section "Khởi tạo sys_admin lần đầu".
- [ ] 11.2 Update `docs/shipment-intake-manual-checklist.md` — chú thích sys_admin flow (optional).
- [ ] 11.3 Tạo `docs/sys-admin-guide.md` — hướng dẫn sys_admin dùng panel.

## 12. Test & verify manual

- [ ] 12.1 Migration chạy trên staging trước, verify:
  - `SELECT current_role();` cho disabled user → NULL.
  - RLS block SELECT/INSERT cho disabled user.
  - Sys_admin có quyền edit bills/expenses như admin.
- [ ] 12.2 E2E: bootstrap sys_admin qua script → login → thấy panel → tạo user mới → user login được.
- [ ] 12.3 Disable user X → user X (tab khác) tự logout trong < 60s.
- [ ] 12.4 Sys_admin tự disable → deny.
- [ ] 12.5 Sys_admin dernier → không delete được (last sys_admin check).
- [ ] 12.6 PIN gate: sys_admin bấm sửa bill → modal PIN → sai 3 lần → lock 5 phút.
- [ ] 12.7 PIN gate: unlock rồi im 5 phút → phải nhập lại.
- [ ] 12.8 MFA: enroll qua QR + verify 6 số → login lần sau bắt nhập TOTP.
- [ ] 12.9 Session TTL: sys_admin AFK 15 phút → auto logout.

## 13. Deployment order

- [ ] 13.1 Deploy Edge Function `admin-users` (không có tác dụng nếu chưa có sys_admin nào call).
- [ ] 13.2 Chạy migration `add-sys-admin-role.sql` trên production.
- [ ] 13.3 Bootstrap sys_admin đầu tiên qua CLI script.
- [ ] 13.4 Sys_admin login → force enroll MFA.
- [ ] 13.5 Deploy frontend (menu mới, PIN modal, auto logout).
- [ ] 13.6 Smoke test sau deploy.

## 14. Post-launch bug fixes (sau khi deploy production)

### 14.1 Bill snapshot — branch info (address / hotline / address_note)

Vấn đề: bill in đang render "Thông tin nhà xe" bằng cách join live tới `branches` — nếu sys_admin sửa address/hotline, bill CŨ đổi theo → sai chứng từ.

- [x] 14.1.1 Migration [add-bill-branch-snapshot.sql](../../../add-bill-branch-snapshot.sql): thêm cột `bills.branch_address_snapshot`, `branch_hotline_snapshot`.
- [x] 14.1.2 Migration [add-branch-address-note.sql](../../../add-branch-address-note.sql): thêm cột `branches.address_note` (chú thích địa chỉ, VD "Bên trong chung cư…") + cột `bills.branch_address_note_snapshot`.
- [x] 14.1.3 App.jsx: fetch `branchInfoById` bao gồm `address_note`; `executeCreateBill` + `executeConvertDraftToBill` snapshot cả 3 field vào bill khi INSERT.
- [x] 14.1.4 App.jsx: bill print preview `buildBranchContact()` ưu tiên snapshot cho bill của branch mình, live cho branch khác.
- [x] 14.1.5 SysAdminPanel `BranchesTab`: thêm input "Ghi chú địa chỉ" ngoài address + hotline; save đủ 3 field.

### 14.2 Bill snapshot — creator / deliverer name

Vấn đề: bill hiển thị "Nhân viên tạo/giao đơn" bằng join live tới `profiles.full_name` — sys_admin đổi tên user → bill cũ đổi theo. Audit log không bị vì đã snapshot `full_name` tại thời điểm log.

- [x] 14.2.1 Migration [add-bill-user-snapshot.sql](../../../add-bill-user-snapshot.sql): thêm `bills.creator_name_snapshot`, `deliverer_name_snapshot`; backfill từ `audit_log.full_name` (bill_create + bill_delivered) cho bill cũ; fallback từ `profiles` nếu bill không có audit.
- [x] 14.2.2 App.jsx: `executeCreateBill` + `executeConvertDraftToBill` set `creator_name_snapshot = session.full_name`.
- [x] 14.2.3 App.jsx: handler giao đơn (`delivered_by`) set `deliverer_name_snapshot = session.full_name`.
- [x] 14.2.4 App.jsx bill detail: hiển thị `creator_name_snapshot / deliverer_name_snapshot` trước, fallback join.

### 14.3 SysAdminPanel — data refresh sau khi save

Vấn đề: sau khi sửa branch trong panel, các query trong App.jsx (bill preview, dropdown, …) vẫn dùng cache cũ đến khi F5.

- [x] 14.3.1 Prop `onDataChanged` từ App → SysAdminPanel → BranchesTab + UsersTab.
- [x] 14.3.2 Handler save thành công gọi `onDataChanged?.()` để App re-fetch `branchInfoById` + `branches`.

### 14.4 PIN gate — cross-tree store

Vấn đề: `SysAdminPinProvider` bọc bên trong App; các handler mutation ngoài provider tree không call được `requireUnlock` qua context.

- [x] 14.4.1 Tạo `src/pinGateStore.js` — module-level singleton với `setPinRequestFn(fn)` + `requireSysAdminUnlock()`.
- [x] 14.4.2 `SysAdminPinModal` Provider auto-register `requireUnlock` vào store qua `useEffect` (cleanup khi unmount).
- [x] 14.4.3 Wrap 7 handler mutation (bill create, convert draft, update bill, cancel bill, deliver, refund, expense delete) với `if (!(await requireSysAdminUnlock())) return;`.

### 14.5 MFA — chống StrictMode double-enroll

Vấn đề: React StrictMode chạy `useEffect` 2 lần → `mfa.enroll` bị gọi 2 lần → lỗi "factor already exists".

- [x] 14.5.1 `enrollGuardRef` trong `MfaFlow.jsx` bảo vệ không cho enroll lần 2.
- [x] 14.5.2 `friendlyName` dùng `crypto.randomUUID().slice(0, 8)` để tránh conflict tên nếu enroll fail giữa chừng và retry.

### 14.6 Sidebar — restrict sys_admin

Vấn đề: sys_admin không cần vào các trang vận hành hằng ngày (admin đã handle). Chỉ giữ trang giám sát + quản trị.

- [x] 14.6.1 Ẩn 4 mục nav cho sys_admin: 👥 Quản Lý Khách Hàng, 📦 Phiếu Gửi Hàng, 📋 Danh Sách Bốc Xếp, 🧾 Công Nợ.
- [x] 14.6.2 Giữ 4 mục: 📋 Tổng Hợp Đơn Hàng, 💰 Quản Lý Doanh Thu, ⚙️ Quản Trị Hệ Thống, 👤 Tài khoản của tôi.
- [x] 14.6.3 Ẩn "👤 Tài khoản của tôi" cho non-sys_admin (chỉ sys_admin dùng — role khác chưa cần đổi PIN/MFA).
- [x] 14.6.4 Guard useEffect: sys_admin lỡ vào `clients/warehouse/debt` (state cũ / bookmark) → redirect về `sys-admin`.
- [x] 14.6.5 Ngoại lệ cho `bills`: cho phép khi có `selectedBill` (mở chi tiết từ Tổng Hợp / Doanh Thu) HOẶC `editingBillId` / `editingDraftId` (đang trong flow Sửa Đơn). Ngược lại (landing form tạo đơn) → redirect.

### 14.7 Deployment notes

- [x] Migration order chạy trên production:
  1. `add-bill-branch-snapshot.sql`
  2. `add-branch-address-note.sql`
  3. `add-bill-user-snapshot.sql`
- [x] Verify: `SELECT bill_code, creator_name_snapshot, deliverer_name_snapshot FROM bills WHERE bill_code = '05GLA01';` → phải trùng audit log.

### 14.8 Bill detail — cross-branch + in-day business rules

Vấn đề: bill detail cho phép nhiều thao tác không đúng workflow (edit cross-branch, giao đơn khi chưa tới, radio pre-selected mặc định gây audit sai…).

- [x] 14.8.1 **Rule 1 + 4**: nút Sửa Đơn / Hủy Đơn chỉ hiện khi (`bill.branch === session.branch` AND `bill.business_date === today`); sys_admin bypass cả 2 điều kiện.
- [x] 14.8.2 **Rule 2**: bill pre-paid (payment_status = 'paid' lúc tạo) → `handleConfirmDelivery` không INSERT `bill_payment_details` mới, không log `payment_received` mới, toast chỉ hiện "Đã xác nhận giao hàng!" (tránh duplicate audit).
- [x] 14.8.3 **Rule 3**: `<fieldset disabled>` bao section Thanh toán & Giao nhận khi user thuộc chi nhánh GỬI (same-branch với bill) — chờ chi nhánh nhận thao tác. Sys_admin bypass.
- [x] 14.8.4 **Rule 5**: nút Hoàn tất giao hàng disable (opacity 50 + tooltip "Hàng chưa tới — chờ qua ngày mới xác nhận giao được") khi `bill.business_date >= todayVN` (cross-branch chưa qua ngày). Sys_admin bypass.
- [x] 14.8.5 **Rule 6**: khi `payOption = "actual"` thêm input "Lý do thu thiếu / thu khác *" (required). Lưu vào `bill_payment_details.note` + audit `bill_payment_received.note` = `"Thu cước lúc giao hàng — {lý do}"`.
- [x] 14.8.6 **Rule 7**: sau `executeUpdateDraft` với `oldBill.delivery_status = 'pending'` → re-fetch bill full joins → `setSelectedBill(fresh)` → user quay lại detail view với info mới, không cần bấm back+chọn lại.
- [x] 14.8.7 Sau `handleConfirmDelivery` + `handleConfirmPayment` → re-fetch bill hiện tại + setSelectedBill để state machine render trạng thái mới (delivered/paid) ngay.

### 14.9 Bill detail — form defaults + UX polish

Vấn đề: radio "Thanh toán" + "Người nhận" tự tick default khi mở bill pending → user không kích hoạt intent, dễ save sai.

- [x] 14.9.1 useEffect sync form: `payOption` KHÔNG sync từ `bill.payment_status` cho case pending (luôn "" — bắt user chọn). Ngoại lệ pre-paid/free — JSX render radio khóa sẵn (hard-coded checked+disabled), không phụ thuộc payOption state.
- [x] 14.9.2 useEffect sync form: `recipientType` chỉ load từ DB khi `delivery_status = 'delivered'`; pending → luôn "" (defensive vs legacy DB có `recipient_type='self'` cho pending).
- [x] 14.9.3 `handleConfirmDelivery`: skip validate `payOption` khi `wasPrePaid` (radio khóa sẵn).
- [x] 14.9.4 Ẩn nút "+ Tạo đơn mới" trong bill detail cho sys_admin (sys_admin không tạo bill vận hành).

### 14.10 Intake form — read-only branch selector

Vấn đề: admin có dropdown Chi Nhánh Gửi → dễ tạo bill nhầm branch → sai bill_code + branch snapshot.

- [x] 14.10.1 Bỏ dropdown admin — luôn render div read-only hiển thị `currentBranch` (= login branch). Muốn tạo bill branch khác phải login user branch đó.

### 14.11 Session cache — auto refresh profile

Vấn đề: `hc_session` (localStorage) chỉ set lúc login. Sys_admin đổi tên/role/branch của user → user đó F5 vẫn thấy info cũ.

- [x] 14.11.1 useEffect sync auth session: sau khi verify JWT hợp lệ + cùng user id, luôn re-fetch `profiles` (id, username, full_name, role, branch_id, branches:branch_id(branch_code)) → so sánh 5 field với cache → nếu khác → ghi đè localStorage + `setSession(fresh)`.

### 14.12 PIN modal — bớt toast noise

- [x] 14.12.1 Bỏ toast "PIN đúng — mở khóa 5 phút" sau khi verify_pin success (giữ silent close). TTL 5 phút vẫn giữ trong logic. Toast lock "Sai PIN 3 lần…" giữ nguyên vì là error thực sự.

### 14.13 Departure cutoff — popup xác nhận xuất bến sau 16:30 VN

Vấn đề: Sau 16:30 VN, xe kho có thể đã xuất bến rồi. Nếu user vẫn tạo đơn chính thức mà quên chưa "Xuất Bến" trên hệ thống → đơn đó có `business_date` = hôm nay nhưng thực tế phải thuộc chuyến mai → sai chuyến, sai bill_code, phải hủy đơn.

Rule nghiệp vụ:
- Sau 16:30 (giờ VN, hardcoded), tạo đơn CHÍNH THỨC (mới) hoặc convert nháp → chính thức → hiện popup hỏi "Xe kho X đã xuất bến chưa?".
- Chỉ hỏi cho đơn chính thức. Lưu nháp thuần túy KHÔNG hỏi.
- Từ nháp → đơn chính thức = phải hỏi (vẫn là hành động "tạo đơn").
- Sys_admin bypass (không tạo đơn vận hành).
- Đã bấm "Xuất Bến" (business_date > todayVN) → skip popup luôn cho tới hết ngày.
- Popup 2 lựa chọn:
  - **Chưa xuất bến** → tiếp tục tạo đơn chính thức cho chuyến hôm nay.
  - **Xe đã đi rồi** → lưu nháp; sau khi xuất bến, user mở lại nháp, submit → tự động thuộc chuyến mai (business_date từ session).

Implementation:

- [x] 14.13.1 Top-level constants + helper trong [src/App.jsx](../../../src/App.jsx): `DEPARTURE_CUTOFF_HOUR = 16`, `DEPARTURE_CUTOFF_MIN = 30`, `isAfterVNDepartureCutoff()` dùng `Intl.DateTimeFormat` với `timeZone: 'Asia/Ho_Chi_Minh'` để so giờ VN, không lệ thuộc timezone máy.
- [x] 14.13.2 State `departureConfirmDialog` shape `{ branch, billData, mode: 'create'|'convert', draftId? }`.
- [x] 14.13.3 Interceptor trong `handleStartCreateBill`: sau khi build `billData`, TRƯỚC khi gọi `executeCreateBill` / `executeConvertDraftToBill`, check `userRole !== 'sys_admin' && isAfterVNDepartureCutoff() && !alreadyDeparted` (`alreadyDeparted = branchSessions[currentBranch].business_date > getVNTodayDate()`) → `setDepartureConfirmDialog(...)` + return. KHÔNG chặn `editingBillId` (admin sửa đơn có sẵn) và `handleSaveDraft` (nháp thuần).
- [x] 14.13.4 Handler `handleDepartureConfirmProceed`: user chọn "Chưa xuất bến" → call executor tương ứng (`executeCreateBill` / `executeConvertDraftToBill`).
- [x] 14.13.5 Handler `handleDepartureConfirmSaveDraft`: user chọn "Xe đã đi rồi" → set `isDraft: true` và call `executeCreateBill` (mode=create) hoặc `executeUpdateDraft` giữ nguyên nháp (mode=convert). Toast "Đã lưu nháp. Sau khi xuất bến, mở lại nháp để tạo đơn cho chuyến mai."
- [x] 14.13.6 Modal JSX 2 nút với cảnh báo `⚠️ Mã đơn hàng KHÔNG sửa được sau khi tạo. Chọn sai chuyến → phải hủy đơn.`
- [x] 14.13.7 Build check pass. Constant `DEPARTURE_CUTOFF_HOUR/MIN` để dễ chỉnh nếu nghiệp vụ đổi giờ cutoff.

### 14.14 Bill preview — in 2 bản (khách giữ + chành xe giữ)

Vấn đề: nút "Xem Bill In" trước đây chỉ render 1 bản biên nhận. Thực tế cần 2 bản mỗi lần tạo/in bill: 1 bản khách hàng giữ, 1 bản chành xe giữ (có thêm phần ký nhận khi khách tới lấy hàng).

Rule nghiệp vụ:
- Giữ nguyên format hiện tại của bill (không đổi field/style cũ).
- Bản chành xe giữ thêm section ký nhận ở cuối: Ngày nhận, Người nhận, khoảng trống ký tên + ghi rõ họ tên + SĐT.
- Bản khách giữ KHÔNG có section ký nhận.
- Khi in (`window.print()`), mỗi bản xuống dòng trang riêng (`page-break-before: always` giữa 2 `.bill-copy`) để máy in hóa đơn 80mm cắt đúng 2 tờ.

Implementation:

- [x] 14.14.1 [src/App.jsx](../../../src/App.jsx): tách nội dung 1 bản bill (header công ty, mã bill, thông tin gửi/nhận, lưu ý, thông tin nhà xe, footer note) thành hàm `renderBillCopy(copyLabel, isDepotCopy)` dùng chung.
- [x] 14.14.2 Badge nhãn phân biệt bản: "Bản khách hàng giữ" (xanh) / "Bản chành xe giữ" (vàng) ở đầu mỗi bản.
- [x] 14.14.3 `isDepotCopy=true` → render thêm section "Xác nhận nhận hàng (chành xe lưu)" gồm Ngày nhận, Người nhận, dòng ký tên + (Ghi rõ họ tên) + SĐT.
- [x] 14.14.4 Render 2 lần `renderBillCopy` trong `#bill-print-content`, ngăn cách bằng divider `border-dashed` (chỉ hiện trên màn hình preview).
- [x] 14.14.5 CSS `@media print`: `.bill-copy + .bill-copy { page-break-before: always }` → bản 2 luôn xuống dòng in riêng.
- [x] 14.14.6 Đổi tiêu đề modal thành "Biên Nhận In (2 bản: khách giữ + chành xe giữ)".
- [x] 14.14.7 Build check pass.

### 14.15 Bill preview — UI polish phần ký nhận (bản chành xe)

- [x] 14.15.1 Bỏ 2 badge nhãn "Bản khách hàng giữ" / "Bản chành xe giữ" ở đầu mỗi bản (thừa, không cần thiết cho bản in).
- [x] 14.15.2 Bỏ placeholder gạch dưới (`______`) sau "Người nhận" và "SĐT" — để trống cho khách viết tay.
- [x] 14.15.3 Bỏ đường kẻ ngang (border) dưới phần chữ ký.
- [x] 14.15.4 Dời "SĐT" xuống cùng hàng với "Chữ ký người nhận" (grid 2 cột), cột SĐT thẳng hàng dọc với cột "Người nhận" ở hàng trên (cùng là cột thứ 2 của grid-cols-2).
- [x] 14.15.5 Bold "SĐT" cho đồng bộ style với các label khác trong bill (Người gửi/Người nhận/SĐT ở phần trên).
- [x] 14.15.6 Build check pass.

### 14.16 Bill preview — watermark logo chống làm giả

Vấn đề: User hỏi có thể in chìm logo công ty lên bill để chống làm giả không. User cung cấp file `src/assets/Logo HC.png`.

Implementation:
- [x] 14.16.1 Import `logoHC` từ `./assets/Logo HC.png` trong App.jsx.
- [x] 14.16.2 Thêm `<img>` watermark tuyệt đối ở giữa mỗi `bill-copy` (cả 2 bản khách giữ + chành xe giữ), `opacity: 0.08`, rộng ~80% container (max 320px), `pointer-events-none`, `z-index: 0`.
- [x] 14.16.3 Bọc nội dung bill hiện có trong layer `relative z-index: 1` để text/border nằm trên watermark.
- [x] 14.16.4 Thêm CSS `.watermark-logo { -webkit-print-color-adjust: exact; print-color-adjust: exact; }` trong `@media print` để đảm bảo watermark vẫn hiển thị khi in (thay vì bị browser ẩn mặc định).
- [x] 14.16.5 Build check pass.
- [x] 14.16.6 (Feedback vòng 2) Canh logo bắt đầu ngay dưới header (không dùng `top:50%` của toàn bộ nội dung nữa vì bản chành xe có thêm section ký nhận nên tổng chiều cao khác bản khách → logo lệch vị trí giữa 2 bản). Dời header ra ngoài wrapper watermark để làm mốc cố định, cùng vị trí ở cả 2 bản.
- [x] 14.16.7 Đổi width từ 80% (max 320px) → 100% để logo chạm lề trái/phải khung in.
- [x] 14.16.8 Thêm `filter: grayscale(100%)` — máy in không in màu được, logo cần in ra xám nhạt thay vì màu.
- [x] 14.16.9 Build check pass.
- [x] 14.16.10 (Feedback vòng 3) Logo full-width đè lên nội dung khó nhìn → giảm còn 65% width, opacity 0.15 → 0.07 (mờ hơn), dời top-0 → top-4 (tránh sát viền header). Build check pass.
- [x] 14.16.11 (Revert) User đánh giá bản 100% width/opacity 0.15/top-0 ổn hơn → revert lại 14.16.10. Build check pass.

### 14.17 Danh Sách Bốc Xếp — chặn Xuất Bến khi còn đơn chưa kiểm đủ số kiện Trong/Ngoài

Vấn đề: User yêu cầu trước khi bấm "Xuất Bến", hệ thống phải kiểm tra toàn bộ đơn của chuyến hiện tại (kho đang chọn) đã điền đủ số kiện Trong/Ngoài và tổng Trong+Ngoài phải khớp `package_count`; nếu còn đơn thiếu/lệch thì không cho xuất bến.

- [x] 14.17.1 `handleDeparture`: thêm check defense-in-depth — filter bills cùng branch + cùng `business_date` với session hiện tại (chuyến sắp đóng), loại `draft`/`cancelled`; nếu có bill nào `inside_count`/`outside_count` null hoặc tổng ≠ `package_count` → toast lỗi + chặn, không gọi `advanceBranchSession`.
- [x] 14.17.2 UI nút "🚛 Xuất Bến": thêm `hasIncomplete` vào điều kiện `canDeparture` (disable nút), `disabledReason`/title hiển thị số lượng đơn còn thiếu/lệch để nhân viên biết cần sửa gì trước khi xuất bến.
- [x] 14.17.3 Build check pass.

### 14.18 Tổng Hợp Đơn Hàng — bỏ option "Nháp" ở filter Trạng thái giao

Vấn đề: User yêu cầu bỏ option "Nháp" khỏi dropdown "TRẠNG THÁI GIAO" ở màn Tổng Hợp Đơn Hàng (không cần lọc riêng bill nháp ở đây).

- [x] 14.18.1 Xoá `<option value="draft">Nháp</option>` khỏi dropdown filter `allBillsFilter.delivery`. Logic filter `f.delivery === "draft"` trong `filteredBills` giữ nguyên (không còn đường vào từ UI, vô hại).
- [x] 14.18.2 Build check pass.

### 14.19 Màn Doanh Thu — hiển thị lịch sử audit thêm/sửa/xóa phiếu chi

Vấn đề: `logAudit` cho `expense_create`/`expense_update`/`expense_delete` đã ghi log từ trước (§4.5), nhưng UI màn Doanh Thu chưa có chỗ xem lại lịch sử này (khác với Bill/Client đã có `BillHistorySection`/`ClientHistorySection`).

- [x] 14.19.1 Tạo `src/ExpenseHistorySection.jsx` (theo pattern `BillHistorySection`) — fetch `audit_log` theo `entityType: "expense"`, render icon/label qua `ACTION_LABELS`/`renderChanges` có sẵn trong `auditLabels.js`.
- [x] 14.19.2 App.jsx: thêm state `expenseHistoryRefreshKey` + `expandedExpenseIds` (Set, cho phép mở nhiều phiếu chi cùng lúc). Bump `expenseHistoryRefreshKey` sau khi `handleAddExpense`/`handleUpdateExpense`/`handleDeleteExpense` thành công.
- [x] 14.19.3 Bảng "Danh sách phiếu chi": thêm nút "📜 Lịch sử" (hiện cho mọi role xem được màn Doanh Thu, không giới hạn theo chi nhánh vì chỉ xem không sửa) — toggle hàng mở rộng chứa `<ExpenseHistorySection>`. Cột "Thao tác" (Sửa/Xóa) vẫn chỉ hiện cho admin/sys_admin đúng chi nhánh như cũ.
- [x] 14.19.4 Build check pass.

- [x] 14.19.5 (Bug fix — user phát hiện) Lịch sử gắn theo TỪNG phiếu chi (§14.19.1-3) có lỗi: khi phiếu bị xoá mềm, hàng biến mất khỏi bảng (local state `expenses` chỉ load `is_delete=false`) → mất luôn nút "📜 Lịch sử" → không xem lại được audit của phiếu đã xoá. Refactor: bỏ toggle theo từng phiếu, đổi `ExpenseHistorySection` thành component thuần hiển thị (nhận `entries`/`loading`/`error` qua props, không tự fetch), render 1 section DUY NHẤT dưới bảng cho cả KỲ đang xem (ngày/tháng/năm).
- [x] 14.19.6 App.jsx: thêm `useEffect` fetch `audit_log` (entity_type='expense') toàn bộ, filter client-side theo kỳ (dùng `toVNDate` + `revenueFilterType/revenueDate/revenueMonth/revenueYear` — đồng bộ cách filter với `paidPaymentsInRange`), sau đó lấy distinct `entity_id` và query thẳng bảng `expenses` (bỏ qua filter `is_delete` ở local state — RLS `expenses_select` cho phép admin/boss/sys_admin đọc cả row đã xoá mềm) để resolve `branch_code`, cuối cùng lọc theo `revenueTab`. Nhờ vậy phiếu đã xoá vẫn hiện đủ lịch sử tạo + xoá.
- [x] 14.19.7 `ExpenseHistorySection`: thêm hiển thị `entity_label` (số tiền + lý do gốc) trong mỗi entry — cần thiết vì phiếu đã xoá không còn hàng trong bảng để đối chiếu ngữ cảnh.
- [x] 14.19.8 Bỏ state `expandedExpenseIds`; cột "Thao tác" trong bảng trở lại chỉ có Sửa/Xóa (không còn nút Lịch sử per-row).
- [x] 14.19.9 Build check pass.

### 14.20 Boss — role chỉ xem (view-only) cho Phiếu Gửi Hàng + Quản Lý Khách Hàng

Vấn đề: Boss trước đây vẫn thấy nav "Phiếu Gửi Hàng" + các nút Sửa/Hủy đơn/Tạo đơn mới/Hoàn tất giao/Xác nhận thanh toán, và bị chặn hẳn không click được vào khách hàng để xem. User yêu cầu: ẩn màn tạo đơn khỏi sidebar cho boss (nhưng bấm vào 1 bill từ tab khác vẫn phải xem được chi tiết), ẩn mọi nút hành động trên bill, và cho boss click vào khách hàng để xem (populate form) nhưng không sửa/xoá/thêm được.

- [x] 14.20.1 Sidebar: bỏ nav "📦 Phiếu Gửi Hàng" cho boss (`userRole !== "sys_admin" && userRole !== "boss"`). Không ảnh hưởng luồng click bill từ Tổng Hợp/Công Nợ/Kho/Doanh Thu vì các nơi đó tự `setCurrentScreen("bills")` + `setSelectedBill(...)` độc lập với sidebar.
- [x] 14.20.2 Bill detail: bỏ `boss` khỏi điều kiện role hiện nút "✏️ Sửa Đơn"/"🚫 Hủy Đơn" (chỉ còn admin/sys_admin) và nút "+ Tạo đơn mới" (`userRole !== "sys_admin" && userRole !== "boss"`).
- [x] 14.20.3 Bill detail: ẩn hẳn nút "✅ Hoàn tất giao hàng"/"💰 Xác nhận thanh toán" khi `userRole === "boss"`; `<fieldset>` bọc section Thanh toán & Giao nhận cũng disable luôn khi boss (trước đây chỉ dựa vào `sameBranch` nên boss có thể lọt qua nếu branch_code không khớp bill).
- [x] 14.20.4 Defense-in-depth: `handleConfirmDelivery`/`handleConfirmPayment` chặn sớm nếu `session.role === 'boss'` (toast lỗi), theo đúng pattern đã dùng ở `handleDeparture`.
- [x] 14.20.5 Quản Lý Khách Hàng: bỏ `disabled={userRole === "boss"}` khỏi nút tên khách trong bảng danh sách (link) → boss click được để populate form xem chi tiết; các input/nút submit trong form vẫn giữ disable cho boss như cũ (không đổi được gì). Đổi tiêu đề form + tooltip theo role boss ("👁️ Xem Khách Hàng" / "Nhấn để xem chi tiết").
- [x] 14.20.6 Build check pass.
- [x] 14.20.7 (Simplify — theo yêu cầu user) Bỏ hẳn cách "populate form để xem" ở §14.20.5, thay bằng view-only đơn giản: với boss, panel bên trái (form Thêm/Sửa) thay hẳn bằng 1 box thông báo tĩnh "👁️ Chế độ chỉ xem"; tên khách trong bảng danh sách render `<span>` thường (không phải `<button>`) — boss không click vào để mở form được nữa, chỉ xem được các cột có sẵn trong bảng (tên, SĐT, địa chỉ, trạng thái blacklist).
- [x] 14.20.8 Build check pass.

### 14.21 Fix 3 bug thanh toán/thu tiền (user báo cáo)

Vấn đề (verbatim): (1) đơn chưa thanh toán + nhập "Số tiền trả thực tế" + ghi chú → lưu xong mục Trạng thái thanh toán hiện "Thanh toán đủ cước" (sai, chỉ thu 1 phần). (2) Tương tự với đơn `delivered+unpaid` thu nợ sau. (3) Bill đã thu tiền ở chi nhánh tạo (VD SG), nhưng khi chi nhánh khác (GL) xác nhận giao hàng, doanh thu bị cộng thêm lần nữa vào GL + audit log trùng.

- [x] 14.21.1 (Bug #1, #2) Root cause: khi `payment_status === "paid"`, radio khoá hiển thị cứng `"Đã thanh toán đủ (shipping_fee)"` bất kể là thu đủ hay thu thiếu (payOption="actual"). Fix: so sánh `actual_amount_paid` với `shipping_fee` — nếu ≥ thì hiện "Đã thanh toán đủ", nếu < thì hiện "Đã thu {actual_amount_paid} / Cước {shipping_fee} (trả thiếu — đã chốt)". Lưu ý: `payment_status='paid'` với actual < fee là hành vi ĐÚNG theo thiết kế (case đã chốt, có ghi lý do — không tính là nợ nữa), chỉ có PHẦN HIỂN THỊ bị sai.
- [x] 14.21.2 (Bug #3) Root cause: `handleConfirmDelivery`/`handleConfirmPayment` tin vào `selectedBill` (React local state) để tính `wasPrePaid`/`isFreeBill`/`isQuoteLater` và số tiền/chi nhánh insert. Nếu chi nhánh A vừa cập nhật payment_status (VD thu tiền lúc tạo) nhưng máy chi nhánh B đang xem bill đó chưa refetch (`bills` state cũ) → `selectedBill.payment_status` stale ("unpaid") dù DB đã "paid" → B xác nhận giao hàng sẽ tưởng bill chưa thu tiền → insert thêm 1 dòng `bill_payment_details` (dưới branch B) + log `bill_payment_received` trùng.
- [x] 14.21.3 Fix: đầu 2 hàm, SELECT lại bill trực tiếp từ DB (`liveBill`, chỉ lấy field cần: delivery_status/payment_status/shipping_fee/branch_id/bill_code) ngay sau bước xác thực role/PIN, dùng `liveBill.*` cho MỌI guard + tính toán số tiền/branch/audit "before" value thay vì `selectedBill.*` (vẫn giữ `selectedBill.id`/`bill_code` cho các câu update/log không nhạy cảm). Nếu fetch fail → toast lỗi, dừng thao tác.
- [x] 14.21.4 Build check pass.

### 14.22 Đồng bộ hoá lại behavior "Số tiền trả thực tế" giữa 2 flow + hiện lý do sau khi chốt

Vấn đề (verbatim, theo screenshot): ở màn "Xác nhận thanh toán" (đơn đã giao, chưa thanh toán), khi chọn "Số tiền trả thực tế" thì hiện 2 field trùng nhau: "Lý do thu thiếu / thu khác *" VÀ "Ghi chú thanh toán (tuỳ chọn)" (cả 2 cùng bind `paymentNote`). User yêu cầu: (a) 2 flow (`handleConfirmDelivery` lúc giao hàng, `handleConfirmPayment` lúc thu nợ sau) phải có behavior giống nhau khi chọn "actual"; (b) bỏ field "Ghi chú thanh toán" trùng khi đã chọn actual; (c) sau khi chốt, hiển thị số tiền đã thu KÈM lý do đã nhập.

- [x] 14.22.1 `handleConfirmPayment` thiếu validate bắt buộc nhập lý do khi `payOption === "actual"` (trong khi `handleConfirmDelivery` đã có — Rule 6) → 2 flow lệch nhau. Thêm check `if (!paymentNote?.trim())` giống hệt `handleConfirmDelivery` để đồng bộ.
- [x] 14.22.2 JSX: field "Ghi chú thanh toán (tuỳ chọn)" (chỉ hiện ở flow `delivered+unpaid`) thêm điều kiện `payOption !== "actual"` — tránh hiện song song với "Lý do thu thiếu / thu khác *" khi actual đã chọn (2 field cùng bind `paymentNote` → trùng lặp UI).
- [x] 14.22.3 Display "paid": khi `actual_amount_paid < shipping_fee` (trả thiếu — đã chốt), tra thêm `payments` state (đã fetch qua `fetchData()`) tìm `payments.find(p => p.bill_id === selectedBill.id)` lấy `note` gốc lúc thu tiền, hiển thị dòng phụ "Lý do: {note}" ngay dưới dòng trạng thái thanh toán.
- [x] 14.22.4 Build check pass.

### 14.23 Fix tiếp: field "Số tiền thực thu" vẫn hiện sau khi chốt + "Lý do" nên dùng field thay vì caption nhỏ

Vấn đề (verbatim, theo screenshot): sau khi xác nhận xong (bill đã "paid — trả thiếu"), field "Số tiền thực thu *" và "Lý do thu thiếu / thu khác *" (rỗng) vẫn còn hiện phía dưới dòng trạng thái. Lý do gốc lại chỉ hiện bằng dòng chữ nhỏ ("Lý do: ...") thay vì field giống các field khác trong form.

- [x] 14.23.1 Root cause: `payOption` (state) không được reset về `""` sau khi `handleConfirmDelivery`/`handleConfirmPayment` chạy xong — chỉ có `actualAmountPaid`/`paymentNote` được reset. Vì `selectedBill.id` không đổi (chỉ data refresh), effect sync form (`[selectedBill?.id]`) không chạy lại nên `payOption` giữ nguyên `"actual"` từ trước → khối `{payOption === "actual" && (...)}` vẫn render 2 input rỗng dù bill đã "paid".
- [x] 14.23.2 Fix 2 lớp: (a) thêm `setPayOption("")` vào cả 2 handler ngay sau khi refetch `fresh` bill thành công (đồng bộ với reset `actualAmountPaid`/`paymentNote`); (b) phòng thủ thêm điều kiện `selectedBill.payment_status !== "paid"` vào JSX render `{payOption === "actual" && ... }` — dù `payOption` có lỡ chưa kịp reset thì field cũng không hiện khi bill đã paid.
- [x] 14.23.3 Đổi cách hiển thị lý do gốc: bỏ caption nhỏ "Lý do: ...", thay bằng 1 field `<input disabled readOnly>` với label "Lý do thu thiếu / thu khác" — style giống hệt field nhập lúc chưa chốt (border, padding, cùng vị trí) để nhất quán UI, chỉ hiện khi có `note` từ `payments` state.
- [x] 14.23.4 Build check pass.

### 14.24 Fix bug thu thừa (actual_amount_paid > shipping_fee) bị hiện sai thành "Đã thanh toán đủ"

Vấn đề (verbatim): Cước 80k nhưng số tiền trả thực tế là 100k (thu THỪA, không phải thiếu). Sau khi save, mục Trạng thái thanh toán hiện sai thành "Thanh toán đủ cước 80.000đ" thay vì hiện số tiền thực thu 100k + lý do. Bill mẫu: `06SGA01`. Audit log (BillHistorySection) vẫn ghi đúng số tiền/lý do — chỉ riêng phần hiển thị "Trạng thái thanh toán" bị sai.

- [x] 14.24.1 Root cause: điều kiện `isFullPaid` ở §14.21/§14.22 dùng so sánh `actual_amount_paid >= shipping_fee` — nên trường hợp thu THỪA (actual > fee) bị coi nhầm là "đủ cước" giống hệt trường hợp thu đúng bằng fee, làm mất thông tin số tiền thực thu + lý do.
- [x] 14.24.2 Fix: đổi `isFullPaid` sang so sánh CHÍNH XÁC `actual_amount_paid === shipping_fee` (chỉ true khi khớp tuyệt đối). Đồng bộ điều kiện hiện field "Lý do thu thiếu / thu khác" (readonly) từ `actual_amount_paid < shipping_fee` → `actual_amount_paid !== shipping_fee` để cover cả 2 chiều (thiếu VÀ thừa).
- [x] 14.24.3 Build check pass.

### 14.25 Modal "Chi Tiết Doanh Thu" — bỏ cột Ghi chú, thêm summary theo người thu

Vấn đề: User yêu cầu bỏ cột "Ghi chú" trong bảng chi tiết doanh thu; thêm summary bên dưới dòng "Tổng cộng: X lần thu" — theo từng người thu, tổng cộng thu bao nhiêu trong kỳ đang xem.

- [x] 14.25.1 Thêm `useMemo` `collectorSummary` (dựa trên `paidPaymentsInRange` đã có sẵn) — group theo `collected_by`, mỗi entry gồm `name` (full_name/username), `count` (số lần thu), `total` (tổng tiền), sort giảm dần theo `total`.
- [x] 14.25.2 Render 1 block ngay dưới dòng "Tổng cộng" trong modal `showRevenueDetail`: mỗi người thu 1 "chip" hiển thị tên + số lần + tổng tiền.
- [x] 14.25.3 Xoá cột "Ghi chú" (`<th>`/`<td>` + colSpan 8→7) khỏi bảng chi tiết từng lượt thu.
- [x] 14.25.4 Build check pass.

### 14.26 Modal "Chi Tiết Doanh Thu" — bỏ cột Ngày thu, ghi rõ tên chi nhánh, in đậm ngày

- [x] 14.26.1 Header modal: đổi `revenueTab` ("SG"/"GL") → tên đầy đủ ("Sài Gòn"/"Gia Lai"); bọc giá trị ngày/tháng/năm đang lọc trong `<span className="font-bold">` để in đậm.
- [x] 14.26.2 Xoá cột "Ngày thu" (`<th>`/`<td>` dùng `toVNDate(pay.created_at)`) khỏi bảng chi tiết — colSpan 7→6 cho hàng "Không có lượt thu tiền nào".
- [x] 14.26.3 Build check pass.
- [x] 14.26.4 (Follow-up) Ngày/tháng đang lọc ở header hiển thị nguyên dạng ISO (`yyyy-mm-dd`/`yyyy-mm`) — đổi sang định dạng VN: `revenueDate.split("-").reverse().join("/")` → `dd/mm/yyyy`; `revenueMonth` tương tự → `mm/yyyy`. Năm giữ nguyên (không cần đổi format).
- [x] 14.26.5 Build check pass.

### 14.27 Tổng Hợp Đơn Hàng — thêm cột "Số Tiền Thu"

- [x] 14.27.1 Thêm cột `<th>Số Tiền Thu</th>` ngay sau "Giá Cước"; `<td>` hiển thị `formatVND(bill.actual_amount_paid || 0)` (field cache có sẵn trên `bills`, được cập nhật qua `refreshBillActualPaid` mỗi lần thu tiền) — hiện "—" nếu đơn miễn phí/báo giá sau (không áp dụng khái niệm "đã thu").
- [x] 14.27.2 Cập nhật colSpan hàng rỗng "Không có đơn nào khớp với bộ lọc" từ 8 → 9.
- [x] 14.27.3 Build check pass.
- [x] 14.27.4 (Fix) Đơn chưa thu tiền hiện "0 đ" gây rối mắt — đổi điều kiện: `!Number(bill.actual_amount_paid)` (0/null/undefined) cũng hiện "—" giống free/quote_later, chỉ hiện số tiền khi thực sự > 0.
- [x] 14.27.5 Build check pass.

### 14.28 Màn Doanh Thu — ẩn section "So sánh kỳ trước"

- [x] 14.28.1 Bỏ hẳn card "So với {kỳ trước}: Doanh thu kỳ trước ... ▲/▼ ...%" (Revamp §20.2) khỏi màn Doanh Thu — giữ nguyên phần breakdown table theo ngày/tháng bên dưới. `prevPeriodRevenue`/`prevPeriodLabel` trong `useMemo` vẫn tính (không dùng tới nữa) nhưng không ảnh hưởng build.
- [x] 14.28.2 Build check pass.

### 14.29 Boss — ẩn audit log ở bill/doanh thu/khách hàng

Vấn đề: Boss (view-only) không nên thấy phần lịch sử audit chi tiết (ai thu tiền, ai sửa gì) ở 3 nơi: chi tiết đơn hàng, màn Doanh Thu, quản lý khách hàng.

- [x] 14.29.1 `BillHistorySection.jsx`: mở rộng guard `userRole === "member"` → `userRole === "member" || userRole === "boss"` (cả effect fetch lẫn early-return render) — áp dụng cho `BillHistorySection` dùng chung ở chi tiết bill.
- [x] 14.29.2 `ClientHistorySection.jsx`: guard tương tự (member || boss) — dù boss hiện đã không mở được form sửa khách (§14.20.7) nên component này thực tế không render cho boss, nhưng thêm guard cho nhất quán/phòng thủ.
- [x] 14.29.3 App.jsx màn Doanh Thu: bọc `<ExpenseHistorySection>` (audit phiếu chi theo kỳ, §14.19) trong `{userRole !== "boss" && (...)}`; đồng thời chặn luôn `useEffect` fetch `expensePeriodAudit` khi `userRole === "boss"` (tránh gọi API thừa cho role không xem được).
- [x] 14.29.4 Build check pass.

### 14.30 Boss — landing screen mặc định = Quản Lý Doanh Thu

- [x] 14.30.1 `handleLoginSuccess`: thêm nhánh `sess.role === "boss"` → `setCurrentScreen("revenue")` (trước đây boss rơi vào nhánh else chung → "bills", dù sidebar đã ẩn nav đó).
- [x] 14.30.2 Initial state `currentTab`: đổi từ hardcode `"bills"` sang function initializer đọc lại `hc_session` trong localStorage (giống pattern initializer của `session`) — `sys_admin` → "sys-admin", `boss` → "revenue", còn lại → "bills". Đảm bảo F5/refresh trang (session khôi phục, không qua `handleLoginSuccess`) vẫn landing đúng màn cho boss.
- [x] 14.30.3 Build check pass.

### 14.31 Sidebar — bỏ badge role, chỉ hiện tên (security-by-obscurity)

Vấn đề: User lo ngại badge role (ADMIN/BOSS/MEMBER/SYS_ADMIN) hiện công khai trên sidebar cho chính user đó thấy — kẻ tấn công chiếm được 1 tài khoản thấp quyền có thể dễ dàng biết được các role tồn tại trong hệ thống để nhắm mục tiêu tấn công tiếp theo.

- [x] 14.31.1 Xoá hẳn `<span className="bg-orange-600 ... uppercase">{userRole}</span>` (badge role) khỏi khối "👤 Đang đăng nhập" trên sidebar — chỉ còn hiện `userFullname`. Không đụng tới các nơi khác hiển thị role cho mục đích quản trị nội bộ (VD: SysAdminPanel danh sách user — chỉ sys_admin xem được, không phải lỗ hổng lộ role ra ngoài).
- [x] 14.31.2 Build check pass.

### 14.32 Modal xác nhận xuất bến — bỏ phần giải thích dài, chỉ giữ 2 button

- [x] 14.32.1 Xoá đoạn giải thích (`<p>Bây giờ đã qua giờ xuất bến...`), list gạch đầu dòng ("Chưa xuất bến" / "Xe đã đi rồi") và cảnh báo đỏ ("Mã đơn hàng KHÔNG sửa được...") khỏi modal `departureConfirmDialog` — giữ nguyên tiêu đề + 2 nút hành động.
- [x] 14.32.2 Đổi nhãn nút cho ngắn gọn: "💾 Xe đã đi — Lưu nháp" → "💾 Lưu nháp"; "✅ Chưa xuất bến — Tạo đơn hôm nay" → "✅ Tạo đơn cho hôm nay". Bỏ biến `branchLabel` không còn dùng.
- [x] 14.32.3 Build check pass.

### 14.33 Modal "Xác nhận Xuất Bến" (nút Xuất Bến ở màn Kho) — tương tự §14.32, bỏ message dài

- [x] 14.33.1 `handleDeparture`'s `askConfirm({...})`: xoá `message` dài (giải thích "CHỈ áp dụng cho kho X", preview mã ngày-code tăng, reset bill_seq, chuyển business_date...) — chỉ giữ `title` ("Xác nhận xuất bến — {branchLabel}") + `confirmText` ("Xuất bến"). Modal giờ chỉ còn tiêu đề + 2 nút (Hủy mặc định của `askConfirm` / Xuất bến).
- [x] 14.33.2 Component `askConfirm` dialog dùng chung: bọc phần `<div>{confirmDialog.message}</div>` trong điều kiện `{confirmDialog.message && (...)}` — tránh render 1 khối trống khi không truyền message (áp dụng chung cho mọi nơi gọi `askConfirm` không có message, không riêng xuất bến).
- [x] 14.33.3 Dọn biến `nextPreview` (tính từ `nextDayCounterText`) không còn dùng sau khi bỏ message; giữ `curSess` vì vẫn cần cho audit log `session_departure`.
- [x] 14.33.4 Build check pass.

### 14.34 Danh Sách Bốc Xếp — summary đầu trang + cột "Giao tận nơi"

- [x] 14.34.1 Refactor: gộp logic filter đơn theo branch+ngày (đang lặp lại 3 chỗ: table body, colSpan rỗng, pagination footer) thành 1 `useMemo` `warehouseFilteredBills` (deps: `bills, warehouseBranch, warehouseDate`) — tái sử dụng ở cả 3 nơi, tránh tính lại 3 lần mỗi render.
- [x] 14.34.2 Thêm `useMemo` `warehouseSummary` (dựa trên `warehouseFilteredBills`) — `totalPackages`/`totalInside`/`totalOutside` (sum `package_count`/`inside_count`/`outside_count` toàn bộ đơn đang lọc, KHÔNG chỉ trang hiện tại).
- [x] 14.34.3 Render 3 ô summary (Tổng số kiện / Kiện Trong / Kiện Ngoài) ngay trên bảng, dưới tab chi nhánh.
- [x] 14.34.4 Thêm cột "Giao tận nơi" vào bảng (giữa "Giá cước" và "Trong") — hiện badge "Có" (`is_home_delivery === true`) hoặc "—". Cập nhật colSpan hàng rỗng 9→10.
- [x] 14.34.5 Build check pass.

### 14.35 Tổng Hợp Đơn Hàng — đơn miễn phí phải hiện "Đã thanh toán" (không phải "Chưa thanh toán")

Vấn đề: Cột "Thanh Toán" ở màn Tổng Hợp Đơn Hàng chỉ so `payment_status === 'paid'`, không xét `'free'` → đơn miễn phí bị hiện sai thành badge đỏ "Chưa thanh toán".

- [x] 14.35.1 Sửa điều kiện cột "Thanh Toán": `(bill.payment_status === 'paid' || bill.payment_status === 'free')` → hiện badge xanh "Đã thanh toán"; còn lại (unpaid/quote_later) → đỏ "Chưa thanh toán".
- [x] 14.35.2 Không đổi phần hiển thị "Thanh toán" ở Chi tiết đơn hàng (`selectedBill`) — nơi đó đã tách riêng nhánh "Đơn miễn phí" (chấm tím) từ trước, không bị lỗi hiện "Chưa thanh toán" như bảng Tổng Hợp.
- [x] 14.35.3 Build check pass.

### 14.36 Màn Doanh Thu — nút « / » chuyển ngày nhanh (lọc theo Ngày)

- [x] 14.36.1 Thêm 2 nút "«"/"»" cạnh ô "Chọn ngày" (chỉ hiện khi `revenueFilterType === "day"`) — bấm « lùi 1 ngày, » tiến 1 ngày, dùng lại helper `getLocalDateString` có sẵn để tránh lệch timezone.
- [x] 14.36.2 Nút to hơn input (`px-3.5 py-2 text-lg`) để dễ bấm cho người lớn tuổi/màn hình cảm ứng.
- [x] 14.36.3 Build check pass.

### 14.37 Đơn "chưa có cước" (quote_later) — member/admin chỉ sửa được cước phí, theo rule ngày/chi nhánh đối xứng

Vấn đề (verbatim): đơn chưa có cước → member/admin có thể sửa đơn nhưng CHỈ sửa được đúng ô cước phí. Rule: bill tạo ở SG ngày 10/9 → trong ngày 10/9 chỉ user SG sửa được cước; từ 11/9 trở đi chỉ user GL (bên nhận hàng) sửa được. Đối xứng nếu bill tạo ở GL. sys_admin bypass toàn bộ rule; boss read-only tuyệt đối. Khi lưu cước → `quote_later` chuyển thành `unpaid`. GL không được "Hoàn tất giao hàng" nếu cước chưa cập nhật. Tái dùng `handleStartCreateBill`/`executeUpdateDraft` có sẵn, không viết flow mới.

- [x] 14.37.1 State mới `feeOnlyEditMode` (App.jsx) — đánh dấu đang ở chế độ "sửa cước phí only"; reset về `false` trong `resetCreateBillForm()`.
- [x] 14.37.2 Nút "✏️ Sửa Đơn" (full-edit, admin/sys_admin) bỏ `quote_later` khỏi điều kiện hiển thị — chỉ còn áp dụng cho `unpaid`/`free` như cũ.
- [x] 14.37.3 Thêm nút mới "✏️ Cập Nhật Cước Phí" — chỉ hiện khi `delivery_status === 'pending' && payment_status === 'quote_later'`, permission riêng `canEditQuoteLaterFee`: sys_admin luôn true; role khác (trừ boss) phải `session.branch_code === allowedFeeBranch`, trong đó `allowedFeeBranch` = chi nhánh tạo đơn nếu `business_date === hôm nay`, ngược lại = chi nhánh còn lại. onClick populate y hệt "Sửa Đơn" cũ nhưng thêm `setFeeOnlyEditMode(true)`, `setShippingFee("")`, `setFeeQuoteLater(false)`.
- [x] 14.37.4 Nút "🚫 Hủy Đơn" cho riêng case `quote_later` tách thành block độc lập (giữ nguyên rule cũ: admin/sys_admin + `canModify` same-branch/today) vì không còn nằm chung nhánh JSX với "Sửa Đơn" nữa.
- [x] 14.37.5 Form tạo/sửa đơn: thêm nhánh `feeOnlyEditMode` (giữa nhánh `boss` và nhánh form đầy đủ) — render `<form onSubmit={handleStartCreateBill}>` rút gọn: banner cảnh báo + tóm tắt (người gửi/nhận/mặt hàng/số kiện) read-only + duy nhất input "Cước phí vận chuyển *" + nút Hủy/Lưu. KHÔNG render field nào khác → user không thể đụng field khác dù chỉ 1 input hiển thị. Validate + `payment_status` tự chuyển `quote_later → unpaid` nhờ `feeQuoteLater=false` đã set khi populate (tái dùng nguyên `handleStartCreateBill`/`executeUpdateDraft`, không thêm hàm mới).
- [x] 14.37.6 Chặn "✅ Hoàn tất giao hàng": thêm điều kiện `feeMissing = payment_status === 'quote_later'` vào `disabled` (cùng `hasArrived`), disable + đổi tooltip khi thiếu cước; sys_admin bypass.
- [x] 14.37.7 Defense-in-depth trong `handleConfirmDelivery`: chặn sớm + toast lỗi nếu `liveBill.payment_status === 'quote_later'` (trừ sys_admin), phòng trường hợp bấm được qua nút đã disable.
- [x] 14.37.8 Xác nhận RLS: `bills_update_member` (fix-cross-branch-rls.sql) đã cho phép member UPDATE bill khác branch khi `delivery_status IN ('pending','delivered')`; `bills_update_admin` không giới hạn branch — không cần migration DB mới cho tính năng này.
- [x] 14.37.9 Build check pass.

### 14.38 Fix bug: sửa đơn (kể cả Cập Nhật Cước Phí) làm đổi "Ngày gửi" sang hôm nay

Vấn đề (verbatim): Đơn `04SGA06` tạo ngày 8/9, chưa có cước. Hôm nay 10/9 cập nhật cước + lưu → "Ngày gửi" (business_date) bị đổi thành 10/09/2026 → phá luôn rule `hasArrived` (cross-branch chỉ cho "Hoàn tất giao hàng" khi `business_date < today`) → GL không xác nhận giao được nữa.

- [x] 14.38.1 Root cause: `executeUpdateDraft` (dùng chung cho cả sửa DRAFT lẫn sửa BILL CHÍNH THỨC qua `editingBillId`) luôn gán `business_date: updateSess.business_date` (business_date của session/chuyến HIỆN TẠI) vào `updatePayload`, không phân biệt draft hay bill đã có mã chính thức. Comment gốc §5.4 chỉ định nghĩa hành vi này cho DRAFT ("nếu draft tạo hôm qua, hôm nay mở sửa → auto-move business_date") nhưng code áp dụng nhầm cho CẢ 2 trường hợp.
- [x] 14.38.2 Fix: đổi điều kiện `...(updateSess ? {business_date...} : {})` → `...(data.isDraft && updateSess ? {business_date...} : {})` — chỉ tự dịch chuyển business_date khi đang sửa DRAFT (`data.isDraft === true`); bill chính thức (`editingBillId`, `isDraft` luôn false) giữ nguyên business_date gốc khi sửa/cập nhật cước.
- [x] 14.38.3 Build check pass.
- [ ] 14.38.4 (Cần làm thủ công) Data hiện tại của bill `04SGA06` đã bị hỏng business_date (thành 10/09/2026 thay vì 08/09/2026) do bug trên — cần 1 câu UPDATE thủ công trực tiếp trên Supabase để khôi phục lại `business_date = '2026-09-08'` cho bill này (đã cung cấp câu lệnh SQL cho user chạy tay, không tạo migration file vì đây là data-fix 1 lần, không phải thay đổi schema).

### 14.39 Action bar chi tiết đơn — dời nút "+ Tạo đơn mới" ra cuối cùng

Vấn đề: Nút "+ Tạo đơn mới" đang nằm GIỮA "← Quay lại" và "✅ Hoàn tất giao hàng"/"💰 Xác nhận thanh toán", nhìn lộn xộn.

- [x] 14.39.1 Dời khối `{userRole !== "sys_admin" && userRole !== "boss" && (<button>+ Tạo đơn mới</button>)}` từ vị trí giữa Hủy Đơn và khối "Hoàn tất giao hàng/Xác nhận thanh toán" xuống SAU khối đó — thứ tự cuối cùng: Quay lại → Sửa Đơn/Cập Nhật Cước Phí/Hủy Đơn → Hoàn tất giao hàng/Xác nhận thanh toán → Tạo đơn mới.
- [x] 14.39.2 Build check pass.

### 14.40 Fix bug: "Lưu Nháp" báo lỗi NOT NULL constraint trên shipping_fee

Vấn đề (verbatim): Lỗi "Lỗi tạo đơn hàng: null value in column "shipping_fee" of relation "bills" violates not-null constraint" khi tạo đơn rồi bấm Lưu Nháp.

- [x] 14.40.1 Root cause: cả 3 hàm build payload (`executeUpdateDraft`, `executeConvertDraftToBill`, `executeCreateBill`) đều tính `shipping_fee: (isFreeShipping||feeQuoteLater) ? 0 : (shippingFee ? parseInt(shippingFee) : null)` — khi KHÔNG chọn miễn phí/báo giá sau VÀ chưa nhập cước (hợp lệ với nháp, vì `handleSaveDraft` không bắt buộc nhập cước như submit chính thức) → gửi `shipping_fee = null` lên DB, vi phạm NOT NULL constraint của cột này.
- [x] 14.40.2 Fix: đổi fallback cuối cùng từ `null` → `0` ở cả 3 chỗ — nháp chưa có cước sẽ lưu `shipping_fee = 0` (nhất quán với cách free/quote_later đã lưu `0` từ trước), không còn gửi `null` lên DB nữa.
- [x] 14.40.3 Build check pass.

### 14.41 Sắp xếp lại + đổi tên button khi sửa đơn nháp (dễ hiểu hơn)

Vấn đề: Dàn button khi mở 1 đơn nháp (Xóa Nháp/Hủy/+Tạo Đơn Mới/Cập Nhật Nháp/Xem Bill In/Hoàn Tất & Tạo Đơn) thứ tự lộn xộn, tên khó hiểu.

- [x] 14.41.1 Tách riêng 3 nhánh render action bar theo `editingDraftId` / `editingBillId` / (tạo mới) thay vì gộp chung điều kiện — tránh ảnh hưởng case sửa bill chính thức khi chỉnh sửa case nháp.
- [x] 14.41.2 Case sửa NHÁP: đổi thứ tự + tên theo yêu cầu: 🚫 "Hủy Đơn Nháp" (đổi từ "Xóa Nháp", thêm `title="Đơn nháp này sẽ bị xóa vĩnh viễn khỏi hệ thống"` để hover báo trước) → 💾 "Lưu Thay Đổi" (đổi từ "Cập Nhật Nháp") → ❌ "Hủy Thay Đổi" (đổi từ "Hủy") → 📝 "Xem Bill In" → 🚀 "Hoàn Tất Và Tạo Đơn" (submit, đổi từ "Hoàn Tất & Tạo Đơn") → "+ Tạo Đơn Mới".
- [x] 14.41.3 Case sửa BILL CHÍNH THỨC (`editingBillId`): giữ nguyên nhãn/hành vi cũ (Hủy Đơn, Hủy, Xem Bill In, Cập Nhật Đơn, Tạo Đơn Mới) — không đổi vì user chỉ yêu cầu cho case nháp.
- [x] 14.41.4 Case tạo mới (không editing): giữ 3 nút cũ (Lưu Nháp, Xem Bill In, Tạo Hoá Đơn), không đổi.
- [x] 14.41.5 Build check pass.

### 14.42 "Lưu Thay Đổi" (sửa nháp) — ở lại màn hình đang sửa, không nhảy sang tạo đơn mới

Vấn đề: Bấm "Lưu Thay Đổi" xong, app tự reset form về chế độ tạo đơn mới thay vì giữ nguyên màn hình đang sửa nháp.

- [x] 14.42.1 Root cause: `executeUpdateDraft` gọi `resetCreateBillForm()` KHÔNG ĐIỀU KIỆN sau khi lưu thành công — hàm này clear luôn `editingDraftId`, khiến UI rơi về nhánh "tạo đơn mới" của action bar (§14.41).
- [x] 14.42.2 Fix: chỉ gọi `resetCreateBillForm()` khi `!data.isDraft` (tức đang sửa BILL CHÍNH THỨC, lúc đó cần clear form vì đã chuyển sang xem `selectedBill`). Khi `data.isDraft === true` (lưu nháp) → bỏ qua reset, giữ nguyên `editingDraftId` + toàn bộ field đang sửa, chỉ hiện toast "Cập nhật nháp thành công!" (đã có sẵn).
- [x] 14.42.3 Build check pass.

### 14.43 Đơn nháp — chỉ đúng chi nhánh tạo mới được sửa/hủy/hoàn tất

Vấn đề (verbatim): đơn nháp chi nhánh nào tạo thì chỉ có user chi nhánh đó mới được sửa/hủy/chuyển thành đơn chính.

- [x] 14.43.1 UI (Tổng Hợp Đơn Hàng): thêm check ngay đầu `onClick` của hàng nháp — nếu `userRole !== 'sys_admin'` và `bill.branch?.branch_code !== session?.branch_code` → toast lỗi "Chỉ nhân viên chi nhánh {X} mới được thao tác nháp này!" và chặn không populate form/không chuyển tab. sys_admin bypass. Cập nhật `title` hover tương ứng để báo trước khi click.
- [x] 14.43.2 RLS defense-in-depth: `bills_update_member` (fix-cross-branch-rls.sql) đã chặn member cross-branch cho draft từ trước, nhưng `bills_update_admin` KHÔNG có ràng buộc branch nào — admin chi nhánh khác vẫn UPDATE được nháp qua DB trực tiếp (bypass UI). Tạo migration mới `fix-draft-branch-restriction.sql`: `bills_update_admin` thêm điều kiện `delivery_status <> 'draft' OR branch_id = current_branch_id()` — admin chỉ bị giới hạn branch khi đối tượng là DRAFT; pending/delivered/cancelled giữ nguyên quyền cross-branch cũ. sys_admin không bị ảnh hưởng (luôn pass).
- [x] 14.43.3 Build check pass.
- [ ] 14.43.4 (Cần chạy tay) User cần chạy `fix-draft-branch-restriction.sql` trên Supabase SQL Editor để áp dụng RLS policy mới (không tự động deploy qua code).

### 14.44 Danh Sách Bốc Xếp — sắp xếp mã đơn tăng dần + cột "Hàng Ghép"

Vấn đề (verbatim): "bảng danh sách bốc xếp, sửa 2 chỗ: 1. thứ tự mã đơn từ nhỏ -> lớn 2. thêm 1 cột 'Hàng Ghép', nằm sau cột vị trí trong ngoài các ô để trống để nhân viên tự điền".

Rule nghiệp vụ:
- Mã đơn trong bảng bốc xếp sắp xếp tăng dần (nhỏ → lớn).
- Cột "Hàng Ghép" nằm sau cột Trong/Ngoài, ô trống để nhân viên tự điền (free text), ô vừa đủ ~5 ký tự (VD HC001), trống thì để trống (không hiện dấu "-").
- Chỉ nhân viên đúng chi nhánh mới điền được (giống Trong/Ngoài); boss không sửa.

Implementation:
- [x] 14.44.1 [src/App.jsx](../../../src/App.jsx) — `warehouseFilteredBills` thêm `.sort((a,b)=>(a.bill_code||"zzzz").localeCompare(b.bill_code||"zzzz"))`; `handlePrintWarehouseList` cũng sort tương tự.
- [x] 14.44.2 [src/App.jsx](../../../src/App.jsx) — thêm `<th>Hàng Ghép</th>` sau cột Ngoài (màn hình + bản in), cập nhật colSpan empty-state 10→11.
- [x] 14.44.3 [src/App.jsx](../../../src/App.jsx) — `handleCombinedGoodsSave(billId, value)`: UPDATE `bills.combined_goods` (trim → null nếu rỗng), chặn boss + cross-branch, cập nhật `setBills` tại chỗ sau khi lưu.
- [x] 14.44.4 [add-combined-goods.sql](../../../add-combined-goods.sql) — `ALTER TABLE public.bills ADD COLUMN IF NOT EXISTS combined_goods TEXT;` (idempotent). **Cần chạy tay trên Supabase.**
- [x] 14.44.5 Build check pass.

### 14.45 Fix bug mất ký tự khi gõ ô "Hàng Ghép" và các ô "Số tiền"

Vấn đề (verbatim): "ô hàng ghép... nó hay có hiện tượng mất chữ, phải nhập lại"; "ở phiếu chi, field số tiền nhiều khi nhập ko ăn, phải nhập lại".

Nguyên nhân: input controlled lấy value từ state toàn App (~7000 dòng). Mỗi keystroke `setBills`/format lại → re-render toàn bộ + realtime refetch (debounce 800ms) ghi đè `bills` giữa lúc gõ → con trỏ nhảy / rớt ký tự. Ô số tiền còn bị format ngàn (`1.000`) làm nhảy cursor.

Implementation:
- [x] 14.45.1 [src/App.jsx](../../../src/App.jsx) — tách component `CombinedGoodsInput`: state cục bộ (`text`), chỉ sync từ prop khi KHÔNG focus (`focusedRef`), lưu DB `onBlur`. Realtime refetch không ghi đè lúc đang gõ.
- [x] 14.45.2 [src/App.jsx](../../../src/App.jsx) — tách component `MoneyInput` dùng chung: state cục bộ giữ chuỗi đã format ngàn, báo giá trị số ra ngoài qua `onChange`; sync từ prop khi không focus → hết nhảy con trỏ / rớt ký tự.
- [x] 14.45.3 [src/App.jsx](../../../src/App.jsx) — áp dụng `MoneyInput` cho 3 ô: Thêm phiếu chi (`expAmount`), Sửa phiếu chi (`expEditAmount`), Số tiền thực thu khi thanh toán (`actualAmountPaid`).
- [x] 14.45.4 Build check pass.

### 14.46 Sys Admin — đổi username cho user (bỏ tiền tố lộ role)

Vấn đề (verbatim): "trong username có cả role. hacker có thể dựa vào đây để đoán dc các role của hệ thống" → muốn đổi username toàn bộ user; "sys_admin cho đổi username, password luôn đi".

Rule nghiệp vụ:
- Username gắn chặt với email đăng nhập `username@hoancau.internal` → đổi username PHẢI đổi đồng thời: `auth.users.email` + `user_metadata.username` + `profiles.username`. Chỉ đổi 1 nơi → user không login được.
- Thứ tự: cập nhật auth TRƯỚC, profiles SAU → nếu lỗi giữa chừng user vẫn login được bằng username cũ (không bị kẹt).
- Mật khẩu giữ nguyên khi đổi username. Kiểm tra trùng tên + định dạng `[a-z0-9_.-]`.

Implementation:
- [x] 14.46.1 [supabase/functions/admin-users/index.ts](../../../supabase/functions/admin-users/index.ts) — `actionUpdateProfile` nhận thêm `username`: validate regex + check trùng (`profiles` khác id), update auth email + metadata TRƯỚC (email `newUsername@hoancau.internal`), rồi `profiles.username`; ghi vào `changes`.
- [x] 14.46.2 [src/SysAdminPanel.jsx](../../../src/SysAdminPanel.jsx) — `EditProfileModal`: ô Username từ read-only → sửa được, thêm vào form state + gửi kèm `update_profile`. Password reset đã có sẵn ở nút 🔑 (action `reset_password`).
- [x] 14.46.3 Deploy `npx supabase functions deploy admin-users --no-verify-jwt` (đã chạy — bản cũ bỏ qua field username nên "save thành công" nhưng không đổi).
- [x] 14.46.4 Build check pass.

### 14.47 Script đổi username hàng loạt (one-off)

Vấn đề: cần đổi username cho toàn bộ user hiện có (bỏ tiền tố `mem_`/`ad_`/`boss_`).

Implementation:
- [x] 14.47.1 [scripts/rename-users.mjs](../../../scripts/rename-users.mjs) — đọc map `scripts/rename-users.map.json` (tên_cũ → tên_mới), dùng service_role: validate + check trùng, `auth.admin.updateUserById({email, user_metadata})` rồi `profiles.username`. Hỗ trợ `--dry-run`.
- [x] 14.47.2 [scripts/rename-users.map.example.json](../../../scripts/rename-users.map.example.json) — file mẫu ánh xạ. User copy → `rename-users.map.json` rồi sửa.
- [x] 14.47.3 Lưu ý: dữ liệu lịch sử cũ (`audit_log.username`, `*_snapshot`) giữ tên cũ — không ảnh hưởng đăng nhập.

### 14.48 Tạo đơn — đơn giao tận nơi bắt buộc thanh toán trước

Vấn đề (verbatim): "ở flow tạo đơn hàng, thêm 1 rule là: đối với đơn giao tận nơi bắt buộc thanh toán trước."
Chỉnh (verbatim): "ko dc tự động tick thanh toán đâu, lỡ user quên thì sao. chuyển field đã thanh toán thành required thôi, nếu chọn giao tận nơi mà k chọn đã thanh toán thì báo lỗi."

Rule nghiệp vụ:
- Đơn có tích "Có giao tận nơi" → "Đã thanh toán" trở thành **required**. KHÔNG auto-tick (tránh user quên mà vẫn tạo được) — bắt user tự tích.
- Nếu giao tận nơi mà chưa tích "Đã thanh toán" → báo lỗi, chặn tạo đơn.
- Ngoại lệ: đơn **miễn phí** (không có gì để thu) → coi như thỏa, cho tạo.
- Đơn **báo giá cước sau** (chưa biết cước, không thu được) → không cho kết hợp; phải bỏ "Báo giá cước sau" để nhập cước và thu tiền.

Implementation:
- [x] 14.48.1 [src/App.jsx](../../../src/App.jsx) — `handleStartCreateBill`: validate `isHomeDelivery && !isPaidImmediately && !isFreeShipping` → toast chặn; nếu `feeQuoteLater` thì gợi ý bỏ "Báo giá cước sau".
- [x] 14.48.2 [src/App.jsx](../../../src/App.jsx) — label "Đã thanh toán" hiện dấu `*` khi đang giao tận nơi (không miễn phí/báo giá sau) để báo bắt buộc; KHÔNG auto-tick, KHÔNG khóa — user tự tích.
- [x] 14.48.3 Build check pass.

### 14.49 Danh Sách Bốc Xếp — hover "Có" (giao tận nơi) hiện địa chỉ giao

Vấn đề (verbatim): "ở screen bốc xếp, khi đơn giao tận nơi, hover chuột vào chữ Có thì hiện địa chỉ giao hàng lên".

Implementation:
- [x] 14.49.1 [src/App.jsx](../../../src/App.jsx) — cột "Giao tận nơi" trong bảng bốc xếp: badge "Có" thêm `title={bill.delivery_address ? 'Địa chỉ giao: ...' : 'Chưa có địa chỉ giao'}` + `cursor-help`.
- [x] 14.49.2 Build check pass.

### 14.50 Bốc Xếp — tooltip địa chỉ giao hiện NGAY khi hover (bỏ delay ~1s của title)

Vấn đề (verbatim): "hover vào chữ Có, khoảng 1s sau nó mới hiện địa chỉ á, có cách nào hover vào là hiện liền ko?"

Nguyên nhân: thuộc tính `title` dùng tooltip mặc định của trình duyệt, có độ trễ ~1s không tùy chỉnh được.

Implementation:
- [x] 14.50.1 [src/App.jsx](../../../src/App.jsx) — thêm component `HoverTooltip`: `onMouseEnter` tính rect + render tooltip qua `createPortal` (fixed position, zIndex 9999) → hiện ngay, không bị bảng `overflow` cắt.
- [x] 14.50.2 [src/App.jsx](../../../src/App.jsx) — thay badge "Có" dùng `title` sang bọc `HoverTooltip` với nội dung địa chỉ giao.
- [x] 14.50.3 Build check pass.

### 14.51 Tạo đơn sau 16:30 — thay "Lưu nháp" bằng "Tạo đơn cho ngày mai" (popup 2 bước)

Vấn đề (verbatim): "t muốn đổi rule, ko lưu nháp nữa mà thay bằng button tạo đơn cho ngày mai. khi chọn button đó thì hiện thêm 1 popup confirm xác nhận xe đã xuất bến chưa, nếu rồi thì tạo đơn cho ngày mai. chưa thì đóng popup xác nhận xuất bến, và quay lại popup xác nhận tạo đơn cho hôm nay hoặc ngày mai, để user check lại."

Rule nghiệp vụ (thay cho 14.48-cũ / rule nháp sau cutoff):
- Sau 16:30 (giờ VN) + chưa xuất bến + không phải sys_admin → popup **bước 1**: "Tạo đơn cho chuyến nào?" với 2 nút: **Tạo đơn hôm nay** / **Tạo đơn ngày mai**. (Bỏ hẳn nút "Lưu nháp".)
- "Tạo đơn hôm nay" → tạo đơn chính thức cho chuyến hôm nay (như cũ).
- "Tạo đơn ngày mai" → popup **bước 2**: "Xe kho {branch} đã xuất bến chưa?":
  - **Rồi** → chốt chuyến hôm nay (advance session = Xuất Bến) rồi tạo đơn cho chuyến mai (mã + business_date của chuyến mới).
  - **Chưa** → đóng bước 2, **quay lại bước 1** để user chọn lại.
- Nếu đã xuất bến sẵn (business_date > hôm nay) → không hỏi, tạo thẳng cho chuyến mai (như cũ). sys_admin vẫn bypass.

Implementation:
- [x] 14.51.1 [src/App.jsx](../../../src/App.jsx) — `executeCreateBill(data, opts)` + `executeConvertDraftToBill(draftId, data, opts)` nhận `opts.ignoreReservedCode`: khi tạo cho chuyến mai, bỏ qua mã đã reserve của hôm nay, build mã từ session mới (sau advance).
- [x] 14.51.2 [src/App.jsx](../../../src/App.jsx) — thay `handleDepartureConfirmSaveDraft` bằng `handleDepartureCreateTomorrow`: nếu chưa xuất bến thì `advanceBranchSession` (+ log `session_departure`), rồi gọi create/convert với `ignoreReservedCode:true`.
- [x] 14.51.3 [src/App.jsx](../../../src/App.jsx) — `departureConfirmDialog` thêm field `stage` ("choice" | "confirm"); 2 chỗ mở popup set `stage:"choice"`.
- [x] 14.51.4 [src/App.jsx](../../../src/App.jsx) — viết lại modal 2 bước: choice (hôm nay / ngày mai) ↔ confirm (đã xuất bến chưa, nút "Chưa" quay lại choice).
- [x] 14.51.5 Build check pass.

