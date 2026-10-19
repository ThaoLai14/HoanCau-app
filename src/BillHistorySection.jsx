// src/BillHistorySection.jsx
// Change: add-audit-log §5
// Ref: openspec/changes/add-audit-log/design.md §5, §6
//
// Section inline luôn hiển thị trên Bill Detail (dưới section Thanh toán & Giao nhận).
// Chỉ render khi userRole ∈ {admin, boss} (member ẩn hoàn toàn — §6.2).
// Auto-fetch on mount + refetch khi prop `refreshKey` đổi (để refresh sau mutation).

import React, { useState, useEffect } from "react";
import { fetchAuditLog } from "./auditLog";
import { ACTION_LABELS, renderChanges } from "./auditLabels";

function AuditEntry({ entry }) {
  const meta = ACTION_LABELS[entry.action] || { text: entry.action, icon: "📝", color: "gray" };
  const changes = renderChanges(entry.changes);
  const dt = new Date(entry.created_at);
  const timeStr = dt.toLocaleString("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Ho_Chi_Minh",
  });
  return (
    <div className="border-l-4 border-orange-300 pl-3 py-2 bg-white rounded shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="text-sm">
            <span className="mr-1">{meta.icon}</span>
            <span className="font-semibold text-gray-800">{entry.full_name || entry.username}</span>
            <span className="text-gray-500"></span>
            <span className="text-gray-700"> {meta.text}</span>
          </div>
          {changes.length > 0 && (
            <ul className="mt-1 text-xs text-gray-700 space-y-0.5 ml-4">
              {changes.map((c, i) => (
                <li key={i}>
                  • <span className="font-medium">{c.label}:</span>{" "}
                  {c.isCreate
                    ? <span className="text-emerald-700">{c.newText}</span>
                    : <><span className="text-red-600 line-through">{c.oldText}</span>{" → "}<span className="text-emerald-700">{c.newText}</span></>}
                </li>
              ))}
            </ul>
          )}
          {entry.note && (
            <div className="mt-1 text-xs italic text-gray-600 ml-4">
              📝 {entry.note}
            </div>
          )}
        </div>
        <div className="text-[10px] text-gray-400 whitespace-nowrap">{timeStr}</div>
      </div>
    </div>
  );
}

export default function BillHistorySection({ billId, refreshKey = 0, userRole = "member" }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [show, setShow] = useState(false); // mặc định ẩn, bấm mới hiện

  useEffect(() => {
    // §6.2: guard member/boss — không fetch. Chỉ fetch khi đã mở (show).
    if (!billId || userRole === "member" || userRole === "boss" || !show) { return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchAuditLog({ entityType: "bill", entityId: billId })
      .then(rows => { if (!cancelled) setEntries(rows); })
      .catch(err => { if (!cancelled) setError(err.message || "Lỗi tải lịch sử"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [billId, refreshKey, userRole, show]);

  if (userRole === "member" || userRole === "boss") return null;
  if (!billId) return null;

  return (
    <div className="mt-4 bg-gray-50 border border-gray-200 rounded-lg p-3">
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="w-full text-sm font-bold text-gray-700 flex items-center gap-2 hover:text-orange-600"
      >
        <span className="text-gray-400">{show ? "▾" : "▸"}</span>
        📜 <span>Lịch sử đơn</span>
        {show && <span className="text-xs text-gray-400 font-normal">({entries.length})</span>}
      </button>
      {show && (
        <div className="mt-2">
          {loading && <div className="text-xs text-gray-500">Đang tải lịch sử...</div>}
          {error && <div className="text-xs text-red-500">Lỗi: {error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="text-xs text-gray-500 italic">Chưa có lịch sử cho đơn này.</div>
          )}
          {!loading && !error && entries.length > 0 && (
            <div className="space-y-2">
              {entries.map(e => <AuditEntry key={e.id} entry={e} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
