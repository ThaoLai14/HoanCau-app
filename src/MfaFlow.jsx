import React, { useEffect, useState, useCallback, useRef } from "react";
import { supabase, callAdminUsers, callMfaRecovery } from "./supabaseClient";

/**
 * MfaFlow — full-screen flow bắt buộc sys_admin enroll TOTP + verify aal2.
 *
 * States (state machine):
 *   - checking      : đang check factors + aal
 *   - need_enroll   : chưa có factor → show QR + verify
 *   - show_codes    : sau enroll → hiển thị 8 recovery codes (1 lần)
 *   - need_verify   : có factor nhưng aal1 → nhập TOTP
 *   - recovery      : user chọn dùng recovery code thay TOTP
 *   - done          : aal2 OK → onComplete()
 *   - error         : lỗi hệ thống, show retry
 *
 * Non-sys_admin: skip toàn bộ (return null).
 */
export default function MfaFlow({ session, onComplete, showToast }) {
  const [state, setState] = useState("checking");
  const [factorId, setFactorId] = useState(null);
  const [enrollment, setEnrollment] = useState(null); // { qr_code, secret, factorId }
  const [codes, setCodes] = useState(null);

  const isSysAdmin = session?.role === "sys_admin";

  const detect = useCallback(async () => {
    if (!isSysAdmin) {
      onComplete?.();
      return;
    }
    setState("checking");
    try {
      const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (aalData?.currentLevel === "aal2") {
        setState("done");
        onComplete?.();
        return;
      }
      const { data: factorData } = await supabase.auth.mfa.listFactors();
      const totpFactors = factorData?.totp || [];
      const verified = totpFactors.find((f) => f.status === "verified");
      if (!verified) {
        // Chưa enroll → enroll
        setState("need_enroll");
        return;
      }
      // Có factor, cần verify TOTP
      setFactorId(verified.id);
      setState("need_verify");
    } catch (err) {
      showToast?.("Lỗi check MFA: " + (err?.message || err), "error");
      setState("error");
    }
  }, [isSysAdmin, onComplete, showToast]);

  useEffect(() => {
    detect();
  }, [detect]);

  if (!isSysAdmin || state === "done") return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[200] p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {state === "checking" && (
          <div className="p-8 text-center text-sm text-gray-500 animate-pulse">
            ⏳ Đang kiểm tra...
          </div>
        )}
        {state === "need_enroll" && (
          <EnrollStep
            onEnrolled={(cs, fid) => {
              setCodes(cs);
              setFactorId(fid);
              setState("show_codes");
            }}
            showToast={showToast}
          />
        )}
        {state === "show_codes" && codes && (
          <ShowCodesStep
            codes={codes}
            onAcknowledged={() => {
              onComplete?.();
              setState("done");
            }}
          />
        )}
        {state === "need_verify" && factorId && (
          <VerifyStep
            factorId={factorId}
            onVerified={() => {
              onComplete?.();
              setState("done");
            }}
            onRecoveryLink={() => setState("recovery")}
            showToast={showToast}
          />
        )}
        {state === "recovery" && (
          <RecoveryStep
            onSuccess={() => {
              // Sau recovery: user cần re-login + enroll lại TOTP.
              // Force logout để reset session.
              showToast?.(
                "Recovery thành công. Vui lòng đăng nhập lại để enroll TOTP mới.",
                "success",
              );
              supabase.auth.signOut();
              // App sẽ tự về LoginScreen qua session listener
            }}
            onBack={() => setState("need_verify")}
            showToast={showToast}
          />
        )}
        {state === "error" && (
          <div className="p-8 text-center space-y-3">
            <p className="text-sm text-red-600">Có lỗi xảy ra, vui lòng thử lại.</p>
            <button
              type="button"
              onClick={detect}
              className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 rounded"
            >
              Thử lại
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Step: Enroll TOTP
// =============================================================================
function EnrollStep({ onEnrolled, showToast }) {
  const [enrollment, setEnrollment] = useState(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [initing, setIniting] = useState(true);
  const enrollGuardRef = useRef(false); // Chống StrictMode gọi effect 2 lần

  useEffect(() => {
    if (enrollGuardRef.current) return;
    enrollGuardRef.current = true;
    (async () => {
      setIniting(true);
      // Cleanup: unenroll các factor cũ chưa verify (từ lần enroll dở dang trước).
      try {
        const { data: existing } = await supabase.auth.mfa.listFactors();
        const all = existing?.all || existing?.totp || [];
        const stale = all.filter((f) => f.status !== "verified");
        for (const f of stale) {
          await supabase.auth.mfa.unenroll({ factorId: f.id });
        }
      } catch (_) {
        // Không block enroll nếu cleanup fail
      }
      // FriendlyName phải unique — tránh collision (StrictMode + retry).
      const uniqueName = `HoanCau Auth ${crypto.randomUUID().slice(0, 8)}`;
      const { data, error } = await supabase.auth.mfa.enroll({
        factorType: "totp",
        friendlyName: uniqueName,
      });
      if (error || !data) {
        showToast?.("Lỗi enroll: " + (error?.message || "unknown"), "error");
        setIniting(false);
        enrollGuardRef.current = false; // Cho phép retry
        return;
      }
      setEnrollment({
        id: data.id,
        qrCode: data.totp?.qr_code,
        secret: data.totp?.secret,
      });
      setIniting(false);
    })();
  }, [showToast]);

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      showToast?.("Mã TOTP phải là 6 số", "error");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: enrollment.id,
      code,
    });
    if (error) {
      showToast?.("Verify thất bại: " + error.message, "error");
      setSubmitting(false);
      return;
    }
    // Enroll OK → sinh recovery codes
    const rc = await callAdminUsers({ action: "generate_recovery_codes" });
    setSubmitting(false);
    if (!rc.ok || !rc.data?.codes) {
      showToast?.("Không sinh được recovery codes: " + (rc.error || "unknown"), "error");
      // Vẫn tiếp tục — user có thể regenerate sau
      onEnrolled([], enrollment.id);
      return;
    }
    onEnrolled(rc.data.codes, enrollment.id);
  };

  if (initing) {
    return (
      <div className="p-8 text-center text-sm text-gray-500 animate-pulse">
        ⏳ Đang tạo QR code...
      </div>
    );
  }
  if (!enrollment) {
    return <div className="p-8 text-center text-sm text-red-600">Không tạo được QR code.</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="text-center">
        <h3 className="text-lg font-bold text-purple-800">🔐 Enroll MFA cho Sys_admin</h3>
        <p className="text-xs text-gray-500 mt-1">
          Sys_admin bắt buộc bật 2FA. Scan QR bằng Google Authenticator / Authy / 1Password.
        </p>
      </div>

      <div className="flex justify-center bg-white border-2 border-purple-200 rounded p-4">
        {enrollment.qrCode ? (
          <img
            src={enrollment.qrCode}
            alt="TOTP QR code"
            className="w-48 h-48"
            style={{ imageRendering: "pixelated" }}
          />
        ) : (
          <p className="text-xs text-red-600">QR code không hiển thị được.</p>
        )}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-gray-500">Nhập tay (không dùng QR)</summary>
        <div className="mt-2 bg-gray-100 p-2 rounded font-mono text-[11px] break-all">
          {enrollment.secret}
        </div>
      </details>

      <form onSubmit={handleVerify} className="space-y-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập mã TOTP hiện tại từ authenticator (6 số)
          </label>
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="123456"
            className="w-full border-2 rounded-lg px-4 py-3 text-2xl text-center font-mono tracking-widest outline-none focus:border-purple-500"
            autoFocus
          />
        </div>
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
        >
          {submitting ? "⏳ Đang verify..." : "✅ Verify + Enroll"}
        </button>
      </form>
    </div>
  );
}

// =============================================================================
// Step: Show recovery codes
// =============================================================================
function ShowCodesStep({ codes, onAcknowledged }) {
  const [ack, setAck] = useState(false);
  return (
    <div className="p-6 space-y-4">
      <h3 className="text-lg font-bold text-purple-800">🎉 Enroll thành công!</h3>
      <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-800">
        ⚠️ <b>QUAN TRỌNG:</b> 8 recovery codes này chỉ hiển thị 1 LẦN duy nhất. Lưu ngay vào
        password manager hoặc in ra giấy. Dùng khi mất điện thoại authenticator.
      </div>
      <div className="bg-gray-900 text-emerald-300 rounded p-3 font-mono text-sm space-y-1">
        {codes.length > 0 ? (
          codes.map((c, i) => (
            <div key={i}>
              {String(i + 1).padStart(2, "0")}. {c}
            </div>
          ))
        ) : (
          <div className="text-yellow-300">Không có codes (regenerate qua Tài khoản của tôi).</div>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
          className="accent-purple-600 w-4 h-4"
        />
        <span>Tôi đã lưu tất cả recovery codes ở nơi an toàn</span>
      </label>
      <button
        type="button"
        onClick={onAcknowledged}
        disabled={!ack}
        className="w-full px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
      >
        Đã lưu — vào app
      </button>
    </div>
  );
}

// =============================================================================
// Step: Verify TOTP
// =============================================================================
function VerifyStep({ factorId, onVerified, onRecoveryLink, showToast }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return;
    setSubmitting(true);
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
    setSubmitting(false);
    if (error) {
      showToast?.("TOTP không đúng: " + error.message, "error");
      setCode("");
      return;
    }
    onVerified();
  };

  return (
    <div className="p-6 space-y-4">
      <div className="text-center">
        <h3 className="text-lg font-bold text-purple-800">🔐 Xác thực</h3>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          className="w-full border-2 rounded-lg px-4 py-3 text-2xl text-center font-mono tracking-widest outline-none focus:border-purple-500"
          autoFocus
        />
        <button
          type="submit"
          disabled={submitting || code.length !== 6}
          className="w-full px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
        >
          {submitting ? "⏳ Verify..." : "✅ Xác nhận"}
        </button>
        <div className="text-center">
          <button
            type="button"
            onClick={onRecoveryLink}
            className="text-xs text-blue-600 hover:underline"
          >
            Mất điện thoại? Dùng recovery code
          </button>
        </div>
      </form>
    </div>
  );
}

// =============================================================================
// Step: Recovery code
// =============================================================================
function RecoveryStep({ onSuccess, onBack, showToast }) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    const res = await callMfaRecovery(code.trim().toLowerCase());
    setSubmitting(false);
    if (res.ok) {
      onSuccess();
    } else {
      showToast?.("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <div className="p-6 space-y-4">
      <div className="text-center">
        <h3 className="text-lg font-bold text-purple-800">🆘 Dùng Recovery Code</h3>
        <p className="text-xs text-gray-500 mt-1">
          Nhập 1 recovery code còn khả dụng (dạng <span className="font-mono">xxxx-xxxxx</span>).
        </p>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="xk3h-9m2pr"
          className="w-full border-2 rounded-lg px-4 py-3 text-lg text-center font-mono outline-none focus:border-purple-500"
          autoFocus
        />
        <button
          type="submit"
          disabled={submitting || !code.trim()}
          className="w-full px-4 py-2 text-sm font-bold text-white bg-purple-600 hover:bg-purple-700 disabled:bg-gray-300 rounded"
        >
          {submitting ? "⏳ Verify..." : "🆘 Dùng recovery code"}
        </button>
        <button
          type="button"
          onClick={onBack}
          className="w-full text-xs text-gray-500 hover:underline"
        >
          ← Quay lại nhập TOTP
        </button>
      </form>
    </div>
  );
}
