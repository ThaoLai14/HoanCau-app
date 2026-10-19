# Capability: Warehouse & Departure

> **Trạng thái**: Tài liệu phản ánh hành vi **đang được code** trong `src/App.jsx` (tab Danh Sách Bốc Xếp, các hàm `handleDeparture`, `handleToggleLocation`, `handleUpdateLocationCounts`).
> Anh cần **đánh dấu chỗ nào sai với yêu cầu thực tế** — mỗi sai lệch sẽ trở thành 1 OpenSpec change riêng.

## Purpose

Hỗ trợ kho theo dõi đơn của 1 chuyến xe trong ngày, đếm số kiện theo vị trí (trong thùng / ngoài cốp xe), bấm Xuất Bến để chốt chuyến và mở chuyến kế tiếp.

## Domain model

- `bills.goods_location` ∈ {`"in"`, `"out"`} — vị trí mặc định khi tạo đơn là `"out"`.
- `bills.inside_count` INTEGER NULL — số kiện đóng trong thùng (đồ nhỏ, giá trị cao, dễ vỡ).
- `bills.outside_count` INTEGER NULL — số kiện chất trên cốp xe.
- Filter của tab: theo `branch_code` đang chọn (warehouseBranch) + theo `warehouseDate` (ngày calendar của `created_at`).

## Requirements

### Requirement: Filter danh sách bốc xếp theo chi nhánh và ngày calendar
Tab Danh Sách Bốc Xếp SHALL hiển thị các bill thuộc 1 chi nhánh + 1 ngày calendar, loại trừ draft và cancelled.

Filter hiện tại: `branch_code === warehouseBranch && delivery_status !== 'draft' && delivery_status !== 'cancelled' && getLocalDateString(created_at) === warehouseDate`.

> ⚠️ **Bug đã xác nhận**: filter dùng `created_at` calendar day. Sau khi Xuất Bến giữa ngày, các đơn của chuyến mai vẫn có `created_at` = hôm nay → hiển thị lẫn vào danh sách hôm nay, không tách được chuyến. Xem change `add-business-date-to-bills`.

#### Scenario: Mặc định mở tab Kho
- **WHEN** user mở tab Danh Sách Bốc Xếp
- **THEN** `warehouseDate = today (local)`, `warehouseBranch = loggedBranch`
- **AND** chỉ hiện các bill có `created_at` rơi vào hôm nay, thuộc chi nhánh đang chọn, không phải draft/cancelled

#### Scenario: Đổi ngày
- **WHEN** user chọn ngày khác từ date picker
- **THEN** danh sách re-filter theo ngày mới (vẫn theo `created_at`)

#### Scenario: Đổi chi nhánh
- **WHEN** user đổi tab SG ↔ GL
- **THEN** danh sách re-filter theo chi nhánh mới

### Requirement: Auto-save inside_count / outside_count
Mỗi bill SHALL hiển thị 2 ô số kiện `inside_count` / `outside_count` editable trực tiếp trong danh sách; 2 ô này MUST auto-save khi user gõ (không có nút Lưu riêng).

Chỉ nhân viên **cùng chi nhánh với bill** được phép cập nhật 2 ô này, bất kể role. Cụ thể:
- **Member**: chỉ update bill của branch mình.
- **Admin**: KHÔNG được update bill của branch khác (dù admin có RLS UPDATE quyền rộng). UI vẫn cho phép xem, nhưng ô input bị `disabled` khi khác branch.
- **Boss**: chỉ xem, không update (role read-only). Ô input luôn `disabled`.

Rule branch check này SHALL enforce ở **UI layer** (disable input + reject callback) để tránh case admin đứng từ SG mà quản lý kho GL nhầm. RLS DB layer vẫn cho admin UPDATE cross-branch (không thay đổi RLS chỉ vì rule này) — đây là guardrail phòng nhầm lẫn, không phải bảo mật thật.

#### Scenario: Gõ inside_count khi cùng branch
- **GIVEN** member SG đang xem tab warehouse SG
- **WHEN** user gõ "3" vào ô inside_count của 1 bill SG
- **THEN** state UI cập nhật ngay
- **AND** hệ thống `UPDATE bills SET inside_count = 3 WHERE id = ?` ngay lập tức

#### Scenario: Admin SG mở tab warehouse GL → ô bị disabled
- **GIVEN** admin SG đang xem tab warehouse GL
- **WHEN** user click vào ô inside_count của bill GL
- **THEN** ô input bị `disabled`, con trỏ chuột hiện tooltip "Chỉ nhân viên GL mới cập nhật được kho này"
- **AND** nếu bằng cách nào gọi được `handleUpdateLocationCounts`, code trả toast lỗi + KHÔNG update DB

#### Scenario: Boss xem tab warehouse → tất cả ô disabled
- **GIVEN** boss login (bất kỳ branch nào)
- **WHEN** mở tab warehouse
- **THEN** mọi ô inside_count/outside_count đều `disabled`

#### Scenario: Xóa hết số
- **WHEN** user xóa hết, để ô trống
- **THEN** `inside_count = NULL`

#### Scenario: Cảnh báo lệch tổng
- **GIVEN** bill có `package_count = 5`
- **WHEN** user nhập `inside_count = 2`, `outside_count = 2` (tổng = 4)
- **THEN** vẫn update DB
- **AND** hiển thị toast cảnh báo "⚠️ Tổng kiện (4) khác với số kiện đơn hàng (5)"

> Lưu ý: cảnh báo này chỉ là cảnh báo, KHÔNG chặn lưu, KHÔNG có rule validation enforce gì.

### Requirement: Toggle goods_location auto-save
`goods_location` SHALL toggle giữa `"in"` và `"out"` và auto-save lên DB ngay khi user bấm.

Vị trí mặc định khi intake là `"out"`.

#### Scenario: Toggle vị trí
- **WHEN** user bấm nút toggle vị trí của 1 bill
- **THEN** `UPDATE bills SET goods_location = <new value> WHERE id = ?` ngay
- **AND** state UI cập nhật

### Requirement: Xuất Bến áp dụng duy nhất chi nhánh đang xem
Nút "Xuất Bến" SHALL áp dụng cho duy nhất chi nhánh đang xem trên tab Kho (`warehouseBranch`); chi nhánh còn lại MUST không bị ảnh hưởng.

Nút có label `"Xuất Bến {warehouseBranch}"`. Bấm vào → hộp xác nhận → nếu OK → gọi `advanceDepartureSession(warehouseBranch)`.

#### Scenario: Xuất bến SG khi đang xem SG
- **WHEN** `warehouseBranch = "SG"`, user bấm Xuất Bến
- **THEN** hộp confirm hiện "Xác nhận xuất bến — Sài Gòn (SG)"
- **WHEN** user confirm
- **THEN** `localStorage["hoanCauDayCounter_SG"].counter` tăng 1, `sessionStart` = now
- **AND** localStorage GL không đổi
- **AND** toast "Đã xuất bến kho SG! Mã đơn hàng mới sẽ bắt đầu từ 01SG<newDayCode>"

#### Scenario: Hủy xuất bến
- **WHEN** user bấm Xuất Bến rồi chọn Cancel
- **THEN** localStorage không thay đổi

#### Scenario: State UI form tạo đơn cập nhật chỉ khi cùng chi nhánh
- **GIVEN** user đang đăng nhập với `loggedBranch = "SG"`, `currentBranch = "SG"` trên form tạo đơn
- **WHEN** user đổi `warehouseBranch = "GL"` và bấm Xuất Bến (kho GL)
- **THEN** form tạo đơn SG KHÔNG re-reserve mã (vì `currentBranch != "GL"`)
- **AND** chỉ localStorage GL đổi

### Requirement: Xuất Bến bị gate theo branch (không gate theo role admin/member)
Nút "Xuất Bến" SHALL enable CHỈ khi `warehouseBranch === session.branch_code` VÀ `session.role !== 'boss'`. Cả admin và member đều bấm được nút này miễn là cùng branch với `warehouseBranch`.

Cụ thể:
- **Member SG / Admin SG** xem tab warehouse SG → button enable → có thể xuất bến SG.
- **Admin SG** switch sang tab warehouse GL → button `disabled`, tooltip "Chỉ nhân viên chi nhánh GL mới được xuất bến kho GL".
- **Boss** (bất kỳ branch nào) → button luôn `disabled`.

Nếu button bằng cách nào được click trong state disabled (vd DevTools), handler `handleDeparture` MUST check lại và reject với toast lỗi.

#### Scenario: Admin SG xuất bến SG (cùng branch)
- **GIVEN** admin có `branch_code = "SG"`, tab warehouse hiện `warehouseBranch = "SG"`
- **WHEN** user bấm Xuất Bến SG
- **THEN** confirm dialog hiện ra
- **AND** sau xác nhận → advance session SG bình thường

#### Scenario: Admin SG xem tab warehouse GL → button disabled
- **GIVEN** admin có `branch_code = "SG"`, user switch sang tab warehouse GL
- **WHEN** hover nút Xuất Bến GL
- **THEN** button có state `disabled` (màu xám, cursor not-allowed)
- **AND** tooltip hiện "Chỉ nhân viên chi nhánh GL mới được xuất bến kho GL"

#### Scenario: Member GL xuất bến GL
- **GIVEN** member có `branch_code = "GL"`, tab warehouse GL
- **WHEN** bấm Xuất Bến GL
- **THEN** thành công

#### Scenario: Boss bấm Xuất Bến → deny
- **GIVEN** boss login (bất kỳ branch nào)
- **WHEN** mở tab warehouse
- **THEN** button Xuất Bến luôn `disabled`
- **AND** nếu bypass UI gọi `handleDeparture` → toast "Boss chỉ được xem, không được xuất bến."

### Requirement: Xuất Bến chỉ enable khi chuyến hiện tại có bill thật
Nút "Xuất Bến" SHALL enable CHỈ khi `branch_sessions[warehouseBranch].bill_seq > 1` (đã có ít nhất 1 bill chính thức trong chuyến hiện tại). Chuyến rỗng (chỉ có draft hoặc không có gì) MUST không được xuất bến — tránh "đốt" mã day_counter mà không có bill nào giữ.

Kết hợp với 2 rule branch/role ở trên, condition đầy đủ:
`canDeparture = session.role !== 'boss' AND warehouseBranch === session.branch_code AND branch_sessions[warehouseBranch].bill_seq > 1`.

Handler `handleDeparture` MUST re-check `bill_seq > 1` trước khi gọi `advanceBranchSession` (defense-in-depth); nếu fail → toast "Chuyến hiện tại của kho {branch} chưa có đơn hàng nào — không thể xuất bến!".

#### Scenario: Chuyến mới sau khi vừa Xuất Bến → button auto-disable
- **GIVEN** vừa bấm Xuất Bến SG → session `{bill_seq: 1, day_counter: A03}`
- **WHEN** user quay lại tab warehouse SG
- **THEN** button Xuất Bến `disabled`
- **AND** tooltip "Chuyến hiện tại của kho SG chưa có đơn hàng nào — không thể xuất bến"

#### Scenario: Tạo 1 bill thật → button enable trở lại
- **GIVEN** session SG `{bill_seq: 1, day_counter: A03}`
- **WHEN** user tạo bill `01SGA03` (chính thức, không draft)
- **THEN** session update thành `{bill_seq: 2, day_counter: A03}`
- **AND** button Xuất Bến SG enable trở lại

#### Scenario: Chỉ tạo draft không enable button
- **GIVEN** session SG `{bill_seq: 1, day_counter: A03}`
- **WHEN** user tạo 1 draft (không convert)
- **THEN** `bill_seq` giữ nguyên = 1
- **AND** button Xuất Bến vẫn `disabled`

#### Scenario: Qua ngày mới không có bill → vẫn disable
- **GIVEN** session SG `{bill_seq: 1, day_counter: A03, business_date: 2026-08-25}` (chuyến rỗng)
- **WHEN** sang ngày 2026-08-26 mở app
- **THEN** auto-roll giữ nguyên counter (theo Requirement "Auto-roll không đốt mã")
- **AND** session → `{bill_seq: 1, day_counter: A03, business_date: 2026-08-26}`
- **AND** button Xuất Bến vẫn `disabled`

### Requirement: Auto-roll không đốt mã day_counter khi chuyến rỗng
Khi `fetchBranchSession` phát hiện `row.business_date < todayVN` (qua ngày mới), hệ thống SHALL check `bill_seq` của session cũ:
- Nếu `bill_seq > 1` → tăng `day_counter` +1 (chuyến cũ có bill thật → mở chuyến mới).
- Nếu `bill_seq === 1` → **giữ nguyên** `day_counter` (chuyến cũ rỗng, không đốt mã).

Cả 2 trường hợp đều update `business_date = todayVN`, `bill_seq = 1`, `session_start = now()`.

Rule này đảm bảo `day_counter` chỉ tăng khi có "chuyến hàng thực" — chi nhánh nghỉ ngày lễ, ngày Chủ Nhật không đốt mã dù nhân viên có mở app kiểm tra.

#### Scenario: Nghỉ 1 ngày không tạo bill → mã không skip
- **GIVEN** ngày 2026-08-25 tạo `01SGA02` (session sau: `{bill_seq: 2, day_counter: A02, business_date: 25/08}`)
- **AND** ngày 2026-08-26 chi nhánh nghỉ, không tạo bill nào
- **AND** ngày 2026-08-27 mở app → auto-roll từ 25/08 → 26/08 (`bill_seq=2 > 1` → counter +1 = A03, `business_date=26/08`), rồi 26/08 → 27/08 (`bill_seq=1` → giữ A03, `business_date=27/08`)

Thực tế 2 lần fetch xảy ra 2 lần calendar day riêng biệt. Mỗi lần fetch check độc lập.

- **WHEN** user tạo bill mới ngày 27/08
- **THEN** mã = `01SGA03` (không skip qua A04)

#### Scenario: Có tạo bill mỗi ngày → mã tăng đều
- **GIVEN** ngày 25/08 tạo `01SGA02` → session `{bill_seq: 2, day_counter: A02, 25/08}`
- **WHEN** ngày 26/08 mở app → fetchBranchSession auto-roll (`bill_seq=2 > 1` → counter A02→A03) → session `{bill_seq: 1, day_counter: A03, 26/08}`
- **AND** tạo bill mới → `01SGA03`, session `{bill_seq: 2, day_counter: A03, 26/08}`
- **WHEN** ngày 27/08 mở app → auto-roll (`bill_seq=2 > 1` → A03→A04)
- **AND** tạo bill mới → `01SGA04`

#### Scenario: Chỉ tạo draft không tăng counter
- **GIVEN** ngày 20/08 session `{bill_seq: 1, day_counter: A03, 20/08}` (đã auto-roll từ 18/08)
- **WHEN** ngày 20/08 tạo draft (không convert) → `bill_seq` giữ = 1
- **AND** ngày 21/08 mở app → auto-roll (`bill_seq=1` → **giữ** A03) → session `{bill_seq: 1, A03, 21/08}`
- **AND** tạo bill chính thức → `01SGA03`

#### Scenario: Draft convert thành bill thật ngay hôm đó → mã dùng counter hiện tại
- **GIVEN** ngày 20/08 session `{bill_seq: 1, day_counter: A03, 20/08}`
- **WHEN** ngày 20/08 tạo draft rồi convert ngay → mã `01SGA03`, session `{bill_seq: 2, A03, 20/08}`
- **WHEN** ngày 21/08 mở app → auto-roll (`bill_seq=2 > 1` → A03→A04)
- **AND** tạo bill mới → `01SGA04`

