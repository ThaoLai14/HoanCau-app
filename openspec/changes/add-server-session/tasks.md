# Tasks: Server-side branch session + `business_date`

## 1. Database migration

- [x] 1.1 Tạo `add-branch-sessions.sql` (repo root) — CREATE TABLE + seed SG/GL + RLS. ✅
- [x] 1.2 Tạo `add-business-date.sql` (repo root) — ADD COLUMN + backfill + NOT NULL + 2 indexes. ✅
- [ ] 1.3 [ANH CHẠY] Chạy 2 file theo thứ tự: **`add-branch-sessions.sql` TRƯỚC**, rồi `add-business-date.sql`.
- [ ] 1.4 [ANH CHẠY] Verify:
  - `SELECT COUNT(*) FROM branch_sessions;` = 2.
  - `SELECT COUNT(*) FROM bills WHERE business_date IS NULL;` = 0.

**NOTE (deviation từ design):** Design gốc §3.3 mô tả `day_counter='A'` letter-only (A→B→...→Z→AA). Thực tế bill_code hiện tại trong DB dùng format `NN{branch}{Letter}NN` (vd `05SGA02`), số cuối là chỉ số ngày trong cycle letter từ `getDayCode()`. Để giữ backward-compat, code lưu `day_counter` full text `"A01"`..`"A99"`..`"B01"`... và `buildBillCodeFromSession = "{seq2}{branch}{day_counter}"` = `"01SGA02"`. Seed khởi tạo `'A'` — sau lần Xuất Bến đầu tiên sẽ được `nextDayCounterText` convert sang `'A02'`. Nếu muốn seed thẳng `'A01'`: chạy `UPDATE branch_sessions SET day_counter = 'A01' WHERE day_counter = 'A';`

## 2. Helpers mới trong App.jsx

- [x] 2.1 `toVNDate(ts)` — đã có; thêm `getVNTodayDate()` trả YYYY-MM-DD hôm nay VN. ✅
- [x] 2.2 `nextDayCounterText(cur)` — "A02" → "A03"; "A99" → "B01". Giữ format cũ. ✅
- [x] 2.3 `fetchBranchSession(branchId)` — SELECT + auto-roll nếu `business_date < todayVN`. ✅
- [x] 2.4 (Gộp vào 2.3) — auto-roll khi fetch phát hiện qua ngày. ✅
- [x] 2.5 `advanceBranchSession(branchId, userId)` — Xuất Bến: `business_date = max(current, today) + 1`, `day_counter = next`, `bill_seq = 1`. ✅
- [x] 2.6 `buildBillCodeFromSession(branchCode, session)` — sync build từ session cache. ✅
- [x] 2.7 `incrementBillSeqOnDB(branchId)` — SELECT + UPDATE `bill_seq += 1` sau khi tạo bill thành công. ✅
- [x] 2.8 `computeBillCodeFromDB` refactor: refetch session sau conflict UNIQUE. ✅

## 3. Xoá localStorage session hoàn toàn

- [x] 3.1 Xoá `getDayCounterFromStorage`. ✅
- [x] 3.2 Xoá `DAY_COUNTER_KEY_PREFIX`, `LEGACY_DAY_COUNTER_KEY`, `_branchKey`, old `advanceDepartureSession`. ✅
- [x] 3.3 Xoá state `dayCounter`, `billSeq`. ✅
- [x] 3.4 Thay bằng `branchSessions = { [branchCode]: sessionRow }` + `branchIdByCode`. ✅

## 4. Login hydration

- [x] 4.1 Effect on `session?.id`: fetch `branches` → build `branchIdByCode` → fetch session cho branch của user login. ✅
- [x] 4.2 `role === 'admin'`: pre-fetch cả SG + GL (Promise.all). ✅

## 5. Form Tạo Đơn

- [x] 5.1 Effect on form open: `reserveBillCode()` build từ cache; auto-fetch nếu cache miss. ✅
- [x] 5.2 `executeCreateBill(data)`: refetch session → INSERT với `business_date` → increment `bill_seq` sau thành công. ✅
- [x] 5.3 `executeUpdateDraft(draftId, data)`: refetch session → UPDATE với `business_date` mới. ✅
- [x] 5.4 `executeConvertDraftToBill(draftId, data)`: refetch session → build mã → UPDATE + retry + increment seq. ✅

## 6. Xuất Bến flow

- [x] 6.1 `handleDeparture()`: confirm dialog (preview day_counter mới) → `advanceBranchSession` → update cache → toast mã kế tiếp → audit log `session_departure`. ✅
- [x] 6.2 Verified KHÔNG còn localStorage khi Xuất Bến. ✅

## 7. Warehouse tab — filter theo `business_date`

- [x] 7.1 Filter danh sách: `b.business_date === warehouseDate`. ✅
- [x] 7.2 Badge đếm theo chi nhánh dùng `business_date`. ✅
- [x] 7.3 Default `warehouseDate = getLocalDateString()` — giữ nguyên.

## 8. All-Bills (Tổng Hợp) tab

- [x] 8.1 Rename `createdFrom/To` → `businessFrom/To` (state + reset). ✅
- [x] 8.2 UI label "Ngày tạo từ/đến" → "Ngày gửi từ/đến". ✅
- [x] 8.3 Filter dùng `b.business_date`. ✅
- [x] 8.4 Column header "Ngày Tạo" → "Ngày Gửi"; cell = `bill.business_date`. ✅
- [x] 8.5 Cột `created_at` chỉ còn trong Bill Detail (Tổng Hợp giờ hiển thị business_date). ✅

## 9. Bill Detail screen

- [x] 9.1 Thêm dòng "Ngày gửi: dd/mm/yyyy" (từ `business_date`). ✅
- [x] 9.2 Giữ "Thời gian tạo" hiển thị `created_at`. ✅

## 10. Sort default

- [x] 10.1 Sort key = `business_date desc, created_at desc` (nhóm đơn cùng ngày kinh doanh). ✅

## 11. Cross-change updates

- [x] 11.1 `fix-shipment-intake-issues`:
  - I-4 (business_date missing) → **FIXED** — 3 execute functions ghi `business_date` từ session.
  - N-1 (auto expected delivery) → **FIXED** — useEffect on `sendDate` → auto set `expectedDeliveryDate = sendDate + 1`.
- [ ] 11.2 `revamp-payment-and-revenue-model` — no action.
- [x] 11.3 `add-audit-log`: `session_departure` log từ diff `curSess.day_counter` → `rolled.day_counter` trong `handleDeparture`. ✅

## 12. Smoke test thủ công

**[ANH TEST] sau khi chạy 2 SQL:**

- [ ] 12.1 Login user SG → mở Supabase: `SELECT * FROM branch_sessions` → 2 rows, `business_date = today`, `day_counter = 'A'` hoặc `'A01'`, `bill_seq = 1`.
- [ ] 12.2 Tạo đơn (nếu seed `'A'`, mã đầu sẽ là `01SGA` — cần chạy `UPDATE branch_sessions SET day_counter = 'A01' WHERE day_counter = 'A';` để trả về format cũ `01SGA01`). Sau đó check `bills.business_date = today` và `branch_sessions.bill_seq = 2`.
- [ ] 12.3 Mở tab browser khác (ẩn danh) → login → session cache có `bill_seq = 2`.
- [ ] 12.4 Tab mới tạo đơn `02SG<counter>` → `bill_seq = 3`.
- [ ] 12.5 Tab gốc Xuất Bến → `business_date=tomorrow, day_counter='A02', bill_seq=1`.
- [ ] 12.6 Tab kia mở lại form → thấy session mới, tạo đơn `01SGA02` với `business_date=tomorrow`.
- [ ] 12.7 Tab Kho: hôm nay = 2 đơn, hôm sau = 1 đơn (filter theo `business_date`).
- [ ] 12.8 Auto-roll qua ngày: mai mở app → `fetchBranchSession` tự UPDATE `business_date`.

## 13. Archive

- [ ] 13.1 [ANH] Review & approve → `openspec archive add-server-session`.

---

## Build check

- [x] `npm run build` PASS (no errors) — 545.51 kB bundle. ✅

## SQL files cần chạy (theo thứ tự)

1. **`add-branch-sessions.sql`** — tạo table + seed SG/GL. **PHẢI CHẠY TRƯỚC.**
2. **`add-business-date.sql`** — thêm cột `business_date` cho `bills` + backfill.
