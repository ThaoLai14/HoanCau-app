import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(scriptDir, '.env.migration.local');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const code = process.argv[2] || '02GLA02';
const { data, error } = await supabase
  .from('bills')
  .select('id, bill_code, delivery_status, is_delete, business_date, return_business_date, created_at, branch_id, current_branch_id, branch:branches!branch_id(branch_code), current_branch:branches!current_branch_id(branch_code), inside_count, outside_count')
  .eq('bill_code', code);
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify(data, null, 2));
process.exit(0);
