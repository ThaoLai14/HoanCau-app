import { useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

/**
 * SessionMonitor — component gọn, mount 1 lần khi user đã login.
 *
 * Chức năng:
 *   1. Track thời điểm tương tác gần nhất (mousemove/keydown/click).
 *   2. Interval 30s check:
 *      - Idle timeout: sys_admin 15 phút, role khác 8 giờ → force logout.
 *      - Disabled/deleted: gọi RPC `current_role()`; nếu trả NULL → force logout.
 *
 * Props:
 *   - session: { id, role, ... } — session hiện tại
 *   - onForceLogout: (reason: string) => void — callback được gọi khi cần logout.
 *                    Handler nên gọi supabase.auth.signOut() + hiển thị toast.
 */
export default function SessionMonitor({ session, onForceLogout }) {
  const lastInteractionRef = useRef(Date.now());
  const alreadyLoggedOutRef = useRef(false);

  useEffect(() => {
    if (!session?.id) return;

    // Reset trạng thái mỗi khi session mới đăng nhập
    alreadyLoggedOutRef.current = false;
    lastInteractionRef.current = Date.now();

    // Attach event listeners cho interaction
    const bumpActivity = () => {
      lastInteractionRef.current = Date.now();
    };
    const events = ["mousemove", "keydown", "click", "touchstart"];
    events.forEach((ev) => window.addEventListener(ev, bumpActivity, { passive: true }));

    // Idle timeout theo role
    const IDLE_MS =
      session.role === "sys_admin" ? 15 * 60 * 1000 : 8 * 60 * 60 * 1000;

    const forceLogout = (reason) => {
      if (alreadyLoggedOutRef.current) return;
      alreadyLoggedOutRef.current = true;
      onForceLogout?.(reason);
    };

    // Interval 30s check
    const interval = setInterval(async () => {
      if (alreadyLoggedOutRef.current) return;

      // Check idle
      const now = Date.now();
      if (now - lastInteractionRef.current > IDLE_MS) {
        forceLogout("Phiên đăng nhập hết hạn do không hoạt động");
        return;
      }

      // Check disabled/deleted qua current_role()
      try {
        const { data, error } = await supabase.rpc("current_role");
        if (error) {
          // Nếu error là do permission → session không hợp lệ, logout
          if (error.code === "PGRST301" || /permission/i.test(error.message || "")) {
            forceLogout("Tài khoản của bạn đã bị vô hiệu hóa");
          }
          // Các error khác (network) → bỏ qua, thử lại tick sau
          return;
        }
        if (data === null || data === undefined) {
          // current_role() trả NULL = user đã bị disable/delete
          forceLogout("Tài khoản của bạn đã bị vô hiệu hóa");
        }
      } catch (_err) {
        // Network fail — bỏ qua
      }
    }, 30 * 1000);

    return () => {
      clearInterval(interval);
      events.forEach((ev) => window.removeEventListener(ev, bumpActivity));
    };
  }, [session?.id, session?.role, onForceLogout]);

  return null;
}
