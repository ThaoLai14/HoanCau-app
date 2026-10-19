// src/ExpenseHistorySection.jsx
// Section lịch sử audit CHUNG cho toàn bộ phiếu chi trong kỳ đang xem (ngày/tháng/năm) ở màn Doanh Thu.
// Không gắn theo từng phiếu chi riêng lẻ — nếu không, khi phiếu chi bị xoá thì hàng biến mất
// khỏi bảng danh sách và mất luôn lối vào xem lịch sử (bug đã bị user phát hiện).
// Data (entries/loading/error) được fetch ở App.jsx (cần join sang bảng expenses để lọc branch,
// kể cả phiếu đã xoá mềm) rồi truyền props xuống đây, component này chỉ lo hiển thị.

import React from "react";
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
            <span className="text-gray-700"> {meta.text}</span>
          </div>
          {entry.entity_label && (
            <div className="text-xs text-gray-500 mt-0.5">🧾 {entry.entity_label}</div>
          )}
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

export default function ExpenseHistorySection({ entries = [], loading = false, error = null, title = "Lịch sử phiếu chi" }) {
  const [show, setShow] = React.useState(false); // mặc định ẩn, bấm mới hiện
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
      <button
        type="button"
        onClick={() => setShow(s => !s)}
        className="w-full text-xs font-bold text-gray-700 flex items-center gap-2 hover:text-orange-600"
      >
        <span className="text-gray-400">{show ? "▾" : "▸"}</span>
        📜 <span>{title}</span>
        {show && <span className="text-[10px] text-gray-400 font-normal">({entries.length})</span>}
      </button>
      {show && (
        <div className="mt-2">
          {loading && <div className="text-xs text-gray-500">Đang tải lịch sử...</div>}
          {error && <div className="text-xs text-red-500">Lỗi: {error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="text-xs text-gray-500 italic">Chưa có thao tác thêm/sửa/xoá phiếu chi nào trong kỳ này.</div>
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

