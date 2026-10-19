# Tasks: Add Debt Collection screen (Công Nợ)

## 1. Prerequisites

- [x] 1.1 Verify change `revamp-payment-and-revenue-model` đã merge (đặc biệt: `bills.actual_amount_paid` được persist đúng, filter cancelled bill).
- [x] 1.2 Verify `bills.actual_amount_paid` cột đã tồn tại + backfill xong (D4 của revamp).

## 2. Backend / query

- [x] 2.1 Không cần migration (dùng field + index có sẵn).
- [x] 2.2 Verify index trên `bills(payment_status, delivery_status, is_delete)` — dataset thực tế ~200-500 bill unpaid → filter+group client-side <10ms, KHÔNG cần index bổ sung. Nếu sau này dataset lớn hơn thì tạo migration nhỏ:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_bills_debt_lookup
    ON bills (payment_status, delivery_status)
    WHERE is_delete = false;
  ```

## 3. Component: DebtCollectionScreen

- [x] 3.1 Inline vào `src/App.jsx` (project là monolith — cùng convention với các tab `revenue`, `all-bills`, `warehouse`).
- [x] 3.2 State: `debtQuery`, `debtIncludePending` (bool, default false), `debtSortMode` ('debt' | 'name', default 'debt'), `debtExpanded` (Set of group keys), `debtRefreshing`.
- [x] 3.3 Reuse `bills` global state (đã fetch trong `fetchData()` mount + refresh sau mọi mutation) → KHÔNG cần `useEffect` riêng.
- [x] 3.4 Extended `bills` select trong `fetchData()` để include `receiver:clients!receiver_id(fullname, phone)` và `sender:clients!sender_id(fullname, phone)` (thêm `phone`).
- [x] 3.5 `useMemo debtGroups` — call `groupBillsByCustomer(bills, debtIncludePending)` → search → sort. `useMemo debtTotals` cho summary cards.

## 4. Grouping helper

- [x] 4.1 Inline helper `groupBillsByCustomer` trong App.jsx (module-scope, cạnh `parseVNDateToISO`):
  - Filter: `is_delete=false` + `delivery_status != 'cancelled'` + `payment_status IN ('unpaid','quote_later')`; default chỉ 'delivered'; toggle ON thêm 'pending + unpaid'; 'pending + quote_later' luôn ẩn.
  - Key theo thứ tự fallback: `receiver_id` → `sender_id` → `__anon_{bill.id}`.
  - Name/phone lấy từ join object; nếu client bị soft-delete → hiển thị "(Khách đã xoá)".
  - `totalDebt` SUM(fee - paid), TRỪ bill quote_later; `Math.max(0, ...)` guard.
  - Return `{ key, customerId, name, phone, bills, totalDebt, hasQuoteLater, quoteLaterCount, billCount }`.

## 5. Sort + search

- [x] 5.1 Sort default `debt` desc; toggle → `name` a-z locale='vi' (dùng `localeCompare`).
- [x] 5.2 Search: match `name.toLowerCase().includes(query)` HOẶC `phone.startsWith(query)`.
- [x] 5.3 Empty state: 3 message tương ứng (no query / includePending on / includePending off + hint).

## 6. Row UI

- [x] 6.1 `CustomerRow`: `▸/▾` + name + phone + `{billCount} bill` + `{formatVND(totalDebt)}đ` (màu đỏ khi >0, xám khi =0).
- [x] 6.2 Badge "Chưa báo cước × N" (amber pill) nếu `quoteLaterCount > 0`.
- [x] 6.3 Click row → toggle `debtExpanded.has(g.key)`.
- [x] 6.4 Expanded: table nhỏ bên dưới, cột `Mã bill | Ngày gửi (dd/mm/yyyy) | Trạng thái giao | Cước | Đã trả | Nợ`. Bill quote_later hiển thị "Chưa báo cước" thay chỗ số tiền.
- [x] 6.5 Click `bill_code` → `setSelectedBill(bill); setPreviousTab('debt'); setCurrentScreenRaw('bills')` (giống pattern revenue → bill-detail).

## 7. Header controls

- [x] 7.1 Search input (`ui.input`).
- [x] 7.2 Checkbox "Bao gồm đơn chưa giao" (accent-orange).
- [x] 7.3 Sort toggle button "↓ Nợ nhiều nhất" / "A → Z".
- [x] 7.4 Refresh button `🔄 Cập nhật` → `await fetchData()` + toast; disable khi đang tải.
- [x] 7.5 Summary cards (4 cards): Khách nợ / Tổng bill / Tổng nợ / Chưa báo cước.

## 8. Navigation integration

- [x] 8.1 Thêm menu item "🧾 Công Nợ" vào main nav (sau "💰 Quản Lý Doanh Thu").
- [x] 8.2 Guard: `(userRole === "admin" || userRole === "boss")` mới render menu.
- [x] 8.3 `useEffect` guard: nếu `currentTab === 'debt' && userRole === 'member'` → redirect về `bills` + toast "Bạn không có quyền truy cập màn Công Nợ".
- [x] 8.4 Bill Detail của bill mở từ Công Nợ: nút "← Quay lại" đã tự động về `previousTab || 'all-bills'` = `'debt'` → render lại debt screen.
- [x] 8.5 Header title `{currentTab === "debt" && "🧾 CÔNG NỢ THEO KHÁCH HÀNG"}`.

## 9. Auto-refresh sau mutate

- [x] 9.1 Bill Detail đã gọi `fetchData()` sau mọi mutation (thu tiền, huỷ, giao) → `bills` global refresh → `debtGroups` useMemo auto-recompute khi quay lại.
- [x] 9.2 State (`debtQuery`, `debtIncludePending`, `debtSortMode`, `debtExpanded`) preserve tự động — không có reset logic; useState giữ nguyên khi chuyển tab.

## 10. Smoke test

- [ ] 10.1 [ANH TEST] 3 khách có 1-3 bill `delivered + unpaid` → thấy 3 rows, tổng nợ tính đúng.
- [ ] 10.2 [ANH TEST] Bill `pending + unpaid` không hiện mặc định; check toggle → hiện.
- [ ] 10.3 [ANH TEST] Bill `pending + quote_later` KHÔNG bao giờ hiện.
- [ ] 10.4 [ANH TEST] Khách có 1 bill `unpaid` (100k) + 1 bill `quote_later` → row hiển thị "2 bill - 100.000đ" + badge "Chưa báo cước × 1".
- [ ] 10.5 [ANH TEST] Click bill → mở Bill Detail → thu full → back → khách biến mất khỏi list.
- [ ] 10.6 [ANH TEST] Search theo tên/SĐT filter đúng (name substring / phone startsWith).
- [ ] 10.7 [ANH TEST] Sort theo tổng nợ giảm dần và toggle A→Z work đúng.
- [ ] 10.8 [ANH TEST] Member login → menu Công Nợ ẩn; nếu vào bằng state cũ → redirect + toast.
- [ ] 10.9 [ANH TEST] Boss login → thấy menu, click bill → Bill Detail read-only.
- [ ] 10.10 [ANH TEST] Cancel 1 bill từ tab khác (theo revamp D11+D12) → back về Công Nợ → refresh → bill biến mất; expense refund xuất hiện trong tab Doanh Thu.

## 11. Archive

- [ ] 11.1 [ANH CHẠY] `openspec validate add-debt-collection-screen --strict`.
- [ ] 11.2 [ANH CHẠY] `openspec archive add-debt-collection-screen` để merge delta vào main specs (tạo `openspec/specs/debt-collection/spec.md` mới).

## 12. Post-apply bug fix — Phone source (2026-07-02)

Bug regression: Session apply đầu tiên vô tình thêm `phone` vào `select` bills query (`sender:clients!sender_id(fullname, phone)`), nhưng `clients` table KHÔNG có column `phone` (số điện thoại nằm ở `client_phones` table riêng). Kết quả: Supabase throw error → `fetchData()` fail → `bills` state = rỗng → Tổng Hợp / Bốc Xếp / Doanh Thu / Công Nợ đều hiển thị 0 đơn.

- [x] 12.1 Revert `bills` query select — bỏ `phone` khỏi `sender:clients!sender_id(...)` và `receiver:clients!receiver_id(...)`, giữ chỉ `fullname`.
- [x] 12.2 Đổi `groupBillsByCustomer` để lấy phone từ `b.receiver_phone?.phone_number || b.sender_phone?.phone_number` (join sẵn có, không cần thêm query).
- [x] 12.3 Thêm fallback: nếu bill đầu tiên của group không có phone → khi thấy bill sau có phone → update `group.phone`.
- [x] 12.4 Update design.md — đính chính đoạn "phone tra qua client_phones ... MVP chỉ dùng clients.phone" thành spec đúng (dùng bill-level `sender_phone`/`receiver_phone` join).
- [x] 12.5 Update spec.md — thêm rõ nguồn phone hiển thị.
- [ ] 12.6 [ANH TEST] Reload app → Tổng Hợp phải hiện lại full bill; Công Nợ vẫn hiển thị phone của khách (là SĐT bill dùng lúc lập).
