// =============================================================================
// admin-users Edge Function
// =============================================================================
// Deploy: npx supabase functions deploy admin-users --no-verify-jwt
// (Tự verify JWT trong requireSysAdmin để trả 401/403 rõ ràng).
//
// Endpoint: POST /admin-users
// Body: { action: '<action_name>', ...args }
// Headers: Authorization: Bearer <user_jwt>
//
// Actions:
//   create               - Tạo user mới (username, full_name, role, branch_code, password)
//   update_profile       - Sửa full_name/role/branch_id của user (target_id + fields)
//   reset_password       - Reset password user khác (target_id, new_password)
//   disable              - Khóa tạm user (target_id)
//   enable               - Mở khóa user (target_id)
//   delete               - Xóa vĩnh viễn user (soft delete + ban) (target_id)
//   verify_pin           - Kiểm tra PIN của sys_admin gọi (pin)
//   set_pin              - Đổi PIN của sys_admin gọi (new_pin, old_pin optional)
//   generate_recovery_codes - Sinh 8 recovery codes cho MFA (trả plaintext 1 lần)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';

import { corsHeaders, handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { requireSysAdmin, type CallerContext } from '../_shared/auth.ts';
import { logAuditSysAdmin } from '../_shared/audit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
}

// =============================================================================
// Helpers
// =============================================================================

function makeAdminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Ngăn sys_admin tự lockout: kiểm tra target không phải chính caller.
 */
function assertNotSelf(callerId: string, targetId: string, action: string): { ok: boolean; error?: string } {
  if (callerId === targetId) {
    return { ok: false, error: `Không thể ${action} chính mình` };
  }
  return { ok: true };
}

/**
 * Kiểm tra target là sys_admin last active. Nếu true → deny disable/delete/demote.
 */
async function assertNotLastSysAdmin(
  admin: ReturnType<typeof makeAdminClient>,
  targetId: string,
): Promise<{ ok: boolean; error?: string }> {
  // Đếm sys_admin active KHÔNG bao gồm target hiện tại
  const { count, error } = await admin
    .from('profiles')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'sys_admin')
    .eq('is_disabled', false)
    .eq('is_deleted', false)
    .neq('id', targetId);
  if (error) {
    return { ok: false, error: 'Không kiểm tra được last sys_admin: ' + error.message };
  }
  if ((count ?? 0) < 1) {
    return { ok: false, error: 'Không thể disable/delete sys_admin cuối cùng còn hoạt động' };
  }
  return { ok: true };
}

async function resolveBranchId(
  admin: ReturnType<typeof makeAdminClient>,
  branchCode: string,
): Promise<{ branchId?: string; error?: string }> {
  const { data, error } = await admin
    .from('branches')
    .select('id')
    .eq('branch_code', branchCode)
    .maybeSingle();
  if (error || !data) {
    return { error: `Không tìm thấy branch ${branchCode}` };
  }
  return { branchId: data.id };
}

// =============================================================================
// Actions
// =============================================================================

async function actionCreate(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const username = String(body.username || '').trim().toLowerCase();
  const full_name = String(body.full_name || '').trim();
  const role = String(body.role || '').trim().toLowerCase();
  const branch_code = String(body.branch_code || '').trim().toUpperCase();
  const password = String(body.password || '');

  if (!/^[a-z0-9_.-]+$/.test(username)) return jsonResponse(400, { error: 'username invalid' });
  if (!full_name) return jsonResponse(400, { error: 'full_name required' });
  if (!['sys_admin', 'admin', 'member', 'boss'].includes(role)) return jsonResponse(400, { error: 'role invalid' });
  if (!['SG', 'GL'].includes(branch_code)) return jsonResponse(400, { error: 'branch_code invalid' });
  if (password.length < 8) return jsonResponse(400, { error: 'password >= 8 chars' });

  const { branchId, error: bErr } = await resolveBranchId(admin, branch_code);
  if (bErr || !branchId) return jsonResponse(400, { error: bErr || 'branch not found' });

  const email = `${username}@hoancau.internal`;
  const { data: created, error: cErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username, full_name, role, branch_id: branchId },
  });
  if (cErr || !created?.user?.id) {
    return jsonResponse(400, { error: cErr?.message || 'createUser failed' });
  }
  const newUserId = created.user.id;

  await logAuditSysAdmin(admin, ctx, {
    action: 'user_created',
    entityType: 'profile',
    entityId: newUserId,
    entityLabel: username,
    changes: { role: [null, role], branch_id: [null, branchId], full_name: [null, full_name] },
  });

  return jsonResponse(200, { success: true, user_id: newUserId });
}

async function actionUpdateProfile(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const target_id = String(body.target_id || '');
  if (!target_id) return jsonResponse(400, { error: 'target_id required' });

  // Fetch target hiện tại
  const { data: target, error: tErr } = await admin
    .from('profiles')
    .select('id, username, full_name, role, branch_id')
    .eq('id', target_id)
    .maybeSingle();
  if (tErr || !target) return jsonResponse(404, { error: 'target not found' });

  // Build update payload
  const updates: Record<string, unknown> = {};
  const changes: Record<string, unknown[]> = {};
  let newUsername = target.username as string;

  if (body.username !== undefined) {
    const u = String(body.username).trim().toLowerCase();
    if (u && u !== target.username) {
      if (!/^[a-z0-9_.-]+$/.test(u)) return jsonResponse(400, { error: 'username không hợp lệ (chỉ a-z 0-9 _.-)' });
      const { data: dup } = await admin
        .from('profiles')
        .select('id')
        .eq('username', u)
        .neq('id', target_id)
        .maybeSingle();
      if (dup) return jsonResponse(400, { error: 'username đã tồn tại' });
      updates.username = u;
      changes.username = [target.username, u];
      newUsername = u;
    }
  }

  if (body.full_name !== undefined && body.full_name !== target.full_name) {
    const newFullName = String(body.full_name || '').trim();
    if (!newFullName) return jsonResponse(400, { error: 'full_name không được rỗng' });
    updates.full_name = newFullName;
    changes.full_name = [target.full_name, newFullName];
  }

  if (body.role !== undefined && body.role !== target.role) {
    const newRole = String(body.role).toLowerCase();
    if (!['sys_admin', 'admin', 'member', 'boss'].includes(newRole)) {
      return jsonResponse(400, { error: 'role invalid' });
    }
    // Anti-lockout: không đổi role sys_admin last về khác
    if (target.role === 'sys_admin' && newRole !== 'sys_admin') {
      const self = assertNotSelf(ctx.callerId, target_id, 'demote');
      if (!self.ok) return jsonResponse(403, { error: self.error });
      const last = await assertNotLastSysAdmin(admin, target_id);
      if (!last.ok) return jsonResponse(403, { error: last.error });
    }
    updates.role = newRole;
    changes.role = [target.role, newRole];
  }

  if (body.branch_code !== undefined) {
    const branchCode = String(body.branch_code).toUpperCase();
    if (!['SG', 'GL'].includes(branchCode)) return jsonResponse(400, { error: 'branch_code invalid' });
    const { branchId } = await resolveBranchId(admin, branchCode);
    if (branchId && branchId !== target.branch_id) {
      updates.branch_id = branchId;
      changes.branch_id = [target.branch_id, branchId];
    }
  }

  if (Object.keys(updates).length === 0) {
    return jsonResponse(200, { success: true, no_changes: true });
  }

  // Đồng bộ auth.users TRƯỚC (email + metadata). Đổi username = đổi email đăng nhập;
  // làm trước profiles để nếu lỗi thì login vẫn dùng username cũ (không bị kẹt).
  if (updates.username || updates.role || updates.branch_id || updates.full_name) {
    const authUpdate: Record<string, unknown> = {
      user_metadata: {
        username: newUsername,
        full_name: updates.full_name ?? target.full_name,
        role: updates.role ?? target.role,
        branch_id: updates.branch_id ?? target.branch_id,
      },
    };
    if (updates.username) authUpdate.email = `${newUsername}@hoancau.internal`;
    const { error: aErr } = await admin.auth.admin.updateUserById(target_id, authUpdate);
    if (aErr) return jsonResponse(400, { error: 'Cập nhật auth thất bại: ' + aErr.message });
  }

  const { error: uErr } = await admin.from('profiles').update(updates).eq('id', target_id);
  if (uErr) return jsonResponse(400, { error: uErr.message });

  await logAuditSysAdmin(admin, ctx, {
    action: 'user_profile_updated',
    entityType: 'profile',
    entityId: target_id,
    entityLabel: target.username,
    changes,
  });

  return jsonResponse(200, { success: true });
}

async function actionResetPassword(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const target_id = String(body.target_id || '');
  const new_password = String(body.new_password || '');
  if (!target_id) return jsonResponse(400, { error: 'target_id required' });
  if (new_password.length < 8) return jsonResponse(400, { error: 'password >= 8 chars' });

  const { data: target } = await admin
    .from('profiles')
    .select('username')
    .eq('id', target_id)
    .maybeSingle();
  if (!target) return jsonResponse(404, { error: 'target not found' });

  const { error } = await admin.auth.admin.updateUserById(target_id, { password: new_password });
  if (error) return jsonResponse(400, { error: error.message });

  await logAuditSysAdmin(admin, ctx, {
    action: 'user_password_reset',
    entityType: 'profile',
    entityId: target_id,
    entityLabel: target.username,
  });

  return jsonResponse(200, { success: true });
}

async function actionDisableOrDelete(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
  mode: 'disable' | 'delete',
): Promise<Response> {
  const target_id = String(body.target_id || '');
  if (!target_id) return jsonResponse(400, { error: 'target_id required' });

  const self = assertNotSelf(ctx.callerId, target_id, mode);
  if (!self.ok) {
    await logAuditSysAdmin(admin, ctx, {
      action: 'user_disable_self_attempt',
      entityType: 'profile',
      entityId: target_id,
      note: `Attempted ${mode} on self`,
    });
    return jsonResponse(403, { error: self.error });
  }

  const { data: target } = await admin
    .from('profiles')
    .select('username, role')
    .eq('id', target_id)
    .maybeSingle();
  if (!target) return jsonResponse(404, { error: 'target not found' });

  // Nếu target là sys_admin, check last-active
  if (target.role === 'sys_admin') {
    const last = await assertNotLastSysAdmin(admin, target_id);
    if (!last.ok) return jsonResponse(403, { error: last.error });
  }

  // Update profiles
  const updates: Record<string, unknown> = {
    is_disabled: true,
    disabled_at: new Date().toISOString(),
    disabled_by: ctx.callerId,
  };
  if (mode === 'delete') updates.is_deleted = true;

  const { error: uErr } = await admin.from('profiles').update(updates).eq('id', target_id);
  if (uErr) return jsonResponse(400, { error: uErr.message });

  // Ban auth user (defense-in-depth) — 100 năm
  const { error: bErr } = await admin.auth.admin.updateUserById(target_id, { ban_duration: '876000h' });
  if (bErr) console.error('[disable] ban failed:', bErr.message);

  await logAuditSysAdmin(admin, ctx, {
    action: mode === 'delete' ? 'user_deleted' : 'user_disabled',
    entityType: 'profile',
    entityId: target_id,
    entityLabel: target.username,
    changes: mode === 'delete'
      ? { is_deleted: [false, true], is_disabled: [false, true] }
      : { is_disabled: [false, true] },
  });

  return jsonResponse(200, { success: true });
}

async function actionEnable(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const target_id = String(body.target_id || '');
  if (!target_id) return jsonResponse(400, { error: 'target_id required' });

  const { data: target } = await admin
    .from('profiles')
    .select('username, is_deleted')
    .eq('id', target_id)
    .maybeSingle();
  if (!target) return jsonResponse(404, { error: 'target not found' });
  if (target.is_deleted) return jsonResponse(400, { error: 'User đã bị xóa, không enable lại được' });

  const { error: uErr } = await admin
    .from('profiles')
    .update({ is_disabled: false, disabled_at: null, disabled_by: null })
    .eq('id', target_id);
  if (uErr) return jsonResponse(400, { error: uErr.message });

  // Unban auth user
  const { error: bErr } = await admin.auth.admin.updateUserById(target_id, { ban_duration: 'none' });
  if (bErr) console.error('[enable] unban failed:', bErr.message);

  await logAuditSysAdmin(admin, ctx, {
    action: 'user_enabled',
    entityType: 'profile',
    entityId: target_id,
    entityLabel: target.username,
    changes: { is_disabled: [true, false] },
  });

  return jsonResponse(200, { success: true });
}

async function actionVerifyPin(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const pin = String(body.pin || '');
  if (!/^\d{6}$/.test(pin)) {
    await logAuditSysAdmin(admin, ctx, {
      action: 'sys_admin_pin_verify_fail',
      entityType: 'profile',
      entityId: ctx.callerId,
      note: 'PIN format invalid',
    });
    return jsonResponse(400, { error: 'PIN phải là 6 chữ số' });
  }

  const { data: profile, error: pErr } = await admin
    .from('profiles')
    .select('sys_admin_pin_hash')
    .eq('id', ctx.callerId)
    .maybeSingle();
  if (pErr || !profile?.sys_admin_pin_hash) {
    return jsonResponse(400, { error: 'Chưa cài đặt PIN. Vui lòng tạo PIN qua Tài khoản của tôi.' });
  }

  const match = bcrypt.compareSync(pin, profile.sys_admin_pin_hash);
  await logAuditSysAdmin(admin, ctx, {
    action: match ? 'sys_admin_pin_verify_success' : 'sys_admin_pin_verify_fail',
    entityType: 'profile',
    entityId: ctx.callerId,
  });

  if (!match) return jsonResponse(401, { error: 'PIN không đúng', success: false });
  return jsonResponse(200, { success: true });
}

async function actionSetPin(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const new_pin = String(body.new_pin || '');
  const old_pin = body.old_pin ? String(body.old_pin) : null;

  if (!/^\d{6}$/.test(new_pin)) return jsonResponse(400, { error: 'new_pin phải là 6 chữ số' });

  const { data: profile } = await admin
    .from('profiles')
    .select('sys_admin_pin_hash')
    .eq('id', ctx.callerId)
    .maybeSingle();

  // Nếu đã có PIN → phải nhập old_pin đúng
  if (profile?.sys_admin_pin_hash) {
    if (!old_pin || !bcrypt.compareSync(old_pin, profile.sys_admin_pin_hash)) {
      return jsonResponse(401, { error: 'PIN cũ không đúng' });
    }
  }

  const newHash = bcrypt.hashSync(new_pin, 10);
  const { error } = await admin
    .from('profiles')
    .update({ sys_admin_pin_hash: newHash })
    .eq('id', ctx.callerId);
  if (error) return jsonResponse(400, { error: error.message });

  await logAuditSysAdmin(admin, ctx, {
    action: 'sys_admin_pin_changed',
    entityType: 'profile',
    entityId: ctx.callerId,
  });

  return jsonResponse(200, { success: true });
}

function generateRecoveryCode(): string {
  // 10 chars: 2 groups of 4 hex-like, xx3h-9m2p (dễ đọc)
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // bỏ i/l/o/0/1 để tránh nhầm
  const rand = new Uint8Array(9);
  crypto.getRandomValues(rand);
  const s = Array.from(rand, (b) => chars[b % chars.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 9)}`;
}

async function actionGenerateRecoveryCodes(
  admin: ReturnType<typeof makeAdminClient>,
  ctx: CallerContext,
): Promise<Response> {
  // Xóa codes cũ
  const { error: delErr } = await admin
    .from('mfa_recovery_codes')
    .delete()
    .eq('user_id', ctx.callerId);
  if (delErr) return jsonResponse(400, { error: 'Xóa codes cũ thất bại: ' + delErr.message });

  // Sinh 8 codes mới
  const codes: string[] = [];
  const rows: Array<{ user_id: string; code_hash: string }> = [];
  for (let i = 0; i < 8; i++) {
    const code = generateRecoveryCode();
    codes.push(code);
    rows.push({ user_id: ctx.callerId, code_hash: bcrypt.hashSync(code, 10) });
  }

  const { error: insErr } = await admin.from('mfa_recovery_codes').insert(rows);
  if (insErr) return jsonResponse(400, { error: 'Lưu codes thất bại: ' + insErr.message });

  await logAuditSysAdmin(admin, ctx, {
    action: 'sys_admin_recovery_codes_generated',
    entityType: 'profile',
    entityId: ctx.callerId,
    note: `Generated 8 new recovery codes`,
  });

  return jsonResponse(200, { success: true, codes });
}

// =============================================================================
// Entry point
// =============================================================================

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  if (req.method !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  const admin = makeAdminClient();

  // Verify caller = sys_admin
  const auth = await requireSysAdmin(admin, req);
  if (!auth.ok) {
    // Log unauthorized attempt (không thể log qua sys_admin flag vì không xác định callerId)
    console.warn('[admin-users] unauthorized:', auth.error);
    return jsonResponse(auth.status, { error: auth.error });
  }
  const ctx = auth.ctx;

  // Rate limit
  if (!checkRateLimit(ctx.callerId)) {
    return jsonResponse(429, { error: 'Rate limit exceeded (30 requests/minute)' });
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Body must be JSON' });
  }

  const action = String(body.action || '');
  try {
    switch (action) {
      case 'create':
        return await actionCreate(admin, ctx, body);
      case 'update_profile':
        return await actionUpdateProfile(admin, ctx, body);
      case 'reset_password':
        return await actionResetPassword(admin, ctx, body);
      case 'disable':
        return await actionDisableOrDelete(admin, ctx, body, 'disable');
      case 'delete':
        return await actionDisableOrDelete(admin, ctx, body, 'delete');
      case 'enable':
        return await actionEnable(admin, ctx, body);
      case 'verify_pin':
        return await actionVerifyPin(admin, ctx, body);
      case 'set_pin':
        return await actionSetPin(admin, ctx, body);
      case 'generate_recovery_codes':
        return await actionGenerateRecoveryCodes(admin, ctx);
      default:
        return jsonResponse(400, { error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[admin-users] handler error:', err);
    return jsonResponse(500, { error: (err as Error).message || 'Internal error' });
  }
});
