// Shared auth helper: verify JWT + check caller role = sys_admin.
// Trả về callerId nếu OK, hoặc { error } nếu không hợp lệ.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export interface CallerContext {
  callerId: string;
  callerRole: string;
  callerBranchId: string | null;
  callerUsername: string;
  callerFullName: string;
}

export async function requireSysAdmin(
  supabase: SupabaseClient,
  req: Request,
): Promise<{ ok: true; ctx: CallerContext } | { ok: false; status: number; error: string }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing Authorization Bearer token' };
  }
  const token = authHeader.slice(7);

  // Verify JWT + get user
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userData?.user?.id) {
    return { ok: false, status: 401, error: 'Invalid JWT' };
  }
  const callerId = userData.user.id;

  // Verify caller là sys_admin, chưa disabled/deleted
  const { data: profile, error: profErr } = await supabase
    .from('profiles')
    .select('role, branch_id, username, full_name, is_disabled, is_deleted')
    .eq('id', callerId)
    .maybeSingle();

  if (profErr || !profile) {
    return { ok: false, status: 403, error: 'Profile not found' };
  }
  if (profile.is_disabled || profile.is_deleted) {
    return { ok: false, status: 403, error: 'Account bị vô hiệu hóa' };
  }
  if (profile.role !== 'sys_admin') {
    return { ok: false, status: 403, error: 'Chỉ sys_admin mới có quyền' };
  }

  return {
    ok: true,
    ctx: {
      callerId,
      callerRole: profile.role,
      callerBranchId: profile.branch_id,
      callerUsername: profile.username,
      callerFullName: profile.full_name,
    },
  };
}
