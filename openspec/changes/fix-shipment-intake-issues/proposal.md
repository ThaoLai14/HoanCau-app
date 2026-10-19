# Proposal: Fix shipment-intake issues (round 1)

## Status

🟢 **READY** — đã chốt toàn bộ open Q + 5 issue mở rộng (N-4, N-10, N-11, N-12, N-13) ngày 2026-06-29. Sẵn sàng viết tasks.

## Why

Audit chi tiết quy trình Tạo Đơn ngày 2026-06-25 + deep-dive 2026-06-29 phát hiện 14 bug/mismatch giữa code và rule nghiệp vụ. Phân loại sau khi anh chốt 2026-06-29:

- **Đã chốt cách fix**: I-1, I-4, I-6, I-8, I-9, I-10, N-1, N-4, N-10, N-11, N-12, N-13.
- **HUỶ**: I-5 — bị thay thế bởi I-6 + N-13 (chỉ address là exception, các field khác không sửa).
- **Defer sang workflow khác**: I-7 (`updated_by`/`updated_at` — qua change về delivery hoặc về audit log).
- **Tách sang change khác**: I-2, I-3 (payment row sync) → `revamp-payment-and-revenue-model`.

## What changes

### I-1: persist `no_declared_value` trong cả 3 đường code

- `executeCreateBill` đã có ✓
- `executeUpdateDraft` ([App.jsx#L974-L993](../../../src/App.jsx#L974-L993)) — **thêm** vào `updatePayload`
- `executeConvertDraftToBill` ([App.jsx#L1113-L1132](../../../src/App.jsx#L1113-L1132)) — **thêm** vào `updatePayload`
- Lúc load bill cũ vào form: KHÔNG được suy diễn `noDeclaredValue` từ `goods_value === 0`. Phải đọc trực tiếp `bill.no_declared_value`.

### I-4 + N-1: 1 field date duy nhất + `expectedDeliveryDate` derived

**Quyết định**: chỉ 1 cột date persist (`business_date` — chung với change `add-server-session`). Form intake cho user override.

- Form intake hiển thị field "Ngày gửi" (date input).
- Default = `session.business_date` (fetch từ `branch_sessions` DB — logic của change `add-server-session`).
- Admin được chỉnh tay (vd backdate).
- Member: readonly (lock theo session).
- Lưu trực tiếp vào `bills.business_date`.

**N-1**: `expectedDeliveryDate` = `sendDate + 1 ngày` (derived, KHÔNG phải `getTomorrowFormatted()` ngày calendar).
- Trên UI và bill in: tự tính `sendDate + 1`.
- KHÔNG persist vào DB.
- Khi admin sửa `sendDate` (lùi/tới) → `expectedDeliveryDate` tự cập nhật theo.
- KHÔNG cho user override `expectedDeliveryDate` riêng (đơn giản hoá UX — nếu cần override, admin sửa `sendDate`).

> ⚠️ Dependency: I-4 phụ thuộc change `add-server-session` (cột `bills.business_date` + bảng `branch_sessions`).

### I-5: HUỶ

Thay thế bởi I-6 + N-13. Address của khách cũ vẫn được update qua intake (N-13 exception), nhưng KHÔNG ghi đè vô điều kiện theo I-5 cũ.

### I-6: thống nhất logic match khách + KHÔNG sửa khách cũ (trừ address)

**Quyết định**:

- 3 đường code dùng chung 1 hàm `resolveOrCreateClient(name, phone, isReceiver, isHomeDelivery, address)`.
- Match key = combo `(LOWER(fullname), phone_number)`.
- Match được → dùng `client_id` cũ. KHÔNG đụng `clients.fullname`, `clients.is_blacklist`, `clients.blacklist_reason`. KHÔNG đụng `client_phones`. Riêng `clients.address` được phép update theo N-13.
- Không match → tạo client mới + insert `client_phones` (CHỈ KHI có phone — xem N-12) + lưu `clients.address` cho receiver new + isHomeDelivery.
- Toast `"Đã lưu khách mới <tên> vào danh sách khách hàng"` sau khi tạo client mới.

### I-8: branch selector theo role

- `member` → lock, dùng `loggedBranch`.
- `admin` → show selector, default = `loggedBranch`, có thể chọn SG/GL.
- `boss` → block entry tab `bills`, hiển thị "Boss không tạo đơn".

### I-9: chống race mã đơn — UNIQUE (safety net) + silent retry

> **UPDATED 2026-07-01**: change `add-server-session` (rename từ `add-business-date-to-bills`) đã chuyển session lên DB → race gần như không xảy ra ở normal flow. I-9 **downgrade** từ "chống race đầy đủ" thành "safety net cho race hiếm":

- Migration: `ALTER TABLE bills ADD CONSTRAINT bills_branch_code_uniq UNIQUE (branch_id, bill_code);` (giữ nguyên).
- Submit flow: optimistic insert. Nếu 23505 → re-fetch `branch_sessions` → recompute mã → retry silent (KHÔNG modal). Max 3 lần retry.
- Áp dụng cả `executeCreateBill` và `executeConvertDraftToBill`.
- **BỎ**: modal confirm `"Đã tồn tại mã <X>. Mã mới: <Y>. [OK]"`.
- Lý do bỏ modal: session cache 100ms fresh, race window rất hẹp (~50ms), retry silent đủ; modal chỉ gây phiền UX.

### I-10: blacklist warning only

Đã đúng — không động.

### N-3: `self_packed` hoạt động đúng

Đã persist đúng trên cả 3 path. KHÔNG có code change. Note: bill `self_packed = true` xử lý giống đơn thường (nhận, giao, thu tiền) — khác biệt duy nhất ở chỗ tranh chấp bồi thường (nhà xe không chịu).

### N-4: admin sửa bill pending+unpaid/free — popup confirm liệt kê field đã đổi

**Quyết định**: admin được sửa toàn bộ form intake cho bill `delivery_status = "pending"` + `payment_status ∈ {unpaid, free, quote_later}`. Khi bấm Lưu:

1. So sánh state hiện tại với snapshot lúc mở form.
2. Build list các field đã đổi (vd "Số kiện: 3 → 5", "Cước phí: 0 → 250,000").
3. Hiển thị modal:
   ```
   Bạn vừa thay đổi các thông tin:
   • Cước phí: 0 → 250,000
   • Trạng thái: Báo giá sau → Đã thanh toán
   [Hủy] [OK — Cập nhật]
   ```
4. OK → UPDATE bills + toast thành công.
5. Cancel → giữ nguyên form, không submit.

**Guardrails để tránh bug**:
- `bill_code` readonly (không cho đổi).
- `branch_id` readonly khi bill đã có `bill_code` (đổi branch sẽ làm mã sai).
- Đổi sender/receiver name vẫn dùng `resolveOrCreateClient()` chung — không tạo orphan client.
- KHÔNG track `updated_by`/`updated_at` (defer I-7) — note rủi ro audit trong design.

> ⚠️ Phụ thuộc: nếu admin tick/untick `isPaidImmediately`, sync với `bill_payment_details` chưa xử lý — vấn đề này thuộc change `revamp-payment-and-revenue-model`. Trong change này, **chỉ persist `payment_status` lên `bills`**; payment row sẽ được handle ở change kia.

### N-10: `special_stars` auto-derive + cho phép manual override

**Quyết định**:

- Auto-derive theo `goods_value`: ≥10M → 2 sao, ≥5M → 1 sao, else → 0.
- User được override tay (giữ logic `starsManual = true` hiện có).
- Khi user thay đổi `goods_value`, NẾU `starsManual = false` → re-derive ngay. Nếu `starsManual = true` → giữ giá trị user đã chọn.
- Khi LOAD bill cũ vào form sửa: KHÔNG force `starsManual = true` như code hiện. Mặc định `starsManual = false` → re-derive theo `goods_value` đang load.
  - Trade-off: nếu admin đã override bill cũ (lưu DB = 0 sao cho hàng 12M) → load lại sẽ auto-derive thành 2 sao. Admin phải override lại nếu muốn giữ 0.
  - Hoặc: thêm column `bills.stars_manual BOOLEAN` để phân biệt. **Đề xuất KHÔNG thêm** vì:
    - Bill admin override 0 sao cho hàng giá trị cao là **hiếm** (chỉ khi khách miễn giá trị).
    - Trường hợp này thường đi cùng `no_declared_value = true` → đã ép `special_stars = 0` rồi.
  - Anh OK approach "no extra column"?

### N-11: thêm enum `quote_later` cho `payment_status`

**Quyết định** (Option C):

- Migration: update CHECK constraint của `bills.payment_status` thành 4 giá trị: `{paid, unpaid, free, quote_later}`.
- Logic mapping UI flag → DB:
  ```
  isFreeShipping = true     ↔ payment_status = "free",       shipping_fee = 0
  isPaidImmediately = true  ↔ payment_status = "paid"
  feeQuoteLater = true      ↔ payment_status = "quote_later", shipping_fee = 0
  mặc định                  ↔ payment_status = "unpaid",     shipping_fee > 0
  ```
- 3 checkbox flag mutually exclusive ở UI (đã có).
- Khi load bill cũ: load thẳng từ `payment_status` (không re-derive từ `shipping_fee = 0`).
- Khi bill ở trạng thái `quote_later`, admin sửa: `shipping_fee` phải required (không cho lưu trống) → khi admin fill xong + tick `isPaidImmediately` → chuyển sang `paid`. Hoặc không tick → chuyển sang `unpaid` (đã có cước, chờ thanh toán).
- **UI ẩn input cước khi `isFreeShipping = true`** (thay bằng label "Miễn phí" thay vì input có placeholder).
- UI input cước hiện khi `feeQuoteLater = true` với placeholder "Báo giá sau" (giữ behavior hiện tại).
- **Tổng hợp đơn / Doanh thu**: cột "Cước phí" hiển thị:
  - `paid` hoặc `unpaid` → format số tiền (vd `200,000 VND`)
  - `free` → label `"Miễn phí"`
  - `quote_later` → label `"Chưa có cước"`

### N-12: khách không SĐT → không lưu `clients` + bill snapshot tên/SĐT

**Quyết định**:

- Khi tạo bill mới với sender/receiver KHÔNG có SĐT → KHÔNG insert vào `clients`/`client_phones`. `bills.sender_id = NULL` (hoặc receiver tương ứng).
- Khi có cả tên + SĐT → resolve theo I-6 (match cũ hoặc tạo mới).

**Schema change** — thêm 4 cột snapshot vào `bills`:
```
sender_name_text    TEXT NULL  -- tên người gửi (snapshot)
sender_phone_text   TEXT NULL  -- SĐT người gửi (snapshot)
receiver_name_text  TEXT NULL  -- tên người nhận (snapshot)
receiver_phone_text TEXT NULL  -- SĐT người nhận (snapshot)
```

- **Source of truth** cho bill display: 4 cột snapshot này. KHÔNG dựa vào JOIN với `clients`.
- FK `sender_id` / `receiver_id` chỉ dùng cho autocomplete + dedup khi tạo đơn mới, KHÔNG dùng để render.
- Lý do: bill là chứng từ in cho khách → giá trị tại thời điểm tạo đơn là vĩnh viễn. Nếu sau này admin sửa tên khách bên Quản Lý Khách Hàng, bill cũ KHÔNG được đổi tên hiển thị.
- Migration: backfill cho bill cũ — copy `clients.fullname` / `client_phones.phone_number` vào 4 cột mới.

> Anh review approach này. Nếu chỉ muốn giải quyết case "khách không SĐT" mà KHÔNG đổi rule rendering → có alternative: chỉ snapshot khi `sender_id = NULL`, vẫn dùng JOIN khi có FK. Cleaner = always snapshot.

### N-13: address là exception của I-6 — được update qua intake

**Quyết định**:

- Khi resolve match khách cũ + `isHomeDelivery = true` + `deliveryAddress` user gõ KHÁC `clients.address`:
  - UPDATE `clients.address = deliveryAddress` (silent — không hỏi user).
  - Bill `delivery_address` snapshot vẫn lưu giá trị user gõ.
- Khi resolve match khách cũ + `isHomeDelivery = false`: KHÔNG đụng `clients.address`.
- Khi khách mới + receiver + `isHomeDelivery = true`: lưu `clients.address = deliveryAddress` (insert mới).
- Khi khách mới + sender: `clients.address = ""` (sender không có address).

> Note: address là exception duy nhất. Các field khác (name, phone, blacklist) vẫn KHÔNG được sửa qua intake — chỉ qua tab Quản Lý Khách Hàng.

## Capabilities affected

- `shipment-intake` — MODIFIED (I-1, I-4, I-6, I-8, N-1, N-4, N-10, N-11, N-12)
- `customer-management` — MODIFIED (I-6 + N-13: intake không sửa khách cũ TRỪ address; N-12: không tạo client nếu không SĐT)
- `bill-code-generation` — MODIFIED (I-9: UNIQUE + modal confirm)
- `revenue-reporting` — MODIFIED (N-11: hiển thị label "Miễn phí" / "Chưa có cước" thay vì số tiền cho 2 enum mới)

## Non-goals

- KHÔNG đụng payment/revenue model deeper (ở change `revamp-payment-and-revenue-model`).
- KHÔNG fix I-7 (`updated_by`/`updated_at` audit) — defer.
- KHÔNG thêm cột `business_date` (ở change `add-server-session`); change này chỉ ADD override behavior.
- KHÔNG đụng `client_phones` "DELETE-then-INSERT" anti-pattern (sẽ giải quyết ở change về Quản Lý Khách Hàng).
- KHÔNG implement Hướng 2/3 của I-9 (Postgres function / DB session).
- KHÔNG sync `bill_payment_details` khi admin đổi `payment_status` (defer ở change `revamp-payment-and-revenue-model`).

## References

- Audit gốc: discussion ngày 2026-06-25.
- Decisions chốt round 1 (I-4, I-6, I-9): discussion ngày 2026-06-29.
- Decisions chốt round 2 (N-1, N-4, N-10, N-11, N-12, N-13): discussion ngày 2026-06-29 (cùng ngày).
- Change phụ thuộc: `add-server-session` (session DB + `business_date` column).
- Change song hành: `revamp-payment-and-revenue-model`.
