# Delta: authentication-and-roles (add-supabase-auth-and-rls)

> Modifies existing capability `authentication-and-roles`. Bỏ plaintext compare, chuyển sang Supabase Auth. Session không còn tự khai trong localStorage — do Supabase Auth quản lý JWT.

## REMOVED Requirements

### Requirement: Plaintext password comparison

**Reason**: Lỗ hổng bảo mật nghiêm trọng — anon key public + RLS disabled → bất kỳ ai đọc bundle JS có thể `SELECT * FROM users` lấy plaintext password của toàn bộ nhân viên. Không phù hợp production với data khách hàng thật.

**Migration**: Thay bằng Requirement "Đăng nhập bằng Supabase Auth với email nội bộ" trong capability mới `supabase-auth`. Password lưu bcrypt trong `auth.users.encrypted_password`, xác thực server-side qua `supabase.auth.signInWithPassword`. Cột `password_hash` bị xoá cùng bảng `public.users` cũ.

## MODIFIED Requirements

### Requirement: User gắn cứng 1 chi nhánh

Mỗi user SHALL được gắn cứng với đúng 1 chi nhánh; `branch_code` trở thành `loggedBranch` và là chi nhánh mặc định trên tất cả tab. Nguồn dữ liệu `branch_id` SHALL là `public.profiles.branch_id`, KHÔNG phải `public.users.branch_id` (bảng đã bị xoá).

App SHALL fetch `branch_code` bằng cách join `profiles` → `branches` sau khi Auth thành công, KHÔNG được đọc `branch_code` từ session tự khai của client.

#### Scenario: User chi nhánh SG đăng nhập

- **WHEN** user có `profiles.branch_id` tương ứng branch có `branch_code = "SG"` đăng nhập thành công
- **THEN** app query `select branch_id, branches(branch_code) from profiles where id = auth.uid()`
- **AND** `currentBranch = "SG"` trong form tạo đơn
- **AND** tab kho mặc định `warehouseBranch = "SG"`
- **AND** tab Tổng Hợp Đơn Hàng mặc định `allBillsTab = "SG"`
- **AND** tab Doanh Thu mặc định `revenueTab = "SG"`

#### Scenario: Client sửa localStorage giả branch → không effect

- **GIVEN** member SG đã login
- **WHEN** attacker sửa React state hoặc localStorage set `branch_code = "GL"`
- **THEN** UI có thể hiển thị "GL" (client-side lie)
- **BUT** mọi query xuống DB vẫn bị RLS lọc theo `current_branch_id() = <sg-uuid>` từ `profiles`
- **AND** không đọc/ghi được dữ liệu GL

### Requirement: Phân quyền 3 role

Hệ thống SHALL phân 3 role với quyền truy cập tab khác nhau, dựa trên `profiles.role`. Việc kiểm soát quyền SHALL được thực thi ở **2 tầng**:

- **UI layer** (App.jsx): ẩn menu, ẩn button, `disabled` input để UX gọn cho từng role.
- **DB layer** (RLS): policy trên từng bảng deny mọi mutation không được phép — chi tiết trong capability `row-level-security`. Đây là hàng rào **thật** cho security.

| Tab | admin | member | boss |
|---|---|---|---|
| Quản Lý Khách Hàng | đầy đủ | KHÔNG thấy menu | xem được, mọi input bị `disabled` |
| Phiếu Gửi Hàng | đầy đủ | tạo đơn + xem chi tiết, KHÔNG sửa/hủy đơn pending | đầy đủ (read-only ở DB layer) |
| Danh Sách Bốc Xếp | đầy đủ | đầy đủ | đầy đủ (read-only ở DB layer) |
| Tổng Hợp Đơn Hàng | đầy đủ | đầy đủ | đầy đủ (read-only ở DB layer) |
| Quản Lý Doanh Thu | đầy đủ | KHÔNG thấy menu | đầy đủ (read-only ở DB layer) |

App code SHALL KHÔNG dựa vào role check UI như security. Attacker bypass UI phải bị RLS chặn ở DB.

#### Scenario: Member không nhìn thấy menu Khách Hàng và Doanh Thu

- **WHEN** user có `profiles.role = "member"` đăng nhập
- **THEN** sidebar chỉ hiển thị 3 mục: Phiếu Gửi Hàng, Danh Sách Bốc Xếp, Tổng Hợp Đơn Hàng

#### Scenario: Boss vào tab Khách Hàng ở chế độ chỉ đọc UI

- **WHEN** user có `profiles.role = "boss"` mở tab Quản Lý Khách Hàng
- **THEN** mọi `<input>`, `<button>` thêm/sửa/blacklist đều có thuộc tính `disabled`
- **AND** boss vẫn xem được toàn bộ danh sách khách hàng

#### Scenario: Boss bypass UI cố update client

- **GIVEN** boss đã login, mở DevTools
- **WHEN** boss chạy `supabase.from('clients').update({ fullname: 'X' }).eq('id', ...)` từ console
- **THEN** RLS deny → response error → dữ liệu KHÔNG bị sửa

#### Scenario: Member bypass UI cố tạo bill cho branch khác

- **GIVEN** member SG đã login
- **WHEN** member chạy từ DevTools `supabase.from('bills').insert({ branch_id: '<gl-uuid>', ... })`
- **THEN** RLS deny (member INSERT bill chỉ cho `branch_id = current_branch_id()`)

#### Scenario: Admin có toàn quyền operational

- **WHEN** user có `profiles.role = "admin"` đăng nhập
- **THEN** sidebar hiển thị đủ 5 mục
- **AND** có thể tạo / sửa / hủy đơn, sửa khách hàng, xuất bến, ghi chi phí (RLS cho phép)

### Requirement: Phiên đăng nhập

Hệ thống SHALL dùng JWT của Supabase Auth để giữ phiên đăng nhập. Session gồm:
- **Access token**: JWT sống ngắn (default 1 giờ, config được).
- **Refresh token**: sống dài (default 30 ngày, config được), tự động dùng để refresh access token khi gần hết hạn.

App SHALL KHÔNG lưu session vào `localStorage['hc_session']` (key cũ). Supabase JS client tự lưu vào key `sb-<project-ref>-auth-token`.

Phiên SHALL bị vô hiệu khi:
- User bấm Đăng Xuất.
- Refresh token hết hạn.
- Admin revoke session qua `supabase.auth.admin.signOut(userId)` (nếu cần).

#### Scenario: Reload trang vẫn còn đăng nhập

- **WHEN** user đã đăng nhập, refresh trình duyệt
- **THEN** `supabase.auth.getSession()` khôi phục session từ `sb-<ref>-auth-token`
- **AND** ứng dụng bỏ qua LoginScreen

#### Scenario: Đăng xuất

- **WHEN** user bấm nút Đăng Xuất
- **THEN** `supabase.auth.signOut()` xóa `sb-<ref>-auth-token` khỏi localStorage và invalidate refresh token phía server
- **AND** quay về LoginScreen

#### Scenario: localStorage bị xóa thủ công

- **WHEN** user xóa `sb-<ref>-auth-token` qua DevTools rồi refresh
- **THEN** ứng dụng hiển thị LoginScreen

#### Scenario: Access token expire → auto refresh

- **GIVEN** access token gần hết hạn
- **WHEN** Supabase JS client tự động refresh
- **THEN** access token mới được set, `onAuthStateChange` fire `TOKEN_REFRESHED`
- **AND** user không bị interrupt

#### Scenario: Refresh token hết hạn (30 ngày không login)

- **GIVEN** user không mở app 30+ ngày
- **WHEN** user mở app
- **THEN** refresh fail → event `SIGNED_OUT`
- **AND** app chuyển về LoginScreen, user phải login lại

## ADDED Requirements

### Requirement: Session state SHALL đồng bộ với Supabase Auth

App SHALL:
- Khởi động: gọi `supabase.auth.getSession()` để check session hiện tại.
- Subscribe `supabase.auth.onAuthStateChange` cho các event: `SIGNED_IN`, `SIGNED_OUT`, `TOKEN_REFRESHED`, `USER_UPDATED`.
- Sau khi có auth session, fetch profile từ `public.profiles` bằng `auth.uid()` và cache trong React state `{ id, username, full_name, role, branch_id, branch_code }`.

App KHÔNG được dùng session state cũ trong React sau khi `onAuthStateChange` fire `SIGNED_OUT` — phải clear state ngay.

#### Scenario: Auto redirect khi refresh token invalid

- **WHEN** `onAuthStateChange` fire `SIGNED_OUT` do refresh fail
- **THEN** app set session state = null
- **AND** hiển thị LoginScreen

#### Scenario: Đăng nhập ở tab A → tab B tự động sync

- **GIVEN** user mở LoginScreen ở tab A và tab B
- **WHEN** user đăng nhập thành công ở tab A
- **THEN** Supabase JS client ở tab B detect qua `storage` event của localStorage
- **AND** `onAuthStateChange` fire `SIGNED_IN` ở tab B
- **AND** tab B tự chuyển sang màn hình chính không cần refresh

### Requirement: Admin quản lý user qua Supabase dashboard hoặc SQL

Hệ thống SHALL KHÔNG có UI trong app cho thao tác:
- Tạo user mới
- Đặt/đổi password
- Đổi role hoặc branch của user

Các thao tác trên SHALL do admin thực hiện qua:
- Helper script `scripts/add-user.mjs` (recommended — tránh sai UUID), HOẶC
- Supabase dashboard → Authentication → Users, HOẶC
- SQL trực tiếp trên `auth.users` và `profiles`.

#### Scenario: Admin thêm nhân viên mới qua script

- **WHEN** admin cần cấp tài khoản cho nhân viên mới tên "linh", role member, chi nhánh SG
- **THEN** admin chạy `node scripts/add-user.mjs --username linh --password abc123 --role member --branch SG --fullname "Nguyễn Linh"`
- **AND** script resolve `branch_id` từ `branch_code = 'SG'`
- **AND** gọi `supabase.auth.admin.createUser({ email: 'linh@hoancau.internal', password: 'abc123', email_confirm: true, user_metadata: { username, full_name, role, branch_id } })`
- **AND** trigger `after_auth_user_created` tự tạo row `profiles`
- **AND** nhân viên login được với username + initial password ngay

#### Scenario: Admin thêm nhân viên qua dashboard

- **WHEN** admin không tiện dùng terminal
- **THEN** admin vào Supabase dashboard → Authentication → Users → "Add user"
- **AND** nhập email `<username>@hoancau.internal` + password + `user_metadata` JSON `{ "username": "linh", "full_name": "Nguyễn Linh", "role": "member", "branch_id": "<sg-uuid>" }`
- **AND** trigger tự tạo profile

#### Scenario: Admin đổi role cho user

- **WHEN** admin cần nâng member "linh" thành admin
- **THEN** admin chạy SQL `UPDATE profiles SET role = 'admin' WHERE username = 'linh'` (admin có RLS UPDATE trên profiles)
- **AND** khi user "linh" refresh app, profile mới được fetch, sidebar hiển thị đủ 5 tab
