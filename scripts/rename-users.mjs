#!/usr/bin/env node
/**
 * scripts/rename-users.mjs
 * ============================================================================
 * Đổi username hàng loạt (bỏ tiền tố lộ role như mem_/ad_/boss_).
 *
 * VÌ SAO phức tạp: username gắn với email đăng nhập `username@hoancau.internal`.
 * Đổi username = phải đổi ĐỒNG THỜI:
 *   1. auth.users.email        → new@hoancau.internal   (để login được)
 *   2. auth user_metadata.username → new
 *   3. public.profiles.username → new
 * Chỉ đổi 1 nơi sẽ làm user KHÔNG đăng nhập được.
 *
 * Usage:
 *   1. Copy scripts/rename-users.map.example.json → scripts/rename-users.map.json
 *      rồi sửa thành { "ten_cu": "ten_moi", ... } theo ý bạn.
 *   2. Chạy thử (không ghi gì):
 *        node scripts/rename-users.mjs --dry-run
 *   3. Chạy thật:
 *        node scripts/rename-users.mjs
 *
 * Đọc service_role key từ scripts/.env.migration.local (KHÔNG commit).
 * LƯU Ý: Các bản ghi lịch sử cũ (audit_log.username, *_snapshot) GIỮ tên cũ —
 * đó là dữ liệu lịch sử, không ảnh hưởng đăng nhập. Người đăng nhập mới mới thấy
 * tên mới. Nếu muốn, có thể đổi mật khẩu sau để an toàn hơn.
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const dryRun = process.argv.includes('--dry-run');

// ---------- Load .env.migration.local ---------------------------------------
const envPath = join(scriptDir, '.env.migration.local');
if (!existsSync(envPath)) {
  console.error(`❌ Không tìm thấy ${envPath}`);
  console.error('   Copy scripts/.env.migration.local.example → scripts/.env.migration.local');
  process.exit(1);
}
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Thiếu SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY trong .env.migration.local');
  process.exit(1);
}

// ---------- Load mapping -----------------------------------------------------
const mapPath = join(scriptDir, 'rename-users.map.json');
if (!existsSync(mapPath)) {
  console.error(`❌ Không tìm thấy ${mapPath}`);
  console.error('   Copy scripts/rename-users.map.example.json → scripts/rename-users.map.json rồi sửa.');
  process.exit(1);
}
let map;
try {
  map = JSON.parse(readFileSync(mapPath, 'utf8'));
} catch (e) {
  console.error('❌ File map không phải JSON hợp lệ:', e.message);
  process.exit(1);
}
const pairs = Object.entries(map).map(([oldU, newU]) => [
  String(oldU).trim().toLowerCase(),
  String(newU).trim().toLowerCase(),
]);

// ---------- Validate mapping -------------------------------------------------
const errs = [];
const newSet = new Set();
for (const [oldU, newU] of pairs) {
  if (!/^[a-z0-9_.-]+$/.test(oldU)) errs.push(`tên cũ không hợp lệ: "${oldU}"`);
  if (!/^[a-z0-9_.-]+$/.test(newU)) errs.push(`tên mới không hợp lệ: "${newU}"`);
  if (newSet.has(newU)) errs.push(`tên mới bị trùng trong map: "${newU}"`);
  newSet.add(newU);
}
if (errs.length) {
  console.error('❌ Map sai:');
  for (const e of errs) console.error('   -', e);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

console.log(`\n${dryRun ? '🧪 DRY-RUN (không ghi gì)' : '🚀 Đổi username'} — ${pairs.length} user\n`);

let ok = 0;
let fail = 0;
for (const [oldU, newU] of pairs) {
  if (oldU === newU) { console.log(`• ${oldU} → (giữ nguyên, bỏ qua)`); continue; }

  // 1. Tìm profile theo username cũ
  const { data: prof, error: pErr } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('username', oldU)
    .maybeSingle();
  if (pErr) { console.error(`✗ ${oldU}: lỗi đọc profile — ${pErr.message}`); fail++; continue; }
  if (!prof) { console.error(`✗ ${oldU}: không tìm thấy user`); fail++; continue; }

  // 2. Kiểm tra tên mới chưa bị dùng
  const { data: dup } = await supabase
    .from('profiles')
    .select('id')
    .eq('username', newU)
    .neq('id', prof.id)
    .maybeSingle();
  if (dup) { console.error(`✗ ${oldU} → ${newU}: tên mới đã tồn tại`); fail++; continue; }

  const newEmail = `${newU}@hoancau.internal`;
  console.log(`• ${oldU} → ${newU}  (${newEmail})`);
  if (dryRun) { ok++; continue; }

  // 3. Đổi email + user_metadata trong auth.users
  const { error: aErr } = await supabase.auth.admin.updateUserById(prof.id, {
    email: newEmail,
    user_metadata: { username: newU },
  });
  if (aErr) { console.error(`  ✗ auth update lỗi: ${aErr.message}`); fail++; continue; }

  // 4. Đổi profiles.username
  const { error: uErr } = await supabase
    .from('profiles')
    .update({ username: newU })
    .eq('id', prof.id);
  if (uErr) {
    console.error(`  ✗ profiles update lỗi: ${uErr.message} (auth đã đổi — chạy lại để đồng bộ)`);
    fail++;
    continue;
  }
  ok++;
}

console.log(`\n${dryRun ? 'Dự kiến' : 'Hoàn tất'}: ${ok} OK, ${fail} lỗi.\n`);
if (!dryRun && ok > 0) {
  console.log('→ Báo user đăng nhập bằng username MỚI. Mật khẩu giữ nguyên.');
}
process.exit(fail > 0 ? 1 : 0);
