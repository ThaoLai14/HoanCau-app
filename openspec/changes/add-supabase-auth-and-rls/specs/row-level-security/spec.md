# Delta: row-level-security (add-supabase-auth-and-rls)

> New capability — toàn bộ là ADDED requirements. Định nghĩa chi tiết policy RLS cho từng bảng public. Chỉ dựa vào `auth.uid()` + `profiles`; KHÔNG dùng `USING (true)`.

## ADDED Requirements

### Requirement: Tất cả bảng public SHALL bật RLS

Mọi bảng trong schema `public` SHALL có `ENABLE ROW LEVEL SECURITY`. Bảng chưa dùng cũng phải bật (defense in depth). Danh sách bảng bắt buộc:

- `profiles`
- `branches`
- `clients`
- `client_phones`
- `bills`
- `bill_payment_details`
- `expenses`
- `branch_sessions`
- `audit_log`

Anon key (chưa login) SHALL KHÔNG có bất kỳ policy nào cho phép SELECT/INSERT/UPDATE/DELETE trên các bảng operational. Chỉ role `authenticated` (đã login qua Auth) mới có policy.

#### Scenario: Anon cố đọc bills → deny

- **GIVEN** client dùng anon key, chưa login (`auth.uid() IS NULL`)
- **WHEN** gọi `supabase.from('bills').select('*')`
- **THEN** trả về mảng rỗng (RLS deny hết, KHÔNG có row nào visible)

#### Scenario: Anon cố insert client → deny

- **GIVEN** client dùng anon key, chưa login
- **WHEN** gọi `supabase.from('clients').insert({ fullname: 'X' })`
- **THEN** trả về error RLS violation

### Requirement: Helper functions cho policy

Hệ thống SHALL cung cấp 3 helper function `SECURITY DEFINER` với `search_path = public` để policy đọc thông tin profile của user hiện tại:

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

Policy SHALL dùng 3 hàm này thay vì lặp lại `EXISTS (SELECT 1 FROM profiles ...)`.

#### Scenario: Anon gọi `current_role()`

- **GIVEN** anon key, chưa login (`auth.uid() IS NULL`)
- **WHEN** hàm được gọi từ policy
- **THEN** trả về NULL
- **AND** policy so sánh NULL với chuỗi → false → deny

#### Scenario: Member gọi `current_role()`

- **GIVEN** user role='member' đã login
- **THEN** `current_role()` trả về `'member'`

### Requirement: RLS policy cho `profiles`

Bảng `profiles` SHALL có các policy sau:

- **SELECT**: mọi user authenticated đọc mọi profile. Cần thiết để hiển thị tên nhân viên tạo/giao đơn cho member. Profile chỉ chứa `username, full_name, role, branch_id` — password nằm ở `auth.users` (không expose).
- **INSERT**: deny (chỉ trigger `after_auth_user_created` tạo — trigger là `SECURITY DEFINER`, bypass RLS).
- **UPDATE**: user sửa các field `full_name` của chính mình. Admin sửa mọi field trên mọi profile. Member/boss MUST KHÔNG sửa `role`, `branch_id`, `username` của bất kỳ ai.
- **DELETE**: deny (phải xoá qua `auth.users` cascade).

#### Scenario: Member đọc profile của user khác

- **GIVEN** member "linh"
- **WHEN** `supabase.from('profiles').select('username, full_name').eq('username', 'trung')`
- **THEN** trả về 1 row của "trung" (username + full_name)

#### Scenario: Boss đọc tất cả

- **GIVEN** boss đã login
- **WHEN** `supabase.from('profiles').select('*')`
- **THEN** trả về mọi row

#### Scenario: Member cố tự nâng role

- **GIVEN** member "linh"
- **WHEN** `supabase.from('profiles').update({ role: 'admin' }).eq('id', auth.uid())`
- **THEN** RLS deny (UPDATE policy của member không cho update cột `role`)

### Requirement: RLS policy cho `branches`

Bảng `branches` SHALL có các policy sau:

- **SELECT**: mọi authenticated.
- **INSERT/UPDATE/DELETE**: admin only.

#### Scenario: Member xem list chi nhánh

- **GIVEN** member đã login
- **WHEN** `supabase.from('branches').select('branch_code')`
- **THEN** trả về `[{ branch_code: 'SG' }, { branch_code: 'GL' }]`

#### Scenario: Member cố thêm chi nhánh mới

- **WHEN** member gọi INSERT branches
- **THEN** RLS deny

### Requirement: RLS policy cho `clients` và `client_phones`

Hai bảng SHALL không phân theo branch — cả 2 chi nhánh dùng chung dữ liệu khách hàng. Policy:

- **SELECT**: mọi authenticated.
- **INSERT**: admin, member.
- **UPDATE**: admin. (Member MUST KHÔNG sửa được sau khi tạo — nếu member phát hiện sai thì báo admin sửa.)
- **DELETE**: deny (soft-delete bằng UPDATE `is_delete = true` do admin thực hiện).

#### Scenario: Member intake tạo khách mới

- **GIVEN** member SG đang tạo bill mới, khách chưa có trong DB
- **WHEN** `resolveOrCreateClient` insert `clients` + `client_phones`
- **THEN** cả 2 insert thành công

#### Scenario: Member cố sửa tên khách

- **WHEN** member `supabase.from('clients').update({ fullname: 'X' }).eq('id', ...)`
- **THEN** RLS deny

#### Scenario: Boss cố sửa khách

- **WHEN** boss update clients
- **THEN** RLS deny (boss không có UPDATE policy nào)

#### Scenario: Admin xoá cứng khách → deny

- **WHEN** admin `supabase.from('clients').delete().eq('id', ...)`
- **THEN** RLS deny (soft-delete only)
- **AND** admin phải dùng `update({ is_delete: true })` thay thế

### Requirement: RLS policy cho `bills`

Bảng `bills` SHALL phân quyền theo role và branch:

- **SELECT**:
  - mọi authenticated (admin, boss, member) đọc được mọi row. Member được xem bill của branch khác để hỗ trợ theo dõi tổng quan (tab "Tổng hợp đơn hàng" + "Bốc xếp" cross-branch).
- **INSERT**:
  - admin: mọi row.
  - member: chỉ với `branch_id = current_branch_id()`.
  - boss: deny.
- **UPDATE**:
  - admin: mọi row.
  - member: row `branch_id = current_branch_id()` VÀ `delivery_status IN ('draft', 'pending', 'delivered')` — bao gồm cả draft (chỉnh nháp), pending (warehouse counter + delivery completion), delivered (edit sau giao nếu cần). MUST KHÔNG update được bill đã cancelled.
  - boss: deny.
- **DELETE**:
  - deny cho **mọi role** (bao gồm admin). Draft bị hủy phải chuyển sang `delivery_status = 'cancelled'` bằng UPDATE (xem delta của capability `shipment-intake`).

#### Scenario: Member SG thấy bill của cả 2 branch

- **GIVEN** member SG login
- **AND** DB có 10 bill SG, 5 bill GL
- **WHEN** `supabase.from('bills').select('*')`
- **THEN** trả về 15 row (cả SG và GL)
- **AND** guardrail branch nằm ở UI (tab list all-bills mặc định theo `session.branch_code`) + policy UPDATE (member chỉ update được bill branch mình)

#### Scenario: Member cố insert bill cho branch khác

- **GIVEN** member SG
- **WHEN** `supabase.from('bills').insert({ branch_id: '<gl-uuid>', ... })`
- **THEN** RLS deny

#### Scenario: Member update bill pending (warehouse hoặc delivery) → OK

- **GIVEN** member SG
- **AND** bill SG có `delivery_status = 'pending'`
- **WHEN** member update `inside_count`, `outside_count`, `goods_location` (warehouse) hoặc `delivery_status = 'delivered'` + recipient fields
- **THEN** UPDATE thành công

#### Scenario: Member cố update bill cancelled → deny

- **GIVEN** member SG, bill SG có `delivery_status = 'cancelled'`
- **WHEN** member update bất kỳ field nào
- **THEN** RLS deny (bill cancelled bất khả sửa)

#### Scenario: Member cố update bill của branch khác → deny

- **GIVEN** member SG
- **WHEN** update bill GL bất kỳ
- **THEN** RLS deny

#### Scenario: Admin cố xoá bill draft

- **GIVEN** admin, bill có `delivery_status = 'draft'`
- **WHEN** `supabase.from('bills').delete().eq('id', <draft_id>)`
- **THEN** RLS deny (KHÔNG có DELETE policy nào cho bills)
- **AND** admin phải soft-cancel bằng `update({ delivery_status: 'cancelled', order_note: '[LÝ DO HỦY]: ...' })`

#### Scenario: Admin cố xoá bill pending

- **WHEN** admin `.delete().eq('id', <pending_id>)`
- **THEN** RLS deny
- **AND** admin phải soft-cancel bằng UPDATE

#### Scenario: Boss cố update bill

- **WHEN** boss update bất kỳ bill nào
- **THEN** RLS deny

### Requirement: RLS policy cho `bill_payment_details`

Bảng `bill_payment_details` SHALL có policy sau (JOIN bills để check branch):

- **SELECT**: admin/boss all; member cùng branch (JOIN bills để check `bills.branch_id`).
- **INSERT**: admin; member cùng branch với bill đích.
- **UPDATE**: admin only.
- **DELETE**: deny (payment record là bằng chứng tài chính, MUST chỉ append).

Vì policy cần JOIN `bills`, dùng subquery:

```sql
CREATE POLICY bpd_select ON bill_payment_details FOR SELECT USING (
  current_role() IN ('admin','boss')
  OR EXISTS (SELECT 1 FROM bills b WHERE b.id = bill_payment_details.bill_id
             AND b.branch_id = current_branch_id())
);
```

#### Scenario: Member SG xem payment của bill SG

- **GIVEN** member SG
- **AND** payment row cho bill SG
- **THEN** SELECT thành công

#### Scenario: Member SG cố xem payment bill GL

- **THEN** RLS deny (không thấy row)

#### Scenario: Ai cố DELETE payment

- **WHEN** admin/member/boss gọi DELETE
- **THEN** RLS deny (append-only)

### Requirement: RLS policy cho `expenses`

Bảng `expenses` SHALL có policy sau:

- **SELECT**: admin/boss all; member cùng branch.
- **INSERT**: admin; member cùng branch.
- **UPDATE**: admin all; member chỉ row do mình tạo VÀ trong ngày hôm nay (`created_at::date = CURRENT_DATE`).
- **DELETE**: deny (soft-delete MUST được thực hiện qua UPDATE `is_delete = true`, chỉ admin).

#### Scenario: Member SG thêm chi phí

- **GIVEN** member SG
- **WHEN** insert expense với `branch_id = current_branch_id()`
- **THEN** thành công

#### Scenario: Member sửa expense ngày cũ

- **GIVEN** member SG
- **AND** expense do mình tạo hôm qua
- **WHEN** UPDATE
- **THEN** RLS deny

#### Scenario: Admin soft-delete expense

- **WHEN** admin `.update({ is_delete: true, deleted_by: auth.uid(), deleted_at: now() })`
- **THEN** thành công

### Requirement: RLS policy cho `branch_sessions`

Bảng `branch_sessions` SHALL có policy sau:

- **SELECT**: mọi authenticated.
- **INSERT**: admin (seed).
- **UPDATE**: admin all; member cùng branch (để rollover `business_date` khi Xuất Bến).
- **DELETE**: deny.

#### Scenario: Member SG Xuất Bến

- **GIVEN** member SG
- **WHEN** UPDATE `branch_sessions` cho branch SG
- **THEN** thành công

#### Scenario: Member SG cố Xuất Bến branch GL

- **WHEN** UPDATE branch_sessions cho `branch_id = <gl-uuid>`
- **THEN** RLS deny

#### Scenario: Boss cố Xuất Bến

- **WHEN** boss update branch_sessions
- **THEN** RLS deny

### Requirement: RLS policy cho `audit_log`

Bảng `audit_log` SHALL có policy sau (thay thế policy permissive cũ trong `add-audit-log-table.sql`):

- **SELECT**: admin, boss. Member MUST KHÔNG đọc được audit log. (Simplification: member cũng không đọc được audit log của chính mình — hiện app không có UI cho member xem history.)
- **INSERT**: mọi authenticated (kể cả boss — để log các action tương lai như view sensitive report, dù hiện chưa có).
- **UPDATE, DELETE**: deny (append-only, đã có sẵn trong spec `audit-log`).

#### Scenario: Admin đọc audit log

- **WHEN** admin gọi fetchAuditLog
- **THEN** trả về mọi row phù hợp filter

#### Scenario: Member đọc audit log

- **WHEN** member SELECT audit_log
- **THEN** trả về mảng rỗng

#### Scenario: Boss ghi audit log

- **WHEN** boss gọi `logAudit(...)` (nếu tương lai có action boss cần log)
- **THEN** INSERT thành công

#### Scenario: Ai cố sửa/xoá audit log

- **THEN** RLS deny cho mọi role

### Requirement: `boss` role có zero write policy trên bảng operational

Trên các bảng `clients`, `client_phones`, `bills`, `bill_payment_details`, `expenses`, `branch_sessions`, hệ thống SHALL KHÔNG có bất kỳ policy INSERT/UPDATE/DELETE nào chấp nhận `current_role() = 'boss'`. Postgres RLS default deny → boss MUST bị chặn ở tầng DB cho mọi mutation.

#### Scenario: Boss cố mọi mutation

- **WHEN** boss thử INSERT/UPDATE/DELETE bất kỳ bảng operational nào
- **THEN** RLS deny hết
