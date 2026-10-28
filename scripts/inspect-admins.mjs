import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const scriptDir = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(scriptDir, '.env.migration.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data: profs } = await supabase
  .from('profiles')
  .select('id, username, full_name, role, is_disabled, is_deleted, is_locked, failed_login_count, locked_at')
  .in('role', ['sys_admin', 'admin'])
  .order('role');

for (const p of profs || []) {
  // Lấy email từ auth.users
  const { data: u } = await supabase.auth.admin.getUserById(p.id);
  console.log(`[${p.role}] ${p.username} (${p.full_name})`);
  console.log(`   email(auth)=${u?.user?.email}  email_confirmed=${!!u?.user?.email_confirmed_at}`);
  console.log(`   is_disabled=${p.is_disabled} is_deleted=${p.is_deleted} is_locked=${p.is_locked} failed=${p.failed_login_count} locked_at=${p.locked_at}`);
  console.log('');
}
process.exit(0);
