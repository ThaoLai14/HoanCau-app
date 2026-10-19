# Tasks: fix-shipment-intake-issues

> Follow implementation order in `design.md` §3. Mỗi task nhỏ đủ để implement + verify trong 1 lượt.

## 1. Migrations (DB trước code)

- [x] 1.1 Tạo file `add-quote-later-status.sql` ở repo root: DROP + ADD CHECK constraint `bills_payment_status_check` với 4 giá trị `{paid, unpaid, free, quote_later}` (N-11).
- [x] 1.2 Bổ sung vào cùng file `add-quote-later-status.sql` block backfill `UPDATE bills SET payment_status='quote_later' WHERE payment_status='unpaid' AND (shipping_fee=0 OR shipping_fee IS NULL) AND delivery_status != 'cancelled';` (kèm comment cảnh báo review).
- [x] 1.3 Tạo file `add-bill-snapshot-columns.sql`: ADD 4 cột `sender_name_text`, `sender_phone_text`, `receiver_name_text`, `receiver_phone_text` (TEXT, nullable ban đầu) (N-12).
- [x] 1.4 Trong `add-bill-snapshot-columns.sql`, thêm backfill từ FK: JOIN `clients` + `client_phones` để copy `fullname`/`phone_number` vào 4 cột snapshot.
- [x] 1.5 Trong `add-bill-snapshot-columns.sql`, thêm verify NULL count + `ALTER COLUMN sender_name_text SET NOT NULL` + `receiver_name_text SET NOT NULL` (chạy sau khi verify).
- [x] 1.6 Tạo file `add-bill-code-unique.sql`: `ALTER TABLE bills ADD CONSTRAINT bills_branch_code_uniq UNIQUE (branch_id, bill_code);` (I-9).
- [ ] 1.7 Verify manually trên DB staging: 3 migration chạy sạch, backfill khớp expected count. Confirm với anh trước khi chạy production.

## 2. I-1: persist `no_declared_value` (quick fix)

- [x] 2.1 Trong `executeUpdateDraft` ([src/App.jsx#L974-L993](../../../src/App.jsx#L974-L993)), thêm `no_declared_value: data.noDeclaredValue || false,` vào `updatePayload`.
- [x] 2.2 Trong `executeConvertDraftToBill` ([src/App.jsx#L1113-L1132](../../../src/App.jsx#L1113-L1132)), thêm `no_declared_value: data.noDeclaredValue || false,` vào `updatePayload`.
- [x] 2.3 Trong `handleFormSubmit`/tương đương xây `data` (khoảng [src/App.jsx#L820-L890](../../../src/App.jsx#L820-L890)), đảm bảo `noDeclaredValue` được include trong object gửi cho 3 hàm execute.
- [x] 2.4 Sửa load bill cũ ([src/App.jsx#L2675](../../../src/App.jsx#L2675) và [src/App.jsx#L3464](../../../src/App.jsx#L3464)): thay `setNoDeclaredValue(bill.goods_value === 0)` bằng `setNoDeclaredValue(!!bill.no_declared_value)`.
- [ ] 2.5 Manual test: tạo bill với `noDeclaredValue=true`, reload trang, mở lại bill → checkbox vẫn tick + `goods_value` giữ đúng.

## 3. I-8: branch selector theo role + boss block

- [x] 3.1 Trong form intake (tab `bills`), tìm nơi render branch (chọn SG/GL). Nếu `userRole === "admin"` → render `<select>` với 2 option; ngược lại → render `<div className="bg-gray-100 cursor-not-allowed">` hiện label branch hiện tại (readonly).
- [x] 3.2 Nếu `userRole === "boss"`, ngay đầu render tab `bills` return sớm với message `"Boss không tạo đơn. Vui lòng xem chi tiết qua các tab khác."`.
- [x] 3.3 State `currentBranch` khi admin đổi select → cập nhật (đã có logic hoặc thêm mới); default = `loggedBranch` từ session.
- [ ] 3.4 Manual test 3 role: admin đổi được branch; member lock; boss thấy message thay vì form.

## 4. I-6 + N-12 + N-13: `resolveOrCreateClient()` + snapshot columns + address exception

- [x] 4.1 Trong `src/App.jsx` (near top of intake helpers), viết helper `async function resolveOrCreateClient({ fullname, phone, isReceiver, isHomeDelivery, deliveryAddress })` theo spec code trong `design.md` §I-6. Trả về `{ clientId, phoneId, isNew, addressUpdated }`.
- [x] 4.2 Trong helper: nếu `phone` rỗng → return `{ clientId: null, phoneId: null, isNew: false, addressUpdated: false }` (N-12 — không insert `clients`).
- [x] 4.3 Trong helper: match combo `(LOWER(fullname), phone_number)` qua `client_phones` JOIN `clients`. Bỏ qua `clients.is_delete=true`.
- [x] 4.4 Trong helper: nếu match + `isReceiver && isHomeDelivery && deliveryAddress` khác `clients.address` → UPDATE `clients.address` (N-13, silent). Set `addressUpdated=true`. KHÔNG động `fullname`, `is_blacklist`, `blacklist_reason`, `client_phones`.
- [x] 4.5 Trong helper: nếu không match → INSERT `clients` (fullname, address=deliveryAddress khi receiver+home, is_blacklist=false) + INSERT `client_phones` (type='primary'). Return `isNew=true`.
- [x] 4.6 Trong `executeCreateBill` ([src/App.jsx#L1157](../../../src/App.jsx#L1157)+): thay 2 block resolve client cũ (sender + receiver) bằng 2 lời gọi `resolveOrCreateClient()`. Toast `"Đã lưu khách mới <tên> vào danh sách khách hàng"` khi `isNew=true`.
- [x] 4.7 Trong `executeUpdateDraft` ([src/App.jsx#L895](../../../src/App.jsx#L895)+): thay resolve client cũ bằng `resolveOrCreateClient()` cho cả sender + receiver.
- [x] 4.8 Trong `executeConvertDraftToBill` ([src/App.jsx#L1016](../../../src/App.jsx#L1016)+): thay resolve client cũ bằng `resolveOrCreateClient()` cho cả sender + receiver.
- [x] 4.9 Trong payload của cả 3 hàm execute, thêm 4 cột snapshot: `sender_name_text: data.senderName.trim()`, `sender_phone_text: data.senderPhone?.trim() || null`, `receiver_name_text: data.receiverName.trim()`, `receiver_phone_text: data.receiverPhone?.trim() || null`. Cho phép `sender_id`/`receiver_id` = null khi không SĐT.
- [x] 4.10 Trong `handleFormSubmit`, sender/receiver phone **không** còn required cho user; chỉ validate `senderName`/`receiverName` (name) và `receiverPhone` khi `isHomeDelivery=true` (address delivery cần liên hệ) — confirm với spec.
- [x] 4.11 Sửa mọi chỗ render bill hiển thị tên/SĐT khách (list bills, detail modal, in bill, tổng hợp): thay `bill.sender?.fullname` → `bill.sender_name_text`; `bill.receiver?.fullname` → `bill.receiver_name_text`; `bill.senderPhone?.phone_number` → `bill.sender_phone_text`; `bill.receiverPhone?.phone_number` → `bill.receiver_phone_text`. Grep toàn `App.jsx` cho pattern `sender?.fullname|receiver?.fullname|senderPhone?.phone|receiverPhone?.phone`.
- [x] 4.12 Ở autocomplete (`ClientAutocomplete.jsx`) và tab Quản Lý Khách Hàng: **giữ nguyên** dùng `clients` table (không đụng snapshot).
- [ ] 4.13 Manual test: (a) tạo bill khách hoàn toàn mới có SĐT → INSERT clients + phone + snapshot khớp; (b) tạo bill khách cũ khác address + home → address clients update; (c) tạo bill sender không có SĐT → `sender_id=null` + snapshot có tên; (d) sửa `clients.fullname` bên tab QLKH → bill cũ vẫn hiện tên gốc.

## 5. N-10: stars logic — bỏ force `starsManual=true` khi load

- [x] 5.1 Ở load bill cũ ([src/App.jsx#L2674](../../../src/App.jsx#L2674)): đổi `setStarsManual(true)` → `setStarsManual(false)`. `setSpecialStars(bill.special_stars || 0)` giữ nguyên (sẽ bị `useEffect` re-derive theo `goodsValue`).
- [x] 5.2 Tương tự ở [src/App.jsx#L3463](../../../src/App.jsx#L3463) (path 2 load bill).
- [x] 5.3 Confirm `useEffect` derive stars ([src/App.jsx#L648-L657](../../../src/App.jsx#L648-L657)) đang đúng logic: goods_value ≥10M → 2, ≥5M → 1, else 0.
- [x] 5.4 Xác nhận: khi user tương tác radio/dropdown `special_stars` → `setStarsManual(true)`. Khi tick `noDeclaredValue` → reset `special_stars=0` (đã có, verify).
- [ ] 5.5 Manual test: bill cũ có `goods_value=12M` + `special_stars=0` (đã override) → mở sửa → auto về 2 sao (chấp nhận trade-off theo design).

## 6. N-11: enum `quote_later` + UI + cột "Cước phí" tổng hợp

- [x] 6.1 Trong 3 hàm execute (`executeCreateBill`, `executeUpdateDraft`, `executeConvertDraftToBill`), viết inline helper compute `payment_status`:
  ```js
  const paymentStatus = data.isFreeShipping ? "free"
    : data.feeQuoteLater ? "quote_later"
    : data.isPaidImmediately ? "paid"
    : "unpaid";
  ```
  Thay 3 chỗ đang tính `data.isFreeShipping ? "free" : (data.isPaidImmediately ? "paid" : "unpaid")` ([App.jsx#L987](../../../src/App.jsx#L987), [App.jsx#L1127](../../../src/App.jsx#L1127), [App.jsx#L1281](../../../src/App.jsx#L1281)).
- [x] 6.2 `shipping_fee` payload: khi `feeQuoteLater=true` → `shipping_fee = 0` (giống `isFreeShipping`). Cập nhật 3 chỗ.
- [x] 6.3 Load bill cũ: đổi `setFeeQuoteLater(!bill.shipping_fee && bill.payment_status !== "free")` → `setFeeQuoteLater(bill.payment_status === "quote_later")`. Cả 2 chỗ ([App.jsx#L2672](../../../src/App.jsx#L2672) và [App.jsx#L3461](../../../src/App.jsx#L3461)).
- [x] 6.4 UI input cước ([App.jsx#L2955-L2970](../../../src/App.jsx#L2955-L2970)): khi `isFreeShipping=true` → **ẩn** input, thay bằng `<div className="bg-gray-100 border rounded px-3 py-1.5 text-sm">Miễn phí</div>`. Khi `feeQuoteLater=true` → giữ input với placeholder "Báo giá sau" (đã có).
- [x] 6.5 Validation `handleFormSubmit` ([App.jsx#L798](../../../src/App.jsx#L798)): giữ `if (!isFreeShipping && !feeQuoteLater && !shippingFee)` — không đổi.
- [x] 6.6 Khi admin sửa bill đang `quote_later` (N-4 sẽ handle popup diff): nếu user bỏ tick `feeQuoteLater` mà chưa nhập `shippingFee` → validation fail (đã cover 6.5).
- [x] 6.7 Cột "Cước phí" trong bảng Tổng hợp đơn: render conditional
  ```jsx
  {bill.payment_status === "free" ? <span className="text-emerald-600">Miễn phí</span>
   : bill.payment_status === "quote_later" ? <span className="text-amber-600">Chưa có cước</span>
   : <span>{formatVND(bill.shipping_fee)}</span>}
  ```
  Grep các bảng bills: tìm cột render `shipping_fee` → wrap conditional.
- [x] 6.8 Cột "Cước phí" trong bảng Doanh thu (tab revenue): tương tự 6.7.
- [x] 6.9 Bill in preview ([App.jsx#L1822](../../../src/App.jsx#L1822)): xử lý 3 case free / quote_later / normal (hiện đang có `pd.feeQuoteLater ? ""` — sửa thành `pd.feeQuoteLater ? "Chưa có cước"` cho rõ).
- [ ] 6.10 Manual test: (a) tạo bill với `feeQuoteLater=true` → DB `payment_status='quote_later'`, `shipping_fee=0`; (b) bảng Tổng hợp cột cước hiện "Chưa có cước"; (c) sửa bill → điền cước + tick paid → DB `payment_status='paid'`, `shipping_fee>0`; (d) bill free vẫn hiện "Miễn phí".

## 7. I-9: race protection UNIQUE + silent retry (downgraded)

- [x] 7.1 Sau khi migration 1.6 đã chạy, viết helper `computeBillCodeFromDB(branchUUID, branchCode)` đặt ở module top-level (sau `advanceDepartureSession`, [App.jsx#L100+](../../../src/App.jsx#L100)) để recompute bill_code từ DB theo session hiện tại. Kèm helper `isBillCodeConflict(err)` check `code=23505` + regex `bills_branch_code_uniq|bills_branch_bill_code`.
- [x] 7.2 Recompute qua `computeBillCodeFromDB` — hiện tại session vẫn localStorage-based (`getDayCounterFromStorage`), khi `add-server-session` merge sẽ swap sang DB session. Signature helper cố định, không phải đổi call sites.
- [x] 7.3 Refactor `executeCreateBill` INSERT: extract `buildBillPayload(billCode)` → vòng lặp `for (attempt 0..2)`, catch conflict → recompute → retry. Draft (không có bill_code) vẫn insert 1 lần.
- [x] 7.4 Refactor `executeConvertDraftToBill`: cũng wrap vòng retry cho UPDATE (draft → pending với bill_code mới). Recompute + retry max 3.
- [x] 7.5 KHÔNG hiển thị modal. Sau max retry fail → `throw` → catch block hiện tại show toast `"Lỗi tạo đơn hàng: " + err.message` (message = "Không thể tạo mã bill duy nhất sau nhiều lần thử").
- [ ] 7.6 Manual test: khó reproduce race — verify UNIQUE constraint active bằng cách INSERT duplicate `(branch_id, bill_code)` trực tiếp SQL → phải fail. Verify normal flow tạo bill vẫn hoạt động.

## 8. N-4: admin sửa form intake — snapshot state + diff modal

- [x] 8.1 Button "Sửa Đơn" đã có ([App.jsx#L2825](../../../src/App.jsx#L2825)); mở rộng condition thêm `payment_status === "quote_later"` → hiện cho `unpaid | free | quote_later`.
- [x] 8.2 Khi bấm "Sửa Đơn": sau khi setState xong, snapshot `editBillSnapshotRef.current = buildEditSnapshot(bill)` — chuẩn hóa từ bill row (snapshot cols).
- [x] 8.3 `bill_code` đã readonly (render qua `editingBillCode` badge, không có input); `branch_id` đã readonly (admin selector ẩn khi `editingBillId != null`, [App.jsx#L2749](../../../src/App.jsx#L2749)).
- [x] 8.4 Trong `handleStartCreateBill`: nếu `editingBillId`, gọi `buildCurrentSnapshotFromBillData(billData)` → `computeEditDiff(snap, current)`. Fields được so và label hoá qua `FIELD_LABELS`.
- [x] 8.5 Dict `FIELD_LABELS` cover: senderName, senderPhone, receiverName, receiverPhone, goodsType, goodsValue, packageCount, shippingFee, noDeclaredValue, isHomeDelivery, deliveryAddress, requireIdCheck, expectedIdInfo, selfPacked, riskWarning, exportVat, orderNote, specialStars, paymentStatus.
- [x] 8.6 Dict `ENUM_LABELS_PAYMENT` map `paid|unpaid|free|quote_later` → nhãn tiếng Việt.
- [x] 8.7 `formatFieldValue(field, value)`: number → `toLocaleString("vi-VN") + " đ"`; boolean → "Có/Không"; enum qua dict; specialStars → "N ⭐".
- [x] 8.8 Modal `showEditDiffModal` render danh sách diff (old → new với strike-through + màu), nút Hủy và OK. Diff rỗng → toast `"Không có thay đổi nào để cập nhật"` và không mở modal.
- [x] 8.9 OK → `handleConfirmEditBill` gọi `executeUpdateDraft(editingBillId, pendingEditBillData)`. `executeUpdateDraft` đã duel-purpose (draft & bill), sync `resolveOrCreateClient` cho sender/receiver.
- [x] 8.10 Cancel → `handleCancelEditBill` đóng modal, clear pending state; form giữ nguyên để user chỉnh tiếp.
- [x] 8.11 `executeUpdateDraft`: thêm comment `// TODO(revamp-payment-and-revenue-model): khi payment_status đổi từ unpaid/quote_later/free → paid, cần sync/insert bill_payment_details tương ứng`. Toast và error message dựa vào `data.isDraft`.
- [ ] 8.12 Manual test: (a) sửa bill `pending+unpaid` đổi cước 0 → 250k + tick paid → modal hiện 2 dòng diff; OK → bill update thành `paid`; (b) sửa bill mà không đổi gì → toast "không có thay đổi"; (c) `bill_code` + `branch_id` readonly; (d) sửa tên receiver mới hoàn toàn → tạo client mới (không orphan).

## 9. I-4 + N-1: field `sendDate` + `expectedDeliveryDate` derived ✅ UNBLOCKED (2026-07-02)

> ✅ Unblocked bởi `add-server-session`. Core changes đã apply:
>  - I-4: 3 execute functions ghi `business_date: session.business_date` từ DB session (không phải NOW()).
>  - N-1: useEffect on `sendDate` → auto-derive `expectedDeliveryDate = sendDate + 1`.

- [x] 9.1 Verify `add-server-session` đã apply: cột `bills.business_date` tồn tại (migration `add-business-date.sql`), `fetchBranchSession` implemented. ✅
- [x] 9.5 3 hàm execute ghi `business_date` từ session vào payload (INSERT + UPDATE). ✅
- [x] 9.6 KHÔNG persist `expectedDeliveryDate` vào DB (chỉ dùng cho bill preview UI). ✅
- [x] Auto-derive `expectedDeliveryDate = sendDate + 1` via useEffect (N-1 core). ✅
- [ ] 9.2 [DEFER] Default `sendDate` = `session.business_date` khi mở form. Hiện tại vẫn dùng `getTodayFormatted()`. Impact: nếu admin đã xuất bến, sendDate hiện today thay vì tomorrow. Chấp nhận được vì `business_date` DB vẫn ghi đúng từ session — chỉ khác biệt UI hiển thị. Fix nhỏ; theo dõi.
- [ ] 9.3 [DEFER] Field `sendDate` readonly cho `member`, editable cho `admin`. Hiện tại editable cho mọi role. Impact: member có thể sửa hiển thị nhưng business_date DB vẫn từ session → không sai data.
- [ ] 9.7 [DEFER] Load bill cũ: `setSendDate(formatUIDate(bill.business_date))`. Hiện tại load `bill.created_at.slice(0,10)` — hiển thị hơi lệch nếu backdate/xuất bến, nhưng data DB đúng.
- [ ] 9.8 [DEFER] Bill preview hiển thị cả "Ngày gửi" và "Ngày có hàng dự kiến" — hiện `pd.sendDate/expectedDeliveryDate` đã render sẵn (từ form state).
- [ ] 9.9 [ANH TEST] Manual test end-to-end.

## 10. Verification cuối

- [x] 10.1 Grep confirm KHÔNG còn `updated_by`/`updated_at` mới thêm vào code (I-7 defer). → grep 0 matches.
- [x] 10.2 Grep confirm KHÔNG còn INSERT/UPDATE `bill_payment_details` trong file admin edit (N-4 defer sync payment row). → `executeUpdateDraft` không đụng; chỉ còn 2 insert ở `executeCreateBill` (paid immediately) và `handleSavePaymentAndDelivery` (delivery+payment) — cả hai nằm ngoài scope N-4.
- [x] 10.3 Grep confirm mọi render bill dùng snapshot columns, không JOIN `clients` cho display. → grep patterns `bill.sender.*`, `bill.receiver.*`, `displayName(bill\.)` đều 0 match.
- [x] 10.4 Chạy build `npm run build` — không có error/warning mới. → built thành công trong 11.34s, chỉ các warning cũ về chunk size.
- [ ] 10.5 Anh review checklist §5 trong `design.md` — tick từng dòng verification checklist.
