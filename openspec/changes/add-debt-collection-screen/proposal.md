# Proposal: Add Debt Collection screen (Công Nợ)

## Status

🟢 **READY** — scope chốt 2026-07-01 sau khi review màn Doanh Thu + bug analysis.

## Why

Hiện tại nhân viên KHÔNG có cách nào tra cứu tổng công nợ theo khách hàng. Để đòi tiền:
- Phải mở tab Tổng Hợp Đơn Hàng, filter `payment_status = unpaid`, rồi tự nhẩm nhóm theo SĐT.
- Không thấy được `quote_later` (đơn "báo giá sau") — thực chất là công nợ nhưng chưa biết số tiền.
- Không có tổng tiền nợ per khách.
- Không biết đơn nào giao rồi mà chưa thu (mới là nợ thật), đơn nào chưa giao (chưa phải nợ).

Hệ quả:
- Miss thu tiền → doanh nghiệp thất thu.
- Gọi khách không chuẩn (báo sai số).
- Không theo dõi được khách nợ mãn tính.

Sau khi change `revamp-payment-and-revenue-model` merge, `bills.actual_amount_paid` được persist đúng → có thể tính công nợ = `shipping_fee - actual_amount_paid` per bill → nhóm per khách → hiển thị.

## What changes

Thêm 1 màn mới **"Công Nợ"** (menu chính, đặt cạnh "Doanh Thu"):

### D1. Group by người NHẬN (fallback sang người GỬI)

- Nhóm bill theo `receiver_id` (khách nhận). Vì trong luồng chành xe, người nhận là người trả tiền (COD-like).
- Nếu bill KHÔNG có `receiver_id` (khách vãng lai — chưa lưu vào `clients`), fallback nhóm theo `sender_id`.
- Nếu cả 2 đều null → hiển thị "Khách vãng lai" (grouping key = `null`, hoặc `bill.bill_code` để phân biệt).

Lý do fallback receiver → sender: có bill người nhận là khách vãng lai (chỉ có tên + SĐT snapshot, chưa lưu vào `clients`) → không nhóm được. Nhưng người gửi thường là khách quen → nhóm theo sender vẫn hữu ích.

### D2. Nguồn data

Query: `bills` WHERE `payment_status IN ('unpaid', 'quote_later')` AND `is_delete = false` AND `delivery_status !== 'cancelled'`.

`quote_later` = "khách chưa báo giá cước, tính sau" → về mặt semantics là 1 dạng công nợ chưa xác định số tiền. Hiển thị trong màn nhưng với label riêng.

### D3. Filter mặc định: giao rồi + nợ

Filter mặc định (khi mở màn): `delivery_status = 'delivered' AND payment_status IN ('unpaid', 'quote_later')`.

Lý do: chỉ có bill ĐÃ GIAO mới có concept "khách đang nợ" (đã nhận hàng nhưng chưa trả tiền). Bill `pending + unpaid` chưa phải nợ (chưa giao → chưa đòi được).

### D4. Toggle "Bao gồm đơn chưa giao"

Checkbox `[ ] Bao gồm đơn chưa giao (pending + unpaid)` mặc định OFF.

Khi ON: hiển thị thêm nhóm bill `pending + unpaid` — cho use case "khách đã hứa trả nhưng bill đang chờ giao, gộp vào tổng cần thu tương lai".

`pending + quote_later`: KHÔNG hiển thị (chưa giao + chưa báo giá → không phải công nợ).

### D5. Rule đặc biệt: `delivered + quote_later` KHÔNG tồn tại

Về nghiệp vụ, khi bấm "Hoàn tất giao hàng", user PHẢI xác định trạng thái thanh toán (paid full / paid actual / unpaid). Không có option `quote_later` ở bước giao — nếu user hứa báo giá sau, chỉ có thể là `unpaid`.

⇒ `delivered + quote_later` không xuất hiện trong dataset. KHÔNG cần xử lý.

Ngược lại `pending + quote_later` là hợp lệ (khách gửi hàng, chưa báo giá cước, chưa giao).

### D6. Tổng nợ per khách

Cho mỗi khách:
- `Tổng nợ = SUM(shipping_fee - COALESCE(actual_amount_paid, 0))` cho các bill của khách đó trong filter hiện tại.
- Đơn `quote_later` (chưa có `shipping_fee`) hiển thị nhãn "Chưa báo cước" thay vì số tiền, KHÔNG cộng vào tổng.

### D7. UI layout (Option 3 chốt)

```
┌─── CÔNG NỢ ──────────────────────────────────────────────────┐
│ [🔍 Tìm khách/SĐT...]  [☐ Bao gồm đơn chưa giao]  [🔄 Refresh]│
│                                                              │
│ ─────────────────────────────────────────────────────────── │
│ ▶ Nguyễn Văn A  0912345678         2 bill    350.000đ       │
│ ▶ Trần Thị B    0987654321         1 bill    Chưa báo cước  │
│ ▼ Lê Văn C      0977111222         3 bill  1.250.000đ       │
│   ├─ 05SGA02  25/06  Cước 500k, đã trả 300k  Nợ: 200.000đ   │
│   ├─ 07SGA01  26/06  Cước 800k, chưa trả     Nợ: 800.000đ   │
│   └─ 03GLA05  28/06  Cước 250k, chưa trả     Nợ: 250.000đ   │
│ ▶ Khách vãng lai (không SĐT)  1 bill   150.000đ            │
└──────────────────────────────────────────────────────────────┘
```

- Mặc định collapse (mỗi khách 1 row tóm tắt).
- Bấm ▶ → expand danh sách bill.
- Bấm mã bill → mở Bill Detail (reuse `selectedBill` state của App.jsx).
- Sort: mặc định theo tổng nợ giảm dần. Có thể toggle sort theo tên A→Z.

### D8. KHÔNG có

- KHÔNG có aging column (30-60-90 ngày) — bảo trì phức tạp, user chưa cần.
- KHÔNG có nút "Thu Nợ" riêng — user click bill_code → mở Bill Detail → dùng flow "Xác nhận thanh toán" đã có (theo change `revamp-payment-and-revenue-model` D1).
- KHÔNG có export CSV — có thể thêm sau nếu cần.
- KHÔNG có thống kê tổng nợ toàn hệ thống — chỉ per khách.

### D9. Role access

- `member`: KHÔNG thấy menu Công Nợ (giống Doanh Thu — sensitive data).
- `admin`: full — có thể click bill để thu tiền (theo flow revamp).
- `boss`: read-only — thấy hết nhưng click bill vào Bill Detail sẽ ở chế độ read-only.

## Capabilities affected

- **NEW capability**: `debt-collection` — spec.md sẽ define requirements. Folder mới trong `openspec/specs/debt-collection/` sau khi archive.

## Dependencies

- **`revamp-payment-and-revenue-model`** — MUST merge trước. Lý do: cần `bills.actual_amount_paid` persist đúng để tính công nợ. Cần filter cancelled đúng.
- `add-server-session` — no direct dep (không đụng `business_date` hay session).
- `add-audit-log` — no new action cần thêm (mọi mutation qua Bill Detail đã log).
- `add-client-phone-history` — không đụng.

## Non-goals

- KHÔNG thêm mutation trên chính màn Công Nợ (không có nút edit inline, không thu tiền inline).
- KHÔNG modify schema (dùng data có sẵn sau khi revamp merge).
- KHÔNG build report / dashboard tổng hợp công nợ.
- KHÔNG gửi SMS/notification nhắc nợ.

## Interactions với change khác

| Change | Trạng thái | Tương tác |
|---|---|---|
| `revamp-payment-and-revenue-model` | in-progress | Blocker. Cần `actual_amount_paid` persist + filter cancelled. |
| `add-server-session` | in-progress | Không đụng. |
| `add-audit-log` | in-progress | Không đụng. |

## References

- Spec revamp payment (`bills.actual_amount_paid` persist rule): `../revamp-payment-and-revenue-model/proposal.md#D4`
- Rule cancel bill auto-refund: `../revamp-payment-and-revenue-model/proposal.md#D12`
