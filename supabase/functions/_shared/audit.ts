// Shared audit log helper cho Edge Functions.
// Wrap INSERT vào audit_log với is_sys_admin_action = true.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import type { CallerContext } from './auth.ts';

export interface AuditPayload {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  changes?: Record<string, unknown> | null;
  note?: string | null;
}

export async function logAuditSysAdmin(
  supabase: SupabaseClient,
  ctx: CallerContext,
  payload: AuditPayload,
): Promise<void> {
  const row = {
    user_id: ctx.callerId,
    username: ctx.callerUsername,
    full_name: ctx.callerFullName,
    user_role: ctx.callerRole,
    action: payload.action,
    entity_type: payload.entityType ?? null,
    entity_id: payload.entityId ?? null,
    entity_label: payload.entityLabel ?? null,
    changes: payload.changes ?? null,
    note: payload.note ?? null,
    is_sys_admin_action: true,
  };
  const { error } = await supabase.from('audit_log').insert(row);
  if (error) {
    // Không throw — audit log fail không được block main action.
    console.error('[logAuditSysAdmin] fail:', error.message, row);
  }
}
