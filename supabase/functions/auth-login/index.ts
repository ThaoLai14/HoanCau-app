// =============================================================================
// auth-login Edge Function
// =============================================================================
// Deploy: npx supabase functions deploy auth-login --no-verify-jwt
// (Public — chưa đăng nhập nên không có JWT; tự kiểm soát bên trong.)
//
// Endpoint: POST /auth-login
//
// Actions:
//   login  (mặc định) - body { username, password }
//                       → kiểm tra khóa → đăng nhập → đếm sai, khóa ở lần thứ 3
//                       → trả { access_token, refresh_token, profile } khi đúng.
//   logout            - body { access_token, reason } → ghi login_events (logout).
//                       Dùng cho đóng tab (fetch keepalive) vì không set được header JWT.
//
// Bảo mật: đếm số lần sai Ở SERVER (client không lách được). KHÔNG tiết lộ số lần
// còn lại hay tài khoản có tồn tại hay không.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { handlePreflight, jsonResponse } from '../_shared/cors.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

const MAX_FAILED = 3;                 // sai đủ số này → khóa
const INTERNAL_DOMAIN = '@hoancau.internal';

function makeAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Đăng nhập thực tế bằng ANON client (giống client thường) để lấy session chuẩn.
function makeAnon() {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function handleLogout(body: Record<string, unknown>, ua: string | null): Promise<Response> {
  const token = String(body.access_token || '');
  const reason = String(body.reason || 'tab_close');
  if (!token) return jsonResponse(200, { ok: true });
  const admin = makeAdmin();
  const { data: u } = await admin.auth.getUser(token);
  const uid = u?.user?.id;
  if (uid) {
    const { data: prof } = await admin
      .from('profiles')
      .select('username, full_name, role, branches(branch_code)')
      .eq('id', uid)
      .maybeSingle();
    await admin.from('login_events').insert({
      user_id: uid,
      username: prof?.username ?? null,
      full_name: prof?.full_name ?? null,
      user_role: prof?.role ?? null,
      // deno-lint-ignore no-explicit-any
      branch_code: (prof as any)?.branches?.branch_code ?? null,
      event_type: 'logout',
      reason,
      user_agent: ua,
    });
  }
  return jsonResponse(200, { ok: true });
}

async function handleLogin(body: Record<string, unknown>, req: Request): Promise<Response> {
  const rawUser = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!rawUser || !password) return jsonResponse(400, { error: 'Thiếu thông tin đăng nhập' });

  const email = rawUser.includes('@') ? rawUser : `${rawUser}${INTERNAL_DOMAIN}`;
  const ua = req.headers.get('user-agent');
  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

  // Rate limit mềm (bổ sung cho rate-limit sẵn có của Supabase).
  if (!checkRateLimit(`login:${email}`, 10, 60_000) || !checkRateLimit(`loginip:${ip}`, 40, 60_000)) {
    return jsonResponse(429, { error: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.' });
  }

  const admin = makeAdmin();

  // Tra user id từ email (service role). Có thể null nếu email không tồn tại.
  let uid: string | null = null;
  try {
    const { data } = await admin.rpc('profile_id_by_email', { p_email: email });
    uid = (data as string) || null;
  } catch { uid = null; }

  // Nếu biết user → kiểm tra trạng thái trước khi thử mật khẩu.
  let prof: Record<string, unknown> | null = null;
  if (uid) {
    const { data } = await admin
      .from('profiles')
      .select('id, username, full_name, role, branch_id, is_disabled, is_deleted, is_locked, failed_login_count, branches(branch_code)')
      .eq('id', uid)
      .maybeSingle();
    prof = data as Record<string, unknown> | null;
    if (prof) {
      if (prof.is_deleted || prof.is_disabled) {
        return jsonResponse(403, { error: 'Tài khoản của bạn đã bị vô hiệu hóa. Liên hệ Quản Trị Viên.' });
      }
      if (prof.is_locked) {
        return jsonResponse(423, { error: 'Tài khoản đã bị khóa do nhập sai nhiều lần. Vui lòng liên hệ Quản Trị Viên để mở khóa.' });
      }
    }
  }

  // Thử đăng nhập bằng ANON client.
  const anon = makeAnon();
  const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({ email, password });

  if (signErr || !signIn?.session) {
    // Sai mật khẩu → tăng bộ đếm (nếu biết user). KHÔNG tiết lộ số lần còn lại.
    if (uid && prof) {
      const next = Number(prof.failed_login_count || 0) + 1;
      const willLock = next >= MAX_FAILED;
      await admin
        .from('profiles')
        .update({
          failed_login_count: next,
          ...(willLock ? { is_locked: true, locked_at: new Date().toISOString() } : {}),
        })
        .eq('id', uid);
      // Ghi audit (phân tích bảo mật) — không ghi vào login_events (chỉ phiên thật).
      await admin.from('audit_log').insert({
        user_id: uid,
        username: prof.username ?? null,
        full_name: prof.full_name ?? null,
        user_role: prof.role ?? null,
        action: willLock ? 'login_locked' : 'login_failed',
        entity_type: 'profile',
        entity_id: uid,
        entity_label: prof.username ?? null,
        note: willLock ? `Khóa tài khoản sau ${next} lần sai` : `Đăng nhập sai (${next})`,
        is_sys_admin_action: false,
      });
    }
    return jsonResponse(401, { error: 'Tên đăng nhập hoặc mật khẩu không đúng' });
  }

  // Đăng nhập đúng. Lấy profile (nếu chưa có do uid null lúc đầu — hiếm).
  const userId = signIn.user?.id || uid;
  if (!userId) return jsonResponse(500, { error: 'Không xác định được tài khoản' });
  if (!prof) {
    const { data } = await admin
      .from('profiles')
      .select('id, username, full_name, role, branch_id, is_disabled, is_deleted, branches(branch_code)')
      .eq('id', userId)
      .maybeSingle();
    prof = data as Record<string, unknown> | null;
  }
  if (!prof) {
    return jsonResponse(403, { error: 'Tài khoản chưa được cấu hình. Liên hệ Quản Trị Viên.' });
  }
  if (prof.is_disabled || prof.is_deleted) {
    return jsonResponse(403, { error: 'Tài khoản của bạn đã bị vô hiệu hóa. Liên hệ Quản Trị Viên.' });
  }

  // Reset bộ đếm + ghi login event.
  await admin.from('profiles').update({ failed_login_count: 0, is_locked: false, locked_at: null }).eq('id', userId);
  // deno-lint-ignore no-explicit-any
  const branchCode = (prof as any)?.branches?.branch_code ?? null;
  await admin.from('login_events').insert({
    user_id: userId,
    username: prof.username ?? null,
    full_name: prof.full_name ?? null,
    user_role: prof.role ?? null,
    branch_code: branchCode,
    event_type: 'login',
    reason: 'password',
    user_agent: ua,
  });

  return jsonResponse(200, {
    access_token: signIn.session.access_token,
    refresh_token: signIn.session.refresh_token,
    profile: {
      id: prof.id,
      username: prof.username,
      full_name: prof.full_name,
      role: prof.role,
      branch_id: prof.branch_id,
      branch_code: branchCode || 'SG',
    },
  });
}

Deno.serve(async (req) => {
  const pf = handlePreflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: 'Body must be JSON' });
  }

  const action = String(body.action || 'login');
  try {
    if (action === 'logout') return await handleLogout(body, req.headers.get('user-agent'));
    return await handleLogin(body, req);
  } catch (err) {
    console.error('[auth-login] error:', err);
    return jsonResponse(500, { error: (err as Error).message || 'Internal error' });
  }
});
