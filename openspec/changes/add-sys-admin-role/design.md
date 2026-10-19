# Design: add-sys-admin-role

## Decisions

### D1 — Role hierarchy: sys_admin là superset của admin, không phải substitute

`sys_admin` có mọi quyền của `admin` + user management + branch config. RLS policies được viết theo dạng `IN ('sys_admin', 'admin')` chứ không phải `'sys_admin' OR bypass`. Điều này giữ nguyên semantic của `admin` (branch manager) và tránh RLS phức tạp.

Đối với các business rule cụ thể của admin (VD: Xuất Bến chỉ enable khi cùng branch với session.branch_code), sys_admin **không bypass** — sys_admin phải chọn branch để thao tác giống admin. Điều này đảm bảo audit log ghi đúng branch của thao tác.

### D2 — `current_role()` return NULL khi user bị disable/delete

Function `current_role()` được sửa để trả về NULL nếu `is_disabled = true` hoặc `is_deleted = true`. Vì mọi policy đều check `current_role() IN (...)`, NULL sẽ fail check → user bị block khỏi mọi bảng.

Alternative đã cân nhắc:
- **Thêm `is_disabled` check vào từng policy**: quá verbose (30+ policies).
- **Dùng Postgres `pg_catalog.set_config` hoặc trigger revoke**: phức tạp, không portable.
- **Client-side check thôi**: attacker giữ JWT vẫn có thể query. Không đủ.

Chọn cách sửa 1 helper function → propagate qua toàn bộ policies.

### D3 — Immediate lockout kết hợp 2 tầng

Khi sys_admin disable/delete 1 user:
1. **Tầng 1 (RLS)**: `is_disabled = true` trong `profiles` → `current_role()` NULL → policies deny.
2. **Tầng 2 (Auth)**: Edge Function gọi `auth.admin.updateUserById({ban_duration:'permanent'})` → JWT không refresh được.

Tầng 1 chặn INSTANT (< 1s vì next query fail). Tầng 2 chặn khi JWT expire (thường 1h). Kết hợp defense-in-depth.

Client-side: interceptor phát hiện lỗi RLS-style (`PGRST301` / `permission denied for schema public` / empty result kèm 401) → force `signOut()` + redirect login + toast "Tài khoản của bạn đã bị vô hiệu hóa".

### D4 — Anti-lockout rules

Sys_admin có thể tự làm mình bị lock ra khỏi hệ thống nếu:
- Tự disable/delete chính mình.
- Tự demote role của mình xuống admin/member.
- Disable/delete sys_admin duy nhất còn lại.

Rules bảo vệ (enforce ở cả Edge Function và RLS policy):
- **R1**: `target_id != caller_id` cho action `disable`, `delete`, `update_profile` (khi thay đổi role).
- **R2**: Nếu action = `disable`/`delete`/`demote_from_sys_admin` cho user là sys_admin cuối cùng còn active (`COUNT(*) FROM profiles WHERE role='sys_admin' AND is_disabled=false AND is_deleted=false = 1`) → deny.

Bootstrap edge case: nếu chẳng may cả 2 rule vẫn không cứu được (VD race condition 2 sys_admin cùng disable nhau), phải resort về `scripts/add-user.mjs` để tạo sys_admin mới. Chấp nhận rủi ro rất nhỏ này.

### D5 — PIN gate là UX barrier, không phải security

PIN được lưu bcrypt trong `profiles.sys_admin_pin_hash`, verify qua Edge Function. Nhưng khi sys_admin unlock thành công, mọi mutation tiếp theo (bill update, expense delete) đi trực tiếp qua Supabase JS client với JWT của sys_admin — KHÔNG qua Edge Function. RLS cho phép vì `role = 'sys_admin'`.

→ Attacker chiếm JWT của sys_admin có thể bỏ qua PIN gate bằng cách gọi thẳng Supabase từ DevTools/Postman.

**Đây là giới hạn được chấp nhận**. Real security dựa vào:
1. MFA — chống steal password.
2. Audit log — trace mọi mutation.
3. Short session TTL cho sys_admin (15 phút inactive → auto logout).

Cân nhắc alternative: proxy mọi mutation của sys_admin qua Edge Function → chậm hơn và phá vỡ 90% code hiện tại. Không worth.

### D6 — MFA (TOTP) chỉ bắt buộc sys_admin

Supabase Auth có MFA Level 2 (AAL2) — user có TOTP factor. Enforce qua:
- Bật MFA enrollment cho project (Supabase Dashboard → Auth settings).
- Client-side: sau login, nếu `role = 'sys_admin'` và `authenticator_assurance_level != 'aal2'` → force enroll flow.
- Sau enroll thành công, mỗi lần login sys_admin nhập TOTP 6 số.

Role khác (admin/member/boss) MFA optional. Nếu sau này muốn ép, chỉ cần thay điều kiện client-side.

Nếu sys_admin mất TOTP (mất điện thoại): recovery duy nhất là vào Supabase Dashboard xóa factor. Phải chấp nhận friction này để đổi lấy security.

### D7 — Edge Function: 1 function nhiều action vs nhiều function

**Chọn**: 1 function `admin-users` với `body.action` switch → nhiều action.

Lý do:
- Chỉ 1 endpoint URL → đơn giản CORS + auth check.
- Share middleware (JWT verify, role check, rate limit, audit).
- Deployment 1 lần cho tất cả action.

Trade-off: file dài hơn (~200 dòng thay vì mỗi function ~50 dòng), nhưng vẫn dưới mức khó maintain.

### D8 — Trạng thái `is_disabled` vs `is_deleted`

| Trạng thái | Trong list UI | Có thể enable lại | Login được không | Xuất hiện trong dropdown assign (VD "collected_by") |
|---|---|---|---|---|
| Active (default) | ✅ hiện | — | ✅ | ✅ |
| `is_disabled=true` | ✅ hiện với badge "Đã khóa" | ✅ Có (Enable button) | ❌ | ❌ (không assign được cho action mới) |
| `is_deleted=true` | ❌ ẩn | ❌ Không (phải SQL) | ❌ | ❌ |

Với record cũ (bill.created_by trỏ tới user đã disabled/deleted), hiển thị tên vẫn hoạt động — chỉ block login + assign mới.

### D9 — Session TTL riêng cho sys_admin

Supabase Auth có session lifetime chung cho project. Không dễ tách riêng theo role.

Workaround: client-side timer. App track thời gian gần nhất user tương tác (mousemove/keydown). Sau X phút không tương tác:
- Sys_admin: X = 15 phút → auto `signOut()`.
- Role khác: X = 8 giờ (dài).

Trade-off: nếu client tab bị đóng và mở lại, timer reset. Đủ tốt cho use case này.

### D10 — Naming: `sys_admin` vs `super_admin` vs `owner`

Chọn `sys_admin` vì:
- Không xung đột với `admin` hiện có.
- Dễ hiểu ("quản trị hệ thống" tiếng Việt).
- Ngắn gọn hơn `super_admin`.
- `owner` implication về ownership pháp lý — sai semantic.

### D11 — Sys_admin xem TẤT CẢ business tabs (bao gồm Doanh Thu + Công Nợ)

Trước đây menu Doanh Thu + Công Nợ chỉ hiện cho `admin` + `boss`. Sys_admin phải xem được tất cả để troubleshoot data. Rule cuối cùng:

| Tab | admin | member | boss | sys_admin |
|---|---|---|---|---|
| Khách Hàng | ✅ | ❌ | ✅ | ✅ |
| Đơn Hàng | ✅ | ✅ | ❌ | ✅ |
| Danh Sách Bốc Xếp | ✅ | ✅ | ❌ | ✅ |
| Tổng Hợp Đơn Hàng | ✅ | ✅ | ✅ | ✅ |
| Quản Lý Doanh Thu | ✅ | ❌ | ✅ | ✅ |
| Công Nợ | ✅ | ❌ | ✅ | ✅ |
| Tài khoản của tôi | ✅ | ✅ | ✅ | ✅ |
| ⚙️ Quản Trị Hệ Thống | ❌ | ❌ | ❌ | ✅ (only) |

### D12 — MFA fallback: recovery codes (không phụ thuộc Supabase Studio)

Sys_admin sau khi enroll TOTP, app SHALL tự động generate 8 recovery codes (mỗi code 10 chars random) và hiển thị 1 lần duy nhất trong modal. User bắt buộc "Tôi đã lưu recovery codes" tick trước khi đóng modal.

Recovery codes lưu bcrypt hash vào bảng mới `mfa_recovery_codes(id, user_id, code_hash, used_at)`. Khi user mất TOTP:
- Login normal (password ok).
- Modal MFA: link "Dùng recovery code thay TOTP" → nhập 1 code.
- Verify: bcrypt compare + check `used_at IS NULL` → nếu OK, đánh dấu `used_at = now()` và cấp aal2. Code chỉ dùng 1 lần.
- Sau login, hiển thị warning "Bạn còn N recovery codes. Cân nhắc regenerate + enroll lại TOTP".

Recovery codes có thể regenerate qua "Tài khoản của tôi" (yêu cầu re-auth password + TOTP hiện tại). Regenerate → invalidate all codes cũ, tạo bộ mới.

Nếu user dùng hết 8 codes + mất TOTP → phải qua Supabase Studio xóa factor (chấp nhận friction cực hiếm).

### D13 — Sys_admin default branch = SG

Sys_admin KHÔNG làm business ops thường xuyên — chỉ vào fix data khi có sai sót. `profiles.branch_id` là formality cho audit ("sys_admin from SG did X"). Default = SG.

Bootstrap script cho phép `--branch SG|GL` nhưng default SG nếu không truyền.

Sys_admin thao tác trên bill của chi nhánh khác (VD sửa bill GL khi sys_admin gán SG) → RLS cho phép vì `role IN ('sys_admin', 'admin')`. Audit log ghi `sys_admin_branch = SG, target_bill_branch = GL` để trace.

Xuất Bến: sys_admin **KHÔNG** được Xuất Bến branch khác branch mình (giữ nguyên rule "chỉ NV cùng branch"). Nếu cần Xuất Bến hộ, phải đổi branch qua Supabase Studio (rare).

## Sequence: Sys_admin tạo user mới

```
Sys_admin (browser)          Edge Function        Supabase Auth    Postgres
       │                          │                    │              │
       │  POST /admin-users       │                    │              │
       │  { action:'create', ...} │                    │              │
       │─────────────────────────▶│                    │              │
       │                          │                    │              │
       │                          │  Verify JWT        │              │
       │                          │───────────────────▶│              │
       │                          │◀───────────────────│              │
       │                          │                    │              │
       │                          │  SELECT role FROM  │              │
       │                          │  profiles          │              │
       │                          │────────────────────────────────▶  │
       │                          │◀────────────────────────────────  │
       │                          │  role='sys_admin' ✓               │
       │                          │                    │              │
       │                          │  Rate limit check  │              │
       │                          │  (Redis/memcache)  │              │
       │                          │                    │              │
       │                          │  auth.admin.createUser             │
       │                          │───────────────────▶│              │
       │                          │                    │  Insert       │
       │                          │                    │  auth.users   │
       │                          │                    │───────────▶  │
       │                          │                    │              │
       │                          │                    │  Trigger      │
       │                          │                    │  handle_new_  │
       │                          │                    │  auth_user    │
       │                          │                    │              │
       │                          │                    │  Insert       │
       │                          │                    │  profiles     │
       │                          │                    │───────────▶  │
       │                          │◀───────────────────│              │
       │                          │                    │              │
       │                          │  INSERT audit_log  │              │
       │                          │────────────────────────────────▶  │
       │                          │                    │              │
       │◀─────────────────────────│                    │              │
       │  200 { user_id, ... }    │                    │              │
```

## Sequence: User bị disable → auto logout

```
Sys_admin              user X (đang online)     Edge Function       Postgres
   │                          │                       │                 │
   │  POST /admin-users       │                       │                 │
   │  {action:'disable',      │                       │                 │
   │   target: X.id}          │                       │                 │
   │─────────────────────────▶│                       │                 │
   │                          │                       │  UPDATE profiles│
   │                          │                       │  SET is_disabled│
   │                          │                       │  =true          │
   │                          │                       │───────────────▶│
   │                          │                       │                 │
   │                          │                       │  auth.admin.    │
   │                          │                       │  updateUserById │
   │                          │                       │  {ban_duration} │
   │                          │                       │                 │
   │                          │                       │  INSERT audit   │
   │                          │                       │                 │
   │◀─────────────────────────│                       │                 │
   │                          │  (next fetchData)    │                 │
   │                          │──────────────────────────────────────▶│
   │                          │                       │                 │
   │                          │                       │  RLS check:     │
   │                          │                       │  current_role() │
   │                          │                       │  = NULL (disabled)
   │                          │                       │  → DENY         │
   │                          │◀──────────────────────────────────────│
   │                          │  Error: no permission │                 │
   │                          │                       │                 │
   │                          │  Client interceptor:  │                 │
   │                          │  supabase.auth.signOut│                 │
   │                          │  → LoginScreen        │                 │
```

## Risks

| Risk | Mitigation |
|---|---|
| Sys_admin tự lockout do bug logic (VD race condition disable lẫn nhau) | R1+R2 anti-lockout + fallback bootstrap qua CLI script |
| Attacker chiếm sys_admin JWT bypass PIN gate | MFA + audit log immutable + short session TTL |
| Edge Function down → không quản lý user được | Bootstrap CLI script vẫn hoạt động (dùng SERVICE_ROLE_KEY offline) |
| Migration lỗi giữa chừng (cột thêm dở dang) | Migration file wrap `BEGIN;...COMMIT;` — atomic rollback |
| Existing sessions của admin cũ hiểu nhầm role mới không tồn tại | Frontend đổi trước migration, deploy đồng thời. Legacy user chỉ có role IN (admin, member, boss) — vẫn hoạt động. |
| PIN quên | Sys_admin dùng "Đổi PIN" trong Tài khoản của tôi. Nếu quên cả PIN + password → dùng CLI reset. |

## Open questions

Tất cả đã được anh chốt trong lần review đầu:
- **[RESOLVED-1]** Sys_admin xem tất cả tab (D11).
- **[RESOLVED-2]** MFA fallback = recovery codes (D12).
- **[RESOLVED-3]** Sys_admin default branch = SG (D13).
