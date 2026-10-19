-- Thêm 2 cột mới vào bảng bills để lưu số kiện trong/ngoài
-- Chạy script này trong Supabase SQL Editor

ALTER TABLE bills
ADD COLUMN inside_count INTEGER DEFAULT NULL,
ADD COLUMN outside_count INTEGER DEFAULT NULL;

-- Không cập nhật dữ liệu cũ, để user tự nhập khi cần
-- Lý do: Tránh user miss dữ liệu khi có giá trị default sẵn

-- Có thể giữ lại cột goods_location để tương thích ngược, hoặc xóa nếu không cần:
-- ALTER TABLE bills DROP COLUMN goods_location;
