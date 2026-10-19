# Proposal: Refine shipment-intake (round 2)

## Status

🟢 **READY** — đã chốt toàn bộ decision qua manual checklist review ngày 2026-07-06.
Sẵn sàng viết tasks.

## Why

Sau khi `fix-shipment-intake-issues` (round 1) đi được 62/76 tasks, mình đứng lại
soát toàn bộ flow "Nhận hàng" bằng cách viết manual checklist theo user story
(dùng cho QA manual + tiền đề automation test). Quá trình soát phát hiện 16 điểm
cần chốt lại — chia thành 4 nhóm:

1. **Role & permissions**: role gate hiện tại (chỉ admin sửa/hủy được bill) sai
   với thực tế nghiệp vụ. Member cần sửa + hủy được bill do mình tạo (mọi thứ
   đều track qua audit_log). Boss KHÔNG được sửa (chỉ xem). Admin KHÔNG được
   cross-branch. Bill đã thu tiền (`paid`) KHÔNG sửa được (phải hủy nếu muốn
   thay đổi — refund tự động qua expense).

2. **Cancel flow**: hiện tại hủy draft = DELETE cứng (mất data + không audit
   được). Cần chuyển sang soft delete (`is_delete=true`). Lý do hủy cần hiện
   thành field riêng trên UI + lưu vào audit_log (không prepend `order_note`
   nữa vì order_note giới hạn 200 ký tự — xem item 9). Hủy đơn paid phải
   auto-tạo 1 row `expenses` với số tiền âm (refund).

3. **Form UI/UX**: bỏ field `expected_id_info` — dùng luôn `order_note` làm dual
   purpose khi tick CCCD/VAT (giới hạn 200 ký tự). Auto-populate địa chỉ
   receiver từ DB lên form. Tick paid ở Lưu nháp → popup confirm (bill paid
   phải là bill chính thức). Thêm nút "Xem bill in" cho preview biên nhận.
   Chặn double-click. No-change save → skip modal + toast.

4. **Data integrity**: `ClientAutocomplete` KHÔNG được suggest số `type='old'`
   (chỉ suggest primary + secondary). Mọi mutation `bills` phải wrap chung
   transaction với INSERT `audit_log` (dùng Supabase RPC function) để tránh
   audit gap khi 1 trong 2 fail.

## What changes

### Group 1: Role & permissions

#### 1.1. Bỏ backdate cho admin (SUPERSEDES fix-shipment-intake-issues §I-4)

Trong `fix-shipment-intake-issues`, admin được sửa "Ngày gửi" (backdate/forward
date). Anh xác nhận nghiệp vụ KHÔNG cho phép backdate — mọi role đều readonly
field "Ngày gửi", giá trị = `session.business_date`.

- `sendDate` input → `disabled` cho MỌI role (kể cả admin).
- `bills.business_date` luôn = `session.business_date` tại thời điểm submit.
- `expectedDeliveryDate` = `sendDate + 1` (giữ derived, readonly, không persist).

#### 1.2. Member sửa + hủy được draft/pending (SUPERSEDES fix §N-4)

- Member sửa được đơn `draft` và `pending` (với `payment_status ∈ {unpaid, free, quote_later}`)
  do mình tạo và cùng chi nhánh mình login.
- Member hủy được draft (soft delete) và pending (cancelled) tương tự.
- Mọi mutation ghi audit_log với `actor_user_id = session.userId`,
  `actor_branch_id = session.branch_id`.

#### 1.3. Boss KHÔNG sửa/hủy bill

- Boss chỉ đọc. Không có nút Sửa hay Hủy trên UI của boss.
- Nếu boss thao tác trực tiếp qua URL/API → RLS reject.

#### 1.4. Admin KHÔNG cross-branch sửa

- Admin login SG chỉ sửa/hủy được bill của chi nhánh SG.
- Bill của chi nhánh khác → chỉ đọc (giống như boss).
- Trên form tạo mới, admin vẫn chọn được branch (khớp với `fix §I-8`).

#### 1.5. Bill paid KHÔNG sửa (phải hủy trước)

- Bill `delivery_status='pending'` + `payment_status='paid'` → nút Sửa disabled
  cho MỌI role.
- Muốn sửa → hủy trước (auto-refund qua expense), rồi tạo bill mới.

### Group 2: Cancel flow

#### 2.1. Draft cancel = soft delete (SUPERSEDES base `shipment-intake` §"Hủy đơn theo trạng thái")

- Hủy draft → **UPDATE `bills.is_delete = true`** (KHÔNG DELETE cứng như hiện tại).
- Draft có `is_delete=true` không hiển thị trên list nháp UI (filter `is_delete=false`).
- Row vẫn tồn tại trong DB để tra cứu qua audit_log / detail cũ.

#### 2.2. Field "lý do hủy" trên UI + audit_log

- Nút Hủy (cả draft + pending) → mở modal có field text "Lý do hủy" (required).
- Submit → ghi lý do vào `audit_log.diff` (JSONB), KHÔNG prepend `order_note`
  (vì order_note giới hạn 200 ký tự — xem 3.1).
- Base spec cũ prepend `order_note` → SUPERSEDE.

#### 2.3. Hủy đơn paid → auto expense refund

- Hủy đơn `pending+paid` → cho phép (không block).
- Sau khi UPDATE `delivery_status='cancelled'`, hệ thống MUST tự động INSERT
  1 row `expenses` với:
  - `amount = -bills.actual_amount_paid` (số âm — biểu diễn refund).
  - `source_bill = bills.id`.
  - `branch_id = bills.branch_id`.
  - `note = "Hoàn cước bill <bill_code> do hủy đơn"`.
  - `created_by = session.userId`.
- Row expense refund này KHÔNG cho admin/member sửa hay xóa (audit-safe).

### Group 3: Form UI/UX

#### 3.1. Bỏ `expected_id_info` — dual-purpose `order_note`

- **Schema change**: DROP COLUMN `bills.expected_id_info`.
- `order_note` (TEXT) thêm CHECK constraint `char_length(order_note) <= 200`.
- Rules `order_note` conditional required:
  - `require_id_check=true` OR `export_vat=true` → order_note REQUIRED.
  - Cả 2 = true → placeholder + error message = "Vui lòng nhập thông tin CCCD, VAT".
  - Chỉ CCCD = true → "Vui lòng nhập thông tin CCCD".
  - Chỉ VAT = true → "Vui lòng nhập thông tin xuất hóa đơn".
  - Không tick gì → optional, placeholder default "Ghi chú thêm nếu cần".
- Bill preview / bill in: hiển thị `order_note` (đã chứa thông tin CCCD/VAT khi cần).
- Migration: backfill data từ `expected_id_info` cũ vào `order_note` (nếu
  order_note cũ không rỗng thì append theo format `<order_note>\n<expected_id_info>`).

#### 3.2. Auto-populate địa chỉ receiver

- Khi receiver được match qua autocomplete/resolve:
  - `clients.address` KHÔNG rỗng → autofill vào `deliveryAddress` input.
  - `clients.address` rỗng → giữ input trống.
- Kết hợp với write-back đã có ở `fix §N-13` để tạo flow đầy đủ (đọc DB ↔ ghi DB).

#### 3.3. Tick paid ở Lưu nháp → popup confirm

- Khi user tick `isPaidImmediately=true` VÀ bấm nút "Lưu nháp":
  - Hiện popup: "Bill đã thanh toán là bill chính thức, không thể là nháp.
    Bạn muốn chuyển sang Lưu đơn?"
  - `[Đồng ý]` → chạy flow Lưu đơn (enforce full validation).
  - `[Hủy]` → giữ form, user tự untick paid rồi Lưu nháp lại.

#### 3.4. Nút "Xem bill in" (preview biên nhận)

- Nút hiển thị:
  - Ngay sau khi Lưu đơn thành công (kèm toast thành công).
  - Trong tab bill detail cho MỌI bill đã có `bill_code`.
- Không hiển với draft (`bill_code=NULL`).
- Click → mở modal preview theo layout in (A5/A6), có nút "In" (`window.print()`).
- Data lấy từ 4 snapshot columns (`sender_name_text`, etc.) — không JOIN clients.
- Bill cancelled → preview vẫn hiển nhưng có watermark/badge "ĐÃ HỦY".

#### 3.5. Double-click guard

- Nút "Lưu đơn", "Lưu nháp", "Hủy", "Cập nhật" → disabled sau click đầu, chỉ
  re-enable khi request hoàn tất (thành công hoặc fail).
- Race check: trước khi UPDATE/DELETE, refetch trạng thái hiện tại — nếu bill
  đã bị người khác mutate (VD cancel bởi user khác) → toast "Đơn đã được cập
  nhật bởi người khác, đang refresh" + refresh UI, không mutation lần 2.

#### 3.6. No-change save → skip modal + toast (MODIFIES fix §N-4)

- Trong form sửa bill, khi user bấm Lưu mà diff RỖNG:
  - KHÔNG hiển modal.
  - KHÔNG UPDATE DB.
  - Toast "Không có thay đổi để lưu".
- Fix §N-4 hiện tại có thể sẽ show modal rỗng — SUPERSEDE.

### Group 4: Data integrity

#### 4.1. Autocomplete KHÔNG suggest số 'old'

- `ClientAutocomplete` khi user gõ tìm khách:
  - Search & suggest CHỈ match row `client_phones` có `type IN ('primary', 'secondary')`.
  - Row `type='old'` KHÔNG được suggest.
- Điểm cần phân biệt: tab tra cứu bill cũ VẪN dùng số 'old' để JOIN hiển thị
  đúng số gốc của bill (đã có ở `add-client-phone-history`) — chỉ autocomplete
  ở form tạo bill mới bị lọc.

#### 4.2. RPC atomic: bill + audit_log 1 transaction

- Mọi mutation `bills` (create, update, cancel, soft-delete) VÀ hủy paid
  (bills + expenses) MUST wrap chung với INSERT `audit_log` trong 1
  transaction Postgres qua Supabase RPC function.
- Nếu bất kỳ bước nào fail → toàn bộ rollback. Client nhận error → toast lỗi.
- RPC signatures (draft, sẽ finalize ở design.md):
  - `create_bill_with_audit(bill_data JSONB, audit_data JSONB)`
  - `update_bill_with_audit(bill_id UUID, bill_data JSONB, audit_data JSONB)`
  - `cancel_bill_with_audit(bill_id UUID, reason TEXT, audit_data JSONB, create_expense BOOLEAN)`
    — khi `create_expense=true` (bill paid), function tự INSERT expense refund.
  - `soft_delete_draft_with_audit(bill_id UUID, reason TEXT, audit_data JSONB)`
- Retry logic phía client cho lỗi transient (VD 23505) vẫn giữ (fix §I-9).

## Capabilities affected

- `shipment-intake` — MODIFIED (backdate, cancel flow, order_note conditional,
  auto-populate address, no-change save, double-click guard, bill preview,
  autocomplete filter, paid không sửa, member sửa được, admin không
  cross-branch, boss không sửa, tick paid ở draft)
- `delivery-and-payment` — MODIFIED (auto expense refund khi hủy paid)
- `audit-log` — MODIFIED (mọi mutation wrap RPC atomic; lý do hủy vào `diff`)
- `customer-management` — MODIFIED (autocomplete filter số 'old')

## Non-goals

- KHÔNG đụng flow giao hàng (delivered).
- KHÔNG đụng revenue report (dù có refund expense, cách render đã đủ handle
  qua sign của amount).
- KHÔNG thêm role mới, không đụng RLS policy chi tiết (chỉ đề cập nguyên tắc).
- KHÔNG viết migration `alter role permissions` (giữ RLS như hiện tại; frontend
  enforce là chính, backend enforce qua RPC function).
- KHÔNG implement UI history của số cũ / lịch sử đơn (đã ở change khác).
- KHÔNG viết Playwright test (đã planning riêng, sẽ dùng manual checklist v2
  làm nguồn).

## Supersedes (từ change khác)

- `fix-shipment-intake-issues §I-4 & §N-1`: phần "admin editable ngày gửi" bị
  bỏ. `expectedDeliveryDate` derived vẫn giữ.
- `fix-shipment-intake-issues §N-4`: rule "chỉ admin/boss sửa được đơn pending"
  bị mở rộng — member cũng sửa được. Rule modal diff giữ nguyên nhưng thêm
  "no-change save skip".
- Base `shipment-intake` §"Hủy đơn theo trạng thái": draft không DELETE cứng
  nữa; lý do hủy không prepend `order_note` nữa.

## Dependencies

- Phụ thuộc `add-server-session` (đã 36/48 done) — cột `bills.business_date`,
  bảng `branch_sessions`.
- Phụ thuộc `add-audit-log` (đã 30/45 done) — bảng `audit_log`, RPC skeleton.
- Phụ thuộc `revamp-payment-and-revenue-model` (đã 62/89 done) — cột
  `bills.actual_amount_paid`, `bill_payment_details`.
- Phụ thuộc `add-client-phone-history` (đã 33/52 done) — `client_phones.type='old'`.
- Phụ thuộc `fix-shipment-intake-issues` (đã 62/76 done) — snapshot columns,
  resolveOrCreateClient, `payment_status='quote_later'`, N-13 write-back address.

**Thứ tự apply đề xuất**: chờ 5 change trên archive xong (hoặc ít nhất
"critical requirements" đã merge vào specs/) rồi mới start round-2 để tránh
conflict merge nặng nề.

## References

- Manual checklist v2: discussion 2026-07-06 (conversation history).
- Confirmed 9 open questions: cùng ngày.
- Change round 1: `openspec/changes/fix-shipment-intake-issues/proposal.md`.
- Change payment: `openspec/changes/revamp-payment-and-revenue-model/proposal.md`.
- Change audit: `openspec/changes/add-audit-log/proposal.md`.
