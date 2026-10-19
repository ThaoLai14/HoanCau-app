# Design: add-audit-log

> Status: 🟢 ready-for-tasks. Snapshot 2026-06-29.

## 1. Architecture overview

```
┌─────────────────────────────────────────┐
│  Frontend (React, src/App.jsx + ...)    │
│                                          │
│  Mutation flow (vd executeUpdateBill):   │
│  1. UPDATE bills SET ... WHERE id = ?    │
│  2. (sau khi 1 thành công)               │
│     await logAudit({ ... })  ──┐         │
│                                 │         │
│  Read flow (section L\u1ecbch s\u1eed \u0111\u01a1n inline): │     │
│  - SELECT FROM audit_log         │         │
│    WHERE entity_id = ?           │         │
│    ORDER BY created_at DESC      │         │
│  - Component <BillHistorySection>│         │
│    auto-fetch khi m\u1edf Bill Detail │         │
│    + auto-refetch sau m\u1ed7i        │         │
│    mutation tr\u00ean bill            │         │
└──────────────────────────────────┼───────┘
                                   ▼
┌─────────────────────────────────────────┐
│  Supabase Postgres                       │
│                                          │
│  ┌─────────────┐    ┌──────────────────┐│
│  │   bills     │    │   audit_log      ││
│  │   clients   │    │   (append-only)  ││
│  │   expenses  │    │                  ││
│  └─────────────┘    └──────────────────┘│
│                                          │
│  RLS:                                    │
│  - INSERT: anyone authenticated          │
│  - SELECT: admin/boss only               │
│  - UPDATE/DELETE: nobody                 │
└─────────────────────────────────────────┘
```

Audit log là **secondary write** — fail không stop main flow. Helper wrapper catch error → console.warn.

## 2. Schema detail

### Migration `add-audit-log-table.sql`

```sql
-- 1. Table
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username TEXT NOT NULL,
  user_role TEXT NOT NULL CHECK (user_role IN ('admin', 'member', 'boss')),

  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'bill', 'client', 'expense', 'session'
  )),
  entity_id UUID,
  entity_label TEXT,

  action TEXT NOT NULL CHECK (action IN (
    'bill_create', 'bill_update', 'bill_cancel',
    'bill_delivered', 'bill_payment_received',
    'client_create', 'client_update', 'client_delete', 'client_blacklist',
    'expense_create', 'expense_update', 'expense_delete',
    'refund_created',
    'session_departure'
  )),

  changes JSONB,
  note TEXT
);

-- 2. Indexes
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX idx_audit_user ON audit_log(user_id);

-- 3. RLS (best-effort vì app chưa dùng Supabase Auth)
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_log_insert_all ON audit_log
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY audit_log_select_all ON audit_log
  FOR SELECT TO anon, authenticated
  USING (true);

-- KHÔNG có policy UPDATE/DELETE → block tất cả (append-only)
```

> ⚠️ Vì app dùng custom auth (LoginScreen so plaintext password trong `public.users`), Supabase client connect anonymously với `anon` key. RLS policy ở trên là **permissive** — KHÔNG thực sự block member đọc audit ở DB level. Cần lock ở **UI/code level**: chỉ admin/boss thấy nút "Lịch sử đơn".
>
> Khi migrate sang Supabase Auth (change riêng), siết lại policy:
> ```sql
> ALTER POLICY audit_log_select_all ON audit_log RENAME TO audit_log_select_admin;
> ALTER POLICY audit_log_select_admin ON audit_log
>   USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin','boss')));
> ```

## 3. Helper module `src/auditLog.js`

```js
import { supabase } from './supabaseClient';

export async function logAudit({
  entityType,
  entityId,
  entityLabel,
  action,
  changes,
  note,
}) {
  try {
    const sessionStr = localStorage.getItem('hc_session');
    if (!sessionStr) {
      console.warn('[audit] no session, skip log');
      return;
    }
    const session = JSON.parse(sessionStr);

    const { error } = await supabase.from('audit_log').insert({
      user_id: session.userId,
      username: session.username || 'unknown',
      user_role: session.role || 'unknown',
      entity_type: entityType,
      entity_id: entityId || null,
      entity_label: entityLabel || null,
      action,
      changes: changes || null,
      note: note || null,
    });

    if (error) console.warn('[audit] insert failed:', error.message);
  } catch (e) {
    console.warn('[audit] exception:', e?.message);
  }
}

export async function fetchAuditLog({ entityType, entityId }) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
```

## 4. Label constants `src/auditLabels.js`

```js
export const FIELD_LABELS = {
  // bills
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
  expected_id_info: 'Thông tin CMND',
  order_note: 'Ghi chú đơn',
  export_vat: 'Xuất VAT',
  business_date: 'Ngày gửi',
  sender_name_text: 'Tên người gửi',
  sender_phone_text: 'SĐT người gửi',
  receiver_name_text: 'Tên người nhận',
  receiver_phone_text: 'SĐT người nhận',
  branch_id: 'Chi nhánh',
  // clients
  fullname: 'Họ tên',
  address: 'Địa chỉ',
  is_blacklist: 'Blacklist',
  blacklist_reason: 'Lý do blacklist',
  // expenses
  amount: 'Số tiền',
  note: 'Ghi chú',
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
  branch_id: {
    // populated runtime từ branches table — fallback hiển thị UUID nếu miss
  },
};

export const ACTION_LABELS = {
  bill_create:           { text: 'tạo đơn',                icon: '🆕',  color: 'emerald' },
  bill_update:           { text: 'sửa đơn',                icon: '✏️',  color: 'amber'   },
  bill_cancel:           { text: 'huỷ đơn',                icon: '❌',  color: 'red'     },
  bill_delivered:        { text: 'giao hàng',              icon: '🚚',  color: 'blue'    },
  bill_payment_received: { text: 'thu cước',               icon: '💰',  color: 'emerald' },
  client_create:         { text: 'tạo khách',              icon: '👤',  color: 'emerald' },
  client_update:         { text: 'sửa khách',              icon: '✏️',  color: 'amber'   },
  client_delete:         { text: 'xoá khách',              icon: '🗑️',  color: 'red'     },
  client_blacklist:      { text: 'đổi blacklist',          icon: '⚠️',  color: 'red'     },
  expense_create:        { text: 'thêm chi phí',           icon: '💸',  color: 'orange'  },
  expense_update:        { text: 'sửa chi phí',            icon: '✏️',  color: 'amber'   },
  expense_delete:        { text: 'xoá chi phí',            icon: '🗑️',  color: 'red'     },
  refund_created:        { text: 'hoàn tiền cho bill huỷ', icon: '↩️',  color: 'orange'  },
  session_departure:     { text: 'xuất bến',               icon: '🚛',  color: 'blue'    },
};

const MONEY_FIELDS = new Set(['shipping_fee', 'goods_value', 'amount']);
const BOOL_FIELDS = new Set([
  'is_home_delivery', 'no_declared_value', 'self_packed',
  'risk_warning', 'require_id_check', 'export_vat', 'is_blacklist',
]);
const DATE_FIELDS = new Set(['business_date']);

function formatVnd(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('vi-VN') + ' VND';
}

function formatValue(field, value) {
  if (value == null || value === '') return '—';
  if (ENUM_LABELS[field]) return ENUM_LABELS[field][value] || String(value);
  if (MONEY_FIELDS.has(field)) return formatVnd(value);
  if (BOOL_FIELDS.has(field)) return value ? 'có' : 'không';
  if (DATE_FIELDS.has(field)) {
    // 'yyyy-MM-dd' → 'dd/MM/yyyy'
    const [y, m, d] = String(value).split('-');
    return `${d}/${m}/${y}`;
  }
  if (field === 'special_stars') return `${value} sao`;
  return String(value);
}

export function renderChanges(changes) {
  // changes = {shipping_fee: [0, 250000], payment_status: ['quote_later', 'paid']}
  if (!changes || typeof changes !== 'object') return [];
  return Object.entries(changes).map(([field, [oldVal, newVal]]) => ({
    label: FIELD_LABELS[field] || field,
    oldText: formatValue(field, oldVal),
    newText: formatValue(field, newVal),
  }));
}
```

## 5. Diff computation

Generic `diffObjects(before, after, allowedFields)`:

```js
export function diffObjects(before, after, allowedFields) {
  const result = {};
  for (const f of allowedFields) {
    const a = before?.[f] ?? null;
    const b = after?.[f] ?? null;
    if (a === b) continue;
    if (a === '' && b === null) continue;
    if (a === null && b === '') continue;
    result[f] = [a, b];
  }
  return Object.keys(result).length ? result : null;
}
```

Allowed fields per entity:
```js
const BILL_AUDIT_FIELDS = [
  'shipping_fee', 'payment_status', 'delivery_status', 'delivery_address',
  'is_home_delivery', 'goods_type', 'goods_value', 'package_count',
  'special_stars', 'no_declared_value', 'self_packed', 'risk_warning',
  'require_id_check', 'expected_id_info', 'order_note', 'export_vat',
  'business_date', 'sender_name_text', 'sender_phone_text',
  'receiver_name_text', 'receiver_phone_text', 'branch_id',
];

const CLIENT_AUDIT_FIELDS = [
  'fullname', 'address', 'is_blacklist', 'blacklist_reason',
];
```

## 6. Integration points

### 6.1 `bill_create` — trong `executeCreateBill` + `executeSaveDraft`

```js
const { data: newBill, error } = await supabase.from('bills').insert(payload).select().single();
if (error) throw error;

await logAudit({
  entityType: 'bill',
  entityId: newBill.id,
  entityLabel: newBill.bill_code || 'Nháp',
  action: 'bill_create',
  changes: null, // create không cần diff, đã hiển thị "tạo đơn" với các thông tin trên row
  note: null,
});
```

> Note: với create, KHÔNG cần `changes` JSON (vì không có before). UI render `bill_create` chỉ hiển thị action + người + thời gian, optionally show 1-2 field key (vd "Khách: Trần A → Lê B, 3 kiện") qua note tự build hoặc qua lookup bill table.

### 6.2 `bill_update` — trong admin edit flow (N-4)

Snapshot trước khi UPDATE:
```js
const beforeSnap = { ...currentBill }; // toàn bộ bill record từ DB lúc mở form
// ... admin sửa form, submit ...
const changes = diffObjects(beforeSnap, formStateAsBillRecord, BILL_AUDIT_FIELDS);
if (!changes) {
  // không có gì thay đổi — vẫn UPDATE nhưng KHÔNG log
  return;
}

const { error } = await supabase.from('bills').update(updatePayload).eq('id', billId);
if (error) throw error;

await logAudit({
  entityType: 'bill',
  entityId: billId,
  entityLabel: bill.bill_code,
  action: 'bill_update',
  changes,
  note: null,
});
```

### 6.3 `bill_cancel`

```js
await logAudit({
  entityType: 'bill',
  entityId: billId,
  entityLabel: bill.bill_code || 'Nháp',
  action: 'bill_cancel',
  changes: null,
  note: cancelReason,  // text user gõ
});
```

### 6.4 `bill_delivered`

```js
await logAudit({
  entityType: 'bill',
  entityId: billId,
  entityLabel: bill.bill_code,
  action: 'bill_delivered',
  changes: { delivery_status: ['pending', 'delivered'] },
  note: null,
});
```

### 6.5 `bill_payment_received`

```js
await logAudit({
  entityType: 'bill',
  entityId: billId,
  entityLabel: bill.bill_code,
  action: 'bill_payment_received',
  changes: { payment_status: ['unpaid', 'paid'] },
  note: `Thu ${formatVnd(amountPaid)}`,
});
```

### 6.6 `client_create` / `client_update` / `client_delete` / `client_blacklist`

```js
// client_create (qua intake hoặc tab QLKH)
await logAudit({
  entityType: 'client',
  entityId: newClient.id,
  entityLabel: newClient.fullname,
  action: 'client_create',
  changes: null,
  note: source === 'intake' ? 'Qua tạo đơn' : 'Qua QL Khách hàng',
});

// client_update
const changes = diffObjects(oldClient, newClientPayload, CLIENT_AUDIT_FIELDS);
if (changes) {
  await logAudit({
    entityType: 'client',
    entityId: client.id,
    entityLabel: client.fullname,
    action: client.is_blacklist !== oldClient.is_blacklist ? 'client_blacklist' : 'client_update',
    changes,
    note: null,
  });
}
```

### 6.7 `expense_create`

```js
await logAudit({
  entityType: 'expense',
  entityId: newExpense.id,
  entityLabel: `${formatVnd(newExpense.amount)} - ${newExpense.note}`,
  action: 'expense_create',
  changes: null,
  note: null,
});
```

### 6.7b `expense_update`

Gọi sau khi admin edit expense trong tab Doanh Thu.

```js
await logAudit({
  entityType: 'expense',
  entityId: expenseId,
  entityLabel: `${formatVnd(newAmount)} - ${newNote}`,
  action: 'expense_update',
  changes: {
    amount: [oldAmount, newAmount],
    note: [oldNote, newNote],
    created_at: [oldDate, newDate],
  },
  note: null,
});
```

### 6.7c `expense_delete`

Gọi sau khi admin soft-delete expense.

```js
await logAudit({
  entityType: 'expense',
  entityId: expenseId,
  entityLabel: `${formatVnd(expense.amount)} - ${expense.note}`,
  action: 'expense_delete',
  changes: { is_delete: [false, true] },
  note: null,
});
```

### 6.7d `refund_created` (auto khi cancel bill đã thu)

Gọi tự động trong `handleConfirmCancelBill` sau khi INSERT expense refund. Xem `revamp-payment-and-revenue-model` D12.

```js
await logAudit({
  entityType: 'expense',
  entityId: refundExpense.id,
  entityLabel: `Hoàn tiền cho bill ${bill.bill_code}`,
  action: 'refund_created',
  changes: {
    amount: [null, refundAmount],
    source_bill: [null, bill.bill_code],
  },
  note: 'Auto tạo khi cancel bill có payment',
});
```

### 6.8 `session_departure`

**UPDATED 2026-07-01**: sau khi merge change `add-server-session`, session được lưu trên DB. Payload đọc từ RETURNING clause của UPDATE thay vì client state.

```js
// Trong advanceDepartureSession helper:
const { data: updated } = await supabase
  .from('branch_sessions')
  .update({ business_date: tomorrow, day_counter: nextLetter, bill_seq: 1, session_start: now, updated_by: session.userId })
  .eq('branch_id', branchId)
  .select('branch_id, business_date, day_counter')
  .single();

await logAudit({
  entityType: 'session',
  entityId: branchId,          // FK sang branches (thay vì null như trước)
  entityLabel: `${branchCode} - ${oldBusinessDate} → ${updated.business_date}`,
  action: 'session_departure',
  changes: {
    business_date: [oldBusinessDate, updated.business_date],
    day_counter: [oldDayCounter, updated.day_counter],
  },
  note: `Tổng ${billCount} đơn`,
});
```

## 7. UI: Section inline `BillHistorySection`

Component mới: `src/BillHistorySection.jsx`. **KHÔNG phải modal** — là 1 section read-only luôn hiển thị cuối Bill Detail (sau section "Thanh toán & Giao nhận"), chỉ hiển thị khi `userRole ∈ {admin, boss}`.

Props: `{ billId }`.

```jsx
function BillHistorySection({ billId }) {
  const [entries, setEntries] = useState(null);
  const reload = useCallback(() => {
    fetchAuditLog({ entityType: 'bill', entityId: billId }).then(setEntries);
  }, [billId]);
  useEffect(() => { reload(); }, [reload]);

  // Parent component gọi onRefreshAudit() sau mỗi mutation trên bill
  // (hoàn tất giao, xác nhận TT, sửa bill, ...) → component refetch.

  return (
    <section className="mt-6 border-t pt-4">
      <h3 className="text-base font-semibold mb-2">📜 Lịch sử đơn</h3>
      {entries === null && <div>Đang tải lịch sử...</div>}
      {entries?.length === 0 && <div className="text-sm text-gray-500">Chưa có lịch sử cho đơn này.</div>}
      <div className="space-y-3">
        {entries?.map(e => <AuditEntry key={e.id} entry={e} />)}
      </div>
    </section>
  );
}

function AuditEntry({ entry }) {
  const meta = ACTION_LABELS[entry.action] || { text: entry.action, icon: '•' };
  const diff = renderChanges(entry.changes); // đã handle case old=null → không mũi tên
  return (
    <div className={`border-l-4 border-${meta.color}-500 pl-3 py-2`}>
      <div className="font-medium text-sm">
        {meta.icon} {formatTime(entry.created_at)} — {entry.username} ({entry.user_role}) {meta.text}
      </div>
      {diff.length > 0 && (
        <ul className="text-sm mt-1 ml-4 list-disc">
          {diff.map((d, i) => (
            <li key={i}>
              {d.label}: {d.oldText !== null ? `${d.oldText} → ${d.newText}` : d.newText}
            </li>
          ))}
        </ul>
      )}
      {entry.note && <div className="text-sm italic mt-1">Ghi chú: {entry.note}</div>}
    </div>
  );
}
```

### Permission

Section HIỂN THỊ khi `userRole ∈ {admin, boss}`. Member KHÔNG thấy. Logic trong Bill Detail parent:

```jsx
{userRole !== 'member' && (
  <BillHistorySection billId={selectedBill.id} key={historyRefreshKey} />
)}
```

Parent thay đổi `historyRefreshKey` sau mỗi mutation → force remount → auto refetch. Hoặc truyền callback ref `reloadFn` thông qua `useImperativeHandle`. Chi tiết để implementation tự chọn.

Vị trí section:
- Bill Detail ở mọi tab list bill (chờ giao, đã giao, đã huỷ, draft).
- Đặt cuối screen, sau section "Thanh toán & Giao nhận"/"Giao hàng & Thu cước".

## 8. Edge cases

| Case | Hành vi |
|---|---|
| `logAudit` fail (mạng/RLS) | console.warn, KHÔNG block main flow |
| User session expired giữa chừng | `getSession()` trả null → skip log + warn |
| Bill được DELETE (chỉ draft) | Audit entry vẫn còn với `entity_id` trỏ tới UUID đã xoá. Render OK vì không JOIN. |
| User bị xoá khỏi `users` | `username` snapshot còn, `user_id` thành NULL (ON DELETE SET NULL). UI hiển thị "username (user_role)" bình thường. |
| Diff `null → ''` hoặc `'' → null` | Skip (coi như không đổi) trong `diffObjects` |
| Bill có 100+ entry (rất hiếm) | Section render full, parent có thể cắt scroll riuên. Không paginate ở MVP. |
| Admin sửa cùng field 2 lần liên tiếp | 2 entry riêng, OK |
| `bill_create` với snapshot fields | Render mỗi field 1 dòng `• <Label>: <newValue>` (không mũi tên vì old=null) |

## 9. Migration order

1. Run `add-audit-log-table.sql` trên Supabase.
2. Add `src/auditLog.js`, `src/auditLabels.js`, `src/BillHistorySection.jsx`.
3. Add 11 `logAudit()` calls vào các mutation hiện có (bill_create snapshot, bill_update diff, ...).
4. Embed `<BillHistorySection>` vào Bill Detail screen ở mọi tab.
5. Smoke test: tạo bill, sửa bill, huỷ bill → mở Bill Detail → section Lịch sử auto-render timeline.

## 10. Non-goals reminder

- KHÔNG implement Option B (tab feed) — defer.
- KHÔNG export, KHÔNG retention, KHÔNG strict RLS (defer auth migration).
- KHÔNG log read events.

## 11. Open follow-ups

- **Option B (activity feed)**: tab "Hoạt động" cho boss xem toàn hệ thống → change `add-activity-feed`.
- **Retention**: nếu sau 1-2 năm log lớn → cân nhắc archive sang table riêng.
- **Strict RLS**: phụ thuộc migration auth (change `migrate-to-supabase-auth`).
- **Activity log cho client/expense**: MVP đã cover qua các action `client_*` và `expense_create`. UI section cho client/expense entity là follow-up nếu cần.
- **Export CSV**: cho boss cần báo cáo audit định kỳ.
