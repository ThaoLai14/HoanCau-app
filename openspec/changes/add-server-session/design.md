# Design: Server-side branch session + `business_date`

> Status: 🟢 ready-for-code. Chốt 2026-07-01.

## 1. Kiến trúc trước / sau

```
TRƯỚC (localStorage per-device):
┌────────────────────────────────┐    ┌────────────────────────────────┐
│  Desktop SG                    │    │  Mobile SG                     │
│  localStorage.hoanCauDayCounter│    │  localStorage.hoanCauDayCounter│
│  {date, counter, sessionStart, │    │  {date, counter, sessionStart, │
│   businessDate}                │    │   businessDate}                │
└────────────────────────────────┘    └────────────────────────────────┘
    ▲                                     ▲
    │ desync khi 1 máy bấm Xuất Bến      │
    └──────── mã đơn trùng ──────────────┘

SAU (server-side):
┌────────────────────────────────┐    ┌────────────────────────────────┐
│  Desktop SG                    │    │  Mobile SG                     │
│  React state (cached session)  │    │  React state (cached session)  │
└────────────────────────────────┘    └────────────────────────────────┘
    │                                     │
    │  fetch/UPDATE                       │  fetch/UPDATE
    ▼                                     ▼
    ┌──────────────────────────────────────────────┐
    │  PostgreSQL: branch_sessions                 │
    │    branch_id | business_date | day_counter | │
    │    bill_seq  | session_start | updated_at  | │
    │    updated_by                                │
    │  (1 row per branch = source of truth)        │
    └──────────────────────────────────────────────┘
```

## 2. Schema

### 2.1 Bảng mới `branch_sessions`

```sql
CREATE TABLE branch_sessions (
  branch_id      UUID PRIMARY KEY REFERENCES branches(id) ON DELETE CASCADE,
  business_date  DATE NOT NULL,
  day_counter    TEXT NOT NULL,        -- vd "A", "B", ..., "AA"
  bill_seq       INT  NOT NULL DEFAULT 1,
  session_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID REFERENCES users(id)
);

COMMENT ON TABLE branch_sessions IS
  'Session state per branch. Source of truth for business_date, bill_code seq/counter.';

COMMENT ON COLUMN branch_sessions.day_counter IS
  'Chữ cái mã ngày, tăng khi Xuất Bến: A → B → ... → Z → AA → AB → ...';
```

### 2.2 Seed 2 row

```sql
INSERT INTO branch_sessions (branch_id, business_date, day_counter, bill_seq, session_start)
SELECT id, CURRENT_DATE, 'A', 1, now()
FROM branches WHERE branch_code = 'SG'
ON CONFLICT (branch_id) DO NOTHING;

INSERT INTO branch_sessions (branch_id, business_date, day_counter, bill_seq, session_start)
SELECT id, CURRENT_DATE, 'A', 1, now()
FROM branches WHERE branch_code = 'GL'
ON CONFLICT (branch_id) DO NOTHING;
```

### 2.3 Cột `bills.business_date`

```sql
ALTER TABLE bills ADD COLUMN business_date DATE;

UPDATE bills
SET business_date = (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
WHERE business_date IS NULL;

ALTER TABLE bills
  ALTER COLUMN business_date SET DEFAULT CURRENT_DATE,
  ALTER COLUMN business_date SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_bills_business_date ON bills(business_date);
CREATE INDEX IF NOT EXISTS idx_bills_branch_business_date ON bills(branch_id, business_date);
```

### 2.4 RLS

`branch_sessions` bảo vệ như `bills` — mọi role đã login đều SELECT được (cần để đọc), chỉ role `admin`/`member` UPDATE được (để tạo đơn / Xuất Bến). Boss KHÔNG UPDATE.

## 3. Code changes surface (App.jsx)

### 3.1 Helper mới `fetchBranchSession(branchId)`

```js
// Returns { branch_id, business_date, day_counter, bill_seq, session_start, updated_at, updated_by }
async function fetchBranchSession(branchId) {
  const { data, error } = await supabase
    .from('branch_sessions')
    .select('*')
    .eq('branch_id', branchId)
    .single();
  if (error) throw error;
  // Auto-roll check: nếu business_date < today (VN) → advance
  const todayVN = toVNDate(new Date());
  if (data.business_date < todayVN) {
    return await advanceToNewDay(branchId, todayVN);
  }
  return data;
}

async function advanceToNewDay(branchId, todayVN) {
  const { data: current } = await supabase
    .from('branch_sessions').select('day_counter').eq('branch_id', branchId).single();
  const nextCounter = nextLetterCounter(current.day_counter);  // A→B, Z→AA, AA→AB
  const { data, error } = await supabase
    .from('branch_sessions')
    .update({
      business_date: todayVN,
      day_counter: nextCounter,
      bill_seq: 1,
      session_start: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: session.userId,
    })
    .eq('branch_id', branchId)
    .select().single();
  if (error) throw error;
  return data;
}
```

### 3.2 Helper `advanceDepartureSession(branchId)` (rewrite)

```js
async function advanceDepartureSession(branchId) {
  const { data: current } = await supabase
    .from('branch_sessions').select('day_counter').eq('branch_id', branchId).single();
  const nextCounter = nextLetterCounter(current.day_counter);
  const tomorrowVN = addDays(toVNDate(new Date()), 1);
  const { data, error } = await supabase
    .from('branch_sessions')
    .update({
      business_date: tomorrowVN,
      day_counter: nextCounter,
      bill_seq: 1,
      session_start: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updated_by: session.userId,
    })
    .eq('branch_id', branchId)
    .select().single();
  if (error) throw error;
  return data;
}
```

### 3.3 Helper `nextLetterCounter(cur)`

```js
// A → B, ..., Z → AA, AA → AB, AZ → BA
function nextLetterCounter(cur) {
  const chars = cur.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] < 'Z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
    chars[i] = 'A'; i--;
  }
  return 'A' + chars.join('');
}
```

### 3.4 Helper `reserveBillCode(branchId, session)`

```js
function reserveBillCode(branchCode, session) {
  const seqPadded = String(session.bill_seq).padStart(2, '0');
  return `${seqPadded}${branchCode}${session.day_counter}${seqPadded}`;
}
```

*Format cũ: `NN{SG|GL}{Letter}NN` = `01SGA02` — giữ nguyên. Cả 2 số đều là `bill_seq`, đúng behavior cũ.*

### 3.5 Insert bill flow

```js
async function executeCreateBill(data) {
  const currentSession = await fetchBranchSession(currentBranch);  // luôn fetch trước
  const billCode = reserveBillCode(branchCode, currentSession);
  const payload = {
    ...existing_fields,
    bill_code: billCode,
    business_date: currentSession.business_date,
  };
  const { data: newBill, error } = await supabase.from('bills').insert(payload).select().single();
  if (error) {
    if (error.code === '23505') {
      // Race hiếm: 2 client insert cùng lúc → retry với session mới
      return executeCreateBill(data);  // recursive, max 3 lần (giới hạn ở caller)
    }
    throw error;
  }
  // Increment seq
  await supabase.from('branch_sessions')
    .update({ bill_seq: currentSession.bill_seq + 1, updated_at: new Date().toISOString(), updated_by: session.userId })
    .eq('branch_id', currentBranch);
  return newBill;
}
```

### 3.6 Helper `toVNDate(ts)` (dùng chung với `revamp-payment-and-revenue-model`)

```js
function toVNDate(ts) {
  if (!ts) return '';
  const d = ts instanceof Date ? ts : new Date(ts);
  const vn = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10);
}
```

> **Cross-ref**: helper này cũng được dùng ở `revamp-payment-and-revenue-model` cho revenue filter. Ai code trước → định nghĩa ở `App.jsx` chung. Change còn lại chỉ dùng.

### 3.7 Điểm gọi

| Điểm | Trước | Sau |
|---|---|---|
| Login xong | Load localStorage | `fetchBranchSession(loggedBranchId)` → cache vào state |
| Mở form Tạo Đơn | Đọc localStorage | `fetchBranchSession(currentBranchId)` → cập nhật cache |
| Bấm "Lưu" tạo đơn | Insert + update localStorage.counter | Insert bill + UPDATE `branch_sessions.bill_seq += 1` |
| Bấm "Xuất Bến" | Update localStorage | `advanceDepartureSession(branchId)` |
| Load Warehouse tab | localStorage.businessDate | Không cần session; filter bill bằng `business_date` cột |
| Load All-Bills tab | localStorage.businessDate | Không cần session; filter bill bằng `business_date` cột |

## 4. UX / Latency

Đo trên free tier Supabase, latency ~50-200ms per query.

| Action | Số query DB | Latency ước tính |
|---|---|---|
| Login | +1 (fetch session lần đầu) | +100ms |
| Mở form Tạo Đơn | +1 (refresh session) | +100ms |
| Bấm Lưu bill | +1 (INSERT) + 1 (UPDATE seq) | +150ms (song hành với insert bill hiện có) |
| Xuất Bến | +1 (UPDATE session) | +100ms |

Tổng: 1 lần tạo đơn thêm ~250-300ms so với trước. Chấp nhận được vì nhân viên đang gõ form 30-60s.

## 5. Edge cases

### 5.1 Auto-roll khi qua ngày mới

Client mở app 08:00 ngày 2026-07-02, session DB có `business_date = 2026-07-01`. `fetchBranchSession` detect và tự UPDATE:
- `business_date = 2026-07-02`
- `day_counter` = next letter (A → B)
- `bill_seq = 1`
- `session_start = now()`

Race: 2 client cùng mở app 08:00 → cả 2 detect → cả 2 UPDATE. Last write wins nhưng end state giống nhau (cùng day_counter, cùng business_date, cùng seq=1). Không nổ.

### 5.2 Xuất Bến sau nửa đêm

Xuất Bến lúc 00:30 ngày 07-02 (trong khi session vẫn đang `business_date=07-01` — chưa auto-roll):
- `advanceDepartureSession` set `business_date = today + 1 = 07-03` (tomorrow của 07-02, không phải 07-02 của trong session).
- Wait — logic đang lấy `tomorrowVN = addDays(toVNDate(new Date()), 1)` — 07-02 + 1 = 07-03. Đúng.
- Auto-roll sau đó (khi mở form lần đầu ngày 07-02): detect `business_date=07-03 > today=07-02` → **KHÔNG auto-roll** (chỉ trigger khi `business_date < today`). Giữ nguyên 07-03. ✓

### 5.3 DB down / mất mạng

`fetchBranchSession` throw → block form Tạo Đơn với error "Không kết nối được server, vui lòng thử lại". User không tạo được đơn. Chấp nhận vì app đã 100% online.

### 5.4 Race 2 client insert bill cùng lúc

Cả 2 fetch session → cùng thấy `bill_seq = 5` → cùng insert bill với `bill_code = 05SGA05`. Client A insert trước → thành công + UPDATE seq=6. Client B insert sau → nhận `23505` (UNIQUE(branch_id, bill_code)) → retry: fetch session mới → thấy seq=6 → insert với `bill_code = 06SGA05` → thành công. Max 3 lần retry.

Race window rất hẹp (~50ms). Với 1 desktop/branch + occasional mobile → hiếm khi nổ. UNIQUE constraint là safety net.

### 5.5 Legacy localStorage vẫn còn

Sau deploy, localStorage cũ vẫn tồn tại trong browser cache. Code mới không đọc → vô hại. Có thể xoá manual: `localStorage.removeItem('hoanCauDayCounter_SG')` etc., nhưng không strict.

## 6. Rollback

Nếu code mới có bug nghiêm trọng:
1. Revert App.jsx về commit trước.
2. Chạy `DROP TABLE branch_sessions;` (không mất data quan trọng — chỉ mất session state hiện tại).
3. `ALTER TABLE bills DROP COLUMN business_date;` (mất backfill; app cũ vẫn chạy bằng `created_at`).
4. Users refresh browser → localStorage cũ hồi sinh vai trò session.

## 7. Impact lên change khác

### 7.1 `fix-shipment-intake-issues`

- **I-9 downgrade**: mô tả trong proposal.md của change đó cần update. Retry modal KHÔNG cần. UNIQUE constraint giữ (safety net cho race hiếm). Code helper `insertBillWithConfirm` không cần build — chỉ cần 1 recursive retry đơn giản trong `executeCreateBill` (max 3 lần).
- **I-4 date input**: default value = `session.business_date` (fetch từ DB), không phải localStorage.
- **Dependency reference**: đổi từ `add-business-date-to-bills` → `add-server-session`.

### 7.2 `revamp-payment-and-revenue-model`

- Revenue tính theo `bill_payment_details.created_at` — KHÔNG dùng `business_date`. Không conflict.
- Helper `toVNDate` được định nghĩa trong change này (ở đâu implement trước thì đặt ở đó, change kia dùng chung).

### 7.3 `add-audit-log`

- Action `session_departure`: log payload `{ old_business_date, new_business_date, old_day_counter, new_day_counter, branch_id }` — data đọc từ DB response của UPDATE (RETURNING clause).

## 8. Verification checklist

- [ ] Anh review proposal + design.
- [ ] 4 delta specs update: `bill-code-generation`, `shipment-intake`, `warehouse-and-departure`, `revenue-reporting`.
- [ ] Tasks phủ hết migration + code refactor + smoke test.
- [ ] Cross-ref cập nhật trong 3 change liên quan (`fix-shipment-intake-issues`, `revamp-payment-and-revenue-model`, `add-audit-log`).
