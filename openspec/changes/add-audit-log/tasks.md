# Tasks: add-audit-log

## 1. Migration & schema

- [x] 1.1 Tạo file `add-audit-log-table.sql` ở root repo với schema `audit_log` + indexes + CHECK constraints + RLS permissive policy (theo design section 2)
- [ ] 1.2 **[ANH CHẠY]** Chạy migration trên Supabase staging, verify table + indexes tồn tại
- [ ] 1.3 **[ANH CHẠY]** Chạy migration trên Supabase production sau khi `fix-shipment-intake-issues` đã deploy

## 2. Helper module

- [x] 2.1 Tạo `src/auditLabels.js` với `FIELD_LABELS`, `ENUM_LABELS`, `ACTION_LABELS`, helpers `formatVnd`, `formatValue`, `renderChanges`
- [x] 2.2 Tạo `src/auditLog.js` với `logAudit({...})` và `fetchAuditLog({entityType, entityId})`
- [x] 2.3 Thêm `diffObjects(before, after, allowedFields)` vào `src/auditLog.js`
- [x] 2.4 `logAudit` fail-safe: mọi lỗi → console.warn, KHÔNG throw (đã implement)

## 3. Integrate logAudit vào mutations (bills)

- [x] 3.1 `executeCreateBill` → snapshot 9 field + `bill_create`; nếu paid immediately → `bill_payment_received` note "Thu cước lúc tạo bill"
- [x] 3.2 `handleSaveDraft` (gộp trong executeCreateBill với isDraft) — đã snapshot cùng format
- [x] 3.3 `executeUpdateDraft` — `select('*')` full bill → diff với BILL_AUDIT_FIELDS → `bill_update`; unpaid→paid → `bill_payment_received` note "Thu cước lúc sửa đơn"
- [x] 3.4 `executeConvertDraftToBill` → `bill_update {delivery_status:[draft,pending], bill_code:[null,newCode]}`; nếu paid immediately → `bill_payment_received`
- [x] 3.5 `handleConfirmCancelBill` — cả draft (delivery_status:[draft,null]) lẫn pending (delivery_status:[prev,cancelled]) → `bill_cancel` với note lý do; refund > 0 → `refund_created`
- [x] 3.6 `handleConfirmDelivery` → `bill_delivered` + recipient_type + note nếu helper; willBePaid → `bill_payment_received`
- [x] 3.7 `handleConfirmPayment` → `bill_payment_received` với finalAmount + paymentNote

## 4. Integrate logAudit vào mutations (clients & expenses & session)

- [x] 4.1 `resolveOrCreateClient` (khi tạo client mới qua intake) → `client_create` note "Qua tạo đơn" với phone_primary + address snapshot
- [x] 4.2 Tab QLKH — tạo khách mới → `client_create` note "Qua QL Khách hàng" với snapshot CLIENT_AUDIT_FIELDS
- [x] 4.3 Tab QLKH — sửa khách → diff clients fields + phone changes; action = `client_blacklist` nếu chỉ đổi is_blacklist, else `client_update`
- [ ] 4.4 **[SKIP]** Tab QLKH — soft-delete khách: hiện KHÔNG có UI handler cho soft-delete client. Bỏ qua đến khi có yêu cầu.
- [x] 4.5 `handleAddExpense` → `expense_create` (dùng `.select("id").single()` để lấy id)
- [x] 4.5b `handleUpdateExpense` → `expense_update` với diffObjects
- [x] 4.5c `handleDeleteExpense` → `expense_delete {is_delete:[false,true]}`
- [x] 4.5d `handleConfirmCancelBill` refund → `refund_created` với `{amount:[null,refundAmount], source_bill:[null,bill_code]}` note "Auto tạo khi cancel bill có payment"
- [ ] 4.6 **[SKIP → BLOCKED bởi add-server-session]** `advanceDepartureSession` chưa tồn tại (session logic hiện là localStorage). Tách sang change `add-server-session`.

## 5. UI Section inline (always-visible)

- [x] 5.1 Tạo `src/BillHistorySection.jsx` component với props `{ billId, refreshKey, userRole }`
- [x] 5.2 `AuditEntry` sub-component inline (icon + username + role + action text + diff bullets + note italic + timestamp)
- [x] 5.3 Embed `<BillHistorySection>` vào Bill Detail sau section "Thanh toán & Giao nhận" — ẩn với member
- [x] 5.4 Fetch qua `fetchAuditLog()` khi mount + auto-refetch qua `refreshKey` tăng sau mỗi mutation (handleConfirmDelivery, handleConfirmPayment, handleConfirmCancelBill, executeUpdateDraft, executeConvertDraftToBill)
- [x] 5.5 Empty state ("Chưa có lịch sử thay đổi.") + loading ("Đang tải lịch sử...") + error state
- [x] 5.6 Render `*_create` với snapshot: `• <Label>: <newValue>` (không mũi tên vì old=null → `isCreate=true`)
- [x] 5.7 Render `*_update`: `• <Label>: <old-strikethrough> → <new-green>`
- [x] 5.8 Snapshot fields cho `bill_create` gồm 9 field chính: shipping_fee, payment_status, sender/receiver name+phone+address, package_count, order_note
- [x] **BONUS** Tạo `src/ClientHistorySection.jsx` + embed vào tab QLKH edit form (unblock `add-client-phone-history` §6-8)

## 6. Permission guard

- [x] 6.1 `<BillHistorySection>` + `<ClientHistorySection>` early-return null khi `userRole === 'member'` (UI guard đủ vì RLS permissive — anon key ai cũng SELECT được)
- [x] 6.2 Verify không render trên UI khi role = member (test bằng cách login member → mở Bill Detail)

## 7. Smoke test — ANH TEST

- [ ] 7.1 Tạo bill mới → mở Bill Detail → section Lịch sử hiển thị 1 entry `bill_create` với 9 field khởi tạo
- [ ] 7.2 Admin sửa cước + payment_status → section refetch → entry `bill_update` với 2 dòng diff đúng tiếng Việt
- [ ] 7.3 Huỷ bill với lý do → section hiển thị `bill_cancel` + note = lý do (nếu có refund → thêm entry `refund_created` trong Doanh Thu)
- [ ] 7.4 Member login → vào Bill Detail → KHÔNG thấy section Lịch sử
- [ ] 7.5 Tắt mạng → sửa bill → main flow thành công (toast success), console.warn audit fail
- [ ] 7.6 Xoá user (qua SQL) → mở Bill Detail entry cũ của user đó → vẫn hiển thị username snapshot (do đã lưu snapshot username lúc log)
- [ ] 7.7 QLKH: sửa khách hàng đổi tên → refresh → `client_update` diff hiển thị đúng
- [ ] 7.8 QLKH: đổi blacklist khách → `client_blacklist` với 1 dòng diff duy nhất
- [ ] 7.9 QLKH: đổi số điện thoại chính → `client_update` với phone_primary diff (từ add-client-phone-history)

## 8. Documentation

- [ ] 8.1 Update README.md hoặc `openspec/README.md` note module `audit_log`
- [ ] 8.2 Note cho team: thêm action mới phải update `ACTION_LABELS` (auditLabels.js) + CHECK constraint trong DB (`add-audit-log-table.sql`)

