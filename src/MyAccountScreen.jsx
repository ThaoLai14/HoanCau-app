import React, { useState, useEffect } from "react";
import { supabase, callAdminUsers } from "./supabaseClient";

/**
 * Screen "Tài khoản của tôi" — mọi role đều thấy.
 * Sections:
 *   - Thông tin (readonly)
 *   - Đổi mật khẩu (mọi role)
 *   - Đổi PIN (chỉ sys_admin)
 *   - MFA (chỉ sys_admin) — regenerate recovery codes
 */
export default function MyAccountScreen({ session, showToast }) {
  const isSysAdmin = session?.role === "sys_admin";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
        <div className="flex items-center gap-3">
          <span className="text-2xl">👤</span>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Tài khoản của tôi</h2>
            <p className="text-xs text-gray-500">
              Xem thông tin cá nhân và đổi mật khẩu / PIN / MFA.
            </p>
          </div>
        </div>
      </div>

      {/* Thông tin */}
      <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
        <h3 className="text-sm font-bold text-gray-800 mb-3 border-b pb-2">📋 Thông tin</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
          <InfoField label="Username" value={session?.username} mono />
          <InfoField label="Họ tên" value={session?.full_name} />
          <InfoField label="Role" value={session?.role} mono />
          <InfoField label="Chi nhánh" value={session?.branch_code} mono />
          <InfoField label="Email nội bộ" value={`${session?.username}@hoancau.internal`} mono />
        </div>
      </div>

      {/* Đổi mật khẩu */}
      <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
        <ChangePasswordSection session={session} showToast={showToast} />
      </div>

      {/* Đổi PIN — chỉ sys_admin */}
      {isSysAdmin && (
        <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
          <ChangePinSection session={session} showToast={showToast} />
        </div>
      )}

      {/* MFA — chỉ sys_admin */}
      {isSysAdmin && (
        <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
          <MfaSection session={session} showToast={showToast} />
        </div>
      )}
    </div>
  );
}

function InfoField({ label, value, mono }) {
  return (
    <div>
      <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">{label}</p>
      <p className={`text-sm font-medium text-gray-900 ${mono ? "font-mono" : ""}`}>
        {value || "—"}
      </p>
    </div>
  );
}

// =============================================================================
// Đổi mật khẩu
// =============================================================================
function ChangePasswordSection({ session, showToast }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (next.length < 8) {
      showToast("Password mới phải >= 8 ký tự", "error");
      return;
    }
    if (next !== confirm) {
      showToast("Password confirm không khớp", "error");
      return;
    }
    if (next === current) {
      showToast("Password mới phải khác password cũ", "error");
      return;
    }
    setSubmitting(true);
    try {
      // 1. Verify current password bằng re-signin
      const email = `${session.username}@hoancau.internal`;
      const { error: verifyErr } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      });
      if (verifyErr) {
        showToast("Password hiện tại không đúng", "error");
        return;
      }
      // 2. Đổi password
      const { error: updErr } = await supabase.auth.updateUser({ password: next });
      if (updErr) {
        showToast("Lỗi đổi password: " + updErr.message, "error");
        return;
      }
      showToast("Đã đổi mật khẩu thành công", "success");
      setCurrent("");
      setNext("");
      setConfirm("");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-bold text-gray-800 mb-3 border-b pb-2">🔑 Đổi mật khẩu</h3>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Mật khẩu hiện tại
          </label>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Mật khẩu mới * (≥ 8 ký tự)
          </label>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            minLength={8}
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập lại mật khẩu mới *
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 rounded"
        >
          {submitting ? "⏳ Đang lưu..." : "💾 Đổi mật khẩu"}
        </button>
      </form>
    </div>
  );
}

// =============================================================================
// Đổi PIN (sys_admin only)
// =============================================================================
function ChangePinSection({ session, showToast }) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(newPin)) {
      showToast("PIN mới phải là 6 chữ số", "error");
      return;
    }
    if (newPin !== confirmPin) {
      showToast("PIN confirm không khớp", "error");
      return;
    }
    setSubmitting(true);
    const res = await callAdminUsers({
      action: "set_pin",
      new_pin: newPin,
      old_pin: oldPin || undefined,
    });
    setSubmitting(false);
    if (res.ok) {
      showToast("Đã đổi PIN thành công", "success");
      setOldPin("");
      setNewPin("");
      setConfirmPin("");
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <div>
      <h3 className="text-sm font-bold text-gray-800 mb-3 border-b pb-2">🔐 Đổi PIN (sys_admin)</h3>
      <div className="bg-purple-50 border border-purple-200 rounded p-3 text-[11px] text-purple-800 mb-3">
        PIN dùng để mở khóa quyền sửa data business khi thao tác trên các screen khác (bill,
        expense...). Khi mở khóa thành công, quyền unlock có TTL 5 phút.
      </div>
      <form onSubmit={handleSubmit} className="space-y-3 max-w-md">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            PIN cũ (bỏ trống nếu chưa cài)
          </label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={oldPin}
            onChange={(e) => setOldPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-purple-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            PIN mới * (6 chữ số)
          </label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={newPin}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-purple-500 font-mono"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập lại PIN mới *
          </label>
          <input
            type="password"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={confirmPin}
            onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-purple-500 font-mono"
          />
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
        >
          {submitting ? "⏳ Đang lưu..." : "💾 Đổi PIN"}
        </button>
      </form>
    </div>
  );
}

// =============================================================================
// MFA management (sys_admin only)
// =============================================================================
function MfaSection({ session, showToast }) {
  const [factors, setFactors] = useState([]);
  const [remainingCodes, setRemainingCodes] = useState(null);
  const [loading, setLoading] = useState(true);

  // Regenerate flow
  const [regenerating, setRegenerating] = useState(false);
  const [newCodes, setNewCodes] = useState(null);
  const [ackSaved, setAckSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data: mfaData } = await supabase.auth.mfa.listFactors();
      setFactors(mfaData?.totp || []);
    } catch {
      setFactors([]);
    }
    // Count remaining recovery codes qua supabase (RLS cho phép user đọc của mình)
    const { count } = await supabase
      .from("mfa_recovery_codes")
      .select("id", { count: "exact", head: true })
      .is("used_at", null);
    setRemainingCodes(count ?? 0);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleRegenerate = async () => {
    if (
      !window.confirm(
        "Sinh 8 recovery codes mới sẽ VÔ HIỆU HÓA toàn bộ codes cũ. Chỉ xem được 1 lần. Tiếp tục?",
      )
    ) return;
    setRegenerating(true);
    const res = await callAdminUsers({ action: "generate_recovery_codes" });
    setRegenerating(false);
    if (res.ok && res.data?.codes) {
      setNewCodes(res.data.codes);
      setAckSaved(false);
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  const handleCloseCodesModal = () => {
    if (!ackSaved) return;
    setNewCodes(null);
    load();
    showToast("Đã lưu recovery codes mới", "success");
  };

  return (
    <div>
      <h3 className="text-sm font-bold text-gray-800 mb-3 border-b pb-2">🔒 MFA (sys_admin)</h3>

      {loading ? (
        <p className="text-sm text-gray-500 animate-pulse">⏳ Đang tải...</p>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="bg-gray-50 border rounded p-3">
              <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">TOTP Factors</p>
              {factors.length === 0 ? (
                <p className="text-xs text-red-600">
                  ⚠️ Chưa enroll TOTP. Vui lòng logout và login lại — app sẽ force enroll.
                </p>
              ) : (
                <ul className="text-xs space-y-1">
                  {factors.map((f) => (
                    <li key={f.id} className="font-mono">
                      ✅ {f.friendly_name || "TOTP"}{" "}
                      <span className="text-gray-500">
                        (enrolled {new Date(f.created_at).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="bg-gray-50 border rounded p-3">
              <p className="text-[10px] font-bold text-gray-500 uppercase mb-1">Recovery codes</p>
              <p className="text-lg font-bold">
                {remainingCodes} <span className="text-xs text-gray-500 font-normal">còn khả dụng</span>
              </p>
              {remainingCodes !== null && remainingCodes <= 3 && remainingCodes > 0 && (
                <p className="text-[11px] text-amber-700 mt-1">
                  ⚠️ Sắp hết codes. Nên regenerate.
                </p>
              )}
              {remainingCodes === 0 && (
                <p className="text-[11px] text-red-700 mt-1">
                  ⚠️ Không còn code. Nếu mất TOTP sẽ kẹt.
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleRegenerate}
            disabled={regenerating}
            className="px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
          >
            {regenerating ? "⏳ Đang sinh..." : "🔄 Sinh 8 recovery codes mới"}
          </button>
        </div>
      )}

      {/* Modal hiển thị codes mới */}
      {newCodes && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-5 space-y-4">
            <h3 className="text-lg font-bold text-purple-800">🔐 Recovery Codes Mới</h3>
            <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-800">
              ⚠️ <b>QUAN TRỌNG:</b> Codes này chỉ hiển thị 1 LẦN duy nhất. Lưu ngay vào password
              manager hoặc in ra giấy. Mất codes = không thể recover MFA.
            </div>
            <div className="bg-gray-900 text-emerald-300 rounded p-3 font-mono text-sm space-y-1">
              {newCodes.map((c, i) => (
                <div key={i}>
                  {String(i + 1).padStart(2, "0")}. {c}
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={ackSaved}
                onChange={(e) => setAckSaved(e.target.checked)}
                className="accent-purple-600 w-4 h-4"
              />
              <span>Tôi đã lưu tất cả 8 codes ở nơi an toàn</span>
            </label>
            <button
              type="button"
              onClick={handleCloseCodesModal}
              disabled={!ackSaved}
              className="w-full px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
            >
              Đã lưu — đóng
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
