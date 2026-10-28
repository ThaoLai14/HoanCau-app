#!/usr/bin/env node
/**
 * scripts/diagnose-returned-bills.mjs (READ-ONLY)
 * Liệt kê các đơn delivery_status='returned' và so với audit_log để xem ngày gửi gốc.
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(scriptDir, '.env.migration.local');
if (!existsSync(envPath)) { console.error('Thiếu', envPath); process.exit(1); }
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: bills, error } = await supabase
  .from('bills')
  .select('id, bill_code, delivery_status, business_date, return_business_date, inside_count, outside_count, combined_goods, return_inside_count, return_outside_count, return_combined_goods, branch_id, current_branch_id')
  .eq('delivery_status', 'returned')
  .order('bill_code', { ascending: true });
if (error) { console.error(error); process.exit(1); }

console.log(`\n=== ${bills.length} đơn returned ===\n`);
for (const b of bills) {
  const { data: logs } = await supabase
    .from('audit_log')
    .select('created_at, changes')
    .eq('entity_type', 'bill')
    .eq('entity_id', b.id)
    .eq('action', 'bill_returned')
    .order('created_at', { ascending: false })
    .limit(1);
  const log = logs?.[0];
  const auditOldBD = log?.changes?.business_date?.[0] ?? null;
  const auditNewBD = log?.changes?.business_date?.[1] ?? null;
  console.log(`${b.bill_code}  id=${b.id}`);
  console.log(`   business_date=${b.business_date}  return_business_date=${b.return_business_date}`);
  console.log(`   counts: in=${b.inside_count} out=${b.outside_count} ghep=${b.combined_goods ?? ''} | return: in=${b.return_inside_count} out=${b.return_outside_count} ghep=${b.return_combined_goods ?? ''}`);
  console.log(`   audit bill_returned business_date: old(ngày gửi gốc)=${auditOldBD}  new(ngày hoàn)=${auditNewBD}`);
  console.log('');
}
process.exit(0);
