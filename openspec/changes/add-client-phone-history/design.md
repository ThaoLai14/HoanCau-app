# Design: add-client-phone-history

> Status: 🟢 ready-for-tasks. Snapshot 2026-06-30.

## 1. Data model

### Current schema

```
client_phones (
  id           UUID PRIMARY KEY,
  client_id    UUID REFERENCES clients(id),
  phone_number TEXT,
  type         TEXT          -- in code: 'primary' | 'secondary'
                             -- DB không có CHECK constraint (main spec confirm)
)
```

### New schema (sau migration)

```
client_phones (
  id           UUID PRIMARY KEY,
  client_id    UUID REFERENCES clients(id),
  phone_number TEXT,
  type         TEXT CHECK (type IN ('primary','secondary','old'))   -- NEW CHECK
)
```

Không thêm cột mới (`is_active`, `replaced_by`, `replaced_at`). Tracing đầy đủ qua `audit_log`.

### Invariant constraint (UI-enforced; KHÔNG có CHECK DB cho 1 khách 1 primary)

Mỗi `client_id` không-soft-delete:
- **Có đúng 1 row** `type='primary'` (UI bắt buộc ô Số chính required).
- **Có 0 hoặc 1 row** `type='secondary'`.
- **Có 0..N row** `type='old'`.

DB KHÔNG có UNIQUE constraint trên `(client_id, type)` cho primary — vì:
1. Khó enforce khi có race condition lúc INSERT-UPDATE chéo.
2. Backend logic luôn duy trì invariant qua transaction-like sequence.
3. Vi phạm tạm thời (vd 2 primary trong tích tắc giữa INSERT mới và UPDATE cũ) chấp nhận được vì là client-side mutation.

> Future improvement (out of scope): nếu cần strict thì thêm partial UNIQUE INDEX `WHERE type='primary'`.

## 2. Migration SQL

File: `add-client-phone-old-type.sql` (root repo, style giống `add-business-date.sql`).

```sql
-- 2026-06-30 — Add 'old' type to client_phones
-- Tham chiếu: openspec/changes/add-client-phone-history/

-- 1. Drop CHECK constraint cũ nếu có (tên có thể khác — adjust)
ALTER TABLE client_phones
  DROP CONSTRAINT IF EXISTS client_phones_type_check;

-- 2. Add CHECK constraint mới với 3 giá trị
ALTER TABLE client_phones
  ADD CONSTRAINT client_phones_type_check
  CHECK (type IN ('primary', 'secondary', 'old'));

-- 3. Sanity check: tìm orphan FK trong bills (informational, không tự fix)
-- Chạy 1 lần thủ công sau migration:
-- SELECT b.id, b.bill_code, b.sender_phone_id
-- FROM bills b LEFT JOIN client_phones p ON p.id = b.sender_phone_id
-- WHERE b.sender_phone_id IS NOT NULL AND p.id IS NULL;
-- SELECT b.id, b.bill_code, b.receiver_phone_id
-- FROM bills b LEFT JOIN client_phones p ON p.id = b.receiver_phone_id
-- WHERE b.receiver_phone_id IS NOT NULL AND p.id IS NULL;
```

Không có backfill cần thiết — chưa có row `'old'` nào.

## 3. Save logic — compare-and-diff

### Inputs

State của form khi user bấm Lưu:
- `editingClientId`: UUID hoặc null
- `newClientName: string`
- `newClientAddress: string`
- `isBlacklist: boolean`
- `blacklistReason: string`
- `newClientPhone: string`         // ô Số chính
- `newClientPhoneSec: string`      // ô Số phụ
- `newClientOldPhones: string[]`   // list số cũ (đã rớt xuống trong phiên edit này hoặc load từ DB)

DB state hiện tại (load lúc enter edit mode):
- `initial.primary: { id, phone_number } | null`
- `initial.secondary: { id, phone_number } | null`
- `initial.olds: Array<{ id, phone_number }>`

### Modal prompt (D5)

Trước khi save (validate xong):

```js
if (initial.primary && newClientPhone !== initial.primary.phone_number) {
  const ok = await askConfirm({
    title: 'Số chính đã được thay đổi',
    message: `Cũ: ${initial.primary.phone_number}\nMới: ${newClientPhone}`,
    confirmText: 'Xác nhận',
    cancelText: 'Huỷ'
  });
  if (!ok) return;
}
// Số phụ KHÔNG prompt — silent demote (D6)
```

### Plan operations

```
ops = []

// 1. Số chính
if (!initial.primary && newClientPhone) {
  // Khách mới (create) HOẶC khách cũ chưa có primary (edge case)
  ops.push({ kind: 'INSERT', phone: newClientPhone, type: 'primary' })
} else if (initial.primary && newClientPhone !== initial.primary.phone_number) {
  // Đổi số chính → demote cũ + insert mới
  ops.push({ kind: 'UPDATE_TYPE', id: initial.primary.id, type: 'old' })
  ops.push({ kind: 'INSERT', phone: newClientPhone, type: 'primary' })
}
// else: không đổi gì với primary

// 2. Số phụ
if (!initial.secondary && newClientPhoneSec) {
  ops.push({ kind: 'INSERT', phone: newClientPhoneSec, type: 'secondary' })
} else if (initial.secondary && !newClientPhoneSec) {
  // User xoá số phụ → demote cũ thành 'old' (D6)
  ops.push({ kind: 'UPDATE_TYPE', id: initial.secondary.id, type: 'old' })
} else if (initial.secondary && newClientPhoneSec !== initial.secondary.phone_number) {
  // Đổi số phụ → demote cũ + insert mới
  ops.push({ kind: 'UPDATE_TYPE', id: initial.secondary.id, type: 'old' })
  ops.push({ kind: 'INSERT', phone: newClientPhoneSec, type: 'secondary' })
}

// 3. Số cũ — read-only, không cho admin sửa qua UI
// UI populate from DB (initial.olds) + any auto-demoted trong phiên edit.
// Logic ops trên đã handle phần demote; KHÔNG cần ops riêng cho 'old' list.

// 4. clients UPDATE
ops.unshift({ kind: 'UPDATE_CLIENT', payload: { fullname, address, is_blacklist, blacklist_reason } })
```

### Execute (non-transactional, best-effort)

Supabase JS không có transaction; chạy tuần tự:

```js
for (const op of ops) {
  if (op.kind === 'UPDATE_CLIENT') {
    await supabase.from('clients').update(op.payload).eq('id', editingClientId)
  } else if (op.kind === 'UPDATE_TYPE') {
    await supabase.from('client_phones').update({ type: op.type }).eq('id', op.id)
  } else if (op.kind === 'INSERT') {
    await supabase.from('client_phones').insert({
      client_id: editingClientId, phone_number: op.phone, type: op.type
    })
  }
}
```

> Note: nếu 1 op fail giữa chừng → state DB không nhất quán. Chấp nhận trade-off (app hiện không có transaction wrapper). Mitigation: log lỗi rõ, không xoá row cũ trước insert mới (sequential safe).

### Edge cases

| Case | Form state | Initial DB | Ops sinh ra |
|---|---|---|---|
| Khách mới, chỉ chính | primary='A', sec='', olds=[] | (no record) | INSERT_CLIENT, INSERT(A, primary) |
| Khách mới, chính + phụ | primary='A', sec='B', olds=[] | (no record) | INSERT_CLIENT, INSERT(A, primary), INSERT(B, secondary) |
| Sửa chỉ tên | primary='A', sec='', olds=[] | primary=A | UPDATE_CLIENT (đổi fullname) |
| Đổi chính (modal Xác nhận) | primary='Z', sec='', olds=[A] | primary=A | UPDATE_CLIENT, UPDATE_TYPE(A→old), INSERT(Z, primary) |
| Xoá phụ | primary='A', sec='', olds=[B] | primary=A, secondary=B | UPDATE_CLIENT, UPDATE_TYPE(B→old) |
| Đổi phụ | primary='A', sec='Y', olds=[B] | primary=A, secondary=B | UPDATE_CLIENT, UPDATE_TYPE(B→old), INSERT(Y, secondary) |
| Đổi chính + xoá phụ | primary='Z', sec='', olds=[A, B] | primary=A, secondary=B | UPDATE_CLIENT, UPDATE_TYPE(A→old), INSERT(Z, primary), UPDATE_TYPE(B→old) |

### Logic populate `newClientOldPhones` trên form

Khi user vừa đổi Số chính & xác nhận modal:
```js
if (modalConfirmed) {
  setNewClientOldPhones(prev => [...prev, initial.primary.phone_number])
}
```
(Cũng cho Số phụ — silent, không modal.)

Khi save thành công + refresh:
- `fetchData()` gọi lại → `clients` với `client_phones(*)` mới nhất.
- `resetClientForm()` clear hết form về Add mode.

## 4. UI mockup

### Form section

```
┌── ✏️ Sửa Khách Hàng ──────────────────────┐
│                                            │
│  Họ tên *  [autoFocus]                     │
│  ┌──────────────────────────────────────┐  │
│  │ Trần A                               │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  📞 Số điện thoại chính *                  │
│  ┌──────────────────────────────────────┐  │
│  │ 0912-NEW                             │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  📞 Số điện thoại phụ                      │
│  ┌──────────────────────────────────────┐  │
│  │                                      │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  📜 Số điện thoại cũ                       │
│   ┌──────────────────────────────────┐     │
│   │ • 0909-A    (chính cũ)           │     │
│   │ • 0988-OLD  (phụ cũ)             │     │
│   └──────────────────────────────────┘     │
│   Không sửa được — đây là lịch sử,         │
│   được dùng để bảo toàn bill cũ.           │
│                                            │
│  Địa chỉ mặc định                          │
│  ┌──────────────────────────────────────┐  │
│  │ 10 Lê Lợi                            │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  ☐ Blacklist                               │
│                                            │
│  [ Lưu ]      [ Huỷ ]                      │
└────────────────────────────────────────────┘

┌── 📜 Lịch sử thay đổi ────────────────────┐  ← chỉ hiện ở edit mode
│ Ngày            Nhân viên     Thay đổi    │
│ ───────────────────────────────────────── │
│ 30/06 14:30     Linh (admin)  Đổi số      │
│                               chính:      │
│                               0909-A →    │
│                               0912-NEW    │
│ 28/06 10:00     Hùng (admin)  Tạo khách   │
└────────────────────────────────────────────┘
```

### Modal confirm

```
╔═══════════════════════════════════════════╗
║ Số chính đã được thay đổi                 ║
╠═══════════════════════════════════════════╣
║                                           ║
║  Cũ:  0909-A                              ║
║  Mới: 0912-NEW                            ║
║                                           ║
║         [ Huỷ ]    [ Xác nhận ]           ║
╚═══════════════════════════════════════════╝
```

Note: không có 2 radio "typo / đổi số" (đơn giản hoá theo D5).

### Bảng danh sách (không đổi, ngoại trừ ý nghĩa)

| Khách | SĐT | Địa chỉ | Trạng thái |
|---|---|---|---|
| Trần A | Chính: 0912-NEW<br>(cũ): 0909-A | 10 Lê Lợi | ✅ Hoạt động |

Quy tắc render trong cột SĐT:
- Hiển thị primary với prefix "Chính:".
- Hiển thị secondary với prefix "Phụ:".
- (Tùy chọn) hiển thị olds với prefix "(cũ):", font nhỏ hơn, mờ hơn.
- Có thể giới hạn show 1-2 số cũ rồi "(còn 3 số nữa)" — out of scope MVP.

## 5. Click row → autofill + scroll + focus + GIỮ PAGINATION

```js
const handleStartEditClient = (c) => {
  const phones = c.client_phones || []
  const primary = phones.find(p => p.type === 'primary')
  const secondary = phones.find(p => p.type === 'secondary')
  const olds = phones.filter(p => p.type === 'old')

  setEditingClientId(c.id)
  setNewClientName(c.fullname || '')
  setNewClientPhone(primary?.phone_number || '')
  setNewClientPhoneSec(secondary?.phone_number || '')
  setNewClientOldPhones(olds.map(p => p.phone_number))     // NEW
  setNewClientAddress(c.address || '')
  setIsBlacklist(!!c.is_blacklist)
  setBlacklistReason(c.blacklist_reason || '')

  // KHÔNG đụng setClientPage — giữ phân trang (D8)
  window.scrollTo({ top: 0, behavior: 'smooth' })

  // NEW: focus ô Họ tên
  setTimeout(() => {
    document.querySelector('input[data-client-form-fullname]')?.focus()
  }, 100)  // delay nhỏ để scroll xong + form re-render
}
```

`fetchData()` đã có sẵn `client_phones(*)` join, không cần thay đổi query.

## 6. Audit log integration

### Action mapping

Mỗi save khách qua `handleAddClient`:
- **Tạo mới**: `logAudit({ action: 'client_create', entityId: clientId, changes: { ...snapshot } })`
  - `changes` snapshot fields theo pattern bill_create: `{fullname, address, phone_primary, phone_secondary, is_blacklist}` với format `[null, value]`.
- **Sửa khách cũ**: `logAudit({ action: 'client_update', entityId: editingClientId, changes: diffObject })`
  - `diffObject` merge:
    - clients diff: `fullname`, `address`, `is_blacklist`, `blacklist_reason` (dùng `diffObjects()` helper).
    - phone diff: `phone_primary: [old, new]`, `phone_secondary: [old, new]`, `phone_demoted_to_old: [null, "<số>"]` cho mỗi số bị demote.
  - 1 entry tổng cho cả save action.

### Field labels mapping (auditLabels.js)

Bổ sung:
```js
FIELD_LABELS.phone_primary       = 'Số điện thoại chính'
FIELD_LABELS.phone_secondary     = 'Số điện thoại phụ'
FIELD_LABELS.phone_demoted_to_old = 'Số chuyển thành cũ'
```

ENUM_LABELS không cần thêm vì là plain text.

### Render label trên section "Lịch sử thay đổi"

Dùng chung pattern `renderChanges()` đã có trong `auditLabels.js`. Render mỗi diff = 1 bullet trong cell "Thay đổi":
```
30/06 14:30  Linh (admin)  • Số điện thoại chính: 0909-A → 0912-NEW
                            • Số chuyển thành cũ: 0909-A
```

## 7. Cross-ref với change `add-audit-log`

### Bổ sung vào `add-audit-log` (delta của change này thêm vào delta spec audit-log):

**ADDED Requirement: Section "Lịch sử thay đổi" inline trong form Sửa Khách Hàng (admin/boss)**

UI form Sửa Khách Hàng (tab QLKH) SHALL có 1 section read-only **"📜 Lịch sử thay đổi"** ngay dưới form (cùng cột trái, dưới nút Lưu/Huỷ). Section CHỈ hiển thị khi:
- `userRole ∈ {admin, boss}`, AND
- `editingClientId !== null` (đang ở chế độ Sửa, KHÔNG phải chế độ Thêm Mới).

Section render bảng 3 cột: Ngày | Nhân viên | Thay đổi.

(Chi tiết scenarios trong delta spec.)

### Sự khác biệt với BillHistorySection

| | BillHistorySection (đơn) | ClientHistorySection (khách) |
|---|---|---|
| Trigger hiển thị | mở Bill Detail | `editingClientId !== null` |
| Vị trí | Cuối Bill Detail | Dưới form Sửa Khách Hàng |
| Layout | Timeline vertical (icon + diff bullets) | **Table 3 cột** (Ngày, Nhân viên, Thay đổi) |
| Auto-refresh | Sau mutation trên bill | Sau khi bấm Lưu thành công |
| Entity type | `entityType='bill'` | `entityType='client'` |

> Layout khác (table vs timeline) — vì user yêu cầu cụ thể "3 cột: ngày, nhân viên, thay đổi". Cell "Thay đổi" vẫn render bullet list giống nhau.

## 8. State machine row client_phones

```
                        ┌─────────────────┐
                        │   (no record)   │
                        └────────┬────────┘
                                 │ INSERT (type='primary')
                                 ▼
                        ┌─────────────────┐         ┌─────────────────┐
                        │     PRIMARY     │◀────────│   SECONDARY     │
                        │  (active main)  │         │ (active backup) │
                        └────────┬────────┘         └────────┬────────┘
                                 │                            │
            UPDATE type='old'    │                            │  UPDATE type='old'
            (khi user đổi chính) │                            │  (khi user xoá phụ)
                                 ▼                            ▼
                        ┌──────────────────────────────────────┐
                        │              OLD                     │
                        │  (read-only, bảo toàn FK bill cũ)    │
                        │  KHÔNG có transition out             │
                        └──────────────────────────────────────┘

  ⚠️ KHÔNG bao giờ: DELETE row, UPDATE phone_number trên row đã có bill ref.
```

> Note: từ `PRIMARY` ↔ `SECONDARY` không có transition trực tiếp trong scope MVP. Nếu cần promote phụ → chính: workaround là gõ tay vào ô chính + xoá ô phụ (sẽ tạo 2 row mới + demote 2 row cũ → có thể tốn không gian). Out of scope optimize.

## 9. Edge cases

| Case | Hành vi |
|---|---|
| Save fail giữa chừng (vd UPDATE_TYPE thành công, INSERT mới fail) | Khách có 0 primary tạm thời. Lần save kế khi user retry: form vẫn có giá trị Số chính → INSERT thành công → state nhất quán lại. Log warning. |
| Race condition 2 admin sửa cùng 1 khách | Last-write-wins. UI ko có optimistic lock. Accept. |
| Khách bị soft-delete (`is_delete=true`) | KHÔNG hiển thị trong list QLKH. Edit form đóng. |
| Phone trùng chính xác (vd user xoá rỗng primary rồi gõ lại đúng số cũ) | `newClientPhone === initial.primary.phone_number` → no-op, không trigger modal. |
| Phone primary giống secondary (cả 2 ô = '0909-A') | Validation form chặn submit; toast "SĐT chính và phụ phải khác nhau". |
| Phone trùng với 1 số trong list 'old' (vd user gõ lại số đã old) | Cho phép — INSERT row mới với cùng phone_number nhưng id khác. Bill mới trỏ về row mới; bill cũ vẫn trỏ row 'old' (FK bảo toàn). |
| Empty form save | Validation chặn (Họ tên + Số chính required). |

## 10. Performance

- Load: `fetchData()` đã JOIN `client_phones(*)`; tất cả phone (kể cả 'old') load 1 lượt. OK với <500 khách + <10 phones/khách.
- Save: 1-5 query tuần tự per save. <1s typical.
- Audit log render: 1 query `audit_log` lọc theo `entity_id=clientId` + sort DESC, limit ~50 entries. OK.

## 11. Migration order

1. Run `add-client-phone-old-type.sql` trên Supabase.
2. Update `auditLabels.js` thêm 3 field labels.
3. Refactor `handleAddClient` theo §3.
4. Update `handleStartEditClient` theo §5.
5. Update UI form: thêm vùng "Số cũ" read-only.
6. Thêm `ClientHistorySection` component dưới form (gated by `editingClientId !== null && userRole !== 'member'`).
7. Add modal confirm (D5).
8. Add `logAudit()` calls trong `handleAddClient`.
9. Smoke test.

## 12. Open follow-ups

- Promote phụ → chính (không qua 'old' trung gian) — optimize.
- Hỗ trợ admin xoá hẳn 1 số 'old' không bao giờ có bill ref (cleanup).
- Visual badge "(cũ)" trên Bill Detail khi phone đang là 'old'.
- Restrict autocomplete intake: optional flag để KHÔNG suggest số `'old'` (UX: tránh khách dùng số cũ).
