# Delta spec: bill-code-generation

## MODIFIED Requirements

### Requirement: Session state trên DB
Session state (business_date, day_counter, bill_seq, session_start) MUST lưu trên bảng `branch_sessions` ở Postgres, 1 row per branch. `localStorage` MUST KHÔNG còn được dùng làm source of truth cho session.

Bảng `branch_sessions` có schema:
- `branch_id UUID PK REFERENCES branches(id)`
- `business_date DATE NOT NULL`
- `day_counter TEXT NOT NULL`
- `bill_seq INT NOT NULL DEFAULT 1`
- `session_start TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
- `updated_by UUID REFERENCES users(id)`

Client MUST fetch session từ DB trước mỗi lần tạo bill và cache trong React state cho vòng đời login session.

#### Scenario: Login khởi tạo session cache
- **WHEN** user đăng nhập thành công
- **THEN** client fetch `branch_sessions` cho `session.branch_id` → cache vào React state
- **AND** nếu user là admin → pre-fetch cả 2 chi nhánh SG + GL

#### Scenario: Mở form Tạo Đơn refresh session
- **WHEN** user mở form Tạo Đơn
- **THEN** client re-fetch `branch_sessions` cho branch hiện tại → update cache
- **AND** compute `reservedBillCode` từ session vừa fetch

### Requirement: Auto-roll khi qua ngày mới trên DB
Khi client fetch `branch_sessions` và detect `session.business_date < today (VN timezone)`, client MUST tự UPDATE session ngay: `business_date = today`, `day_counter = nextLetterCounter(cur)`, `bill_seq = 1`, `session_start = now()`, `updated_by = current user`.

Auto-roll chạy độc lập cho từng branch. Race giữa 2 client cùng detect → last write wins (end state giống nhau).

#### Scenario: Mở app sáng hôm sau
- **GIVEN** `branch_sessions.SG = {business_date: 2026-07-01, day_counter: 'A', bill_seq: 5}`
- **WHEN** user mở app lúc 08:00 ngày 2026-07-02 (VN)
- **THEN** `fetchBranchSession('SG')` detect và UPDATE thành `{business_date: 2026-07-02, day_counter: 'B', bill_seq: 1, session_start: 08:00...}`
- **AND** trả về session mới

#### Scenario: Auto-roll rollover Z → AA
- **GIVEN** session có `day_counter = 'Z'`
- **WHEN** auto-roll kích hoạt
- **THEN** `day_counter` mới = `'AA'`

### Requirement: Xuất Bến gọi server UPDATE
Bấm "Xuất Bến" MUST thực hiện 1 UPDATE atomic trên `branch_sessions`: `business_date = tomorrow (VN)`, `day_counter = nextLetterCounter(cur)`, `bill_seq = 1`, `session_start = now()`, `updated_by = current user`. Sau khi UPDATE thành công, client update cache.

`localStorage` MUST KHÔNG được ghi khi Xuất Bến.

#### Scenario: Xuất bến ban ngày
- **GIVEN** `branch_sessions.SG = {business_date: 2026-07-01, day_counter: 'A', bill_seq: 6}`
- **WHEN** user bấm Xuất Bến lúc 14:30 ngày 2026-07-01
- **THEN** DB UPDATE thành `{business_date: 2026-07-02, day_counter: 'B', bill_seq: 1, session_start: 2026-07-01T14:30...}`
- **AND** bill tạo sau đó có `bill_code = 01SGB01`, `business_date = 2026-07-02`

#### Scenario: Xuất Bến sau nửa đêm (giữ đúng ngày kinh doanh)
- **GIVEN** session `business_date = 2026-07-01`
- **WHEN** user bấm Xuất Bến lúc 00:30 ngày 2026-07-02 (VN, chưa auto-roll)
- **THEN** DB UPDATE `business_date = 2026-07-03` (tomorrow của 2026-07-02, không phải 2026-07-02)

### Requirement: Bill code sinh từ session cache
`bill_code` MUST được tính theo format `NN{SG|GL}{day_counter}NN` với NN = `bill_seq` (2 chữ số, padStart 0) và `day_counter` = chữ cái hiện tại của session.

Cả 2 số NN đều là `bill_seq` (giữ format cũ).

#### Scenario: Format mã đơn
- **GIVEN** session `{day_counter: 'A', bill_seq: 3}`, branch = SG
- **WHEN** compute `reserveBillCode('SG', session)`
- **THEN** kết quả = `'03SGA03'`

#### Scenario: Sau insert bill, seq tăng
- **GIVEN** session `bill_seq = 3`
- **WHEN** insert bill `03SGA03` thành công
- **THEN** DB UPDATE `bill_seq = 4`, `updated_by = current user`

### Requirement: Retry khi race UNIQUE bill_code
Nếu INSERT bill nhận error `23505` (UNIQUE violation trên `(branch_id, bill_code)`), client MUST:
1. Re-fetch session mới.
2. Compute lại `bill_code`.
3. Retry INSERT (max 3 lần).

KHÔNG hiển thị modal confirm — retry silent (race hiếm khi xảy ra do session cache 100ms fresh).

#### Scenario: 2 client insert đồng thời
- **GIVEN** cả desktop và mobile SG cùng fetch session `bill_seq = 5`
- **WHEN** cả 2 cùng INSERT `05SGA05`
- **THEN** 1 client thành công (UPDATE seq=6)
- **AND** client còn lại nhận `23505` → refetch → thấy seq=6 → INSERT `06SGA05` → thành công

## REMOVED Requirements

### Requirement: LocalStorage per-device session
**Reason**: Session được chuyển sang DB (`branch_sessions`). LocalStorage KHÔNG còn dùng.
**Migration**: LocalStorage cũ vẫn tồn tại trong browser cache nhưng không được đọc. User không cần xoá thủ công.
