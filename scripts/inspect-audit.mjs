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
const id = process.argv[2];
const { data, error } = await supabase
  .from('audit_log')
  .select('created_at, action, changes, note, username')
  .eq('entity_id', id)
  .order('created_at', { ascending: true });
if (error) { console.error(error); process.exit(1); }
for (const r of data) {
  console.log(`${r.created_at}  [${r.action}] by ${r.username}`);
  if (r.changes) console.log('   changes:', JSON.stringify(r.changes));
  if (r.note) console.log('   note:', r.note);
}
console.log(`\nTổng ${data.length} log`);
process.exit(0);
