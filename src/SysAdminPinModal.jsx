import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from "react";
import { callAdminUsers } from "./supabaseClient";
import { setPinRequestFn } from "./pinGateStore";

/**
 * PIN gate cho sys_admin trên business screens.
 *
 * Sys_admin có RLS quyền edit toàn bộ business data (bill, expense, client, ...).
 * Nhưng UI bắt buộc nhập PIN 6 số trước khi cho phép mutation, TTL 5 phút.
 * → Tránh sys_admin bấm nhầm sửa data.
 *
 * Cách dùng:
 *   1. Wrap App tree với <SysAdminPinProvider session={session} showToast={...}>.
 *   2. Trong handler bất kỳ (bill update, expense delete, ...):
 *        const requirePin = useSysAdminUnlock();
 *        async function handleEdit() {
 *          if (!(await requirePin())) return;  // user cancel hoặc PIN sai
 *          // proceed with mutation
 *        }
 *
 * Nếu session.role != 'sys_admin', requirePin() trả true ngay (không gate).
 */

const UNLOCK_TTL_MS = 5 * 60 * 1000; // 5 phút
const MAX_ATTEMPTS = 3;
const LOCK_DURATION_MS = 5 * 60 * 1000; // Lock modal 5 phút sau 3 lần sai

const PinContext = createContext(null);

export function SysAdminPinProvider({ session, showToast, children }) {
  const [modalState, setModalState] = useState(null);
  // modalState = { resolve, reject } khi mở modal, null khi đóng.

  const [unlockedAt, setUnlockedAt] = useState(0);
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  // Auto-reset unlocked flag sau TTL
  useEffect(() => {
    if (unlockedAt === 0) return;
    const t = setTimeout(() => setUnlockedAt(0), UNLOCK_TTL_MS);
    return () => clearTimeout(t);
  }, [unlockedAt]);

  const isUnlocked = useCallback(() => {
    return unlockedAt > 0 && Date.now() - unlockedAt < UNLOCK_TTL_MS;
  }, [unlockedAt]);

  /**
   * Yêu cầu unlock. Trả Promise<boolean>:
   *   - Nếu role != sys_admin → true ngay
   *   - Nếu đang unlock trong TTL → true ngay
   *   - Nếu chưa/hết TTL → mở modal, user nhập PIN → true nếu OK, false nếu cancel/sai
   */
  const requireUnlock = useCallback(async () => {
    if (session?.role !== "sys_admin") return true;
    if (isUnlocked()) return true;
    return new Promise((resolve) => {
      setModalState({ resolve });
    });
  }, [session, isUnlocked]);

  // Register callback vào module store để handlers ngoài React tree gọi được.
  useEffect(() => {
    setPinRequestFn(requireUnlock);
    return () => setPinRequestFn(null);
  }, [requireUnlock]);

  const handleClose = (result) => {
    if (modalState?.resolve) modalState.resolve(result);
    setModalState(null);
  };

  const handleSubmitPin = async (pin) => {
    if (Date.now() < lockedUntil) {
      showToast?.("Modal đang bị khóa. Vui lòng thử lại sau.", "error");
      return;
    }
    const res = await callAdminUsers({ action: "verify_pin", pin });
    if (res.ok && res.data?.success) {
      setUnlockedAt(Date.now());
      setAttempts(0);
      handleClose(true);
      return;
    }
    // Sai
    const newAttempts = attempts + 1;
    setAttempts(newAttempts);
    if (newAttempts >= MAX_ATTEMPTS) {
      const until = Date.now() + LOCK_DURATION_MS;
      setLockedUntil(until);
      setAttempts(0);
      showToast?.("Sai PIN 3 lần liên tiếp. Modal khóa 5 phút.", "error");
      handleClose(false);
      return;
    }
    showToast?.(
      `PIN sai (còn ${MAX_ATTEMPTS - newAttempts} lần)`,
      "error",
    );
  };

  return (
    <PinContext.Provider value={requireUnlock}>
      {children}
      {modalState && (
        <SysAdminPinModal
          onSubmit={handleSubmitPin}
          onCancel={() => handleClose(false)}
          attempts={attempts}
          maxAttempts={MAX_ATTEMPTS}
          lockedUntil={lockedUntil}
        />
      )}
    </PinContext.Provider>
  );
}

export function useSysAdminUnlock() {
  const require = useContext(PinContext);
  if (!require) {
    // Fallback: không có provider (VD chưa login) → không gate
    return async () => true;
  }
  return require;
}

// =============================================================================
// Modal
// =============================================================================
function SysAdminPinModal({ onSubmit, onCancel, attempts, maxAttempts, lockedUntil }) {
  const [pin, setPin] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Countdown timer khi lock
  useEffect(() => {
    if (Date.now() >= lockedUntil) {
      setCountdown(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, lockedUntil - Date.now());
      setCountdown(remaining);
      if (remaining <= 0) return;
      return setTimeout(tick, 1000);
    };
    const t = tick();
    return () => t && clearTimeout(t);
  }, [lockedUntil]);

  const isLocked = countdown > 0;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (isLocked || pin.length !== 6) return;
    setSubmitting(true);
    await onSubmit(pin);
    setSubmitting(false);
    setPin("");
  };

  const mmss = (ms) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[100] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm">
        <div className="px-5 py-3 border-b bg-purple-50 rounded-t-xl">
          <h3 className="font-bold text-sm text-purple-800 flex items-center gap-2">
            🔐 Xác thực bổ sung
          </h3>
          <p className="text-[11px] text-purple-600 mt-0.5">
            Nhập PIN 6 số của sys_admin để mở khóa thao tác sửa data.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {isLocked ? (
            <div className="bg-red-50 border border-red-200 rounded p-3 text-center text-sm text-red-800">
              🔒 Modal đã bị khóa do sai PIN nhiều lần.
              <br />
              <b className="text-lg font-mono">{mmss(countdown)}</b>
            </div>
          ) : (
            <div>
              <input
                ref={inputRef}
                type="password"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="••••••"
                disabled={submitting}
                autoComplete="off"
                className="w-full border-2 rounded-lg px-4 py-3 text-2xl text-center font-mono tracking-widest outline-none focus:border-purple-500"
              />
              {attempts > 0 && (
                <p className="text-[11px] text-red-600 mt-2 text-center">
                  Sai PIN ({attempts}/{maxAttempts})
                </p>
              )}
            </div>
          )}
          <div className="flex justify-between items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-semibold text-gray-700 border rounded hover:bg-gray-50"
            >
              Hủy
            </button>
            <button
              type="submit"
              disabled={submitting || isLocked || pin.length !== 6}
              className="px-5 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
            >
              {submitting ? "⏳ Kiểm tra..." : "🔓 Mở khóa"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
