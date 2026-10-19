# Design: Add Supabase Auth + real RLS

## Context

App Hoàn Cầu hiện dùng **custom auth** (bảng `public.users` + plaintext compare trong `LoginScreen.jsx`) và **không có RLS** trên 7/8 bảng public. App là SPA React + Vite gọi thẳng Supabase từ browser bằng **anon key** (public, đã embed trong bundle).

Đến 09/2026 app go-live với data thật của khách hàng chành xe (số điện thoại, địa chỉ, giá trị hàng, doanh thu). Nếu để nguyên security posture hiện tại thì bất kỳ ai đọc bundle JS đều có thể:
- Đọc mật khẩu plaintext của toàn bộ nhân viên (`SELECT * FROM users`).
- Đọc/sửa/xóa toàn bộ dữ liệu 7 bảng còn lại.
- Đọc dữ liệu khách hàng thật (PII).

**Stakeholders**: anh (owner + dev + admin), nhân viên SG/GL (member), CEO (boss). Không có team ops, không có SRE.

**Ràng buộc**:
- 2 tuần deadline → không refactor UI, không viết test suite mới.
- Không có Node backend → mọi auth/authorization phải do Supabase (Auth + RLS) đảm nhiệm.
- Không muốn user quản lý mật khẩu qua UI (anh sẽ tự set + reset qua DB/dashboard).
- Không muốn forgot-password / email flow (email `<username>@hoancau.internal` không tồn tại thật).
- Nhân viên hiện có ~ vài người (đủ nhỏ để migrate 1 lần thủ công).

## Goals / Non-Goals

**Goals:**
1. Bảo mật `password_hash`: attacker có anon key **không thể** đọc được password của bất kỳ user nào.
2. Bảo mật dữ liệu bảng operational: attacker chưa login **không thể** đọc/ghi. User đã login chỉ thấy dữ liệu mà role/branch của họ được phép.
3. `boss` = read-only ở tầng DB — kể cả JWT của boss bị compromise cũng không phá dữ liệu được.
4. Migrate user hiện có **không cần đổi mật khẩu**.
5. Không breaking UX cho nhân viên: vẫn login bằng username + password, vẫn thấy đúng các tab cũ.
6. Fit trong 2 tuần dev + smoke test.

**Non-Goals:**
- MFA / 2FA cho admin (defer sau go-live).
- Forgot-password flow, email verification, self-service reset.
- UI admin quản lý user trong app (admin sẽ SQL trực tiếp hoặc dùng Supabase dashboard).
- Rotate anon key (nice-to-have, không blocker vì RLS chính là hàng rào thật).
- Refactor `App.jsx` thành nhiều file, thêm TypeScript, thêm test suite.
- Phân quyền tinh hơn per-column (vd giấu `goods_value` với member) — không có yêu cầu.
- Phân quyền cross-branch giữa SG và GL cho `clients` (khách hàng là chia sẻ 2 branch, xem Decision D3).

## Decisions

### D1. Auth = Supabase Auth với email nội bộ `<username>@hoancau.internal`

**Chọn**: `supabase.auth.signInWithPassword` với email được ghép từ username.

**Alternatives:**
- **A. Custom RPC `verify_login(username, password)` + JWT tự phát**: viết SQL function trả về JWT thủ công. → Bỏ vì tự sign JWT phức tạp, dễ sai, không tận dụng được refresh token của Supabase.
- **B. Supabase Auth với email thật của nhân viên**: cần verify email thật, cần flow forgot-password. → Bỏ vì anh yêu cầu không email flow. Có thể chuyển sau go-live nếu cần.
- **C. Chọn (đã dùng)**: `<username>@hoancau.internal` là email giả, Supabase Auth chấp nhận mà không verify domain (bật setting "Enable email confirmations = false" trên dashboard). User vẫn nhập username ở UI, LoginScreen tự ghép `@hoancau.internal` trước khi gọi Auth.

**Lý do**: đơn giản nhất, tận dụng full Auth stack (bcrypt, JWT, refresh token, rate limiting), migrate được data cũ, có đường thoát khi cần chuyển sang email thật.

### D2. Bỏ `public.users`, thêm `public.profiles` REFERENCES `auth.users(id)`

**Chọn**: 1-1 relationship, `profiles.id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`.

**Alternatives:**
- **A. Giữ `public.users` với `user_id UUID REFERENCES auth.users(id)`**: thêm cột mới, drop `password_hash`. → Vẫn được nhưng dễ sinh ambiguity `users.id` vs `users.user_id`. Đổi thành `profiles` cho rõ ràng.
- **B. Chọn (đã dùng)**: rename thành `profiles`, `id = auth.users.id`.

**Đồng thời rename foreign key**: các bảng đang REFERENCES `users(id)` (như `audit_log.user_id`, `bill_payment_details.collected_by`, `bills.created_by`, ...) — vẫn UUID, giá trị mới = `auth.users.id` mới. Migration script phải cập nhật FK constraint (drop cũ, tạo mới trỏ `profiles(id)`).

**Trigger auto-create profile**: khi INSERT vào `auth.users` (qua admin API), 1 trigger `after_auth_user_created` phải INSERT row tương ứng vào `profiles` (username lấy từ `raw_user_meta_data->>'username'`, role/branch_id lấy từ metadata). Điều này giúp admin tạo user mới bằng SQL đơn 1 statement gọi `supabase.auth.admin.createUser(...)` với metadata.

### D3. RLS policy: `clients`, `client_phones` không lọc theo branch

**Chọn**: cả 2 branch cùng thấy toàn bộ khách hàng.

**Lý do nghiệp vụ**: khách hàng gửi từ SG → GL và ngược lại. 1 khách có thể được cả 2 branch nhập. Trong spec `customer-management` hiện tại KHÔNG có yêu cầu chia branch.

**Trade-off**: member SG có thể thấy danh sách khách đã từng gửi ở GL. → Chấp nhận vì đây là dữ liệu shared operational, không phải PII sensitive kiểu tài chính.

### D4. `boss` = zero write policy

**Chọn**: KHÔNG viết bất kỳ INSERT/UPDATE/DELETE policy nào FOR `boss` trên bảng operational.

**Alternatives:**
- **A. Cho boss UPDATE nhưng gate ở UI**: → Bỏ, vì spec `authentication-and-roles` nói rõ boss = observer.
- **B. Chọn (đã dùng)**: Postgres RLS default deny → boss không có policy = không được write. Đơn giản, không sai được.

**Ngoại lệ**: boss vẫn INSERT được vào `audit_log` (vì audit log ghi cả action đọc/xem trong tương lai nếu cần), và INSERT được nếu Supabase Auth cần update lastSignInAt (không, Auth quản lý `auth.users` không đụng `profiles`).

### D5. Helper SQL functions cho policy

**Chọn**: viết 3 hàm `SECURITY DEFINER` để tránh subquery lặp trong policy:

```sql
CREATE FUNCTION public.current_profile() RETURNS profiles
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT * FROM profiles WHERE id = auth.uid() $$;

CREATE FUNCTION public.current_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT role FROM profiles WHERE id = auth.uid() $$;

CREATE FUNCTION public.current_branch_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
  AS $$ SELECT branch_id FROM profiles WHERE id = auth.uid() $$;
```

**Lý do**: policy dạng `EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND ...)` lặp lại 20+ chỗ, dễ sai. Có helper thì policy đọc như tiếng người: `USING (current_role() IN ('admin','boss') OR bills.branch_id = current_branch_id())`.

**Trade-off**: `SECURITY DEFINER` cần `SET search_path = public` để không bị SQL injection qua search_path. Đã set.

**Cắt được nếu deadline gấp**: inline subquery vào policy trực tiếp, verbose hơn nhưng vẫn chạy đúng.

### D6. Session lấy từ `supabase.auth.onAuthStateChange`, không dùng localStorage tự khai

**Chọn**: App.jsx bootstrap:

```js
useEffect(() => {
  supabase.auth.getSession().then(({ data }) => hydrateSession(data.session));
  const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
    hydrateSession(session);
  });
  return () => sub.subscription.unsubscribe();
}, []);
```

`hydrateSession` fetch profile từ `profiles` bằng `auth.uid()`, set React state `{ id, username, full_name, role, branch_id, branch_code }`.

**Alternatives:**
- **A. Đọc thẳng từ JWT claims**: Supabase cho custom claims nhưng cần setup Auth Hook (Edge Function). Overhead. Bỏ.
- **B. Chọn (đã dùng)**: fetch profile qua RLS-guarded SELECT. Tự nhiên, không setup thêm gì.

Supabase JS client tự lưu session vào `localStorage` với key riêng (không đụng `hc_session` cũ) và refresh token tự động.

**Implementation note**: Để giảm diff, giữ `localStorage['hc_session']` như 1 client-side **cache** cho `auditLog.js` và các chỗ đọc `session.id/role/branch_id`. Source of truth là Supabase Auth JWT — App có `useEffect` sync: khi `SIGNED_OUT` thì clear cache. Cache bị lệch id (data cũ trước migration) → tự clear + force login lại.

### D7. Fresh install thay vì migrate user cũ

**Chọn**: wipe toàn bộ data test trước migration (chỉ giữ `branches`). Sau đó migration + tạo user mới bằng `scripts/add-user.mjs`.

**Alternatives:**
- **A. Migrate user cũ qua script Node đọc `users_legacy_backup`**: cần backup, restore rollback, backfill FK cho các cột `bills.created_by`, `audit_log.user_id`, ... → phức tạp, dễ sai.
- **B. Chọn (đã dùng)**: wipe → migration → thêm user mới. Sạch, không có row nào giữ FK cũ trỏ user id đã xoá.

**Trade-off**: mất data test. Chấp nhận vì chưa go-live (đã confirm với anh).

### D8. Helper CLI `scripts/add-user.mjs` cho admin tạo user

**Chọn**: script Node local đọc service_role key từ `.env.migration.local` (git-ignored), parse CLI args `--username --password --role --branch --fullname`, resolve `branch_id` từ `branch_code`, gọi `supabase.auth.admin.createUser` với metadata đầy đủ.

**Alternatives:**
- **A. Chỉ dùng Supabase dashboard**: admin phải gõ JSON `user_metadata` tay mỗi lần → dễ sai UUID branch_id, tốn thời gian.
- **B. Chọn (đã dùng)**: script CLI nhanh, validate args, in kết quả rõ ràng.

**Trade-off**: cần service_role key trên máy admin. Chấp nhận với ràng buộc: file `.env.migration.local` git-ignored, ai có quyền chạy script = ai có service_role.

### D9. Cấu trúc migration file = 1 SQL BEGIN...COMMIT + `-- ROLLBACK` comment

**Chọn**: toàn bộ migration nằm trong 1 transaction. Nếu SQL fail giữa chừng, Postgres tự rollback → DB về nguyên state ban đầu. Cuối file có block `-- ROLLBACK` với các câu lệnh reverse để chạy tay nếu cần undo sau khi commit.

**Section layout**:
- A: branches (unique index + seed idempotent)
- B: profiles table
- C: trigger `on_auth_user_created`
- D: helper functions (`current_role`, `current_branch_id`)
- E: FK về profiles (DO block idempotent)
- F: enable RLS (9 bảng)
- G: DROP policies cũ (từ add-branch-sessions + add-audit-log)
- H-O: policies mới cho 9 bảng, mỗi bảng 1 section

### D10. Hủy bill draft = soft-cancel (đổi hành vi hiện tại)

**Chọn**: bỏ hard-delete cho draft. Cả draft lẫn pending khi hủy đều UPDATE `delivery_status = 'cancelled'`, kèm lý do hủy prepend vào `order_note`, kèm `logAudit` action `bill_cancel` với `user_id = auth.uid()` (qua session cache).

**Alternatives:**
- **A. Giữ hard-delete draft** (hiện tại): → Bỏ vì mất dấu vết ai hủy draft, lý do gì. Với data thật production, cần audit đầy đủ.
- **B. Chọn (đã dùng)**: soft-cancel draft — đồng nhất với pending. RLS DELETE trên `bills` = deny cho mọi role (kể cả admin).

**Impact code**:
- `handleConfirmCancelBill` trong `App.jsx` — bỏ nhánh `if draft` riêng, thống nhất 1 flow `UPDATE`. Refund logic chỉ chạy cho non-draft.
- Audit log: `changes = { delivery_status: [oldStatus, 'cancelled'] }` cho cả draft lẫn pending.

**Impact RLS**: `bills` DELETE policy = **deny cho tất cả role**. Đơn giản hơn (không cần phân biệt draft/pending).

**Trade-off**: DB có thể tích draft cancelled không bao giờ dùng. Chấp nhận (volume nhỏ, có thể job cleanup sau này).

## Resolved Decisions (từ 6 open questions ban đầu)

1. **Script tạo user**: T viết `scripts/add-user.mjs`, anh chạy trên máy anh với service_role key. Script + `.env.migration.local` KHÔNG commit.
2. **Không có Supabase staging riêng + data test disposable**: → anh đã wipe toàn bộ data (`TRUNCATE` operational tables + `DROP TABLE users` + `DROP TABLE monthly_revenue`), chỉ giữ `branches`. Migration chạy trên chính project với DB gần như trống. Không cần backup phức tạp.
3. **Branches seed**: migration bao gồm `INSERT INTO branches (branch_code) VALUES ('SG'), ('GL') ON CONFLICT (branch_code) DO NOTHING` + `CREATE UNIQUE INDEX IF NOT EXISTS` để idempotent.
4. **`branch_sessions` write policy**: boss = KHÔNG UPDATE. Member UPDATE row `branch_id = current_branch_id()`. Admin UPDATE tất cả. ✅ giữ như spec đã viết.
5. **`clients.is_delete`**: KHÔNG hard-delete kể cả admin. DELETE policy = deny cho mọi role. Soft-delete = UPDATE `is_delete = true` do admin. ✅ giữ như spec đã viết.
6. **`bills` DELETE cho draft**: đổi behavior — draft cũng soft-cancel (xem D10). Bills DELETE policy = deny cho mọi role.

## Risks / Trade-offs

| Rủi ro | Mitigation |
|---|---|
| RLS policy sai → member SG thấy bill GL, hoặc member không thấy bill của mình. | Smoke test manual sau migration: login 3 role, verify từng màn hình. Migration là 1 transaction → nếu SQL fail thì rollback tự động. |
| Trigger auto-create profile fail → user tạo được ở `auth.users` mà không có `profiles` → RLS deny mọi thứ → không login được vào app. | `scripts/add-user.mjs` verify profile được tạo trước khi in "thành công". Nếu fail, script báo lỗi rõ ràng để admin xử lý. |
| Anon key trong git history vẫn xài được | Chấp nhận (out of scope). Sau go-live rotate qua Supabase dashboard nếu cần. |
| Session state không sync khi refresh token expire → user bị đăng xuất giữa chừng | `onAuthStateChange` fire `SIGNED_OUT` → App clear cache và về LoginScreen. Chấp nhận cho MVP. |
| `boss` không có INSERT policy audit_log → gọi `logAudit` từ boss sẽ fail | Policy INSERT audit_log = `auth.uid() IS NOT NULL` (không phân role). Boss INSERT được. Đã note trong D4. |
| RLS `SELECT` chậm do subquery vào `profiles` mỗi request | Helper function `STABLE` → planner cache 1 lần per statement. Ít hàng trong `profiles` (< 20). Không bottleneck. |
| Cache localStorage lệch với Auth (data cũ trước migration, hoặc SIGNED_OUT tab khác) | Bootstrap `useEffect` check `getSession()` khi mount, clear cache nếu Auth null hoặc id lệch. Subscribe `SIGNED_OUT` để clear real-time. |
| Service_role key bị leak (commit nhầm) | `.env.migration.local` matches `*.local` trong `.gitignore`. File example `.env.migration.local.example` có warning rõ. |

## Migration Plan

**Phase 0 (cleanup — đã thực hiện)**:
Anh chạy SQL cleanup trên Supabase SQL editor để wipe data test:
```sql
TRUNCATE bill_payment_details, expenses, audit_log, bills, client_phones, clients, branch_sessions CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.monthly_revenue CASCADE;
DELETE FROM auth.users WHERE email LIKE '%@hoancau.internal';
```
DB sạch, chỉ còn schema + `branches` (SG/GL).

**Phase 1 (migration + code deploy)**:
1. Anh chạy `add-supabase-auth-and-rls.sql` trên Supabase SQL editor (1 transaction, rollback tự động nếu fail).
2. Copy `scripts/.env.migration.local.example` → `scripts/.env.migration.local`, điền `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`.
3. Tạo user thật bằng `node scripts/add-user.mjs --username <tên> --password <mk> --role <role> --branch <SG|GL> --fullname "<họ tên>"` (mỗi lệnh 1 user).
4. Deploy Vite build mới (`npm run build` → hosting).
5. Test admin login → tạo 1 bill → soft-cancel bill → logout.
6. Test member SG + member GL + boss login.

**Phase 2 (post go-live tuning)**:
1. Bật Leaked Password Protection trên Supabase Auth dashboard.
2. Rotate anon key nếu cần (Supabase dashboard → Settings → API → Rotate).
3. Monitor Supabase Logs 1 tuần đầu.

**Rollback**:
- Nếu migration fail giữa chừng: transaction tự rollback. Sửa SQL, chạy lại.
- Nếu code deploy fail: `git revert` commit code, redeploy build cũ. DB không rollback được vì đã wipe data cũ — nhưng data cũ chỉ là test, không mất gì quan trọng.
- Nếu policy sai sau deploy: dùng comment `-- ROLLBACK` cuối `add-supabase-auth-and-rls.sql` để disable RLS tạm thời (chấp nhận security downgrade trong thời gian fix policy).

## Open Questions

Không còn open questions. Tất cả 6 câu ban đầu đã resolved (xem section "Resolved Decisions" trong Decisions).
