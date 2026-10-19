## Why

Tab Doanh Thu hiện chỉ xem tốt theo ngày; xem theo tháng/năm còn sơ sài và không phản ánh đúng cách chi phí phát sinh. Chi phí cố định (lương, thuê văn phòng) thuộc về cả tháng chứ không thuộc một ngày, nhưng hiện mọi phiếu chi đều gắn một ngày — nhập lương ngày mùng 5 làm ngày đó "lỗ giả". Ngoài ra chi phí chưa phân loại nên không tổng hợp được "cả năm tốn nhất khoản nào", và boss phải cộng tay doanh thu SG + GL.

## What Changes

- Tab Doanh Thu tách thành **3 sub-tab thời gian** rõ ràng: Ngày / Tháng / Năm, mỗi tab có bố cục riêng (thay cho 1 dropdown gộp chung).
- Thêm **2 loại phiếu chi**: phiếu chi **theo ngày** (gắn 1 ngày) và phiếu chi **theo tháng** (gắn 1 tháng, không có ngày). Phiếu chi tháng KHÔNG hiển thị ở màn Ngày để tránh "lỗ giả".
- Thêm **danh mục chi phí (category)** dùng chung cho cả 2 chi nhánh, do `sys_admin` quản lý (thêm/sửa/xoá). Mỗi phiếu chi bắt buộc chọn category. Phiếu chi cũ chưa có category → gán mặc định "Chưa phân loại".
- **Báo cáo năm**: thu tổng hợp theo từng tháng; chi tổng hợp theo category (tổng cả năm); lợi nhuận năm = tổng thu − tổng chi. **Báo cáo tháng**: thêm bảng chi theo category của riêng tháng đó.
- Thêm tab **"Tổng 2 chi nhánh"** (chỉ boss) để xem doanh thu gộp SG + GL.
- **Khóa sổ tháng** theo từng chi nhánh: cửa sổ ân hạn 3 ngày đầu tháng sau để nhập bù phiếu chi tháng; boss được hỏi "đã hoàn tất doanh thu tháng trước chưa?" mỗi khi mở app trong thời gian ân hạn; boss có thể khóa sổ thủ công bất cứ lúc nào. Sau khi khóa, chỉ `sys_admin` được nhập backdate. Mọi thao tác ghi audit log.
- **Chặn backdate phiếu chi ngày**: admin/boss chỉ nhập phiếu chi ngày cho hôm nay; chỉ `sys_admin` nhập/sửa phiếu chi cho ngày quá khứ.

## Capabilities

### New Capabilities
- `expense-categories`: Bảng danh mục chi phí dùng chung 2 chi nhánh, `sys_admin` CRUD, ràng buộc không cho xoá category còn dính phiếu chi, gán mặc định "Chưa phân loại" cho dữ liệu cũ, mỗi phiếu chi tham chiếu một category.
- `monthly-ledger-close`: Quy trình khóa sổ chi phí theo tháng × chi nhánh, cửa sổ ân hạn 3 ngày, prompt nhắc boss, nút khóa thủ công, quy tắc khóa/mở và quyền `sys_admin` bypass.

### Modified Capabilities
- `revenue-reporting`: Phiếu chi có 2 loại ngày/tháng; bố cục 3 sub-tab Ngày/Tháng/Năm; báo cáo tháng thêm bảng chi theo category; báo cáo năm = thu theo tháng + chi theo category; tab "Tổng 2 chi nhánh" cho boss; quy tắc chặn backdate phiếu chi ngày.

## Impact

- **DB** (ad-hoc `.sql` tại repo root):
  - Bảng mới `expense_categories(id, name, is_active, created_at, ...)`.
  - `expenses` thêm `category_id` (FK, NOT NULL sau backfill "Chưa phân loại"), `period_type` ('day' | 'month'), `period_month` (DATE/text cho phiếu chi tháng).
  - Bảng mới `monthly_closes(branch_id, period_month, status, closed_by, closed_at, ...)`.
  - RLS: `sys_admin` backdate; admin/boss giới hạn theo quy tắc khóa sổ.
- **Code**: `src/App.jsx` tab Doanh Thu (form nhập phiếu chi, useMemo tính toán theo category/period, 3 sub-tab, tab tổng boss), prompt khóa sổ khi mở app; `src/SysAdminPanel.jsx` thêm quản lý category; `src/auditLabels.js` + `src/auditLog.js` thêm action cho category/khóa sổ.
- **Audit**: thêm action cho category CRUD, month-close, backdate phiếu chi.

## Non-goals / Quyết định còn mở

- **D11** (có bỏ việc tự động loại doanh thu của bill bị hủy hay không) và **category cho phiếu hoàn tiền tự động** — CHƯA chốt, chờ chốt flow hủy đơn. Thiết kế phần này để ngỏ trong design.md; khóa sổ tháng là cơ sở để sau này "đóng băng" số tháng cũ.
- Lương chi tiết theo từng nhân viên (quản lý nhân sự) — ngoài phạm vi; dùng nút "thêm khoản" trong phiếu chi tháng là đủ.
- Xuất Excel/CSV — chưa làm, để sau.
- Tab doanh thu theo tuần — không làm (tránh rối); phiếu chi tháng + nhiều dòng đã đủ cho SG trả lương theo tuần.
