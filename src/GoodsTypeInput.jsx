// src/GoodsTypeInput.jsx
// Ô "Mặt hàng gửi": textarea (cho nhiều món) + gợi ý từ danh sách cố định.
// Gợi ý theo TỪ đang gõ (đoạn sau dấu phẩy / xuống dòng cuối), khớp không dấu và coi đ = d.
import { useState, useMemo, useRef } from "react";

// Danh sách mặt hàng cố định (có thể bổ sung sau).
export const GOODS_TYPES = [
  "Thức ăn", "Linh kiện", "Kính", "Mắt kính", "Gọng kính", "Tròng kính",
  "Hàng bảo hành", "Đồ xe", "Mỹ phẩm", "Thuốc", "Giày", "Quần áo",
  "Đồ dùng", "Mẫu xét nghiệm", "Mẫu dùng thử", "Hồ sơ", "Dụng cụ",
  "Đồ điện tử", "Đồ gia dụng",
];

// Bỏ dấu tiếng Việt + đ→d + thường hoá để so khớp.
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");

export default function GoodsTypeInput({ value, onChange, placeholder, className, rows = 3 }) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const ref = useRef(null);

  // Tách phần đã nhập trước + token đang gõ (sau dấu phẩy/xuống dòng cuối cùng).
  const { prefix, token } = useMemo(() => {
    const m = /[\n,][^\n,]*$/.exec(value || "");
    if (m) return { prefix: value.slice(0, m.index + 1), token: value.slice(m.index + 1) };
    return { prefix: "", token: value || "" };
  }, [value]);

  const suggestions = useMemo(() => {
    const q = normalize(token.trim());
    if (!q) return [];
    const list = GOODS_TYPES.filter((g) => normalize(g).includes(q));
    // Nếu đã khớp đúng 1 món (gõ xong) thì không cần gợi ý nữa.
    if (list.length === 1 && normalize(list[0]) === q) return [];
    return list.slice(0, 10);
  }, [token]);

  const pick = (g) => {
    const leadingWs = token.match(/^\s*/)[0];
    onChange(prefix + leadingWs + g);
    setOpen(false);
    setActiveIdx(0);
    ref.current?.focus();
  };

  const onKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => (i + 1) % suggestions.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length); }
    else if (e.key === "Enter") { e.preventDefault(); pick(suggestions[activeIdx] || suggestions[0]); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => { onChange(e.target.value); setOpen(true); setActiveIdx(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg max-h-56 overflow-auto text-sm">
          {suggestions.map((g, i) => (
            <li
              key={g}
              onMouseDown={(e) => { e.preventDefault(); pick(g); }}
              onMouseEnter={() => setActiveIdx(i)}
              className={`px-3 py-2 cursor-pointer ${i === activeIdx ? "bg-orange-100 text-orange-800 font-semibold" : "hover:bg-gray-50"}`}
            >
              {g}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
