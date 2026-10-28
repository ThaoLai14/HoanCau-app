#!/usr/bin/env node
/**
 * scripts/fix-business-date-edit-bug.mjs
 * ============================================================================
 * Sửa data cũ: trước khi có guard §5.4, executeUpdateDraft ghi đè business_date
 * = ngày sửa cho CẢ đơn chính thức → "Ngày gửi" bị đẩy sang ngày sửa, đơn biến
 * mất khỏi danh sách bốc xếp ngày tạo gốc.
 *
 * Fix: với đơn chính thức (có bill_code) mà business_date LỆCH > 1 NGÀY so với
 * ngày tạo (VN) VÀ business_date trùng đúng 1 ngày có log sửa (bill_update/...)
 * → đặt lại business_date = ngày tạo nghiệp vụ (VN date của created_at).
 *
 * Bỏ qua đơn lệch đúng +1 ngày (tạo sau Xuất Bến — hợp lệ).
 * Idempotent: chạy lại không ảnh hưởng (lần 2 business_date đã == ngày tạo).
 * ============================================================================
 */
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
const DRY_RUN = !process.argv.includes('--apply');

const vnDate = (iso) => new Date(new Date(iso).getTime() + 7 * 3600 * 1000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const { data: bills, error } = await supabase
  .from('bills')
  .select('id, bill_code, business_date, created_at')
  .not('bill_code', 'is', null)
  .eq('is_delete', false)
  .order('created_at', { ascending: true });
if (error) { console.error(error); process.exit(1); }

console.log(`\n${DRY_RUN ? '[DRY-RUN]' : '[APPLY]'}\n`);
let fixed = 0;
for (const b of bills) {
  const createVN = vnDate(b.created_at);
  if (b.business_date === createVN) continue;
  const gap = daysBetween(createVN, b.business_date);
  if (gap <= 1) continue; // +1 ngày = tạo sau Xuất Bến, hợp lệ → bỏ qua
  const { data: logs } = await supabase
    .from('audit_log')
    .select('created_at, action')
    .eq('entity_id', b.id)
    .in('action', ['bill_update', 'bill_fee_quoted', 'bill_payment_received', 'bill_delivered'])
    .order('created_at', { ascending: true });
  const editDates = (logs || []).map(l => vnDate(l.created_at));
  if (!editDates.includes(b.business_date)) continue; // không trùng ngày sửa → không chắc là bug, bỏ qua
  console.log(`✔ ${b.bill_code}: business_date ${b.business_date} → ${createVN}  (lệch ${gap} ngày)`);
  if (!DRY_RUN) {
    const { error: upErr } = await supabase.from('bills').update({ business_date: createVN }).eq('id', b.id);
    if (upErr) { console.error(`  ❌ ${upErr.message}`); continue; }
  }
  fixed++;
}
console.log(`\n${DRY_RUN ? 'Sẽ sửa' : 'Đã sửa'}: ${fixed} đơn`);
if (DRY_RUN) console.log('→ Chạy lại với  --apply  để ghi thật.\n');
process.exit(0);
