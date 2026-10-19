# Design: fix-shipment-intake-issues

> Status: 🟢 ready-for-tasks. Snapshot 2026-06-29 — đã chốt cả round 1 (I-1, I-4, I-6, I-8, I-9, I-10) và round 2 (N-1, N-3, N-4, N-10, N-11, N-12, N-13).

## 1. Bản đồ 14 issue

```
   I-1  ✓ persist no_declared_value (3 đường code, không suy diễn từ goods_value=0)
   I-2  → tách sang revamp-payment-and-revenue-model
   I-3  → tách sang revamp-payment-and-revenue-model
   I-4  ✓ 1 cột business_date, user override on intake form
   I-5  ✗ HUỶ (thay bởi I-6 + N-13)
   I-6  ✓ resolveOrCreateClient() chung, match combo, KHÔNG sửa khách cũ
   I-7  ⏸ defer (updated_by/_at qua change về delivery hoặc audit log)
   I-8  ✓ branch selector theo role
   I-9  ✓ UNIQUE(branch_id, bill_code) safety net + silent retry (downgraded)
   I-10 ✓ blacklist warning only (đã đúng)
   N-1  ✓ expectedDeliveryDate = sendDate + 1 (derived, không persist)
   N-3  ✓ self_packed đã đúng (note nghiệp vụ)
   N-4  ✓ admin sửa pending+unpaid/free + popup confirm diff
   N-10 ✓ stars auto + cho phép manual override; load KHÔNG force starsManual
   N-11 ✓ enum quote_later (4 giá trị) + UI label cho cột cước
   N-12 ✓ không SĐT → không tạo client; 4 cột snapshot trên bills
   N-13 ✓ address là exception — được update qua intake
```

## 2. Technical detail

### I-1: persist `no_declared_value`

2 hàm thiếu trong payload:
- `executeUpdateDraft` ([App.jsx#L974-L993](../../../src/App.jsx#L974-L993))
- `executeConvertDraftToBill` ([App.jsx#L1113-L1132](../../../src/App.jsx#L1113-L1132))

Fix: thêm `no_declared_value: data.noDeclaredValue || false,` vào cả 2 `updatePayload`.

**Bug phụ** ở code load bill cũ ([App.jsx#L2676](../../../src/App.jsx#L2676)):
```js
setNoDeclaredValue(bill.goods_value === 0);  // ❌ suy diễn sai
```
→ Sửa thành:
```js
setNoDeclaredValue(!!bill.no_declared_value);
```

### I-4 + N-1: 1 cột date + expectedDeliveryDate derived

**Dependency**: change `add-server-session` (bảng `branch_sessions` + cột `bills.business_date`).

UI form:
- Field "Ngày gửi" (`<input type="date">` hoặc dd/mm/yyyy theo style hiện có).
- Default = `session.business_date` (fetch từ DB).
- `admin` → editable; `member` → readonly.
- Field "Ngày có hàng dự kiến" auto-derive = `sendDate + 1 ngày`. Readonly trên UI cho mọi role. Tự cập nhật khi `sendDate` đổi.
- Cả 2 field hiển thị trên bill in.

Payload:
- `business_date: parseUIDate(data.sendDate)` thêm vào `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`.
- KHÔNG persist `expectedDeliveryDate`.

Edge:
- Admin chọn `sendDate` không khớp `session.businessDate` → mã đơn vẫn dùng counter của session hiện tại. (Mã đơn ≠ ngày gửi.)
- `expectedDeliveryDate` = `sendDate + 1` áp dụng cho mọi trường hợp, kể cả khi `sendDate` là quá khứ (backdate).

### I-6 + N-13: `resolveOrCreateClient()`

1 helper duy nhất:

```js
// Returns { clientId, phoneId, isNew, addressUpdated }
async function resolveOrCreateClient({ fullname, phone, isReceiver, isHomeDelivery, deliveryAddress }) {
  const name = (fullname || "").trim();
  const phoneTrim = (phone || "").trim();

  // N-12: không SĐT → không động clients/client_phones
  if (!name) throw new Error("fullname required");
  if (!phoneTrim) {
    return { clientId: null, phoneId: null, isNew: false, addressUpdated: false };
  }

  // Match combo (LOWER(fullname), phone)
  const { data: phoneRows } = await supabase
    .from("client_phones")
    .select("id, client_id, clients(id, fullname, address, is_delete)")
    .eq("phone_number", phoneTrim);

  const match = (phoneRows || []).find(
    (r) =>
      r.clients &&
      !r.clients.is_delete &&
      r.clients.fullname.toLowerCase() === name.toLowerCase()
  );

  if (match) {
    // N-13: address là exception, được update nếu khác
    let addressUpdated = false;
    if (isReceiver && isHomeDelivery && deliveryAddress) {
      const newAddr = deliveryAddress.trim();
      if (newAddr && newAddr !== (match.clients.address || "")) {
        await supabase
          .from("clients")
          .update({ address: newAddr })
          .eq("id", match.client_id);
        addressUpdated = true;
      }
    }
    return { clientId: match.client_id, phoneId: match.id, isNew: false, addressUpdated };
  }

  // Không match → tạo client mới
  const newAddress = isReceiver && isHomeDelivery ? (deliveryAddress || "") : "";
  const { data: newClient, error: cErr } = await supabase
    .from("clients")
    .insert({ fullname: name, address: newAddress, is_blacklist: false, is_delete: false })
    .select().single();
  if (cErr) throw cErr;

  const { data: newPhone, error: pErr } = await supabase
    .from("client_phones")
    .insert({ client_id: newClient.id, phone_number: phoneTrim, type: "primary" })
    .select().single();
  if (pErr) throw pErr;

  return { clientId: newClient.id, phoneId: newPhone.id, isNew: true, addressUpdated: false };
}
```

Edge cases:
- Khách `is_delete = true` → coi như không match → tạo mới.
- 2 `client_phones` cùng `phone_number` (đã có rác trong DB) → query trả nhiều row → `.find()` sẽ pick row đầu tiên thoả combo. (Không safe nhưng chấp nhận — sẽ clean ở change Quản Lý Khách Hàng.)
- N-13 auto-update silent: nếu admin gõ nhầm địa chỉ → khách cũ bị ghi đè. Chấp nhận theo decision.

### I-8: branch theo role

```jsx
{userRole === "admin" ? (
  <select value={currentBranch} onChange={e => setCurrentBranch(e.target.value)}>
    <option value="SG">Sài Gòn (SG)</option>
    <option value="GL">Gia Lai (GL)</option>
  </select>
) : (
  <div className="bg-gray-100 cursor-not-allowed">
    {currentBranch === "SG" ? "Sài Gòn (SG)" : "Gia Lai (GL)"}
  </div>
)}
```

Boss block ở entry tab `bills`:
```jsx
if (userRole === "boss") {
  return <div>Boss không tạo đơn. Vui lòng xem chi tiết qua các tab khác.</div>;
}
```

Khi N-4 (admin sửa bill): branch_id readonly nếu bill đã có `bill_code`.

### I-9: UNIQUE + silent retry (downgraded)

> **UPDATED 2026-07-01**: vì `add-server-session` đã chuyển session lên DB, race gần như không xảy ra. Modal confirm bỏ, chỉ giữ silent retry.

Migration `add-bill-code-unique.sql`:
```sql
ALTER TABLE bills
  ADD CONSTRAINT bills_branch_code_uniq UNIQUE (branch_id, bill_code);
```

Helper retry (rewrite):
```js
async function insertBillWithRetry(payloadBuilder, branchId, session) {
  const MAX = 3;
  let sess = session;
  for (let i = 1; i <= MAX; i++) {
    const payload = payloadBuilder(sess);
    const { data, error } = await supabase.from("bills").insert(payload).select().single();
    if (!error) return { bill: data, session: sess };
    if (error.code !== "23505" || !error.message?.includes("bills_branch_code_uniq")) throw error;
    sess = await fetchBranchSession(branchId);  // re-fetch to get new bill_seq
  }
  throw new Error("Không reserve được mã đơn sau 3 lần thử.");
}
```

Convert draft → pending: UPDATE thay vì INSERT, vẫn catch 23505 → re-fetch → recompute → retry (max 3).

### N-3: `self_packed`

Code hiện đúng. Không action.

> Note nghiệp vụ: bill `self_packed = true` xử lý giống đơn thường (nhận, giao, thu tiền). Khác biệt duy nhất: nếu xảy ra tranh chấp với khách → nhà xe không chịu trách nhiệm bồi thường.

### N-4: admin sửa form intake — popup confirm diff

UI flow:
```
1. Admin bấm "Sửa Đơn" trên bill pending+unpaid/free/quote_later
2. Snapshot toàn bộ form state lúc mở: const formSnapshot = { ...currentFormState }
3. Admin sửa
4. Bấm Lưu → compute diff (current vs formSnapshot)
5. Hiển thị modal:
   ┌────────────────────────────────────────┐
   │ Bạn vừa thay đổi các thông tin:         │
   │ • Cước phí: 0 → 250,000                │
   │ • Trạng thái: Báo giá sau → Đã TT       │
   │                                         │
   │              [Hủy]    [OK — Cập nhật]   │
   └────────────────────────────────────────┘
6. OK → UPDATE bills + toast
7. Cancel → giữ form
```

Diff format helpers cần:
- Map field name kỹ thuật → label tiếng Việt (vd `shipping_fee` → "Cước phí", `payment_status` → "Trạng thái thanh toán").
- Map enum value → label (vd `quote_later` → "Báo giá sau", `paid` → "Đã thanh toán").
- Format số tiền (vd `250000` → `"250,000"`).
- Bỏ qua field nội bộ không hiển thị (`updated_at` etc.).

Guardrails:
- `bill_code` readonly trên form (luôn).
- `branch_id` readonly khi bill đã có `bill_code` (mọi case admin sửa đều có bill_code → branch_id luôn readonly).
- Sender/receiver name đổi → re-resolve qua `resolveOrCreateClient()`. Nếu cả tên + SĐT thay đổi → có thể tạo client mới (đúng theo I-6).
- `payment_status` thay đổi → KHÔNG sync `bill_payment_details` ở change này (defer). Note rõ trong tasks.

Risk audit trail:
- Admin sửa xong, KHÔNG có log ai sửa lúc nào (I-7 defer).
- Nếu cần urgent → có thể thêm `updated_at` cột TIMESTAMPTZ với default `now()` + trigger update — nhưng vẫn defer cho change audit log riêng.

### N-10: stars auto-derive + manual override

UI:
- Field `goods_value` change → nếu `starsManual === false` → re-derive `special_stars`.
- User chọn `special_stars` (radio/dropdown) → set `starsManual = true` + giá trị user chọn.
- User reset (`goods_value` change to 0 hoặc tick `noDeclaredValue`) → reset `starsManual = false` + `special_stars = 0`.

Load bill cũ:
- KHÔNG set `setStarsManual(true)` mặc định (sửa hiện code ở [App.jsx#L2675](../../../src/App.jsx#L2675)).
- Set `setSpecialStars(bill.special_stars || 0)`.
- Set `setStarsManual(false)` → re-derive theo `goods_value` đang load.
- Trade-off: bill cũ có manual override (vd hàng 12M → 0 sao) sẽ bị reset về 2 sao khi load. Admin phải override lại.
- Approach đơn giản nhất, KHÔNG thêm column `stars_manual` BOOLEAN.

### N-11: enum `quote_later`

Migration `add-quote-later-status.sql`:
```sql
ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_payment_status_check;
ALTER TABLE bills ADD CONSTRAINT bills_payment_status_check
  CHECK (payment_status IN ('paid', 'unpaid', 'free', 'quote_later'));
```

Backfill bill cũ:
```sql
-- Bill nào đang shipping_fee=0 + unpaid → giả định là quote_later
UPDATE bills
  SET payment_status = 'quote_later'
  WHERE payment_status = 'unpaid'
    AND (shipping_fee = 0 OR shipping_fee IS NULL)
    AND delivery_status != 'cancelled';
```

> ⚠️ Backfill này dựa trên giả định. Có thể sai cho bill mới tạo (chưa nhập cước). Recommend chạy backfill xong, admin review danh sách bill `quote_later` mới đổi để confirm.

Code mapping:
- `executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`: payload tính:
  ```js
  const paymentStatus = data.isFreeShipping ? "free"
    : data.feeQuoteLater ? "quote_later"
    : data.isPaidImmediately ? "paid"
    : "unpaid";
  ```
- Load bill: `setFeeQuoteLater(bill.payment_status === "quote_later")`. Bỏ re-derive cũ.

UI:
- Khi `isFreeShipping = true`: **ẩn input cước**, thay bằng `<div className="bg-gray-100">Miễn phí</div>`.
- Khi `feeQuoteLater = true`: giữ input (placeholder "Báo giá sau", bg vàng).
- Khi cả 2 false: input bình thường.
- Validation: khi bill ở `quote_later` admin mở sửa → required `shippingFee` (không cho lưu trống) → khi fill xong + admin tick `isPaidImmediately` → chuyển `paid`; không tick → `unpaid`.

Cột "Cước phí" ở tổng hợp đơn / doanh thu:
```jsx
{bill.payment_status === "free" ? (
  <span className="text-emerald-600">Miễn phí</span>
) : bill.payment_status === "quote_later" ? (
  <span className="text-amber-600">Chưa có cước</span>
) : (
  <span>{formatVnd(bill.shipping_fee)}</span>
)}
```

### N-12: không SĐT → không tạo client + snapshot columns

Migration `add-bill-snapshot-columns.sql`:
```sql
ALTER TABLE bills
  ADD COLUMN sender_name_text    TEXT,
  ADD COLUMN sender_phone_text   TEXT,
  ADD COLUMN receiver_name_text  TEXT,
  ADD COLUMN receiver_phone_text TEXT;

-- Backfill từ FK
UPDATE bills b
  SET sender_name_text    = sc.fullname,
      sender_phone_text   = sp.phone_number,
      receiver_name_text  = rc.fullname,
      receiver_phone_text = rp.phone_number
FROM clients sc, client_phones sp, clients rc, client_phones rp
WHERE b.sender_id = sc.id
  AND b.sender_phone_id = sp.id
  AND b.receiver_id = rc.id
  AND b.receiver_phone_id = rp.id;

-- Sender name là required cho bill (theo validation): NOT NULL sau backfill
ALTER TABLE bills ALTER COLUMN sender_name_text   SET NOT NULL;
ALTER TABLE bills ALTER COLUMN receiver_name_text SET NOT NULL;
```

> ⚠️ Backfill có thể fail nếu bill cũ có FK orphan (sender_id trỏ tới client đã xoá cứng — hiếm vì dùng soft-delete). Trước khi NOT NULL, verify count NULL = 0.

Payload (3 đường code):
```js
const billPayload = {
  // ... existing
  sender_id: senderRes.clientId,       // có thể null nếu không SĐT
  sender_phone_id: senderRes.phoneId,  // có thể null
  receiver_id: receiverRes.clientId,
  receiver_phone_id: receiverRes.phoneId,
  // Snapshot columns
  sender_name_text:    data.senderName.trim(),
  sender_phone_text:   data.senderPhone?.trim() || null,
  receiver_name_text:  data.receiverName.trim(),
  receiver_phone_text: data.receiverPhone?.trim() || null,
};
```

Render code thay vì:
```js
{bill.sender?.fullname}  // ❌ FK-based
```
Thành:
```js
{bill.sender_name_text}  // ✓ snapshot
```

Áp dụng ở mọi nơi render bill: list, detail, preview, in bill, autocomplete results (nhưng autocomplete vẫn dùng clients table, không phải bills).

Edge case:
- Bill cũ đã backfill xong → sender_name_text giống `bill.sender.fullname` tại thời điểm backfill.
- Sau khi admin sửa khách bên Quản Lý Khách Hàng (đổi fullname): `clients.fullname` đổi, `bill.sender_name_text` GIỮ NGUYÊN. → Bill cũ vẫn hiển thị tên gốc. ✓ Đúng nghiệp vụ chứng từ.
- Khi admin sửa bill (N-4) → `sender_name_text` đổi theo state form.

### N-13: address exception

Đã cover trong `resolveOrCreateClient()` ở phần I-6 trên. Note thêm:

- Auto-update silent → KHÔNG hỏi user. Anh chấp nhận trade-off "có thể overwrite nhầm".
- Update CHỈ áp dụng cho **receiver** + `isHomeDelivery = true`. Sender không có address → KHÔNG đụng.
- `clients.address` của khách cũ chỉ đổi khi user thực sự gõ địa chỉ KHÁC (cả 2 đều không rỗng và khác nhau). Nếu user xoá rỗng → KHÔNG đụng (giữ địa chỉ cũ trong clients).

## 3. Implementation order

1. **Migrations** (chạy DB trước):
   - `add-quote-later-status.sql` (N-11)
   - `add-bill-snapshot-columns.sql` (N-12)
   - `add-bill-code-unique.sql` (I-9)
   - (`add-server-session.sql` thuộc change `add-server-session` — phải merge trước)
2. **Quick fix** (PR nhỏ):
   - I-1: thêm field `no_declared_value` vào 2 payload + sửa load bill ngược.
3. **UI role** (PR độc lập):
   - I-8: branch selector + boss block.
4. **Helper unification** (PR trung):
   - I-6 + N-12 + N-13: viết `resolveOrCreateClient()` + apply 3 chỗ + snapshot columns vào payload.
5. **Stars logic** (PR nhỏ):
   - N-10: bỏ `setStarsManual(true)` lúc load.
6. **Payment enum** (PR trung):
   - N-11: helper compute payment_status 4 enum + UI ẩn input/label + cột "Cước phí" trong tổng hợp.
7. **Race protection** (PR trung):
   - I-9: insert helper + modal + áp dụng 2 chỗ.
8. **Admin edit form** (PR lớn):
   - N-4: snapshot form state + diff modal + guardrails (readonly branch_id, bill_code).
9. **Date override** (sau khi `add-server-session` merge):
   - I-4 + N-1: input "Ngày gửi" + derived expectedDeliveryDate.

## 4. Open follow-ups (không trong scope)

- `client_phones` "DELETE-then-INSERT" trong Sửa Khách → orphan FK. → Change về Quản Lý Khách Hàng.
- 2 client cùng SĐT khác tên → autocomplete loạn. → Migrate dữ liệu + rule mới ở change Quản Lý Khách Hàng.
- I-9 hướng 2/3 (Postgres function, full DB session) → change multi-device.
- I-7 (`updated_by`/`updated_at`) → change về delivery hoặc audit log riêng.
- Sync `bill_payment_details` khi admin đổi `payment_status` → change `revamp-payment-and-revenue-model`.

## 5. Verification checklist

- [ ] Anh review proposal.md + design.md, confirm các quyết định.
- [ ] Specs viết xong cho 4 capability (shipment-intake, customer-management, bill-code-generation, revenue-reporting).
- [ ] Tasks.md có đủ check item cho 9 phase (theo Implementation order ở section 3).
- [ ] 4 migration SQL được commit ở root repo.
- [ ] Dependency với `add-server-session` được note rõ trong tasks (phase 9).
