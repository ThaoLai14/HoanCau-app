import React, { useMemo, useState, useRef, useEffect } from "react";

/**
 * Autocomplete khách hàng theo tên / SĐT.
 * - Khi user gõ >= 1 ký tự, hiện dropdown các khách matching.
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

  // Group by client: mỗi entry = { client, phones[] }. Skip type='old'.
  // Filter: giữ phone nếu keyword khớp fullname HOẶC phone_number của phone đó.
  // Sort primary trước secondary. Max 8 clients.
  const matches = useMemo(() => {
    if (keyword.length < 1) return [];
    const groups = [];
    for (const c of clients) {
      const phones = (c.client_phones || []).filter((p) => p.type !== "old");
      const nameHit = c.fullname?.toLowerCase().includes(keyword);
      if (phones.length === 0) {
        if (nameHit) groups.push({ client: c, phones: [] });
        continue;
      }
      const sorted = [...phones].sort((a, b) => {
        if (a.type === "primary" && b.type !== "primary") return -1;
        if (a.type !== "primary" && b.type === "primary") return 1;
        return 0;
      });
      const matched = [];
      for (const p of sorted) {
        const phoneHit = p.phone_number?.toLowerCase().includes(keyword);
        if (nameHit || phoneHit) matched.push(p);
      }
      if (matched.length > 0) groups.push({ client: c, phones: matched });
    }
    return groups.slice(0, 8);
  }, [clients, keyword]);

  const handlePick = (client, phone) => {
    onNameChange(client.fullname || "");
    onPhoneChange(phone?.phone_number || "");
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
            if (!skipNextOpen && keyword.length >= 1) setOpen(true);
          }}
          placeholder={namePlaceholder}
          autoComplete="off"
          className="w-full border rounded px-3 py-1.5 text-sm"
        />

        {open && matches.length > 0 && (
          <ul className="absolute z-30 left-0 right-0 mt-1 max-h-80 overflow-y-auto bg-white border border-gray-200 rounded-lg shadow-lg text-xs divide-y">
            {matches.map((group) => {
              const c = group.client;
              return (
                <li
                  key={c.id}
                  className={c.is_blacklist ? "bg-red-50/40" : ""}
                >
                  <div className="px-3 pt-2 pb-1 flex items-center justify-between gap-2">
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
                    {c.is_blacklist && (
                      <span className="bg-red-100 text-red-700 text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0">
                        BLACKLIST
                      </span>
                    )}
                  </div>
                  {group.phones.length === 0 ? (
                    <div
                      onMouseDown={(e) => {
                        e.preventDefault();
                        handlePick(c, null);
                      }}
                      className="px-3 pb-2 pl-5 text-gray-400 italic cursor-pointer hover:text-gray-600"
                    >
                      (chưa có số điện thoại)
                    </div>
                  ) : (
                    <div className="pb-1.5">
                      {group.phones.map((p) => (
                        <div
                          key={p.id}
                          onMouseDown={(e) => {
                            e.preventDefault();
                            handlePick(c, p);
                          }}
                          className="px-3 py-1 pl-5 cursor-pointer hover:bg-orange-100 flex items-center gap-2"
                        >
                          <span className="font-mono text-gray-600">
                            {p.phone_number}
                          </span>
                          <span
                            className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${
                              p.type === "primary"
                                ? "bg-orange-100 text-orange-700"
                                : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {p.type === "primary" ? "chính" : "phụ"}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {open && keyword.length >= 1 && matches.length === 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg text-xs px-3 py-2 text-gray-500 italic">
            Không tìm thấy khách hàng. Sẽ tạo mới khi lưu đơn.
          </div>
        )}
      </div>

      <div>
        <label className="block text-xs text-gray-400 mb-1">SĐT</label>
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
