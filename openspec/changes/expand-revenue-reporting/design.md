## Context

Tab Doanh Thu (`src/App.jsx`, `currentTab === "revenue"`) hiện tính `totalRevenue`/`totalExpense`/`netRevenue` client-side trong `useMemo`, lọc theo một dropdown `revenueFilterType` ∈ {day, month, year}. Đã có sẵn bảng breakdown (tháng → từng ngày, năm → từng tháng) và `prevPeriodRevenue` (không render). Doanh thu lấy từ `bill_payment_details.amount_paid` (nguồn truth sau change `revamp-payment-and-revenue-model`), gom theo `toVNDate(created_at)`. Chi phí lấy từ `expenses(amount, note, branch_id, created_at, is_delete)` — **không có trường phân loại, không có khái niệm "chi của tháng"**.

Change này mở rộng phần báo cáo tháng/năm, thêm phân loại chi phí và khóa sổ tháng. Các quyết định dưới đây được chốt qua thảo luận với chủ sản phẩm (explore mode).

## Goals / Non-Goals

**Goals:**
- Xem doanh thu theo Ngày / Tháng / Năm với bố cục phù hợp từng kỳ.
- Phân loại chi phí theo category dùng chung, tổng hợp chi theo category cuối tháng/năm.
- Tách phiếu chi theo ngày vs theo tháng để lương/thuê không làm một ngày "lỗ giả".
- Khóa sổ chi phí theo tháng × chi nhánh, có ân hạn và nhắc boss.
- Tab tổng gộp 2 chi nhánh cho boss.

**Non-Goals:**
- Quyết định D11 (loại/không loại doanh thu của bill bị hủy) và category cho phiếu hoàn tiền tự động — để ngỏ, chờ chốt flow hủy đơn.
- Quản lý lương chi tiết theo nhân viên; xuất Excel/CSV; tab theo tuần.

## Decisions

### D1 — 3 sub-tab thời gian thay cho 1 dropdown
Tab Doanh Thu có 3 sub-tab Ngày / Tháng / Năm, mỗi tab một bố cục riêng. Lý do: 3 kỳ cần hiển thị khác nhau (ngày = chi tiết giao dịch; tháng = tổng + chi theo category; năm = thu theo tháng + chi theo category). Thay thế dropdown `revenueFilterType` hiện tại.
- *Alternatives*: giữ dropdown (gọn code nhưng mỗi kỳ bị ép chung 1 khung — lý do ban đầu gây rối).

### D2 — Phiếu chi 2 loại: theo ngày và theo tháng
`expenses` thêm `period_type TEXT CHECK (period_type IN ('day','month'))`.
- `period_type='day'`: gắn một ngày cụ thể (giữ `created_at`/ngày nghiệp vụ); hiển thị ở màn Ngày + Tháng + Năm.
- `period_type='month'`: thêm `period_month DATE` (ngày đầu tháng, ví dụ `2026-10-01`); KHÔNG hiển thị ở màn Ngày; hiển thị ở Tháng + Năm.
- Lý do: lương/thuê thuộc về cả tháng, gắn vào 1 ngày sẽ bóp méo màn Ngày. `period_month` độc lập `created_at` vì có thể nhập lương T10 vào đầu T11.
- *Alternatives*: dùng "category type" (cố định/vận hành) — bị loại vì người dùng muốn tự quyết từng phiếu, không ràng theo category.

### D3 — Category dùng chung, sys_admin quản lý
Bảng mới `expense_categories(id, name, is_active, created_at)`. Dùng chung cả SG + GL (chi phí vẫn tách theo `branch_id` trên `expenses`). Chỉ `sys_admin` thêm/sửa/xoá.
- **Xoá**: chỉ cho xoá category KHÔNG dính phiếu chi nào. Nếu còn dính → chặn, báo "đang có phiếu chi liên quan". Cân nhắc dùng `is_active=false` (ẩn) thay cho xoá cứng khi cần ngưng dùng nhưng vẫn giữ lịch sử.
- **Sửa tên**: áp dụng cho cả phiếu cũ lẫn mới (vì phiếu tham chiếu `category_id`, không copy tên).
- Danh sách khởi tạo: tiền ăn, tiền mua vật dụng, tiền lương, tiền thuê văn phòng, tiền xe, tiền trà nước lái xe, + "Chưa phân loại".

### D4 — Mọi phiếu chi bắt buộc có category
`expenses.category_id` NOT NULL (sau backfill). Phiếu chi cũ → gán category "Chưa phân loại". Form nhập phiếu chi (ngày và tháng) đều có ô chọn category bắt buộc.

### D5 — Bố cục báo cáo
- **Màn Ngày**: tổng thu − tổng chi (chỉ phiếu chi `period_type='day'` của ngày đó) + danh sách đơn thu + danh sách phiếu chi ngày.
- **Màn Tháng**: tổng thu, tổng chi (phiếu chi ngày trong tháng + phiếu chi tháng), lợi nhuận + **bảng chi theo category** của tháng.
- **Màn Năm**: bảng THU theo 12 tháng (+ tổng năm); bảng CHI gom theo category (tổng cả năm); lợi nhuận năm = tổng thu − tổng chi. (Khớp mẫu báo cáo người dùng cung cấp.)

### D6 — Tab "Tổng 2 chi nhánh" cho boss
Thêm sub-tab chi nhánh thứ 3, chỉ hiển thị với role `boss`, cộng gộp số liệu SG + GL (read-only). Lý do: boss hiện phải cộng tay.

### D7 — Chặn backdate phiếu chi ngày
admin/boss chỉ được tạo phiếu chi `period_type='day'` cho **ngày hôm nay** (ép chốt sổ cuối ngày, không để lẫn qua hôm sau). Chỉ `sys_admin` được thêm/sửa phiếu chi ngày cho ngày quá khứ. Mọi thao tác ghi audit log.

### D8 — Khóa sổ tháng theo chi nhánh
Bảng mới `monthly_closes(id, branch_id, period_month DATE, status TEXT CHECK (status IN ('open','closed')), closed_by UUID, closed_at TIMESTAMPTZ)`. Khóa **riêng từng chi nhánh** cho mỗi tháng.
- **Ân hạn**: phiếu chi `period_type='month'` của tháng T được admin/boss nhập/sửa trong tháng T và trong **3 ngày đầu** của tháng T+1.
- **Prompt boss**: khi `boss` mở app, nếu tháng liền trước của một chi nhánh chưa `closed` và còn trong hạn → hỏi "Đã hoàn tất doanh thu tháng {T} chưa?". Bấm "Rồi" → set `closed` ngay. Bấm "Chưa" → nhắc "còn N ngày", vẫn mở; prompt lặp lại mỗi lần mở app cho tới khi khóa hoặc hết hạn.
- **Khóa thủ công**: boss có nút khóa sổ trong tab Tháng, khóa bất cứ lúc nào.
- **Sau khóa** (status `closed` HOẶC quá 3 ngày ân hạn): admin/boss bị chặn nhập/sửa phiếu chi tháng của tháng đó; chỉ `sys_admin` backdate được. Mọi thao tác ghi log.
- **Ai khóa**: chỉ `boss`. admin không khóa được.

### D9 — Trạng thái "khóa" là tính toán, không chỉ là cờ
Một tháng `T` của chi nhánh `B` coi là KHÓA với admin/boss khi: tồn tại `monthly_closes` row `closed`, HOẶC `today > (ngày đầu T+1 + 3 ngày)`. Cờ `closed` chỉ là "khóa sớm chủ động"; hết hạn là "khóa tự động". `sys_admin` luôn bypass.

## Risks / Trade-offs

- **[Xoá category có race]** → kiểm tra số phiếu chi tham chiếu ngay trước khi xoá (server-side, ví dụ RLS/trigger hoặc đếm rồi chặn); ưu tiên `is_active=false` để an toàn lịch sử.
- **[Khóa sổ dính D11 chưa chốt]** → month-close chính là cơ chế đóng băng số tháng cũ; khi chốt D11 sẽ dựa trên nó. Tạm thời không đổi logic doanh thu-khi-hủy.
- **[Tính toán client-side phình to theo năm]** → năm nhiều dữ liệu có thể chậm; chấp nhận trước mắt (quy mô nhỏ), tối ưu sau nếu cần.
- **[RLS theo thời gian phức tạp]** → quy tắc "hôm nay / 3 ngày / sys_admin bypass" cần viết cẩn thận trong policy; test từng role.
- **[Prompt boss gây phiền]** → chỉ hỏi trong cửa sổ ân hạn và chỉ khi chưa khóa; sau khi "Rồi" thì ngừng.

## Migration Plan

1. SQL tại repo root (idempotent): tạo `expense_categories`, seed danh sách mặc định + "Chưa phân loại"; thêm cột `expenses.category_id`/`period_type`/`period_month`; backfill `category_id`="Chưa phân loại", `period_type`='day'; đặt NOT NULL; tạo `monthly_closes`; thêm/điều chỉnh RLS.
2. Deploy code `src/App.jsx` + `src/SysAdminPanel.jsx` + audit labels.
3. Rollback: cột/bảng mới nullable trước khi NOT NULL; giữ script rollback tách như các `.sql` khác.

## Open Questions

- **D11**: Khi hủy đơn đã thu tiền, doanh thu tháng cũ giữ hay bỏ? (Nghiêng "giữ, hủy là sự kiện của tháng hiện tại", dựa trên month-close — nhưng chưa chốt.)
- Category cho phiếu hoàn tiền tự động (khi có): dùng category riêng "Hoàn tiền"? Chờ flow hủy đơn.
- Phiếu chi tháng: ân hạn 3 ngày áp cho "tháng liền trước"; có cần cho nhập tháng xa hơn với admin không, hay chỉ sys_admin? (Hiện chốt: chỉ tháng hiện tại + tháng liền trước cho admin/boss.)
