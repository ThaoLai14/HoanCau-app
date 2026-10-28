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

// VN date từ created_at UTC
const vnDate = (iso) => {
  const d = new Date(new Date(iso).getTime() + 7 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
};

const { data: bills, error } = await supabase
  .from('bills')
  .select('id, bill_code, delivery_status, business_date, return_business_date, created_at')
  .not('bill_code', 'is', null)
  .eq('is_delete', false)
  .order('created_at', { ascending: true });
if (error) { console.error(error); process.exit(1); }

const suspects = [];
for (const b of bills) {
  const createVN = vnDate(b.created_at);
  if (b.business_date === createVN) continue; // khớp ngày tạo → OK
  // Lấy audit bill_create để biết ngày tạo nghiệp vụ gốc; và các bill_update
  const { data: logs } = await supabase
    .from('audit_log')
    .select('created_at, action')
    .eq('entity_id', b.id)
    .in('action', ['bill_create', 'bill_update', 'bill_fee_quoted', 'bill_payment_received'])
    .order('created_at', { ascending: true });
  const editDates = (logs || []).filter(l => l.action !== 'bill_create').map(l => vnDate(l.created_at));
  const matchesEdit = editDates.includes(b.business_date);
  suspects.push({ code: b.bill_code, status: b.delivery_status, createVN, business_date: b.business_date, matchesEdit, editDates: [...new Set(editDates)] });
}

console.log(`\nTổng đơn chính thức: ${bills.length}`);
console.log(`Đơn có business_date != ngày tạo (VN): ${suspects.length}\n`);
for (const s of suspects) {
  const flag = s.matchesEdit ? '⚠️ BUG (business_date = ngày sửa)' : '  (lệch — có thể do xuất bến / tạo đơn cho mai)';
  console.log(`${s.code} [${s.status}]  tạo=${s.createVN}  business_date=${s.business_date}  ${flag}`);
  console.log(`   ngày sửa: ${s.editDates.join(', ') || '(không có)'}`);
}
process.exit(0);
