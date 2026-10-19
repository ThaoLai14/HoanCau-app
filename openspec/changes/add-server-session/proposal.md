# Proposal: Add server-side branch session + `business_date` column

## Status

🟢 **READY** — chốt vòng 2 ngày 2026-07-01. Gộp scope cũ (`add-business-date-to-bills`) với chuyển session sang server-side.

## Why

Hai vấn đề gốc, cùng nguồn:

**Vấn đề 1 — Xuất Bến giữa ngày sai ngày kinh doanh.**
Khi nhân viên bấm **Xuất Bến** giữa ngày (ví dụ 14:30), code hiện chỉ tăng `dayCounter`/`sessionStart` trong `localStorage` để các bill **tiếp theo** nhận mã của chuyến mai (ví dụ `A02 → A03`). Nhưng các bill ấy vẫn có `created_at = now()` rơi vào ngày calendar HÔM NAY. Hệ quả:
1. Tab **Danh Sách Bốc Xếp** lọc theo `created_at::date` → đơn của chuyến mai bị trộn vào danh sách hôm nay.
2. Tab **Tổng Hợp Đơn Hàng** filter "Ngày tạo từ/đến" theo `created_at` → kết quả lệch ngày kinh doanh.
3. Tab **Doanh Thu** — decision D5 của `revamp-payment-and-revenue-model` đã handover phần này cho change đó (revenue tính theo `bill_payment_details.created_at`), nên change này KHÔNG lo phần revenue nữa.

**Vấn đề 2 — Session per-device gây collision multi-device.**
`localStorage` là **per-device**: 1 máy bàn + 1 mobile ở cùng chi nhánh có 2 bản state khác nhau. Hệ quả thực tế (ngày lễ tết khi 2 người cùng tạo đơn):
- **Bill code race**: máy bàn đã tạo `01SGA02` → mobile chưa refetch → mobile cũng dự kiến `01SGA02` → 2 bill trùng mã.
- **`businessDate` desync**: máy bàn bấm Xuất Bến → mobile chưa biết → mobile vẫn dùng businessDate cũ → đơn tạo trên mobile rơi vào ngày kinh doanh sai.
- **User có thể tamper**: `localStorage` truy cập từ browser dev tools → nhân viên sửa `dayCounter` tay được → tạo mã đơn "gian".

Không có audit trail cho ai Xuất Bến lúc nào.

## Decisions chốt 2026-07-01

| # | Quyết định |
|---|---|
| D1 | **Session sống trên DB** (bảng mới `branch_sessions`, 1 row per branch). `localStorage` bị xoá hoàn toàn khỏi vai trò lưu session. |
| D2 | Fields của `branch_sessions`: `branch_id UUID PK`, `business_date DATE`, `day_counter TEXT`, `bill_seq INT`, `session_start TIMESTAMPTZ`, `updated_at TIMESTAMPTZ`, `updated_by UUID → users.id`. |
| D3 | Mỗi lần Xuất Bến = 1 UPDATE atomic trên DB. Mọi thiết bị fetch trước khi tạo đơn → thấy session mới nhất → mã đơn + `business_date` luôn đúng. |
| D4 | I-9 (race UNIQUE bill_code) của change `fix-shipment-intake-issues` được **downgrade** thành "safety net": UNIQUE constraint giữ, nhưng retry modal KHÔNG cần vì race không thể xảy ra ở normal flow. |
| D5 | Cột `bills.business_date DATE` được thêm (giữ nguyên scope cũ). Backfill từ `created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'::date`. |
| D6 | Bill payload write `business_date` từ `session.business_date` (fetch từ DB), không phải `localStorage`. |
| D7 | Warehouse tab filter `business_date === warehouseDate`. Tổng Hợp filter theo `business_date` (label "Ngày gửi"). |
| D8 | Sub-tab Doanh Thu KHÔNG dùng `business_date` — hand over hoàn toàn cho `revamp-payment-and-revenue-model` (tính theo `bill_payment_details.created_at`). |
| D9 | Nếu DB down → block workflow tạo đơn (không có offline fallback). Chấp nhận, vì app đã 100% phụ thuộc mạng cho mọi Supabase call. |
| D10 | Session read cache trong React state cho vòng đời session (từ login → logout). Chỉ re-fetch khi: (a) mở form tạo đơn, (b) sau khi Xuất Bến, (c) manual refresh. Giảm latency đáng kể. |

## What changes

### Schema mới: `branch_sessions`

```sql
CREATE TABLE branch_sessions (
  branch_id      UUID PRIMARY KEY REFERENCES branches(id),
  business_date  DATE NOT NULL,
  day_counter    TEXT NOT NULL,        -- vd "A", "B", ..., "AA"
  bill_seq       INT  NOT NULL DEFAULT 1,
  session_start  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     UUID REFERENCES users(id)
);
```

Seed 2 row lúc migration cho 2 chi nhánh SG + GL với giá trị hiện tại (đọc từ 1 localStorage tuỳ ý hoặc default "A", 1, today).

### Schema thêm cột: `bills.business_date DATE NOT NULL DEFAULT CURRENT_DATE`

Backfill từ `created_at AT TIME ZONE 'Asia/Ho_Chi_Minh'::date`. 2 index: `idx_bills_business_date`, `idx_bills_branch_business_date`.

### Xoá localStorage session

Xoá hoàn toàn `hoanCauDayCounter_<branch>` khỏi codebase:
- `getDayCounterFromStorage` → thay bằng `fetchBranchSession(branchId)`.
- `advanceDepartureSession` → thay bằng `advanceDepartureSession(branchId)` (server UPDATE).
- `reserveBillCode` → build mã từ session vừa fetch từ DB, KHÔNG count từ `bills` local.

### Xuất Bến flow mới

```
User bấm Xuất Bến trên SG
   │
   ▼
UPDATE branch_sessions
  SET business_date = CURRENT_DATE + INTERVAL '1 day',
      day_counter = <next letter>,   -- A → B → C → ... → AA
      bill_seq = 1,
      session_start = now(),
      updated_at = now(),
      updated_by = <session.user_id>
  WHERE branch_id = <SG.id>
  RETURNING *;
   │
   ▼
Cập nhật React state session cho SG
   │
   ▼
Toast "Đã xuất bến"
```

Mọi thiết bị khác lúc mở form tạo đơn tiếp theo → fetch `branch_sessions` → thấy state mới.

### Bill code sinh từ session

```js
async function reserveBillCode(branchId) {
  const s = await fetchBranchSession(branchId);
  const branchCode = getBranchCode(branchId);  // "SG" hoặc "GL"
  const seqPadded = String(s.bill_seq).padStart(2, "0");
  const counterPadded = String(s.bill_seq).padStart(2, "0");
  return `${seqPadded}${branchCode}${s.day_counter}${counterPadded}`;
}
```

*(Format cũ giữ nguyên: `NN{SG|GL}{Letter}NN` — vd `01SGA02`.)*

### Insert bill → increment seq

Sau khi INSERT bill thành công, cùng transaction UPDATE session:

```sql
UPDATE branch_sessions
  SET bill_seq = bill_seq + 1,
      updated_at = now(),
      updated_by = <session.user_id>
  WHERE branch_id = <branch>;
```

Nếu 2 client cùng cố insert → 1 sẽ thắng, 1 sẽ nhận `23505` unique violation → retry với `bill_seq` mới (rare, nhưng có safety net).

## Capabilities affected

- `bill-code-generation` — MODIFIED (session sống trên DB, không còn localStorage)
- `shipment-intake` — MODIFIED (bill payload write `business_date` từ session DB)
- `warehouse-and-departure` — MODIFIED (filter theo `business_date` + xuất bến gọi server)
- `revenue-reporting` — MODIFIED (chỉ Tổng Hợp filter theo `business_date`; sub-tab Doanh Thu đã handover)

## Non-goals

- KHÔNG lo phần revenue calculation (đã handover cho `revamp-payment-and-revenue-model`).
- KHÔNG lo edit/delete expense (thuộc `revamp-payment-and-revenue-model`).
- KHÔNG lo audit log cho Xuất Bến (thuộc `add-audit-log` — action `session_departure`, nhưng có cross-ref: `add-audit-log` cần biết session data model mới).
- KHÔNG hỗ trợ offline mode.
- KHÔNG đụng payment logic (thuộc `revamp-payment-and-revenue-model`).

## Migration steps (order matters)

1. Tạo file `add-branch-sessions.sql` ở repo root:
   - `CREATE TABLE branch_sessions ...`
   - Seed 2 row cho SG + GL với default values.
2. Tạo file `add-business-date.sql` ở repo root:
   - `ALTER TABLE bills ADD COLUMN business_date DATE`
   - `UPDATE bills SET business_date = (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`
   - `ALTER TABLE bills ALTER COLUMN business_date SET NOT NULL DEFAULT CURRENT_DATE`
   - 2 CREATE INDEX.
3. Chạy 2 file theo thứ tự trên Supabase.
4. Deploy code mới (đọc/ghi từ `branch_sessions`).
5. Xoá `localStorage.hoanCauDayCounter_*` (không strict, sẽ tự lỗi thời).

## Interactions với change khác

| Change | Trạng thái | Tương tác |
|---|---|---|
| `fix-shipment-intake-issues` | proposal+design ready | I-9 downgrade từ "chống race" thành "safety net UNIQUE constraint" (bỏ retry modal). I-4 date input đọc default từ `branch_sessions.business_date` thay vì localStorage. |
| `revamp-payment-and-revenue-model` | tasks ready | Doanh thu vẫn tính theo `bill_payment_details.created_at`, KHÔNG dùng `business_date`. Không conflict. |
| `add-audit-log` | tasks ready | Action `session_departure` giữ nguyên; log payload đọc `session.updated_by` từ DB thay vì trong JS. |
| `add-client-phone-history` | tasks ready | Không tương tác. |

## References

- Vòng chốt 2026-07-01 (session server-side): B4 discussion.
- Vòng chốt 2026-06-24 (business_date): quyết định gốc.
- Change bị đổi tên từ: `add-business-date-to-bills` → `add-server-session`.
