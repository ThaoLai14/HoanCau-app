import React, { useState } from "react";
import { supabase } from "./supabaseClient";

export default function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    setErrMsg("");
    setLoading(true);

    try {
      const uname = username.trim().toLowerCase();
      if (!uname) throw new Error("Vui lòng nhập tên đăng nhập");
      const email = `${uname}@hoancau.internal`;

      // 1. Đăng nhập qua Supabase Auth (JWT + bcrypt server-side)
      const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (authError) {
        // Không tiết lộ user tồn tại hay không → luôn thông báo generic
        throw new Error("Tên đăng nhập hoặc mật khẩu không đúng");
      }

      // 2. Fetch profile từ public.profiles (RLS cho phép user đọc profile của mình)
      const authUserId = authData.user?.id;
      if (!authUserId) throw new Error("Đăng nhập lỗi: không có user id");

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, username, full_name, role, branch_id, is_disabled, is_deleted, branches(branch_code)")
        .eq("id", authUserId)
        .maybeSingle();

      if (profileError) throw profileError;
      if (!profile) {
        // Auth user tồn tại nhưng thiếu profile → trigger fail hoặc metadata sai
        await supabase.auth.signOut();
        throw new Error("Tài khoản chưa được cấu hình. Liên hệ quản trị viên.");
      }
      // Chặn user bị disabled/deleted không đăng nhập được
      if (profile.is_disabled || profile.is_deleted) {
        await supabase.auth.signOut();
        throw new Error("Tài khoản của bạn đã bị vô hiệu hóa. Liên hệ quản trị viên.");
      }

      // 3. Trả session lên App (giữ shape cũ để tối thiểu diff)
      onLogin({
        id: profile.id,
        username: profile.username,
        full_name: profile.full_name,
        role: profile.role,
        branch_id: profile.branch_id,
        branch_code: profile.branches?.branch_code || "SG",
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

        <div className="px-6 pb-5 text-center">
          <p className="text-[10px] text-gray-400">© 2026 Vận Tải Hoàn Cầu</p>
        </div>
      </div>
    </div>
  );
}
