# Design: refine-shipment-intake-round-2

## Overview

Round 2 gom 16 quyết định từ manual checklist review 2026-07-06. Chia 4 nhóm:
role & permissions, cancel flow, form UI/UX, data integrity.

## Key Decisions

### D1. Không backdate — mọi role readonly "Ngày gửi"

**Alternatives xét**:
- (A) Chỉ admin backdate được (fix round 1 chọn).
- (B) Cấm hoàn toàn — anh xác nhận business rule (chọn).
- (C) Cho phép ai cũng backdate + audit trail.

**Chọn B**. Lý do:
- Ngày gửi gắn với chuyến xe thật. Backdate làm sai số kê khai chuyến, ảnh
  hưởng revenue report theo `business_date`.
- Nếu admin cần fix sai sót cũ → thao tác qua DB trực tiếp (rare enough).
- `session.business_date` đã model đúng ngữ nghĩa (sau Xuất Bến flip sang
  ngày mai) → không cần override.

**Impact**: SUPERSEDES fix `§I-4` phần "admin editable".

### D2. Role gate mới cho edit/cancel

**Ma trận quyền** (áp dụng cho bill do user tạo, cùng chi nhánh):

| Role   | Tạo mới | Sửa draft | Sửa pending (chưa paid) | Sửa pending (paid) | Hủy draft | Hủy pending |
|--------|:-------:|:---------:|:-----------------------:|:------------------:|:---------:|:-----------:|
| member |   ✅    |    ✅     |           ✅            |         ❌         |    ✅     |     ✅      |
| admin  |   ✅    |    ✅     |           ✅            |         ❌         |    ✅     |     ✅      |
| boss   |   ❌    |    ❌     |           ❌            |         ❌         |    ❌     |     ❌      |

**Ma trận cross-branch** (admin login SG thao tác bill của GL):

| Action                    | Cho phép? |
|---------------------------|:---------:|
| Xem                       |    ✅     |
| Sửa                       |    ❌     |
| Hủy                       |    ❌     |
| Tạo mới cho GL từ UI SG   |    ✅     |

**Rationale**:
- Member cần sửa/hủy được vì thực tế 90% đơn do member tạo, không thể đợi admin.
- Audit_log ghi nhận toàn bộ mutation → không mất traceability.
- Bill paid = tiền đã thu → sửa ngầm rất rủi ro. Muốn thay đổi phải hủy (có
  refund expense hiện lên báo cáo) → transparent.
- Cross-branch chỉnh sửa mở lỗ hổng cho admin 1 chi nhánh can thiệp chi nhánh
  khác không có context → cấm.

**Enforcement**:
- Frontend: nút Sửa/Hủy disabled + tooltip lý do.
- Backend: RPC function check `bills.branch_id = auth_branch_id` + `payment_status != 'paid'`.

**Impact**: SUPERSEDES fix `§N-4`.

### D3. Cancel flow — soft delete draft + expense refund cho paid

**State transitions mới**:

```
    draft (is_delete=false)
       │
       │  hủy (soft delete)
       ▼
    draft (is_delete=true)     ← không hiển UI, còn trong DB
                                 audit_log ghi lý do
```

```
    pending unpaid/free/quote_later
       │
       │  hủy
       ▼
    cancelled
       (bill_code giữ, order_note không đổi,
        lý do vào audit_log.diff)
```

```
    pending paid
       │
       │  hủy
       ▼
    cancelled + INSERT expenses(amount = -actual_amount_paid, ...)
       (auto refund, 1 transaction với cancel bill)
```

**Tại sao không tách cột `cancel_reason`?**
- Số lượng field bill đã nhiều (~30 cột) → thêm cột riêng cho 1 case rare.
- Audit_log là source of truth cho "lịch sử thay đổi" → lý do hủy vào
  `audit_log.diff.reason` là consistent với các mutation khác (`bill_update`
  cũng ghi diff các field trong `audit_log.diff`).
- Trước đây base spec prepend `order_note` — đã phá order_note purity + nay
  order_note bị giới hạn 200 chars → càng không phù hợp.

**Expense refund format**:
- `amount = -actual_amount_paid` (dùng dấu âm để phân biệt với thu; revenue
  report sum theo amount là ra net revenue).
- `source_bill = bills.id` — trace ngược về bill nguồn.
- `is_delete = false` (row expense luôn tồn tại; không cho admin sửa/xoá qua UI).
- Nếu bill paid nhiều lần (rare — hiện tại 1 bill = 1 payment) → sum tất cả
  `bill_payment_details.amount_paid` cho `source_bill = bill.id` rồi lấy âm.

**Impact**: SUPERSEDES base `shipment-intake` §"Hủy đơn theo trạng thái";
thêm requirement mới vào `delivery-and-payment`.

### D4. Bỏ `expected_id_info` — dual-purpose `order_note`

**Alternatives xét**:
- (A) Giữ nguyên 2 field riêng (`expected_id_info` + `order_note`).
- (B) Merge vào `order_note`, drop `expected_id_info` (anh chọn).
- (C) Đổi tên thành `special_note` để tránh confusion.

**Chọn B**. Lý do:
- Thực tế nhân viên khai CCCD hoặc mã số thuế chỉ 1-2 lần/ngày → không đáng
  giá tạo field riêng.
- UI đơn giản hơn (bớt 1 input) — form tạo bill đã dài.
- Migration đơn giản: `ALTER TABLE bills DROP COLUMN expected_id_info` sau
  khi backfill vào `order_note`.

**Rules order_note conditional**:

```
tick CCCD?  tick VAT?   order_note required?   placeholder / error
──────────  ─────────   ───────────────────    ──────────────────────────
   false     false             optional         "Ghi chú thêm nếu cần"
   true      false             required         "Vui lòng nhập thông tin CCCD"
   false     true              required         "Vui lòng nhập thông tin xuất hóa đơn"
   true      true              required         "Vui lòng nhập thông tin CCCD, VAT"
```

**Limit 200 ký tự**:
- Client-side: `maxLength=200` + counter "n/200".
- Server-side: DB CHECK `char_length(order_note) <= 200`.
- Backfill: nếu `expected_id_info` + `order_note` combined > 200 → truncate
  + log warning migration.

### D5. Auto-populate địa chỉ receiver

**Data flow (kết hợp với write-back fix §N-13)**:

```
   FORM OPEN                       FORM SUBMIT
   ─────────                       ───────────
   receiver autocomplete           isHomeDelivery=true
   → match client                  + delivery_address != clients.address
      ↓                               ↓
   clients.address != empty        UPDATE clients.address
      ↓                               ↓
   autofill deliveryAddress        write-back done
```

**Edge cases**:
- Match cũ + `clients.address` rỗng → autofill rỗng, user tự nhập → save →
  write-back lần đầu.
- Match cũ + user sửa autofill → save → write-back ghi đè.
- Match cũ + `isHomeDelivery=false` → autofill vẫn chạy (để user thấy address
  cũ nếu cần chuyển), nhưng KHÔNG write-back (giữ `bills.delivery_address=NULL`).
- Bill cũ load để sửa: autofill từ `bills.delivery_address` (snapshot),
  KHÔNG từ `clients.address` — snapshot thắng.

### D6. Tick paid ở Lưu nháp → popup confirm

**Alternatives xét**:
- (A) Auto untick paid khi user bấm Lưu nháp (silent).
- (B) Popup confirm chuyển sang Lưu đơn (anh chọn).
- (C) Chặn hẳn tick paid khi UI đang ở "chế độ nháp".

**Chọn B**. Lý do:
- (A) mất data / user không biết bị gì → confusing.
- (C) khó implement vì UI không có "chế độ nháp" rõ ràng — 2 nút Lưu đơn +
  Lưu nháp cùng dùng chung state form.
- (B) explicit + educate user: "paid không compatible với draft".

### D7. Nút "Xem bill in"

**Design UI**:
- 1 button primary, icon printer, label "Xem bill in".
- Vị trí:
  - Trong form create: hiện sau khi Lưu đơn thành công, đè lên nút "Lưu đơn"
    (state UI chuyển "form đã submit").
  - Trong bill detail: nằm cạnh nút "Sửa" / "Hủy".
- Modal preview:
  - Chiều rộng A5/A6 (~148mm), có thể print A4 ghép 2 bill.
  - Snapshot columns cho tên/SĐT.
  - Barcode 128 hoặc QR chứa `bill_code`.
  - Cancelled → watermark chéo "ĐÃ HỦY" màu đỏ.
- Nút "In" → `window.print()`, kèm CSS `@media print` ẩn header/footer app.

### D8. Double-click guard

**Pattern áp dụng cho MỌI nút mutation**:

```javascript
const [submitting, setSubmitting] = useState(false);

async function handleSubmit() {
  if (submitting) return;
  setSubmitting(true);
  try {
    await mutationRPC(...);
  } finally {
    setSubmitting(false);
  }
}

<button disabled={submitting} onClick={handleSubmit}>Lưu đơn</button>
```

Kết hợp với optimistic race check: trước UPDATE/DELETE, refetch bill state để
đảm bảo không mutate stale data.

### D9. No-change save → skip modal

```javascript
function handleEditSave() {
  const diff = computeDiff(currentState, snapshotRef.current);
  if (diff.length === 0) {
    toast("Không có thay đổi để lưu");
    return;
  }
  showModal(diff);
}
```

**Impact**: MODIFIES fix `§N-4` (trước đây modal hiện dù không có diff).

### D10. Autocomplete filter số 'old'

**Query change** trong `ClientAutocomplete`:

```sql
-- CŨ (hiện tại)
SELECT c.*, cp.phone_number
FROM clients c
JOIN client_phones cp ON cp.client_id = c.id
WHERE (c.fullname ILIKE $1 OR cp.phone_number ILIKE $1)
  AND c.is_delete = false;

-- MỚI (round 2)
SELECT c.*, cp.phone_number, cp.type
FROM clients c
JOIN client_phones cp ON cp.client_id = c.id
WHERE (c.fullname ILIKE $1 OR cp.phone_number ILIKE $1)
  AND c.is_delete = false
  AND cp.type IN ('primary', 'secondary');   -- ← MỚI
```

**Impact**:
- Khách "Trần A" có primary `0912-NEW` + old `0909-A` → gõ "0909" KHÔNG suggest.
- Bill cũ dùng phone_id trỏ số 'old' → bill detail vẫn JOIN được (không đụng
  render path).

### D11. RPC atomic — Supabase function skeleton

**Motivation**: nếu client insert bill xong rồi insert audit_log fail → audit
gap không phát hiện được. Anh chọn A (rollback atomic).

**Signatures**:

```sql
-- Create bill
CREATE FUNCTION create_bill_with_audit(
  bill_data JSONB,       -- toàn bộ payload bill
  audit_data JSONB       -- { actor_user_id, actor_branch_id, diff }
) RETURNS UUID           -- bill_id vừa tạo
LANGUAGE plpgsql AS $$
DECLARE new_bill_id UUID;
BEGIN
  INSERT INTO bills (...) VALUES (...) RETURNING id INTO new_bill_id;
  INSERT INTO audit_log (bill_id, action, ...)
    VALUES (new_bill_id, 'bill_create', ...);
  -- nếu payment_status='paid', insert bill_payment_details ở đây luôn
  RETURN new_bill_id;
END $$;

-- Update bill (draft or pending)
CREATE FUNCTION update_bill_with_audit(
  target_bill_id UUID,
  bill_data JSONB,
  audit_data JSONB       -- audit_data.diff chứa list field đã đổi
) RETURNS VOID;

-- Cancel bill (auto refund nếu paid)
CREATE FUNCTION cancel_bill_with_audit(
  target_bill_id UUID,
  cancel_reason TEXT,
  audit_data JSONB
) RETURNS VOID
-- Nội bộ: check payment_status. Nếu 'paid' → INSERT expenses refund. Update
-- delivery_status='cancelled'. Insert audit_log với action='bill_cancel',
-- diff.reason = cancel_reason.

-- Soft delete draft
CREATE FUNCTION soft_delete_draft_with_audit(
  target_bill_id UUID,
  cancel_reason TEXT,
  audit_data JSONB
) RETURNS VOID
-- UPDATE bills.is_delete=true. Insert audit_log action='bill_draft_cancel'.
```

**Error handling**:
- Function raise exception → Postgres rollback toàn bộ transaction (bill +
  audit + expense/payment). Client nhận PostgREST error → toast lỗi.
- 23505 (UNIQUE bill_code) → giữ retry logic client-side (fix §I-9).

**Migration ordering**:
1. Backfill (drop `expected_id_info` sau khi ghi vào `order_note`).
2. Thêm CHECK `char_length(order_note) <= 200`.
3. Tạo 4 RPC functions.
4. Migrate client code từ trực tiếp `supabase.from('bills').insert(...)` sang
   `supabase.rpc('create_bill_with_audit', ...)`.

**Backward compat**: giữ direct table access cho SELECT (read-only), chỉ RPC
hóa write path.

## Trade-offs

### Trade-off 1: RPC atomic vs client simplicity

- **+**: audit không bao giờ mất, compliance sạch.
- **-**: mọi mutation phải viết RPC function trước. Client code phức tạp hơn.
- **-**: debug lỗi khó hơn (error trong function ẩn stack trace).

Chấp nhận vì audit là mission-critical cho chành xe.

### Trade-off 2: Member sửa/hủy được → risk lạm quyền

- **+**: nghiệp vụ thực tế trơn tru.
- **-**: member có thể sửa cước, hủy đơn của mình để giấu doanh thu.
- **Mitigation**: audit_log ghi mọi thay đổi + boss có dashboard xem toàn bộ
  history + `bills.actual_amount_paid` khớp với `bill_payment_details` là
  source of truth (member không sửa được payment_details qua flow này).

### Trade-off 3: Soft delete draft → junk data

- **+**: giữ audit + không mất data khi user hủy nhầm.
- **-**: `bills` table phình theo thời gian (rác draft cancelled).
- **Mitigation**: index trên `is_delete` để filter nhanh; nếu quá nhiều rác
  (>1 năm) → archival job (out of scope round 2).

## Risks

1. **RPC migration break existing flow**: nếu deploy RPC nhưng client code
   chưa update → double write hoặc missing audit. Mitigation: feature flag
   per-RPC + rollout từng flow.
2. **Backfill `order_note` mất data**: bill cũ có `expected_id_info` +
   `order_note` combined > 200 → truncate. Mitigation: chạy dry-run migration
   + log tất cả case bị truncate để manual review.
3. **Boss dashboard chưa có UI xem audit toàn bộ**: mitigation-3 của trade-off
   2 phụ thuộc UI này. Nếu chưa có → risk member lạm quyền không phát hiện.
   Đề xuất: audit dashboard là 1 change follow-up.

## Open questions (resolved trong session này)

Đã chốt hết ở conversation 2026-07-06. Ghi lại đầy đủ trong proposal.
