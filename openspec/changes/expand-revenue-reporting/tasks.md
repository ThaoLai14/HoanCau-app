## 1. Database — migration SQL (repo root, idempotent)

- [x] 1.1 Tạo bảng `expense_categories(id, name, is_active, created_at)` + seed danh sách mặc định (tiền ăn, tiền mua vật dụng, tiền lương, tiền thuê văn phòng, tiền xe, tiền trà nước lái xe) + "Chưa phân loại". → `add-expense-categories-and-period.sql`
- [x] 1.2 `expenses` thêm `category_id` (FK → expense_categories ON DELETE RESTRICT), `period_type TEXT CHECK (period_type IN ('day','month'))`, `period_month DATE` + CHECK ràng period_month theo period_type.
- [x] 1.3 Backfill phiếu chi cũ: `category_id` = "Chưa phân loại", `period_type` = 'day'; sau đó set `category_id` NOT NULL.
- [x] 1.4 Tạo bảng `monthly_closes(id, branch_id, period_month, status CHECK IN ('open','closed'), closed_by, closed_at)` + unique (branch_id, period_month).
- [x] 1.5 RLS: category SELECT mọi role, CRUD chỉ `sys_admin` (xoá chặn bằng FK RESTRICT). monthly_closes SELECT admin/boss/sys_admin, ghi boss+sys_admin. Lock theo thời gian enforce ở app code.
- [x] 1.6 Rollback block trong cùng file (nullable trước NOT NULL), theo style các `.sql` khác.

## 2. Category management (sys_admin)

- [x] 2.1 `src/SysAdminPanel.jsx`: thêm tab "Danh mục chi" (`CategoriesTab`) — list + thêm/sửa/xoá.
- [x] 2.2 Chặn xoá category còn dính phiếu chi → bắt lỗi FK 23503, thông báo "đang có phiếu chi liên quan".
- [x] 2.3 Đổi tên category áp dụng cho cả phiếu cũ (tham chiếu `category_id`, không copy tên).
- [x] 2.4 Audit log cho category create/update/delete (nhãn mới + nới CHECK action trong migration).

## 3. Form nhập phiếu chi (category + loại kỳ)

- [x] 3.1 `src/App.jsx`: thêm ô chọn category (bắt buộc) vào form `handleAddExpense`.
- [x] 3.2 Thêm lựa chọn loại kỳ: theo ngày / theo tháng.
- [x] 3.3 Phiếu chi theo ngày: admin/boss dùng hôm nay (created_at=now). (sys_admin backdate ngày quá khứ qua UI — TODO nhỏ, chưa thêm date picker.)
- [x] 3.4 Phiếu chi theo tháng: chọn tháng, lưu `period_month`; áp quy tắc ân hạn/khóa sổ.
- [x] 3.5 Audit log: thêm field category/period vào changes của expense_create; month_close logged.

## 4. Bố cục 3 sub-tab thời gian

- [x] 4.1 `src/App.jsx` tab revenue: đổi dropdown `revenueFilterType` thành 3 sub-tab Ngày/Tháng/Năm.
- [x] 4.2 Màn Ngày: chỉ cộng phiếu chi `period_type='day'` của ngày (month-expenses loại trừ trong useMemo).
- [x] 4.3 Màn Tháng: tổng thu/chi + bảng chi theo category + breakdown theo ngày.
- [x] 4.4 Màn Năm: breakdown thu theo tháng + bảng chi theo category (tổng năm).
- [x] 4.5 `useMemo`: tách phiếu chi theo `period_type`, gom `categoryBreakdown`; breakdownRows period-aware.

## 5. Tab "Tổng 2 chi nhánh" (boss)

- [x] 5.1 Thêm sub-tab chi nhánh thứ 3 `ALL` chỉ hiển thị với role `boss`.
- [x] 5.2 Cộng gộp thu + chi SG+GL (`matchBranch` trong useMemo); form nhập ẩn với ALL.

## 6. Khóa sổ tháng

- [x] 6.1 Helper `isMonthEditableByAdmin`/`isMonthLocked`: `closed` HOẶC quá 3 ngày đầu tháng kế; sys_admin bypass.
- [x] 6.2 Prompt khi `boss` mở app (useEffect + modal); "Rồi" → close; "Chưa" → dismiss + lặp lần sau.
- [x] 6.3 Nút khóa sổ thủ công trong tab Tháng (chỉ boss).
- [x] 6.4 Chặn admin/boss nhập phiếu chi tháng khi đã khóa (`handleAddExpense`); sys_admin bypass.
- [x] 6.5 Audit log cho month_close.

## 7. Kiểm thử & hoàn tất

- [ ] 7.1 Test theo role: member (ẩn tab), admin (nhập hôm nay), boss (khóa sổ, tab tổng), sys_admin (backdate). — chờ anh test sau khi chạy SQL.
- [ ] 7.2 Test phiếu chi tháng không làm màn Ngày "lỗ giả". — chờ anh test.
- [ ] 7.3 Test xoá category bị chặn khi còn phiếu chi; đổi tên áp cho phiếu cũ. — chờ anh test.
- [x] 7.4 `npm run build` pass.
- [ ] 7.5 Ghi lại kết quả + quyết định D11 (khi chốt) vào openspec.

## 8. Quyết định còn mở (chưa làm — chờ chốt flow hủy đơn)

- [ ] 8.1 D11: doanh thu tháng cũ khi hủy đơn đã thu tiền (giữ hay bỏ) — dựa trên khóa sổ tháng.
- [ ] 8.2 Category cho phiếu hoàn tiền tự động (ví dụ "Hoàn tiền").
