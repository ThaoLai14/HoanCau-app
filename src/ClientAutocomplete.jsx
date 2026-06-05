import React, { useMemo, useState, useRef, useEffect } from "react";

/**
 * Autocomplete khách hàng theo tên / SĐT.
 * - Khi user gõ >= 3 ký tự, hiện dropdown các khách matching.
 * - Click 1 dòng → populate tên + SĐT vào form.
 * - Nếu khách bị blacklist → icon ⚠️ kèm tooltip lý do.
 *
 * Props:
 *  - clients: array khách hàng (kèm client_phones)
 *  - nameValue, onNameChange: state Họ tên
 *  - phoneValue, onPhoneChange: state SĐT
 *  - namePlaceholder, phonePlaceholder
 *  - accentColor: "orange" | "blue"
 */
export default function ClientAutocomplete({
  clients = [],
  nameValue,
  onNameChange,
  phoneValue,
  onPhoneChange,
  namePlaceholder = "Họ tên...",
  phonePlaceholder = "Để trống nếu không có...",
}) {
  const [open, setOpen] = useState(false);
  const [skipNextOpen, setSkipNextOpen] = useState(false);
  const wrapRef = useRef(null);

  // Đóng dropdown khi click ra ngoài
  useEffect(() => {
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const keyword = nameValue.trim().toLowerCase();

  const matches = useMemo(() => {
    if (keyword.length < 3) return [];
    return clients
      .filter((c) => {
        const nameHit = c.fullname?.toLowerCase().includes(keyword);
        const phoneHit = c.client_phones?.some((p) =>
          p.phone_number?.toLowerCase().includes(keyword)
        );
        return nameHit || phoneHit;
      })
      .slice(0, 8); // tối đa 8 gợi ý
  }, [clients, keyword]);

  const handlePick = (c) => {
    const primaryPhone =
      c.client_phones?.find((p) => p.type === "primary")?.phone_number ||
      c.client_phones?.[0]?.phone_number ||
      "";
    onNameChange(c.fullname || "");
    onPhoneChange(primaryPhone);
    setSkipNextOpen(true);
    setOpen(false);
  };

  return (
    <div className="space-y-3" ref={wrapRef}>
      <div className="relative">
        <label className="block text-xs text-gray-400 mb-1">Họ tên *</label>
        <input
          type="text"
          value={nameValue}
          onChange={(e) => {
            onNameChange(e.target.value);
            if (skipNextOpen) setSkipNextOpen(false);
            else setOpen(true);
          }}
          onFocus={() => {
            if (!skipNextOpen && keyword.length >= 3) setOpen(true);
          }}
          placeholder={namePlaceholder}
          autoComplete="off"
          className="w-full border rounded px-3 py-1.5 text-sm"
        />

        {open && matches.length > 0 && (
          <ul className="absolute z-30 left-0 right-0 mt-1 max-h-64 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg text-xs divide-y">
            {matches.map((c) => {
              const primary =
                c.client_phones?.find((p) => p.type === "primary")?.phone_number ||
                c.client_phones?.[0]?.phone_number ||
                "—";
              return (
                <li
                  key={c.id}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handlePick(c);
                  }}
                  className={`px-3 py-2 cursor-pointer hover:bg-orange-50 flex items-center justify-between gap-2 ${
                    c.is_blacklist ? "bg-red-50/40" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-gray-800 truncate flex items-center gap-1.5">
                      {c.is_blacklist && (
                        <span
                          className="text-red-600 cursor-help"
                          title={`BLACKLIST: ${c.blacklist_reason || "Không có lý do"}`}
                        >
                          ⚠️
                        </span>
                      )}
                      {c.fullname}
                    </p>
                    <p className="text-gray-500 font-mono text-[11px]">{primary}</p>
                  </div>
                  {c.is_blacklist && (
                    <span className="bg-red-100 text-red-700 text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0">
                      BLACKLIST
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {open && keyword.length >= 3 && matches.length === 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg text-xs px-3 py-2 text-gray-500 italic">
            Không tìm thấy khách hàng. Sẽ tạo mới khi lưu đơn.
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">SĐT chính (Optional)</label>
        <div className="relative">
          <input
            type="text"
            inputMode="tel"
            value={phoneValue}
            onChange={(e) => onPhoneChange(e.target.value)}
            placeholder={phonePlaceholder}
            className="w-full border rounded px-3 py-1.5 pr-8 text-sm"
          />
          {phoneValue && (
            <button
              type="button"
              onClick={() => onPhoneChange("")}
              title="Xóa số"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-red-500 transition text-xs font-bold"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
