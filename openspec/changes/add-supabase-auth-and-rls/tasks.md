# Tasks: add-supabase-auth-and-rls

> Deadline: ~2 tuần. Data test đã wipe (cleanup SQL đã chạy 2026-08-17). Không cần backup phức tạp, không migrate legacy user.

## 1. Cleanup (đã xong)

- [x] 1.1 Chạy cleanup SQL trên Supabase (TRUNCATE + DROP users + DROP monthly_revenue + xoá auth.users test)
- [x] 1.2 Verify DB còn schema + 2 row `branches` (SG, GL)

## 2. SQL migration `add-supabase-auth-and-rls.sql`

- [x] 2.1 Section A — branches: `ALTER COLUMN id SET DEFAULT gen_random_uuid()`, UNIQUE INDEX trên `branch_code`, seed `('SG'), ('GL')` idempotent
- [x] 2.2 Section B — bảng `public.profiles` (id FK auth.users ON DELETE CASCADE, CHECK role, UNIQUE username, FK branches)
- [x] 2.3 Section C — trigger `on_auth_user_created` (SECURITY DEFINER, đọc `raw_user_meta_data`, INSERT profiles ON CONFLICT DO NOTHING)
- [x] 2.4 Section D — helper functions `current_role()`, `current_branch_id()` (SECURITY DEFINER, STABLE, SET search_path = public)
- [x] 2.5 Section E — FK re-add cho `audit_log.user_id`, `bills.created_by/delivered_by`, `bill_payment_details.collected_by`, `expenses.created_by/updated_by/deleted_by` (DO block idempotent, ON DELETE SET NULL)
- [x] 2.6 Section F — ENABLE RLS cho 9 bảng (profiles, branches, clients, client_phones, bills, bill_payment_details, expenses, branch_sessions, audit_log)
- [x] 2.7 Section G — DROP permissive policies cũ từ `add-branch-sessions.sql` + `add-audit-log-table.sql`
- [x] 2.8 Section H — policy `profiles`: SELECT self+admin/boss, UPDATE admin all + self (không được đổi role/branch/username), INSERT/DELETE deny
- [x] 2.9 Section I — policy `branches`: SELECT all authenticated, ALL admin
- [x] 2.10 Section J — policy `clients` + `client_phones`: SELECT all, INSERT admin+member, UPDATE admin, DELETE deny
- [x] 2.11 Section K — policy `bills`: SELECT theo role/branch, INSERT theo role+branch check, UPDATE admin all + member draft branch mình, DELETE deny all
- [x] 2.12 Section L — policy `bill_payment_details`: JOIN bills check branch, INSERT theo bill's branch, UPDATE admin, DELETE deny
- [x] 2.13 Section M — policy `expenses`: SELECT/INSERT theo role+branch, UPDATE admin all + member own+today, DELETE deny
- [x] 2.14 Section N — policy `branch_sessions`: SELECT all, INSERT admin, UPDATE admin all + member branch mình, DELETE deny
- [x] 2.15 Section O — policy `audit_log`: SELECT admin/boss, INSERT any authenticated, UPDATE/DELETE deny
- [x] 2.16 Comment `-- ROLLBACK` cuối file với DROP FUNCTION + DISABLE RLS statements
- [x] 2.17 Bọc toàn bộ trong `BEGIN...COMMIT` để atomic

## 3. Frontend code

- [x] 3.1 `src/LoginScreen.jsx` — rewrite `handleSubmit`: ghép email `<username>@hoancau.internal`, gọi `supabase.auth.signInWithPassword`, fetch profile qua RLS SELECT, trả session shape cũ lên App
- [x] 3.2 `src/App.jsx` — thêm `useEffect` sync với `supabase.auth.getSession()` on mount + subscribe `SIGNED_OUT` để clear cache
- [x] 3.3 `src/App.jsx` — `handleLogout` gọi `supabase.auth.signOut()` trước khi clear cache
- [x] 3.4 `src/App.jsx` — rewrite `handleConfirmCancelBill`: bỏ nhánh `if draft` hard-delete, thống nhất soft-cancel cho cả draft lẫn pending; refund flow chỉ chạy cho non-draft
- [x] 3.5 Giữ `localStorage['hc_session']` như client-side cache (source of truth = Auth JWT) để tránh sửa `auditLog.js` và các chỗ đọc `session.id/role/branch_id` trong App
- [x] 3.6 `npm run build` verify không error

## 4. Helper script

- [x] 4.1 `scripts/add-user.mjs` — parse CLI args, validate role/branch/username/password/fullname, resolve branch_id từ branch_code, gọi `supabase.auth.admin.createUser` với metadata, verify profile row được trigger tạo
- [x] 4.2 `scripts/.env.migration.local.example` — template có comment cảnh báo service_role key (matches `*.local` trong `.gitignore`)

## 5. Anh apply — production

Anh làm tuần tự:

- [ ] 5.1 Vào Supabase Dashboard → **SQL Editor** → New Query → paste toàn bộ `add-supabase-auth-and-rls.sql` → Run. Nếu error → gửi t xem, sửa. Nếu OK → chạy 3 query verify cuối file (RLS enabled, policy count, branches).
- [ ] 5.2 Vào **Supabase Dashboard → Authentication → Providers → Email** → tắt "Confirm email" (email `@hoancau.internal` không thật, không nhận được confirm).
- [ ] 5.3 Copy `scripts/.env.migration.local.example` → `scripts/.env.migration.local`. Vào **Supabase Dashboard → Settings → API** → copy Project URL + service_role secret, dán vào file `.env.migration.local`.
- [ ] 5.4 Chạy `node scripts/add-user.mjs --help` để verify script chạy được.
- [ ] 5.5 Tạo admin đầu tiên (chính anh):
  ```
  node scripts/add-user.mjs --username <username_anh> --password <mật_khẩu_mạnh> --role admin --branch SG --fullname "<Họ Tên Anh>"
  ```
- [ ] 5.6 Tạo các user khác (member SG, member GL, boss...) với password đủ mạnh (>=8 ký tự, có chữ + số).
- [ ] 5.7 Deploy Vite build mới lên hosting (`npm run build` → upload `dist/`).
- [ ] 5.8 Login test:
  - Admin: login → tạo bill test → soft-cancel bill test → logout. Verify audit_log có 2 row (bill_create + bill_cancel).
  - Member SG: login → tạo bill → thấy bill của mình → không thấy bill GL nếu member khác tạo → soft-cancel bill của mình.
  - Boss: login → xem được list bill → thử bấm Sửa (nếu UI cho) → verify UPDATE bị RLS deny (check Network tab).
- [ ] 5.9 DevTools attack test:
  - Logout, mở Console, chạy `await supabase.from('bills').select('*')` → trả về `[]` (RLS deny anon).
  - Login member SG, chạy `await supabase.from('bills').delete().eq('id', '<any-uuid>')` → RLS error.

## 6. Post go-live (defer, không blocker)

- [ ] 6.1 Bật **Leaked Password Protection** trên Supabase Auth (Dashboard → Auth → Policies → Enable)
- [ ] 6.2 Rotate anon key (Dashboard → Settings → API → Rotate) — chỉ khi cần (anon key có thể public an toàn vì RLS đã enforce thật)
- [ ] 6.3 Nghiên cứu bật MFA cho admin (nếu có yêu cầu)
- [ ] 6.4 Chuyển sang email thật của nhân viên (khi cần forgot-password flow)

## 7. Archive change

- [ ] 7.1 Sau khi anh apply xong và app chạy ổn định vài ngày → archive change vào `openspec/changes/archive/`
- [ ] 7.2 Sync delta specs (authentication-and-roles, shipment-intake) vào main specs
