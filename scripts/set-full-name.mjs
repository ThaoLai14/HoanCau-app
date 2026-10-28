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

const newName = process.argv[2];
const username = process.argv[3] || 'sys_admin';
if (!newName) { console.error('Usage: node set-full-name.mjs "<Tên mới>" [username]'); process.exit(1); }

const { data, error } = await supabase
  .from('profiles')
  .update({ full_name: newName })
  .eq('username', username)
  .select('id, username, full_name');
if (error) { console.error(error); process.exit(1); }
console.log('Đã đổi:', JSON.stringify(data, null, 2));
process.exit(0);
