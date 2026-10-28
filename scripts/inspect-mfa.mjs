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

const username = process.argv[2] || 'sys_admin';
const { data: prof } = await supabase.from('profiles').select('id, username, full_name').eq('username', username).maybeSingle();
if (!prof) { console.error('Không thấy', username); process.exit(1); }

const { data, error } = await supabase.auth.admin.mfa.listFactors({ userId: prof.id });
if (error) { console.error('listFactors error:', error.message); process.exit(1); }
console.log(`MFA factors của ${prof.username} (${prof.full_name}):`);
console.log(JSON.stringify(data, null, 2));
process.exit(0);
