#!/usr/bin/env node
/**
 * scripts/fix-returned-business-date.mjs
 * ============================================================================
 * Sửa data cũ sau khi đổi sang Hướng A+ (danh sách bốc xếp bất biến).
 *
 * Trước A+: handleReturnBill ghi đè business_date = ngày hoàn → mất ngày gửi gốc.
 * Fix: với mỗi đơn delivery_status='returned' & return_business_date IS NULL:
 *   - return_business_date = business_date hiện tại (ngày hoàn)
 *   - business_date = ngày gửi gốc (lấy từ audit_log action bill_returned, old value)
 *
 * Số kiện Trong/Ngoài/Hàng ghép hiện tại = của chuyến đi → GIỮ NGUYÊN.
 * return_inside/outside/combined để NULL (chuyến hoàn về chưa xếp; sys_admin điền sau).
 *
 * Idempotent: chỉ chạm đơn return_business_date IS NULL. Chạy lại không ảnh hưởng.
 * ============================================================================
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

const DRY_RUN = process.argv.includes('--apply') ? false : true;

const { data: bills, error } = await supabase
  .from('bills')
  .select('id, bill_code, business_date, return_business_date')
  .eq('delivery_status', 'returned')
  .is('return_business_date', null)
  .order('bill_code', { ascending: true });
if (error) { console.error(error); process.exit(1); }

console.log(`\n${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'} ${bills.length} đơn cần sửa\n`);
let fixed = 0, skipped = 0;
for (const b of bills) {
  const { data: logs } = await supabase
    .from('audit_log')
    .select('changes')
    .eq('entity_type', 'bill')
    .eq('entity_id', b.id)
    .eq('action', 'bill_returned')
    .order('created_at', { ascending: false })
    .limit(1);
  const origBD = logs?.[0]?.changes?.business_date?.[0] ?? null;
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(origBD)) {
    console.log(`⏭  ${b.bill_code}: không tìm thấy ngày gửi gốc trong audit → BỎ QUA (sửa tay sau)`);
    skipped++;
    continue;
  }
  if (origBD === b.business_date) {
    console.log(`⏭  ${b.bill_code}: ngày gửi gốc == business_date hiện tại → không cần sửa`);
    skipped++;
    continue;
  }
  console.log(`✔  ${b.bill_code}: business_date ${b.business_date} → ${origBD} | return_business_date → ${b.business_date}`);
  if (!DRY_RUN) {
    const { error: upErr } = await supabase
      .from('bills')
      .update({ return_business_date: b.business_date, business_date: origBD })
      .eq('id', b.id);
    if (upErr) { console.error(`   ❌ lỗi: ${upErr.message}`); skipped++; continue; }
  }
  fixed++;
}
console.log(`\n${DRY_RUN ? 'Sẽ sửa' : 'Đã sửa'}: ${fixed} | Bỏ qua: ${skipped}`);
if (DRY_RUN) console.log('→ Chạy lại với  --apply  để ghi thật.\n');
process.exit(0);
