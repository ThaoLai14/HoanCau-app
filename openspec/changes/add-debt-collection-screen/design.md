# Design: Debt Collection screen (Công Nợ)

> Status: **READY**. Decisions D1–D9 chốt 2026-07-01.
> Dependency: change `revamp-payment-and-revenue-model` (MUST merge trước).

## 1. Data model — dùng có sẵn (không thêm cột)

Nguồn duy nhất: `bills` (join với `clients` cho tên + SĐT).

```sql
-- Query cơ bản (chưa optimize)
SELECT
  b.id,
  b.bill_code,
  b.business_date,
  b.shipping_fee,
  COALESCE(b.actual_amount_paid, 0) AS paid,
  (b.shipping_fee - COALESCE(b.actual_amount_paid, 0)) AS debt,
  b.payment_status,
  b.delivery_status,
  b.branch_id,
  b.sender_id,
  b.receiver_id,
  s.fullname AS sender_name,
  s.phone AS sender_phone,
  r.fullname AS receiver_name,
  r.phone AS receiver_phone
FROM bills b
LEFT JOIN clients s ON b.sender_id = s.id
LEFT JOIN clients r ON b.receiver_id = r.id
WHERE b.is_delete = false
  AND b.delivery_status != 'cancelled'
  AND b.payment_status IN ('unpaid', 'quote_later')
ORDER BY b.business_date DESC;
```

Client-side grouping (JS reduce) — không cần server view/RPC. Số lượng bill unpaid tại thời điểm t chỉ ~200-500 rows tối đa (cả 2 chi nhánh) → grouping client-side đủ nhanh.

**Phone source (đính chính 2026-07-02)**: `clients` table KHÔNG có column `phone` — số điện thoại được lưu ở table riêng `client_phones` (3 type: primary/secondary/old, xem change `add-client-phone-history`). Vì vậy phone hiển thị ở màn Công Nợ MUST lấy từ join sẵn có `sender_phone:client_phones!sender_phone_id(phone_number)` / `receiver_phone:client_phones!receiver_phone_id(phone_number)` — tức là **SĐT user chọn khi lập bill đó** (có thể là số phụ hoặc số cũ nếu bill tạo lúc SĐT đó vẫn còn primary/secondary). Đây là số hợp lý nhất để gọi liên hệ khách về công nợ vì đó là SĐT khách dùng khi giao dịch. KHÔNG mở query phụ chỉ để lấy `primary phone` — overkill cho ~500 bill.

## 2. Grouping logic

```js
function groupBillsByCustomer(bills, includePending) {
  // 1. Filter
  const filtered = bills.filter(b => {
    if (b.is_delete) return false;
    if (b.delivery_status === 'cancelled') return false;
    if (!['unpaid', 'quote_later'].includes(b.payment_status)) return false;
    if (b.delivery_status === 'delivered') return true;   // default: delivered + unpaid|quote_later
    if (b.delivery_status === 'pending' && includePending && b.payment_status === 'unpaid') return true;
    // pending + quote_later: KHÔNG hiện (D4)
    return false;
  });

  // 2. Group key: receiver_id → fallback sender_id → fallback null
  const groups = new Map();  // key -> { customerId, name, phone, bills[] }
  for (const b of filtered) {
    const key = b.receiver_id || b.sender_id || `__anon_${b.id}`;
    const isReceiver = !!b.receiver_id;
    const name = isReceiver ? b.receiver_name : b.sender_name || 'Khách vãng lai';
    const phone = isReceiver ? b.receiver_phone : b.sender_phone || '';

    if (!groups.has(key)) {
      groups.set(key, { key, customerId: b.receiver_id || b.sender_id || null, name, phone, bills: [] });
    }
    groups.get(key).bills.push(b);
  }

  // 3. Tính tổng nợ mỗi group
  return Array.from(groups.values()).map(g => ({
    ...g,
    totalDebt: g.bills.reduce((sum, b) => {
      if (b.payment_status === 'quote_later') return sum;  // KHÔNG cộng
      return sum + (Number(b.shipping_fee || 0) - Number(b.actual_amount_paid || 0));
    }, 0),
    hasQuoteLater: g.bills.some(b => b.payment_status === 'quote_later'),
    billCount: g.bills.length,
  }));
}
```

## 3. Sort & search

```js
// Sort default: tổng nợ giảm dần. Toggle: name A→Z.
const sorted = sortMode === 'debt'
  ? groups.sort((a, b) => b.totalDebt - a.totalDebt)
  : groups.sort((a, b) => a.name.localeCompare(b.name, 'vi'));

// Search: match name (substring) hoặc phone (startsWith)
const searched = query
  ? sorted.filter(g =>
      g.name.toLowerCase().includes(query.toLowerCase()) ||
      (g.phone || '').startsWith(query)
    )
  : sorted;
```

## 4. UI structure

```jsx
function DebtCollectionScreen() {
  const [query, setQuery] = useState('');
  const [includePending, setIncludePending] = useState(false);
  const [sortMode, setSortMode] = useState('debt');
  const [expanded, setExpanded] = useState(new Set());
  const [bills, setBills] = useState([]);

  useEffect(() => { fetchBills(); }, []);

  const groups = useMemo(() =>
    searchGroups(sortGroups(groupBillsByCustomer(bills, includePending), sortMode), query),
    [bills, includePending, sortMode, query]
  );

  return (
    <div>
      <Header>
        <SearchBox value={query} onChange={setQuery} placeholder="Tìm khách/SĐT..." />
        <Toggle checked={includePending} onChange={setIncludePending} label="Bao gồm đơn chưa giao" />
        <button onClick={fetchBills}>🔄 Cập nhật</button>
        <SortToggle mode={sortMode} onChange={setSortMode} />
      </Header>

      {groups.map(g => (
        <CustomerRow
          key={g.key}
          group={g}
          expanded={expanded.has(g.key)}
          onToggle={() => toggleExpanded(g.key)}
          onBillClick={openBillDetail}
        />
      ))}

      {groups.length === 0 && <EmptyState />}
    </div>
  );
}
```

## 5. Bill click → open Bill Detail

Reuse existing `selectedBill` + `previousTab` state của App.jsx.

```js
function openBillDetail(bill) {
  setSelectedBill(bill);
  setPreviousTab('debt');   // để nút "← Quay lại" của Bill Detail biết đường về
  setActiveTab('bill-detail');   // hoặc mở modal, tùy convention hiện tại
}
```

Sau khi user thao tác (thu tiền, huỷ, ...) trên Bill Detail:
- Trở về màn Công Nợ.
- `fetchBills()` re-fetch để list update.

## 6. Edge cases

| Case | Handling |
|---|---|
| Bill có `receiver_id = null` (khách vãng lai) | Fallback sender. Nếu cả 2 null → group "Khách vãng lai" per-bill (mỗi bill 1 group) |
| Bill có `receiver_id` nhưng client đã bị soft-delete | Join LEFT vẫn trả `receiver_name = null` → hiển thị "(Khách đã xoá)" |
| Bill `pending + quote_later` với toggle bật | KHÔNG hiện (rule D4) |
| Nhiều bill của khách A có `quote_later` | Group vẫn hiển thị, `totalDebt = 0`, badge "Chưa báo cước x N" |
| Khách có SĐT trùng nhưng 2 clients (data dirty) | Group theo `id` — 2 groups riêng. User biết tự merge qua QLKH nếu cần |
| Bill vừa thay đổi trạng thái từ tab khác (thu tiền, huỷ) | User bấm 🔄 Refresh để cập nhật (không auto-poll) |

## 7. Performance

- ~500 unpaid bills tối đa (~1KB/bill JSON) → 500KB payload → fine.
- Grouping O(n), sort O(n log n) → dưới 10ms cho n=500.
- Không cần index thêm (đã có index trên `payment_status`, `delivery_status`, `is_delete` ở migrations trước).

## 8. Rollout

- Feature-flag KHÔNG cần — màn mới, không đụng luồng cũ.
- Data không migration (dùng có sẵn).
- Roll cùng lúc với revamp payment (revamp merge trước → smoke test debt screen sau).

## 9. Impact

| Impact | Risk |
|---|---|
| Menu chính +1 item "Công Nợ" | Low — nếu code sai chỉ ẩn menu, không đụng data |
| Query `bills` filter thêm điều kiện | Very Low — dùng field có index |
| Reuse Bill Detail component | Low — cần verify `previousTab='debt'` navigation về đúng |

## 10. Rollback

Xoá menu + component. Không có DB migration để undo.
