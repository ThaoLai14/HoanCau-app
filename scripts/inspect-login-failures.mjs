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

// 1. profiles có failed_login_count > 0 hoặc is_locked
const { data: profs } = await supabase
  .from('profiles')
  .select('username, failed_login_count, is_locked, locked_at')
  .or('failed_login_count.gt.0,is_locked.eq.true');
console.log('=== profiles có đếm sai / bị khóa ===');
console.log(profs?.length ? JSON.stringify(profs, null, 2) : '(không có — chưa account nào bị đếm sai)');

// 2. audit_log login_failed / login_locked gần đây
const { data: logs } = await supabase
  .from('audit_log')
  .select('created_at, action, username, note')
  .in('action', ['login_failed', 'login_locked'])
  .order('created_at', { ascending: false })
  .limit(10);
console.log('\n=== audit_log login_failed/login_locked gần nhất ===');
console.log(logs?.length ? JSON.stringify(logs, null, 2) : '(không có log nào — edge function auth-login CHƯA được gọi khi đăng nhập sai)');
process.exit(0);
