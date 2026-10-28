import React, { useState, useEffect } from "react";
import { supabase } from "./supabaseClient";

// Màn đặt lại mật khẩu — hiện khi user mở app từ link "quên mật khẩu" (Supabase PASSWORD_RECOVERY).
export default function ResetPasswordScreen({ onDone }) {
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const [needMfa, setNeedMfa] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);

  // Nếu tài khoản bật 2FA → đổi mật khẩu đòi phiên AAL2. Link recovery chỉ cho AAL1 →
  // phải nhập mã TOTP để nâng lên AAL2 trước khi updateUser.
  useEffect(() => {
    (async () => {
      try {
        const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (data?.nextLevel === "aal2" && data?.currentLevel !== "aal2") setNeedMfa(true);
      } catch (_) { /* ignore */ }
    })();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (next.length < 8) { setErr("Mật khẩu mới phải từ 8 ký tự trở lên"); return; }
    if (next !== confirm) { setErr("Xác nhận mật khẩu không khớp"); return; }
    setLoading(true);
    try {
      // Có 2FA → nâng phiên lên AAL2 bằng mã TOTP trước khi đổi mật khẩu.
      if (needMfa) {
        const code = mfaCode.trim();
        if (!/^\d{6}$/.test(code)) { setErr("Nhập mã 2FA gồm 6 chữ số"); return; }
        const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
        if (fErr) { setErr("Lỗi 2FA: " + fErr.message); return; }
        const totp = factors?.totp?.[0];
        if (!totp) { setErr("Không tìm thấy thiết bị 2FA của tài khoản này."); return; }
        const { data: ch, error: cErr } = await supabase.auth.mfa.challenge({ factorId: totp.id });
        if (cErr) { setErr("Lỗi 2FA: " + cErr.message); return; }
        const { error: vErr } = await supabase.auth.mfa.verify({ factorId: totp.id, challengeId: ch.id, code });
        if (vErr) { setErr("Mã 2FA không đúng. Thử lại."); return; }
      }
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) { setErr("Lỗi đặt mật khẩu: " + error.message); return; }
      await supabase.auth.signOut();
      setDone(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-100 via-orange-50 to-yellow-50 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-orange-100 overflow-hidden">
        <div className="bg-orange-800 text-white px-6 py-5">
          <h1 className="text-lg font-bold tracking-wide">🔑 Đặt lại mật khẩu</h1>
          <p className="text-xs text-orange-200 mt-0.5">Nhập mật khẩu mới cho tài khoản của bạn.</p>
        </div>

        {done ? (
          <div className="p-6 space-y-4 text-center">
            <p className="text-sm text-emerald-700 font-semibold">✅ Đã đặt lại mật khẩu thành công.</p>
            <button
              type="button"
              onClick={() => onDone?.()}
              className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2.5 rounded-lg text-sm"
            >
              Về trang đăng nhập
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-6 space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-600 mb-1">Mật khẩu mới *</label>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="Tối thiểu 8 ký tự"
                autoComplete="new-password"
                required
                className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-600 mb-1">Xác nhận mật khẩu *</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Nhập lại mật khẩu mới"
                autoComplete="new-password"
                required
                className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
              />
            </div>
            {needMfa && (
              <div>
                <label className="block text-xs font-bold text-gray-600 mb-1">Mã 2FA (6 số) *</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="Mã trên app xác thực"
                  autoComplete="one-time-code"
                  className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500 tracking-[0.3em] font-mono text-center"
                />
                <p className="text-[11px] text-gray-400 mt-1">Tài khoản có bật 2FA — nhập mã để xác nhận đổi mật khẩu.</p>
              </div>
            )}
            {err && <p className="text-xs text-red-600 font-semibold">{err}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-orange-600 hover:bg-orange-700 text-white font-bold py-2.5 rounded-lg text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loading ? "⏳ Đang lưu..." : "💾 Đặt lại mật khẩu"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
