import React, { useState } from "react";
import { supabase, callAuthLogin } from "./supabaseClient";

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState("");
  // Gửi mail đặt lại mật khẩu về email quản trị đã đăng ký (không bắt gõ email).
  const [forgotMsg, setForgotMsg] = useState("");
  const [forgotSending, setForgotSending] = useState(false);
  const adminRecoveryEmail = import.meta.env.VITE_ADMIN_RECOVERY_EMAIL || "thanh.thao14190@gmail.com";

  const sendReset = async () => {
    setForgotMsg("");
    setForgotSending(true);
    try {
      await supabase.auth.resetPasswordForEmail(adminRecoveryEmail, { redirectTo: window.location.origin });
    } catch (_) { /* không tiết lộ lỗi */ }
    setForgotMsg("Đã gửi mail đặt lại cho Quản Trị Viên. Vui lòng kiểm tra hộp thư quản trị.");
    setForgotSending(false);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrMsg("");
    setLoading(true);

    try {
      const uname = username.trim().toLowerCase();
      if (!uname) throw new Error("Vui lòng nhập tên đăng nhập");

      // Đăng nhập qua Edge Function auth-login: server đếm số lần sai + khóa ở lần 3,
      // kiểm tra disabled/locked, rồi trả session + profile khi đúng.
      const result = await callAuthLogin(uname, password);
      if (!result.ok) {
        // Thông báo giữ nguyên câu từ server (đã ẩn thông tin nhạy cảm như số lần còn lại).
        throw new Error(result.error || "Tên đăng nhập hoặc mật khẩu không đúng");
      }

      const { access_token, refresh_token, profile } = result.data || {};
      if (!access_token || !refresh_token || !profile) {
        throw new Error("Đăng nhập lỗi: phản hồi không hợp lệ");
      }

      // Thiết lập session vào supabase client (JWT + refresh token) để mọi query sau có RLS.
      const { error: setErr } = await supabase.auth.setSession({ access_token, refresh_token });
      if (setErr) throw new Error("Không thiết lập được phiên đăng nhập: " + setErr.message);

      // Trả session lên App (giữ shape cũ)
      onLogin({
        id: profile.id,
        username: profile.username,
        full_name: profile.full_name,
        role: profile.role,
        branch_id: profile.branch_id,
        branch_code: profile.branch_code || "SG",
      });
    } catch (err) {
      setErrMsg(err.message || "Có lỗi xảy ra");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-orange-100 via-orange-50 to-yellow-50 p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-orange-100 overflow-hidden">
        <div className="bg-orange-800 text-white px-6 py-5">
          <h1 className="text-lg font-bold tracking-wide">🚚 VẬN TẢI HOÀN CẦU</h1>
          <p className="text-xs text-orange-200 mt-0.5">Hệ thống quản lý đơn hàng Sài Gòn - Gia Lai</p>
        </div>

        <div className="px-6 pt-5 pb-2">
          <h2 className="text-sm font-bold text-orange-700">🔐 Đăng nhập hệ thống</h2>
          <p className="text-[11px] text-gray-400 mt-0.5">Liên hệ quản trị viên để được cấp tài khoản.</p>
        </div>

        <form onSubmit={handleSubmit} className="p-6 pt-3 space-y-4">
          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">Tên đăng nhập *</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Tên đăng nhập"
              autoComplete="username"
              required
              className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:border-orange-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-600 mb-1">Mật khẩu *</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Mật khẩu"
              autoComplete="current-password"
              required
              className="w-full border rounded-lg px-3 py-2 text-sm outline-none focus:border-orange-500"
            />
          </div>

          {errMsg && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs font-semibold p-3 rounded-lg">
              ❌ {errMsg}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 text-white font-bold py-2.5 rounded-lg text-sm transition shadow"
          >
            {loading ? "⏳ Đang đăng nhập..." : "🔐 Đăng Nhập"}
          </button>
        </form>

        <div className="px-6 pb-3 text-center space-y-1.5">
          <p className="text-[11px] text-gray-500">
            Bạn cần đổi mật khẩu? <span className="text-gray-600 font-semibold">Liên hệ Quản Trị Viên hệ thống để đổi cho bạn.</span>
          </p>
          <button
            type="button"
            onClick={sendReset}
            disabled={forgotSending}
            className="text-[11px] text-orange-600 hover:underline font-semibold disabled:text-gray-400"
          >
            {forgotSending ? "⏳ Đang gửi..." : "Gửi mail cho Quản Trị Viên"}
          </button>
          {forgotMsg && <p className="text-[11px] text-emerald-700 font-semibold">{forgotMsg}</p>}
        </div>

        <div className="px-6 pb-5 text-center">
          <p className="text-[10px] text-gray-400">© 2026 Vận Tải Hoàn Cầu</p>
        </div>
      </div>
    </div>
  );
}
