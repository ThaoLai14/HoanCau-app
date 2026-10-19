// =============================================================================
// mfa-recovery Edge Function
// =============================================================================
// Deploy: npx supabase functions deploy mfa-recovery --no-verify-jwt
//
// Endpoint: POST /mfa-recovery
// Body: { code: '<10-char-recovery-code>' }
// Headers: Authorization: Bearer <user_jwt_aal1>
//
// Flow:
//   1. User login normal (aal1) — password ok, chưa qua MFA.
//   2. Gọi endpoint này với recovery code thay TOTP.
//   3. Server bcrypt-compare code với mfa_recovery_codes chưa dùng của user.
//   4. Nếu match: mark used_at = now, cấp aal2 via magic link workaround.
//
// Note: Supabase JS admin API không có "elevate to aal2" trực tiếp. Workaround:
//   - Verify code + audit log ở server.
//   - Trả về success/fail.
//   - Client-side: sau khi nhận success, gọi mfa.challengeAndVerify với factor
//     recovery (không dùng — Supabase không hỗ trợ recovery factor).
//   - Alternative đơn giản: server DELETE tất cả MFA factors của user → user
//     login lần sau chỉ cần password + phải enroll TOTP lại.
//   Tạm dùng approach này: xóa factors + client force re-enroll.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';

import { corsHeaders, handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { logAuditSysAdmin } from '../_shared/audit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function makeAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // Verify JWT (chỉ cần aal1)
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return jsonResponse(401, { error: 'Missing Authorization Bearer token' });
  }
  const token = authHeader.slice(7);

  const admin = makeAdminClient();
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return jsonResponse(401, { error: 'Invalid JWT' });
  }
  const userId = userData.user.id;

  // Rate limit
  if (!checkRateLimit(`recovery:${userId}`, 5, 60_000)) {
    return jsonResponse(429, { error: 'Quá nhiều lần thử. Vui lòng thử lại sau 1 phút.' });
  }

  // Fetch profile
  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('id, username, full_name, role, is_disabled, is_deleted')
    .eq('id', userId)
    .maybeSingle();
  if (pErr || !profile) return jsonResponse(403, { error: 'Profile not found' });
  if (profile.is_disabled || profile.is_deleted) {
    return jsonResponse(403, { error: 'Account bị vô hiệu hóa' });
  }
  if (profile.role !== 'sys_admin') {
    // Chỉ sys_admin có recovery codes trong MVP này
    return jsonResponse(403, { error: 'Chức năng này chỉ dành cho sys_admin' });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Body must be JSON' });
  }
  const code = String(body.code || '').toLowerCase().trim();
  if (!/^[a-z2-9]{4}-[a-z2-9]{5}$/.test(code)) {
    return jsonResponse(400, { error: 'Recovery code format invalid (VD: xk3h-9m2pr)' });
  }

  // Fetch unused recovery codes
  const { data: codes, error: cErr } = await admin
    .from('mfa_recovery_codes')
    .select('id, code_hash')
    .eq('user_id', userId)
    .is('used_at', null);
  if (cErr) return jsonResponse(500, { error: cErr.message });
  if (!codes || codes.length === 0) {
    return jsonResponse(401, { error: 'Không còn recovery code khả dụng' });
  }

  // Bcrypt compare với từng code
  let matchedId: string | null = null;
  for (const row of codes) {
    if (bcrypt.compareSync(code, row.code_hash)) {
      matchedId = row.id;
      break;
    }
  }

  const ctx = {
    callerId: userId,
    callerRole: profile.role,
    callerBranchId: null,
    callerUsername: profile.username,
    callerFullName: profile.full_name,
  };

  if (!matchedId) {
    await logAuditSysAdmin(admin, ctx, {
      action: 'sys_admin_recovery_code_used',
      entityType: 'profile',
      entityId: userId,
      note: 'FAILED — code invalid or already used',
    });
    return jsonResponse(401, { error: 'Recovery code không đúng hoặc đã sử dụng' });
  }

  // Mark used
  const { error: uErr } = await admin
    .from('mfa_recovery_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', matchedId);
  if (uErr) return jsonResponse(500, { error: uErr.message });

  // Đếm codes còn lại
  const { count: remainingCount } = await admin
    .from('mfa_recovery_codes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('used_at', null);

  // Xóa MFA factors để user có thể enroll lại TOTP mới ở lần login tiếp theo.
  // Approach: dùng admin API list factors + delete từng cái.
  try {
    const { data: mfaData } = await admin.auth.admin.mfa.listFactors({ userId });
    if (mfaData?.factors) {
      for (const factor of mfaData.factors) {
        await admin.auth.admin.mfa.deleteFactor({ userId, id: factor.id });
      }
    }
  } catch (err) {
    console.error('[mfa-recovery] delete factors failed:', err);
    // Không block — user vẫn cần login lại
  }

  await logAuditSysAdmin(admin, ctx, {
    action: 'sys_admin_recovery_code_used',
    entityType: 'profile',
    entityId: userId,
    note: `SUCCESS — ${remainingCount ?? 0} codes remaining`,
  });

  return jsonResponse(200, {
    success: true,
    remaining_codes: remainingCount ?? 0,
    message: 'Recovery code hợp lệ. Vui lòng logout và login lại để enroll TOTP mới.',
  });
});
