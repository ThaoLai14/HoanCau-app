# Manual Checklist — Flow Nhận Hàng (Shipment Intake)

> **Mục đích**: checklist tick tay dùng cho QA manual + tiền đề viết Playwright test cho flow "Nhận hàng" của app HoanCau.
>
> **Format**: user story + rules + happy case + exception, group theo field/behavior.
>
> **Nguồn**: tổng hợp từ specs `openspec/specs/shipment-intake/spec.md` + các delta của 5 change in-progress (`fix-shipment-intake-issues`, `add-server-session`, `revamp-payment-and-revenue-model`, `add-client-phone-history`, `refine-shipment-intake-round-2`) — phản ánh **state đích** sau khi toàn bộ change apply.
>
> **Lần cập nhật gần nhất**: 2026-07-06.

---

## 0. Tổng quan flow

**Nguyên tắc chéo (cross-cutting)** — áp dụng cho MỌI section bên dưới:

- **Audit log**: mọi mutation (create / update / cancel / soft-delete) trên `bills` phải insert row vào `audit_log` với đủ actor (userId, branch), action, diff (field cũ → mới) và lý do (nếu hủy). Wrap chung transaction qua RPC function.
- **Soft delete**: không có DELETE cứng nào trên `bills`. Hủy draft = `is_delete=true`; hủy pending = `delivery_status='cancelled'`.
- **Không backdate**: MỌI role (kể cả admin) readonly field "Ngày gửi". Luôn = `session.business_date`.
- **Double-submit guard**: mọi nút Lưu / Hủy chặn double-click (disable sau click đầu, race check refetch trước mutation).
- **Bill paid không sửa**: muốn thay đổi phải hủy (auto-refund qua expense) rồi tạo bill mới.

**Role gate**:

| Role   | Tạo mới | Sửa draft/pending (chưa paid) | Sửa pending paid | Hủy draft/pending | Cross-branch mutate |
|--------|:-------:|:-----------------------------:|:----------------:|:-----------------:|:-------------------:|
| member |   ✅    |              ✅               |        ❌        |        ✅         |         ❌          |
| admin  |   ✅    |              ✅               |        ❌        |        ✅         |         ❌          |
| boss   |   ❌    |              ❌               |        ❌        |        ❌         |         ❌          |

**State machine bill**:

```
   [không có bill]
         │
    ┌────┴────┐
    │         │
Lưu nháp  Lưu đơn
    │         │
    ▼         ▼
  draft ──►  pending ──► delivered (out of scope checklist này)
    │         │
    ▼         ▼
soft-del   cancelled
(is_delete) (delivery_status)
              │
              │ (nếu paid)
              ▼
    + expense refund (amount âm)
```

---

## 1. Chi nhánh (branch)

**US**: Là nhân viên, tôi cần đơn tôi tạo được gắn đúng chi nhánh để mã đơn và doanh thu không bị lẫn giữa SG/GL.

**Rules**:
- Member → field branch readonly = `loggedBranch`.
- Admin → hiện `<select>` SG/GL, default = `loggedBranch`, đổi được trên form TẠO MỚI.
- Boss → không vào được tab.
- Khi admin đổi branch → `bill_code` reserve theo counter chi nhánh mới.
- Sau khi bill đã có `bill_code`, branch readonly cho MỌI role (không đổi được khi sửa).

**Happy**:
- [ ] Member login SG mở form → "Sài Gòn (SG)" xám, không click được.
- [ ] Admin login SG chuyển sang GL trên form mới → preview mã bill đổi format GL, submit → `bills.branch_id=GL`.

**Exception**:
- [ ] Boss mở tab Tạo Đơn → thông báo "Boss không có quyền tạo đơn".
- [ ] Admin/member sửa 1 bill đã có mã → field branch disabled.

---

## 2. Ngày gửi & Ngày có hàng dự kiến

**US**: Là nhân viên, tôi cần đơn tôi tạo luôn thuộc phiên kinh doanh hiện tại; ngày gửi không thể sửa để không có sai lệch với chuyến xe thực tế.

**Rules**:
- "Ngày gửi" = `session.business_date` (từ `branch_sessions`), **readonly cho MỌI role** (kể cả admin — không có backdate).
- "Ngày có hàng dự kiến" = Ngày gửi + 1, readonly cho mọi role, KHÔNG persist DB (chỉ hiển + in bill).
- `bills.business_date` được ghi = "Ngày gửi" tại thời điểm submit (re-fetch session ngay trước submit).
- Sau Xuất Bến, session flip → "Ngày gửi" tự đổi theo trên form đang mở.

**Happy**:
- [ ] Session `business_date=01/07/2026`, member mở form → "Ngày gửi" 01/07/2026 readonly, "Ngày có hàng dự kiến" 02/07/2026 readonly.
- [ ] Admin mở form → cũng readonly, không có UI backdate.
- [ ] Sau Xuất Bến 14:30 (session flip sang 02/07), tạo đơn 15:00 → `business_date=02/07/2026`, `created_at` ≈ 15:00 hôm 01/07.

**Exception**:
- [ ] Mọi role cố sửa "Ngày gửi" → input disabled, không nhận input.
- [ ] Mọi role cố sửa "Ngày có hàng dự kiến" → input disabled.

---

## 3. Người gửi & Người nhận (senderName/Phone + receiverName/Phone)

**US**: Là nhân viên, tôi nhập tên & SĐT người gửi và người nhận; nếu khách đã có trong hệ thống thì được nhận diện tự động để không tạo dup.

**Rules chung cho cả sender + receiver**:
- Tên bắt buộc (cả Lưu đơn lẫn Lưu nháp).
- SĐT tùy chọn.
- Autocomplete: gõ tên hoặc SĐT → suggest từ `clients` + `client_phones`.
  - **Chỉ match số `type='primary'` hoặc `'secondary'`. KHÔNG match số `type='old'`** (số cũ không suggest khi tạo bill mới).
  - Chọn suggest → autofill tên + SĐT (+ địa chỉ nếu receiver + có địa chỉ trong DB — xem mục 8).
- Submit resolve khách:
  - Match theo combo `(LOWER(fullname), phone_number)` trên `client_phones` (primary/secondary, chưa xóa).
  - Match → dùng `client_id` + `phone_id` cũ. KHÔNG update `clients.fullname`, `is_blacklist`, `blacklist_reason`.
  - Không match → INSERT client mới + phone mới `type='primary'`.
  - SĐT trống → `<x>_id=NULL`, `<x>_phone_id=NULL`, không tạo client/phone.
- Snapshot: `bills.sender_name_text`, `sender_phone_text`, `receiver_name_text`, `receiver_phone_text` LUÔN = giá trị user gõ (không lấy từ DB).
- Sender mới → `clients.address=""` (sender không lưu địa chỉ, dù isHomeDelivery).
- Receiver mới → `clients.address` xử lý theo mục 8.
- **Cho phép sender = receiver** (cùng tên + SĐT, tự gửi cho mình): không chặn, submit bình thường.

**Happy**:
- [ ] Gõ tên "Trần A" đã có trong DB → suggest hiện (bao gồm SĐT primary + secondary, KHÔNG có số old), chọn → autofill.
- [ ] Sender "Trần A" `0909-A` khớp combo cũ → không tạo dup, dùng `client_id`+`phone_id` cũ.
- [ ] Sender "Nguyễn Mới" `0912-XYZ` chưa có → tạo client mới, toast "Đã lưu khách mới…".
- [ ] Sender "Nguyễn X" (không SĐT) → `sender_id=NULL`, `sender_phone_id=NULL`, `sender_name_text='Nguyễn X'`.
- [ ] Sender = Receiver (cùng "Trần A" + `0909-A`) → cho phép, cả 2 FK cùng trỏ 1 client.

**Exception**:
- [ ] Tên sender hoặc receiver trống → toast "Vui lòng nhập tên người gửi và người nhận!", không submit.
- [ ] Sender "Trần A" `0909-B` khi DB có "Trần A" `0909-A` → tạo client mới (tên trùng nhưng SĐT khác → không match).
- [ ] Sender "Trần A" `0909-A` khi DB có "Trần Anh" `0909-A` → tạo client mới (SĐT trùng nhưng tên khác).
- [ ] Autocomplete: khách "Trần A" có primary=`0912-NEW` + old=`0909-A` → suggest CHỈ hiển `0912-NEW`, không hiển `0909-A`.
- [ ] Sau khi lưu bill, admin đổi tên khách trong tab Quản Lý → mở lại bill vẫn thấy tên gốc (snapshot).

---

## 4. Loại hàng (goodsType)

**US**: Là nhân viên, tôi khai loại hàng để lên phiếu và tra cứu sau này.

**Rules**:
- Bắt buộc cho Lưu đơn.
- KHÔNG bắt buộc cho Lưu nháp.
- Free text; ghi vào `bills.goods_type`.

**Happy**:
- [ ] Nhập "Quần áo" → Lưu đơn OK.

**Exception**:
- [ ] Lưu đơn với `goodsType` trống → toast lỗi.
- [ ] Lưu nháp với `goodsType` trống → cho phép.

---

## 5. Số kiện (packageCount)

**US**: Là nhân viên, tôi khai số kiện để đóng gói và giao chính xác.

**Rules**:
- Bắt buộc ≥ 1 cho Lưu đơn.
- KHÔNG bắt buộc cho Lưu nháp.
- Ghi vào `bills.package_count`.

**Happy**:
- [ ] Nhập 3 → Lưu đơn OK.

**Exception**:
- [ ] Lưu đơn với `packageCount=0` hoặc trống → toast "Vui lòng nhập số kiện hàng (tối thiểu 1)!".
- [ ] Nhập số âm hoặc chữ → không accept.

---

## 6. Giá trị hàng + Sao đặc biệt (bảo quản) — gộp

**US**: Là nhân viên, tôi khai giá trị hàng để hệ thống tự đề xuất mức bảo quản (sao đặc biệt); tôi có thể override nếu khách yêu cầu khác.

**Rules — Giá trị hàng (`goodsValue`)**:
- Kiểu số, cho phép để trống (default 0).
- Auto-format thousand separator.
- Ghi vào `bills.goods_value`.

**Rules — Sao đặc biệt (`specialStars`)**:
- Auto-derive từ `goodsValue` khi form đang mở (chưa override):
  - ≥ 10,000,000 → 2 sao.
  - ≥ 5,000,000 → 1 sao.
  - Else → 0 sao.
- User click chọn tay (0/1/2) → set `starsManual=true`, tắt auto-derive cho lần submit hiện tại.
- Khi LOAD bill cũ để sửa → `starsManual=false` (reset), re-derive theo `goods_value` hiện đang load. Admin phải override lại nếu muốn giữ giá trị override cũ.
- Khi `noDeclaredValue=true` (mục 12) → ép `special_stars=0` bất kể user chọn gì.
- Ghi vào `bills.special_stars`.

**Happy**:
- [ ] `goodsValue=12M`, không override → auto = 2 sao → submit → `special_stars=2`.
- [ ] `goodsValue=6M` → auto = 1 sao.
- [ ] `goodsValue=2M` → auto = 0 sao.
- [ ] `goodsValue=12M`, click 0 sao → submit → `special_stars=0`.
- [ ] Đổi `goodsValue` 0→6M khi chưa override → UI sao tự 0→1.
- [ ] `noDeclaredValue=true` + click 2 sao → submit → `special_stars=0`.

**Exception**:
- [ ] Nhập chữ / số âm vào `goodsValue` → không accept.
- [ ] Load bill cũ (goods_value=12M, special_stars=0 do override cũ) → UI hiển 2 sao (re-derive), admin phải click lại 0 sao.
- [ ] Override 2 sao rồi đổi `goodsValue` 6M→12M → sao giữ 2 (không re-derive vì đang manual).

---

## 7. Cước phí + 3 flag thanh toán loại trừ

**US**: Là nhân viên, tôi khai cước và trạng thái thanh toán rõ ràng: đơn thường / miễn phí / báo giá sau / thanh toán ngay. 4 trạng thái loại trừ nhau.

**Rules chung**:
- 3 checkbox `isFreeShipping`, `feeQuoteLater`, `isPaidImmediately` MUTUAL EXCLUSIVE (tick 1 → 2 kia untick).
- Mapping UI → DB:
  - `isFreeShipping=true` → `payment_status='free'`, `shipping_fee=0`.
  - `feeQuoteLater=true` → `payment_status='quote_later'`, `shipping_fee=0`.
  - `isPaidImmediately=true` → `payment_status='paid'`, `shipping_fee=user nhập`.
  - Không flag nào → `payment_status='unpaid'`, `shipping_fee=user nhập`.
- Load bill cũ: đọc thẳng `bills.payment_status`, không suy diễn từ `shipping_fee=0`.

### 7a. Cước thường (không flag nào)

- Input cước bình thường, required cho Lưu đơn.
- Không insert `bill_payment_details`.

**Happy**:
- [ ] Cước 200k, không flag → `payment_status='unpaid'`, `shipping_fee=200000`.

**Exception**:
- [ ] Cước trống, không flag, Lưu đơn → toast "Vui lòng nhập cước phí!".

### 7b. Miễn phí (`isFreeShipping`)

- Tick → input cước ẩn, hiển label "Miễn phí".
- Submit → `payment_status='free'`, `shipping_fee=0`, KHÔNG insert `bill_payment_details`.

**Happy**:
- [ ] Tick miễn phí → input ẩn → submit → DB đúng.
- [ ] Load bill `payment_status='free'` → UI tick sẵn.

**Exception**:
- [ ] Tick miễn phí sau khi đã nhập cước 200k → input biến mất, giá trị bị reset về 0 khi lưu.
- [ ] Tick miễn phí rồi tick paid → miễn phí auto untick (mutual exclusion).

### 7c. Báo giá sau (`feeQuoteLater`)

- Tick → input cước hiện với placeholder "Báo giá sau", cho phép trống.
- Submit → `payment_status='quote_later'`, `shipping_fee=0`.
- Đơn này hiển "Chưa có cước" trong bảng tổng hợp; admin/member sau này mở lại để nhập cước (mục 16).

**Happy**:
- [ ] Tick báo giá sau → placeholder đúng → submit → `payment_status='quote_later'`.
- [ ] Load bill `payment_status='quote_later'` → UI tick sẵn.

**Exception**:
- [ ] Tick báo giá sau + gõ số vào ô cước → submit → cước reset 0.

### 7d. Thanh toán ngay (`isPaidImmediately`)

- Tick → input cước required.
- Submit khi cước 200k:
  - `bills.payment_status='paid'`, `shipping_fee=200000`, `actual_amount_paid=200000`.
  - INSERT `bill_payment_details(amount_paid=200000, branch_id=session.branch_id, collected_by=session.userId)`.
- `bill_payment_details.branch_id` = **session.branch_id** (chi nhánh nhân viên login), KHÔNG phải `bills.branch_id`.

**Happy**:
- [ ] Member SG tick paid + cước 200k → INSERT bill + payment record; `payment_details.branch_id=SG`, `collected_by=<user SG>`.
- [ ] Admin login SG chọn `bills.branch_id=GL`, tick paid → `bills.branch_id=GL` nhưng `payment_details.branch_id=SG`.

**Exception**:
- [ ] Tick paid + cước trống, Lưu đơn → toast lỗi cước.
- [ ] Tick paid ở form **Lưu nháp** → **popup confirm** (xem mục 14).

---

## 8. Giao tận nơi + Địa chỉ giao (isHomeDelivery + deliveryAddress)

**US**: Là nhân viên, tôi khai đơn có giao tận nơi hay không; nếu có, tôi phải nhập địa chỉ. Nếu receiver đã có địa chỉ lưu sẵn trong hệ thống, tôi được autofill để không phải gõ lại; nếu tôi sửa hoặc nhập địa chỉ mới, hệ thống lưu lại địa chỉ mới cho khách để lần sau tự dùng.

**Rules — checkbox + address input**:
- Checkbox `isHomeDelivery`.
- `isHomeDelivery=true` → input `deliveryAddress` hiện + required.
- `isHomeDelivery=false` → input ẩn hoặc disabled; submit ép `bills.delivery_address=NULL`.
- Submit → `bills.is_home_delivery` và `bills.delivery_address` ghi đúng.

**Rules — auto-populate address từ receiver**:
- Khi receiver được match qua autocomplete/resolve:
  - Nếu `clients.address` của receiver KHÔNG rỗng → autofill vào `deliveryAddress` input.
  - Nếu `clients.address` rỗng → giữ input trống, chờ user nhập.
- Auto-populate CHỈ chạy khi tạo bill mới hoặc load draft.
- Khi LOAD bill cũ (đã có `bill_code`) → autofill từ `bills.delivery_address` (snapshot), KHÔNG từ `clients.address`.

**Rules — write-back địa chỉ vào `clients.address`**:
- Sau khi submit thành công VÀ `isHomeDelivery=true`:
  - Receiver mới (chưa có DB): `clients.address = deliveryAddress`.
  - Receiver cũ, `clients.address` rỗng: UPDATE `clients.address = deliveryAddress` (write-back lần đầu).
  - Receiver cũ, `clients.address` khác `deliveryAddress` (user sửa): UPDATE `clients.address = deliveryAddress` (**ghi đè**).
  - Receiver cũ, `clients.address` = `deliveryAddress` (không đổi): không update.
- Khi `isHomeDelivery=false`: KHÔNG đụng `clients.address` (giữ nguyên).

**Happy**:
- [ ] Tick giao tận nơi + nhập "123 Trần Phú" → `is_home_delivery=true`, `delivery_address='123 Trần Phú'`.
- [ ] Không tick → `is_home_delivery=false`, `delivery_address=NULL`.
- [ ] Receiver cũ có `clients.address="10 Nguyễn Trãi"` + tick giao tận nơi → input autofill "10 Nguyễn Trãi".
- [ ] Receiver cũ rỗng địa chỉ, user nhập "5 Lê Lợi" + submit → `clients.address` update thành "5 Lê Lợi".
- [ ] Receiver cũ "10 Nguyễn Trãi", user sửa thành "15 Nguyễn Trãi" + submit → `clients.address` update thành "15 Nguyễn Trãi" (ghi đè).
- [ ] Receiver mới, tick giao tận nơi, nhập "123 Trần Phú" → tạo client mới với `clients.address="123 Trần Phú"`.

**Exception**:
- [ ] Tick giao tận nơi + địa chỉ trống → toast "Vui lòng nhập địa chỉ giao hàng!", không submit.
- [ ] Receiver cũ "10 Nguyễn Trãi", user bỏ tick giao tận nơi → `clients.address` giữ "10 Nguyễn Trãi", `bills.delivery_address=NULL`.
- [ ] Load bill cũ `is_home_delivery=true` → UI tick + autofill địa chỉ TỪ `bills.delivery_address` (snapshot), không từ `clients.address` hiện tại.
- [ ] Receiver được autofill "10 Nguyễn Trãi", user xóa trắng input rồi bấm submit với `isHomeDelivery=true` → toast lỗi địa chỉ trống.

---

## 9. Ghi chú + Check CCCD + Xuất VAT (merged — DESIGN MỚI)

> **Design change** (round 2): bỏ field riêng `expectedIdInfo`. Field `orderNote` giờ dual-purpose: ghi chú tự do + chứa thông tin CCCD/VAT khi tick flag tương ứng. Giới hạn 200 ký tự.

**US**: Là nhân viên, khi đơn yêu cầu kiểm CCCD hoặc xuất hóa đơn VAT, tôi ghi thẳng thông tin vào ô ghi chú (không có field riêng); ô ghi chú lúc đó trở thành bắt buộc để tôi không quên.

**Rules — 3 checkbox độc lập**:
- `requireIdCheck` (yêu cầu kiểm CCCD).
- `exportVat` (xuất hóa đơn VAT).
- Cả 2 độc lập với nhau, có thể tick riêng hoặc cả 2.

**Rules — `orderNote` (dual-purpose)**:
- Free text, giới hạn **200 ký tự** (client-side `maxLength=200` + counter "N/200"; server-side CHECK).
- Default optional.
- **Conditional required**:
  - Không tick gì → optional, placeholder default "Ghi chú thêm nếu cần".
  - Chỉ CCCD → required, placeholder + error "Vui lòng nhập thông tin CCCD".
  - Chỉ VAT → required, placeholder + error "Vui lòng nhập thông tin xuất hóa đơn".
  - Cả 2 → required, placeholder + error "Vui lòng nhập thông tin CCCD, VAT".
- Submit → `bills.order_note`, `bills.require_id_check`, `bills.export_vat` ghi đúng.
- **KHÔNG còn `bills.expected_id_info`** — cột đã DROP; migration backfill dữ liệu cũ vào `order_note` (concat + truncate 200).

**Happy**:
- [ ] Không tick cờ nào, ghi chú trống → submit OK, `order_note=NULL`.
- [ ] Không tick cờ nào, ghi chú "Giao sáng" → submit OK, `order_note='Giao sáng'`.
- [ ] Tick requireIdCheck + nhập "CCCD 4 số cuối 1234" → submit OK, `require_id_check=true`, `order_note='CCCD 4 số cuối 1234'`.
- [ ] Tick exportVat + nhập "Công ty ABC, MST 123456" → submit OK, `export_vat=true`, `order_note='Công ty ABC, MST 123456'`.
- [ ] Tick cả 2 + nhập "CCCD 1234, MST 123456" → submit OK, 2 cờ = true.

**Exception**:
- [ ] Tick requireIdCheck, ghi chú trống → toast/error "Vui lòng nhập thông tin CCCD", không submit.
- [ ] Tick exportVat, ghi chú trống → error "Vui lòng nhập thông tin xuất hóa đơn".
- [ ] Tick cả 2, ghi chú trống → error "Vui lòng nhập thông tin CCCD, VAT".
- [ ] Nhập > 200 ký tự → chặn input tại 200, hiển counter "200/200".
- [ ] Tick requireIdCheck + nhập → bỏ tick → ghi chú vẫn giữ (không auto-clear); user tự xóa nếu muốn.
- [ ] Load bill cũ có `require_id_check=true`, `order_note='CCCD 1234'` → UI tick sẵn + hiển note.

---

## 10. Cảnh báo rủi ro (riskWarning)

**US**: Là nhân viên, tôi đánh dấu đơn có rủi ro bể vỡ để nhân viên giao cẩn thận và giới hạn trách nhiệm bồi thường.

**Rules**: Checkbox độc lập, không tương tác. Submit → `bills.risk_warning`.

**Happy**:
- [ ] Tick → `risk_warning=true`. Không tick → `false`.
- [ ] Load bill cũ tick sẵn đúng.

---

## 11. Khách tự đóng gói (selfPacked)

**US**: Là nhân viên, tôi đánh dấu đơn khách tự đóng để giới hạn trách nhiệm hư hỏng do đóng gói.

**Rules**: Checkbox độc lập. Submit → `bills.self_packed`.

**Happy**:
- [ ] Tick / không tick → DB đúng.

---

## 12. Không khai giá trị (noDeclaredValue)

**US**: Là nhân viên, tôi đánh dấu đơn khách không khai giá trị để giới hạn bồi thường và không tính bảo quản.

**Rules**:
- Checkbox `noDeclaredValue`.
- Tick → ép `goods_value=0`, `special_stars=0` khi lưu (dù user nhập).
- Persist qua 3 flow: create / update draft / update pending.
- Load bill cũ: đọc thẳng `bill.no_declared_value`, KHÔNG suy diễn từ `goods_value=0`.

**Happy**:
- [ ] Tick + `goodsValue=8M` → `goods_value=0`, `special_stars=0`, `no_declared_value=true`.
- [ ] Tick + Lưu nháp → persist đúng.
- [ ] Draft `no_declared_value=true`, sửa thành pending → giữ `true`.
- [ ] Load bill cũ `no_declared_value=true` → UI tick.

**Exception**:
- [ ] Bill cũ `goods_value=0`, `no_declared_value=false` → UI KHÔNG tick.

---

## 13. Xem bill in (Preview biên nhận)

**US**: Là nhân viên, sau khi lưu đơn (hoặc mở lại 1 bill cũ), tôi cần xem trước biên nhận theo layout in để gửi khách hoặc in ra giấy.

**Rules**:
- Nút "Xem bill in" hiển thị:
  - Ngay sau khi Lưu đơn thành công (thay thế nút "Lưu đơn", form chuyển state "submitted").
  - Trong tab tra cứu bill (billDetail) cho MỌI bill đã có `bill_code`.
- KHÔNG hiển với draft (`bill_code=NULL`).
- Click → modal preview format A5/A6 hiển:
  - Mã bill, ngày gửi, ngày có hàng dự kiến.
  - Tên + SĐT sender/receiver (từ 4 snapshot columns, KHÔNG JOIN clients).
  - Loại hàng, số kiện, giá trị hàng, số sao đặc biệt.
  - Cước phí + trạng thái thanh toán.
  - Địa chỉ giao (nếu có).
  - Ghi chú (bao gồm CCCD/VAT khi có).
  - Các flag: cảnh báo rủi ro, tự đóng gói, không khai giá trị, VAT, CCCD.
  - Barcode Code128 hoặc QR chứa `bill_code`.
- Nút "In" (`window.print()`) và "Đóng".
- Bill cancelled → overlay watermark chéo "ĐÃ HỦY" màu đỏ 30% opacity.

**Happy**:
- [ ] Tạo đơn xong → nút "Xem bill in" hiện → click → modal preview hiển đúng data.
- [ ] Ở bill detail của bill cũ → nút "Xem bill in" hiện → preview đúng.
- [ ] Click "In" → mở dialog in của browser.

**Exception**:
- [ ] Draft (chưa có `bill_code`) → nút "Xem bill in" KHÔNG hiện.
- [ ] Bill cancelled → nút vẫn hiện, preview có watermark "ĐÃ HỦY".
- [ ] Bill có `sender_phone_text=NULL` → phần SĐT hiển "—" hoặc trống, không crash.
- [ ] Đổi `clients.fullname` sau khi tạo bill → preview vẫn hiển tên gốc (snapshot).

---

## 14. Lưu nháp (Save Draft)

**US**: Là nhân viên, khi khách chưa đủ thông tin (chưa biết cước, chưa đủ loại hàng, v.v.), tôi lưu tạm ở dạng nháp để không mất data đã nhập.

**Rules**:
- Nút "Lưu nháp" khác nút "Lưu đơn".
- Chỉ bắt buộc: `senderName` + `receiverName`. Field khác optional.
- Submit → INSERT `bills` với `bill_code=NULL`, `delivery_status='draft'`, các field khác lưu theo form (có thể NULL/0/false).
- `business_date` vẫn = session hiện tại.
- Resolve khách giống Lưu đơn.
- **Chặn Lưu nháp khi tick `isPaidImmediately`**:
  - Popup confirm: "Bill đã thanh toán là bill chính thức, không thể là nháp. Bạn muốn chuyển sang Lưu đơn?"
  - `[Đồng ý]` → chạy flow Lưu đơn (enforce full validation).
  - `[Hủy]` → giữ form, user tự untick paid rồi Lưu nháp lại.
- **Ghi audit log** (`action='bill_draft_create'` hoặc `'bill_draft_update'`).

**Happy**:
- [ ] Nhập sender+receiver, các field khác trống → Lưu nháp → INSERT `delivery_status='draft'`, `bill_code=NULL`.
- [ ] Mở lại draft, sửa 1 field, Lưu nháp → UPDATE giữ `draft`.
- [ ] Draft có `no_declared_value=true` → persist đúng.
- [ ] Audit log có row cho action tạo/sửa draft.

**Exception**:
- [ ] Lưu nháp thiếu senderName → toast lỗi.
- [ ] Lưu nháp thiếu receiverName → toast lỗi.
- [ ] Lưu nháp với `packageCount=0` → cho phép (khác Lưu đơn).
- [ ] Lưu nháp với cước trống, không flag → cho phép.
- [ ] Lưu nháp với `isPaidImmediately=true` → popup confirm hiện; bấm Đồng ý → chuyển sang Lưu đơn; bấm Hủy → không lưu, form giữ nguyên.

---

## 15. Lưu đơn (bill chính thức, sinh `bill_code`)

**US**: Là nhân viên, khi khách đủ thông tin, tôi bấm "Lưu đơn" để đơn chính thức có mã bill, sẵn sàng giao.

**Rules**:
- Enforce đầy đủ validation: senderName, receiverName, goodsType, packageCount≥1, cước hoặc flag phù hợp, địa chỉ nếu isHomeDelivery, order_note nếu tick CCCD/VAT.
- Reserve `bill_code` từ session hiện tại.
- INSERT `bills` với `delivery_status='pending'`, `bill_code=<mã sinh>`.
- Nếu tick paid → INSERT `bill_payment_details`.
- Resolve khách (mục 3).
- Write-back địa chỉ (mục 8).
- **RPC atomic**: mọi INSERT (bills + audit_log + optionally bill_payment_details) wrap trong 1 transaction. Bất kỳ bước nào fail → rollback toàn bộ.
- Ghi audit log (`action='bill_create'`).

**Case đặc biệt — Lưu đơn từ 1 draft đang mở (convert draft → pending)**:
- Mở draft (từ list nháp) → form autofill từ draft.
- Bấm "Lưu đơn" (thay vì "Lưu nháp"):
  - Enforce full validation.
  - Reserve `bill_code` mới.
  - Update row draft cũ (không INSERT mới): `bill_code=<mới>`, `delivery_status='pending'`, `business_date=session hiện tại` (re-stamp).
  - Nếu tick paid → INSERT payment.
  - Audit log (`action='bill_convert_from_draft'`).

**Happy**:
- [ ] Đủ field, không draft → Lưu đơn → sinh `bill_code`, `delivery_status='pending'`, `business_date=hôm nay`.
- [ ] Mở draft, đủ field, Lưu đơn → UPDATE draft thành pending, sinh mã, re-stamp `business_date`.
- [ ] Lưu đơn với paid → INSERT payment record.
- [ ] Lưu đơn với báo giá sau → `payment_status='quote_later'`, không insert payment.
- [ ] Sau Lưu đơn thành công → form reset + nút "Xem bill in" hiển.
- [ ] Audit log có row (create hoặc convert_from_draft).

**Exception**:
- [ ] Thiếu bất kỳ field bắt buộc → toast lỗi tương ứng, không submit.
- [ ] Race: 2 client submit cùng `bill_seq` → 1 nhận 23505 → auto refetch + retry silent (max 3 lần).
- [ ] Retry fail 3 lần → modal/toast lỗi hệ thống, form giữ data.
- [ ] Audit_log INSERT fail giữa RPC → toàn bộ rollback, bill KHÔNG lưu, toast lỗi + form giữ data.
- [ ] Double-click nút "Lưu đơn" → chỉ tạo 1 bill (nút disabled sau click đầu).

---

## 16. Sửa đơn (draft + pending) — mọi role có audit log

**US**: Là nhân viên (member hoặc admin), tôi sửa được đơn draft hoặc pending của tôi (cùng chi nhánh, chưa paid) để cập nhật thông tin; trước khi lưu tôi review đúng những gì đã thay đổi qua modal diff. Mọi thay đổi track audit log.

**Rules**:
- **Member cũng sửa được** (không giới hạn admin/boss).
- Sửa được đơn:
  - `delivery_status='draft'` — mọi field.
  - `delivery_status='pending'` VÀ `payment_status ∈ {unpaid, free, quote_later}` — mọi field trừ `bill_code`, `branch_id`, `sendDate`.
- **KHÔNG sửa được**:
  - `delivery_status='pending'` + `payment_status='paid'` — muốn thay đổi phải hủy trước.
  - `delivery_status='cancelled'` — đã hủy, chỉ đọc.
  - Bill của chi nhánh khác (dù admin) — cross-branch bị chặn.
  - Boss ở bất kỳ trường hợp nào — chỉ đọc.
- Bấm "Sửa" → autofill form từ bill, giữ snapshot.
- Sửa xong bấm Lưu:
  1. Compute diff giữa state hiện tại và snapshot.
  2. Nếu diff RỖNG → **skip modal, không UPDATE DB, toast "Không có thay đổi để lưu"**.
  3. Nếu có diff → hiển modal "Bạn vừa thay đổi các thông tin:" liệt kê `<label tiếng Việt>: <cũ format> → <mới format>`.
  4. OK → gọi RPC `update_bill_with_audit` (UPDATE bills + INSERT audit_log trong 1 transaction) + toast "Đã cập nhật đơn <bill_code>".
  5. Cancel → giữ form ở state đã sửa (không revert), không UPDATE DB.
- `bill_code` disabled.
- `branch_id` disabled (bill đã có mã).
- "Ngày gửi" readonly (mục 2).
- Đổi sender/receiver name/phone → re-resolve, có thể tạo client mới.
- Đổi `deliveryAddress` với `isHomeDelivery=true` → write-back `clients.address` theo mục 8.
- **KHÔNG có case đổi `payment_status` từ paid → unpaid** (bill paid không sửa được).
- Audit log ghi cho MỌI mutation.

**Happy**:
- [ ] Member SG mở đơn `05SGA02` (pending+quote_later) của SG, nhập cước 250k + tick paid → modal:
  ```
  Bạn vừa thay đổi các thông tin:
  • Cước phí: 0 → 250,000
  • Trạng thái thanh toán: Báo giá sau → Đã thanh toán
  ```
- [ ] Bấm OK → UPDATE + INSERT payment + audit log + toast.
- [ ] Bấm Cancel → không UPDATE, form giữ state đã sửa (không revert).
- [ ] Bấm Lưu mà không đổi gì → skip modal, toast "Không có thay đổi để lưu".
- [ ] Sửa draft (đổi tên receiver + note) → modal + UPDATE + audit log.
- [ ] Member SG sửa bill draft SG → OK.
- [ ] Admin SG sửa bill pending+unpaid SG → OK.

**Exception**:
- [ ] Cố sửa đơn `paid` → nút Sửa disabled với tooltip "Bill đã thu tiền, muốn thay đổi vui lòng hủy đơn".
- [ ] Cố sửa đơn `cancelled` → nút Sửa disabled hoặc form readonly.
- [ ] Member SG cố sửa bill của GL → nút Sửa disabled với tooltip "Chỉ sửa được bill của chi nhánh mình".
- [ ] Admin SG cố sửa bill của GL → nút Sửa disabled với tooltip tương tự.
- [ ] Boss mở bill (mọi trạng thái) → nút Sửa ẩn hoàn toàn.
- [ ] Cố sửa `bill_code` → disabled, không nhận input.
- [ ] Cố đổi branch khi bill đã có mã → disabled.
- [ ] Cố sửa "Ngày gửi" → disabled.
- [ ] Double-click nút Lưu → chỉ UPDATE 1 lần.
- [ ] Race: admin A đang sửa, admin B mutate trước → refetch phát hiện → toast "Đơn đã được cập nhật bởi người khác, đang refresh" + không mutation lần 2.

---

## 17. Hủy đơn (draft + pending) — mọi role, soft delete, auto refund cho paid

**US**: Là nhân viên (member hoặc admin), tôi hủy được đơn draft hoặc pending của tôi kèm lý do; đơn không bị xóa vĩnh viễn khỏi DB, giữ lịch sử để tra cứu. Nếu đơn đã thu tiền, hệ thống tự động tạo phiếu chi hoàn tiền.

**Rules chung**:
- **Member cũng hủy được** (không giới hạn admin).
- Boss KHÔNG hủy được (chỉ đọc).
- Admin/member KHÔNG hủy cross-branch.
- Nút Hủy → mở modal có field text "Lý do hủy" (required, ≤ 200 ký tự).
- Lý do hủy lưu vào `audit_log.diff.reason` (JSONB), KHÔNG prepend `order_note`.
- **Chặn double-cancel**: nút disabled sau click; refetch trước submit — nếu bill đã bị cancel bởi user khác → toast "Đơn đã hủy trước đó" + refresh UI.
- RPC atomic: cancel + audit + (nếu paid) expense refund wrap 1 transaction.

**Rules — hủy draft**:
- Submit → **UPDATE `bills.is_delete=true`** (soft delete), KHÔNG DELETE cứng.
- Draft biến mất khỏi list nháp UI (filter `is_delete=false`), nhưng row vẫn còn trong DB.
- Ghi audit log (`action='bill_draft_cancel'`, `diff.reason=<lý do>`, `diff.is_delete=[false, true]`).

**Rules — hủy pending unpaid/free/quote_later**:
- Submit → UPDATE `delivery_status='cancelled'`. `bill_code`, `order_note` giữ nguyên.
- Ghi audit log (`action='bill_cancel'`, `diff.reason=<lý do>`, `diff.delivery_status=[pending, cancelled]`).

**Rules — hủy pending paid (auto refund)**:
- UPDATE `delivery_status='cancelled'`.
- Auto INSERT 1 row `expenses`:
  - `amount = -SUM(bill_payment_details.amount_paid WHERE bill_id=<target>)` (số âm).
  - `source_bill = <bill_id>`.
  - `branch_id = bills.branch_id`.
  - `note = 'Hoàn cước bill <bill_code> do hủy đơn'`.
  - `created_by = session.userId`.
  - `is_delete = false`.
- Ghi 2 audit log: `action='bill_cancel'` + `action='refund_created'`.
- Expense refund KHÔNG cho admin/member sửa/xóa qua UI.
- Toast: "Đã hủy đơn <bill_code> và hoàn cước <số tiền> VND".

**Happy — hủy draft**:
- [ ] Member hủy draft với lý do "khách đổi ý" → `bills.is_delete=true`, row vẫn còn DB, không hiển UI list nháp, audit log có row.

**Happy — hủy pending unpaid**:
- [ ] Member hủy pending `05SGA03` (unpaid) với lý do "hàng hỏng" → `delivery_status='cancelled'`, `bill_code` giữ, `order_note` không đổi, audit log có `action='bill_cancel'`, `diff.reason='hàng hỏng'`.

**Happy — hủy pending paid (auto refund)**:
- [ ] Bill `05SGA02` paid 250k, admin hủy với lý do "Khách trả hàng":
  - [ ] `bills.delivery_status='cancelled'`.
  - [ ] `expenses` có row mới `amount=-250000`, `source_bill=<bill_id>`, `note='Hoàn cước bill 05SGA02 do hủy đơn'`.
  - [ ] Audit log 2 rows: `bill_cancel` + `refund_created`.
  - [ ] Toast "Đã hủy đơn 05SGA02 và hoàn cước 250,000 VND".

**Happy — hủy bill free (không refund)**:
- [ ] Bill `05SGA04` free, hủy → `delivery_status='cancelled'`, KHÔNG có expense mới (free = không thu tiền = không có gì hoàn).

**Exception**:
- [ ] Hủy không nhập lý do → chặn, toast/error "Vui lòng nhập lý do hủy".
- [ ] Nhập lý do > 200 ký tự → chặn tại 200.
- [ ] Boss cố hủy → nút Hủy ẩn hoàn toàn.
- [ ] Member SG cố hủy bill GL → nút Hủy disabled.
- [ ] Double click nút Hủy → chỉ execute 1 lần.
- [ ] Race: hủy 1 bill đã bị người khác hủy → refetch phát hiện, toast "Đơn đã hủy trước đó", không mutation lần 2.
- [ ] Bill soft-deleted vẫn tra cứu được qua tab lịch sử/audit — verify UI có filter phù hợp.
- [ ] Expense refund tạo tự động, cố mở tab Chi Phí sửa row này → hiển readonly hoặc không có nút Sửa/Xóa.
- [ ] Bill paid nhiều lần thu (VD 2 lần 100k + 150k), hủy → expense refund `amount=-250000` (sum tất cả).

---

## 18. Reset form sau submit

**US**: Là nhân viên, sau khi lưu/hủy đơn thành công, form clear để nhập đơn tiếp mà không sót data cũ.

**Rules**:
- Lưu đơn thành công → form reset toàn bộ, nút "Xem bill in" hiển (mục 13).
- Lưu nháp thành công → form reset + toast "Đã lưu nháp".
- Sửa bill thành công → form reset, quay lại tab trước đó (billDetail hoặc list).
- Hủy bill thành công → form reset, quay lại tab trước đó.
- **Submit fail** (network / DB error / RPC rollback) → form GIỮ NGUYÊN, toast lỗi, cho user retry.
- **Không có autosave**: đóng tab giữa chừng → data mất (theo confirm nghiệp vụ).

**Happy**:
- [ ] Lưu đơn xong → form trống, sẵn cho đơn mới, nút "Xem bill in" cho bill vừa tạo.
- [ ] Sửa bill xong → quay lại tab bill detail của bill đó.

**Exception**:
- [ ] Network drop giữa submit → form giữ nguyên, toast retry.
- [ ] Đóng tab giữa chừng → mở lại form trống (không autosave).

---

## 19. Audit log (cross-cutting)

**US**: Là admin/boss, tôi cần tra cứu mọi thay đổi trên bất kỳ bill nào, biết ai làm gì lúc nào, để audit và giải quyết tranh chấp.

**Rules**:
- Mọi mutation trên `bills` phải insert row vào `audit_log`. Action enum kín:
  - `bill_create` (Lưu đơn mới, sinh bill_code).
  - `bill_draft_create` / `bill_draft_update` (Lưu nháp).
  - `bill_update` (Sửa đơn pending).
  - `bill_convert_from_draft` (draft → pending).
  - `bill_cancel` (hủy pending → cancelled).
  - `bill_draft_cancel` (hủy draft → soft delete).
  - `bill_delivered` (giao xong — out of scope checklist này).
  - `bill_payment_received` (thu tiền → paid).
  - `refund_created` (auto khi hủy paid).
- Row audit_log gồm: `bill_id`, `actor_user_id`, `actor_username` (snapshot), `actor_role` (snapshot), `actor_branch_id`, `entity_type`, `entity_id`, `entity_label` (bill_code hoặc "Nháp"), `action`, `diff` (JSONB `{ field: [old, new], reason: "..." }`), `created_at`.
- **Append-only**: không có code path UPDATE/DELETE row audit_log.
- **RPC atomic**: mọi INSERT audit_log wrap chung transaction với mutation bill (create/update/cancel/soft-delete/expense-refund). Bất kỳ bước fail → rollback tất cả.
- Section "📜 Lịch sử đơn" trên bill detail hiển các row này với label tiếng Việt (`auditLabels.js`).

**Happy**:
- [ ] Mỗi action ở mục 14, 15, 16, 17 đều tạo 1 row audit_log (2 rows cho case hủy paid).
- [ ] Diff format đúng: field label tiếng Việt (VD "Cước phí"), giá trị format tiếng Việt (VD "250,000").
- [ ] Section lịch sử refresh sau mỗi mutation (không phải reload trang mới thấy).
- [ ] Xoá user "Linh" khỏi `users` sau đó → audit_log của Linh vẫn hiển `actor_username='Linh'`, `actor_role='admin'` (snapshot).

**Exception**:
- [ ] Cố UPDATE hoặc DELETE row audit_log qua RLS → reject.
- [ ] Login → KHÔNG log (chỉ mutation mới log).
- [ ] Autocomplete query / mở form / xem dữ liệu → KHÔNG log (chỉ mutation).
- [ ] Mutation fail giữa RPC (VD INSERT bills OK nhưng INSERT audit_log fail) → toàn bộ rollback, bill KHÔNG lưu, toast lỗi + form giữ.

---

## 20. Double-click guard + Race check (cross-cutting)

**US**: Là hệ thống, không được tạo bill trùng / cancel 2 lần / update 2 lần khi user bấm nút nhanh hoặc 2 nhân viên thao tác cùng lúc.

**Rules**:
- Mọi nút mutation (`Lưu đơn`, `Lưu nháp`, `Cập nhật`, `Hủy`) → state `submitting` set khi bấm; nút disabled cho đến khi RPC hoàn tất (thành công hoặc fail).
- Bấm nhiều lần liên tiếp → chỉ execute 1 lần.
- Trước UPDATE/CANCEL, refetch bill state:
  - Nếu bill đã bị mutate bởi user khác (`delivery_status` đã đổi, `is_delete=true`, `payment_status` khác snapshot) → toast "Đơn đã được cập nhật bởi người khác, đang refresh" + refresh UI, KHÔNG mutation lần 2.
- Race sinh mã bill (INSERT/UPDATE nhận 23505) → auto refetch session + retry silent, max 3 lần. Retry fail 3 lần → toast lỗi hệ thống.

**Happy**:
- [ ] Bấm "Lưu đơn" 3 lần liên tiếp trong 200ms → chỉ tạo 1 bill.
- [ ] Bấm "Hủy" 2 lần liên tiếp → bill chỉ chuyển `cancelled` 1 lần.
- [ ] 2 client cùng insert `05SGA05` → 1 thắng, 1 refetch → thấy seq=6 → insert `05SGA06` thành công, không modal.

**Exception**:
- [ ] Admin A đang sửa bill `05SGA02`, admin B hủy bill này trước → A bấm OK → refetch phát hiện cancelled → toast "Đơn đã được cập nhật bởi người khác" + không UPDATE.
- [ ] Retry mã bill fail 3 lần → toast/modal "Không thể sinh mã bill, vui lòng thử lại".

---

## Notes cho tester

- **Ưu tiên**: chạy section 0 → 17 trước (form flow chính). Section 18, 19, 20 là cross-cutting, verify khi làm các case của 14-17.
- **Test data cần có**:
  - Session `branch_sessions` với `business_date` biết trước.
  - Ít nhất 3 khách: 1 có primary+secondary, 1 có primary+old, 1 chưa có trong DB.
  - 1 draft cũ (tạo hôm trước) để test re-stamp `business_date` khi convert.
  - 1 bill pending unpaid, 1 pending paid, 1 pending quote_later, 1 pending free — mỗi loại 1 ví dụ để test sửa/hủy.
  - 1 bill cancelled sẵn để test không thể sửa.
- **Reset giữa test**: nếu test destructive (hủy paid → tạo expense refund), reset DB bằng SQL script trước batch test kế tiếp.
- **Roles**: cần 3 tài khoản test — 1 member SG, 1 admin SG, 1 boss.
- **Cross-branch test**: cần thêm 1 admin GL (hoặc member GL) để verify cross-branch reject.

---

## Lịch sử cập nhật

| Ngày       | Ai | Thay đổi                                                             |
|------------|-----|----------------------------------------------------------------------|
| 2026-07-06 | -   | v1 — tổng hợp từ manual review + 5 change in-progress + round 2 mới. |
