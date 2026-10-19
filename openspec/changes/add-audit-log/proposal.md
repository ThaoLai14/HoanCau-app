# Proposal: Add audit log

## Status

🟢 **READY** — chốt scope 2026-06-29, revised 2026-06-30 (Option A revised: **inline section "Lịch sử đơn"** luôn hiển thị trên Bill Detail, KHÔNG phải modal). Option B (tab feed toàn hệ thống) defer change sau.

## Why

App đang cho admin sửa nhiều thứ (sửa bill pending — N-4 trong `fix-shipment-intake-issues`, sửa khách, huỷ đơn, thêm chi phí, đánh giao hàng, xuất bến...) mà KHÔNG có chỗ ghi lại ai làm gì lúc nào. Khi xảy ra tranh chấp (vd "ai sửa cước từ 250k xuống 200k?") thì hiện tại không có cách truy ngược → bị động.

I-7 ban đầu (thêm `updated_by`/`updated_at` trên `bills`) chỉ giải quyết được "lần sửa cuối" — KHÔNG giữ lịch sử. Anh muốn "ghi log để phòng hờ" → cần solution lưu được toàn bộ chuỗi thao tác.

Stack hiện tại (React SPA + Supabase, không có Node backend) → KHÔNG ghi file log thực sự được. Solution khả thi: 1 table Postgres dedicated cho audit, + UI render thành timeline tiếng Việt dễ đọc.

## What changes

### Schema mới: `audit_log` table

```sql
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Ai
  user_id UUID REFERENCES users(id),
  username TEXT NOT NULL,        -- snapshot (đề phòng user bị xoá)
  user_role TEXT NOT NULL,       -- snapshot: 'admin' | 'member' | 'boss'

  -- Đối tượng bị tác động
  entity_type TEXT NOT NULL,     -- 'bill' | 'client' | 'expense' | 'session'
  entity_id UUID,                -- nullable cho session events
  entity_label TEXT,             -- vd bill_code "05SGA02", clients.fullname

  -- Thao tác
  action TEXT NOT NULL,          -- xem bảng "Sự kiện được log"
  changes JSONB,                 -- diff field cũ → mới (chỉ khi update)
  note TEXT                      -- ghi chú tự do (lý do huỷ, etc.)
);

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id);
```

`audit_log` là **append-only**: không UPDATE, không DELETE. RLS chặn member, chỉ admin/boss đọc được.

### Helper `logAudit()`

1 hàm duy nhất, gọi sau mọi mutation cần track:

```js
async function logAudit({
  entityType, entityId, entityLabel,
  action, changes, note,
}) {
  const session = getSession(); // existing helper
  await supabase.from('audit_log').insert({
    user_id: session.userId,
    username: session.username,
    user_role: session.role,
    entity_type: entityType,
    entity_id: entityId,
    entity_label: entityLabel,
    action,
    changes: changes || null,
    note: note || null,
  });
}
```

Lỗi từ `logAudit` MUST KHÔNG block luồng nghiệp vụ chính — nếu fail, chỉ console.warn (audit là phụ trợ, không stop user).

### Sự kiện được log (scope MVP)

| `action` | Khi nào |
|---|---|
| `bill_create` | Tạo bill (cả pending lẫn draft) |
| `bill_update` | Admin sửa bill pending (N-4) hoặc convert draft → pending |
| `bill_cancel` | Huỷ bill (draft hoặc pending) |
| `bill_delivered` | Đánh dấu giao xong |
| `bill_payment_received` | Thu cước cho đơn `unpaid` |
| `client_create` | Tạo khách mới (qua intake hoặc qua tab QLKH) |
| `client_update` | Sửa khách (qua tab QLKH) |
| `client_delete` | Soft-delete khách |
| `client_blacklist` | Đánh blacklist hoặc bỏ blacklist |
| `expense_create` | Thêm chi phí |
| `session_departure` | Xuất bến (rollover business_date) |

KHÔNG log: login, autocomplete query, mở form, xem dữ liệu.

### Label mapping (UI render)

2 file constants để map technical → tiếng Việt:

```js
// src/auditLabels.js
export const FIELD_LABELS = {
  shipping_fee: 'Cước phí',
  payment_status: 'Trạng thái TT',
  delivery_status: 'Trạng thái giao',
  delivery_address: 'Địa chỉ giao',
  is_home_delivery: 'Giao tận nơi',
  goods_type: 'Loại hàng',
  goods_value: 'Giá trị hàng',
  package_count: 'Số kiện',
  special_stars: 'Sao đặc biệt',
  no_declared_value: 'Không khai giá trị',
  self_packed: 'Tự đóng gói',
  risk_warning: 'Cảnh báo rủi ro',
  require_id_check: 'Kiểm tra CMND',
  order_note: 'Ghi chú đơn',
  sender_name_text: 'Tên người gửi',
  sender_phone_text: 'SĐT người gửi',
  receiver_name_text: 'Tên người nhận',
  receiver_phone_text: 'SĐT người nhận',
  business_date: 'Ngày gửi',
  // clients
  fullname: 'Họ tên',
  address: 'Địa chỉ',
  is_blacklist: 'Blacklist',
  blacklist_reason: 'Lý do blacklist',
};

export const ENUM_LABELS = {
  payment_status: {
    paid: 'Đã thanh toán',
    unpaid: 'Chưa TT',
    free: 'Miễn phí',
    quote_later: 'Báo giá sau',
  },
  delivery_status: {
    pending: 'Chờ giao',
    delivered: 'Đã giao',
    cancelled: 'Đã huỷ',
    draft: 'Nháp',
  },
};

export const ACTION_LABELS = {
  bill_create: { text: 'tạo đơn', icon: '🆕', color: 'emerald' },
  bill_update: { text: 'sửa đơn', icon: '✏️', color: 'amber' },
  bill_cancel: { text: 'huỷ đơn', icon: '❌', color: 'red' },
  bill_delivered: { text: 'giao hàng', icon: '🚚', color: 'blue' },
  bill_payment_received: { text: 'thu cước', icon: '💰', color: 'emerald' },
  client_create: { text: 'tạo khách', icon: '👤➕', color: 'emerald' },
  client_update: { text: 'sửa khách', icon: '✏️', color: 'amber' },
  client_delete: { text: 'xoá khách', icon: '🗑️', color: 'red' },
  client_blacklist: { text: 'đánh blacklist', icon: '⚠️', color: 'red' },
  expense_create: { text: 'thêm chi phí', icon: '💸', color: 'orange' },
  expense_update: { text: 'sửa chi phí', icon: '✏️', color: 'amber' },
  expense_delete: { text: 'xoá chi phí', icon: '🗑️', color: 'red' },
  refund_created: { text: 'hoàn tiền cho bill huỷ', icon: '↩️', color: 'orange' },
  session_departure: { text: 'xuất bến', icon: '🚛', color: 'blue' },
};
```

### Helper render diff sang tiếng Việt

```js
function renderChanges(changes, entityType) {
  // changes = {shipping_fee: [0, 250000], payment_status: ['quote_later', 'paid']}
  // → ["Cước phí: 0 → 250,000 VND", "Trạng thái TT: Báo giá sau → Đã thanh toán"]
}
```

Quy tắc format:
- Số tiền (field nằm trong allowlist tiền): formatVnd (`250,000 VND`).
- Boolean: `true → "có"`, `false → "không"`.
- Enum: lookup `ENUM_LABELS[field]`.
- FK (`sender_id`, `receiver_id`, ...): KHÔNG track diff trực tiếp — admin sửa khách thì khách mới đã có audit_log entry riêng (`client_update` hoặc `client_create`). Bill diff sẽ track `sender_name_text` (snapshot) thay vì `sender_id`.
- Ngày: dd/MM/yyyy.
- Sao: `2 → 0` hiển thị `"2 sao → 0 sao"`.

### UI: Section inline "Lịch sử đơn" trên bill detail

Trên panel chi tiết bill (mọi tab list bill), thêm **1 section read-only "📜 Lịch sử đơn" luôn hiển thị** (KHÔNG phải modal, không cần nút mở). Section vị trí sau phần "Thanh toán & Giao nhận":

```
┌─── 📜 Lịch sử đơn 05SGA02 ─────────────────────────┐
│ ❌ 18:00 26/06/2026  Linh (admin) huỷ đơn          │
│    Ghi chú: "Khách trả hàng do hỏng kiện"          │
│                                                    │
│ 🚚 16:00 25/06/2026  Tài (member) giao hàng        │
│                                                    │
│ ✏️ 14:30 25/06/2026  Linh (admin) sửa đơn          │
│    • Cước phí: 0 VND → 250,000 VND                 │
│    • Trạng thái TT: Báo giá sau → Đã thanh toán    │
│                                                    │
│ 🆕 09:15 25/06/2026  Hùng (admin) tạo đơn          │
│    • Cước phí: Báo giá sau                         │
│    • Tên người gửi: Trần A                         │
│    • SDT người gửi: 0909-A                         │
│    • Tên người nhận: Lê B                          │
│    • Số kiện: 3                                    │
└────────────────────────────────────────────────────┘
```

- Section LUÔN HIỂN THỊ khi `userRole ∈ {admin, boss}` (member KHÔNG thấy).
- Sắp xếp NEWEST → OLDEST (lịch sử gần nhất ở trên).
- Hiển thị icon + thời gian + tên user + role + action tiếng Việt.
- Render diff theo helper: mỗi field 1 bullet `• <Label>: <old> → <new>`. Case `bill_create` (old=null) → chỉ hiển thị new value, không có mũi tên.
- Nếu `changes = null` (vd `bill_cancel`) → chỉ hiển thị action + thời gian + note.
- `bill_create` SHALL chứa snapshot `{field: [null, value]}` cho các field khởi tạo (shipping_fee, sender_*, receiver_*, package_count, ...) → section render loạt bullet danh sách field, không cần extra query.
- Auto-refetch sau mỗi mutation trên bill (vd sau "Hoàn tất giao hàng" → section re-render với entry mới).
- Empty state: "Chưa có lịch sử cho đơn này."
- Permission: admin/boss thấy section; member KHÔNG thấy.

### RLS policy

```sql
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

-- Insert: mọi user đăng nhập (server-side validate user_id qua auth.uid())
CREATE POLICY audit_log_insert_all ON audit_log
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Select: chỉ admin/boss
CREATE POLICY audit_log_select_admin ON audit_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u
      WHERE u.id = auth.uid()
        AND u.role IN ('admin', 'boss')
    )
  );

-- Update/Delete: KHÔNG cho phép (append-only)
-- (không tạo policy = block tất cả)
```

> ⚠️ App hiện không dùng Supabase Auth (auth dùng custom `public.users` + plaintext password trong LoginScreen). RLS dùng `auth.uid()` sẽ không hoạt động trực tiếp. Trong design.md sẽ chốt lại — phương án tạm: dựa vào logic client-side (chỉ admin/boss query). Sau khi migrate sang Supabase Auth (change riêng), siết bằng RLS.

## Capabilities affected

- `audit-log` — **NEW** capability (tạo spec mới `openspec/specs/audit-log/spec.md` sau khi archive change này).

## Non-goals

- KHÔNG implement Option B (tab "Hoạt động" feed toàn hệ thống). Defer change sau.
- KHÔNG track read events (login, mở form, autocomplete) — quá ồn.
- KHÔNG migrate auth sang Supabase Auth — RLS sẽ làm best-effort, defer hard security tới change auth.
- KHÔNG export audit log ra CSV / PDF — defer.
- KHÔNG retention policy (xoá log cũ) — giữ vĩnh viễn cho đến khi anh quyết.
- KHÔNG track diff cho FK columns trực tiếp (`sender_id`, ...) — chỉ track snapshot text columns (đã có ở `fix-shipment-intake-issues` N-12).
- KHÔNG block luồng nghiệp vụ khi `logAudit` fail — chỉ warn.

## Dependencies

- `fix-shipment-intake-issues` (N-12 snapshot columns) — bill audit trail dùng `sender_name_text` để render diff người gửi thay vì lookup FK.
- Anh muốn merge `fix-shipment-intake-issues` xong rồi mới làm `add-audit-log` (tránh xung đột).

## References

- Discussion 2026-06-29: anh muốn "ghi file log để phòng hờ" → chốt dùng audit_log table + timeline UI tiếng Việt.
- I-7 trong `fix-shipment-intake-issues` được close bằng change này.
- Option B (activity feed) sẽ thành change `add-activity-feed` sau.
