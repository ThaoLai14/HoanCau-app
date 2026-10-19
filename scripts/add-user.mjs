#!/usr/bin/env node
/**
 * scripts/add-user.mjs
 * ============================================================================
 * Helper để admin/sys_admin thêm nhân viên mới sau go-live.
 *
 * Usage:
 *   node scripts/add-user.mjs \
 *     --username linh \
 *     --password Abc12345 \
 *     --role member \
 *     --branch SG \
 *     --fullname "Nguyễn Linh"
 *
 * Bootstrap sys_admin đầu tiên (chỉ dùng khi chưa có sys_admin trong DB):
 *   node scripts/add-user.mjs \
 *     --username sys \
 *     --password Abc12345 \
 *     --role sys_admin \
 *     --pin 123456 \
 *     --fullname "System Admin"
 *   (Nếu không truyền --branch, default = SG)
 *
 * Đọc service_role key từ scripts/.env.migration.local (KHÔNG commit).
 * Tự resolve branch_id từ branch_code (SG|GL), gọi Supabase Auth admin API.
 * Trigger `on_auth_user_created` tự tạo row `profiles` từ user_metadata.
 * Nếu role=sys_admin, thêm bước UPDATE profiles.sys_admin_pin_hash.
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------- Parse CLI args (trước env check để --help chạy được kể cả khi thiếu env) ----

const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
    opts[key] = val;
    if (val !== true) i++;
  }
}

if (opts.help || opts.h) {
  console.log(`
Usage: node scripts/add-user.mjs [options]

Options:
  --username   <string>              Tên đăng nhập (lowercase, không khoảng trắng)
  --password   <string>              Mật khẩu ban đầu (>= 8 ký tự)
  --role       sys_admin|admin|member|boss
  --branch     SG|GL                 (Default SG cho sys_admin, required cho role khác)
  --fullname   <string>              Họ tên đầy đủ (có thể có dấu, dùng "quotes")
  --pin        <6-digit>             PIN 6 số (BẮT BUỘC nếu role=sys_admin)
  --help                             Xem hướng dẫn

Ví dụ:
  # Tạo member SG
  node scripts/add-user.mjs --username linh --password Abc12345 \\
    --role member --branch SG --fullname "Nguyễn Linh"

  # Bootstrap sys_admin đầu tiên
  node scripts/add-user.mjs --username sys --password Abc12345 \\
    --role sys_admin --pin 123456 --fullname "System Admin"
`);
  process.exit(0);
}

// ---------- Load .env.migration.local ---------------------------------------

const scriptDir = dirname(fileURLToPath(import.meta.url));
const envPath = join(scriptDir, '.env.migration.local');
if (!existsSync(envPath)) {
  console.error(`❌ Không tìm thấy ${envPath}`);
  console.error('   Copy scripts/.env.migration.local.example → scripts/.env.migration.local');
  console.error('   và điền SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.');
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

// ---------- Validate ---------------------------------------------------------

const errs = [];
const username = String(opts.username || '').trim().toLowerCase();
const password = String(opts.password || '');
const role = String(opts.role || '').trim().toLowerCase();
const rawBranch = String(opts.branch || '').trim().toUpperCase();
const fullname = String(opts.fullname || '').trim();
const pin = String(opts.pin || '').trim();

// Sys_admin default branch = SG nếu không truyền
const branch = rawBranch || (role === 'sys_admin' ? 'SG' : '');

if (!/^[a-z0-9_.-]+$/.test(username)) errs.push('username phải chỉ có [a-z0-9_.-], không khoảng trắng');
if (password.length < 8) errs.push('password phải >= 8 ký tự');
if (!['sys_admin', 'admin', 'member', 'boss'].includes(role)) errs.push('role phải là sys_admin|admin|member|boss');
if (!['SG', 'GL'].includes(branch)) errs.push('branch phải là SG hoặc GL');
if (!fullname) errs.push('fullname không được rỗng');

// PIN required cho sys_admin
if (role === 'sys_admin') {
  if (!/^\d{6}$/.test(pin)) errs.push('sys_admin BẮT BUỘC có --pin gồm đúng 6 chữ số');
} else if (pin) {
  errs.push('--pin chỉ dùng cho role=sys_admin');
}

if (errs.length) {
  console.error('❌ Sai tham số:');
  for (const e of errs) console.error('   -', e);
  console.error('\nChạy `node scripts/add-user.mjs --help` xem hướng dẫn.');
  process.exit(1);
}

// ---------- Main -------------------------------------------------------------

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `${username}@hoancau.internal`;

console.log(`→ Tạo user: ${username} (${fullname})`);
console.log(`   email:  ${email}`);
console.log(`   role:   ${role}`);
console.log(`   branch: ${branch}`);
if (role === 'sys_admin') console.log(`   pin:    ${pin} (sẽ bcrypt hash)`);

// 1. Resolve branch_id
const { data: branchRow, error: bErr } = await supabase
  .from('branches')
  .select('id')
  .eq('branch_code', branch)
  .maybeSingle();
if (bErr || !branchRow) {
  console.error(`❌ Không tìm thấy branch ${branch}:`, bErr?.message || 'not found');
  process.exit(1);
}
const branch_id = branchRow.id;

// 2. Tạo auth user với metadata (trigger sẽ tự INSERT profiles)
const { data: created, error: cErr } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { username, full_name: fullname, role, branch_id },
});
if (cErr) {
  console.error('❌ Tạo auth user thất bại:', cErr.message);
  process.exit(1);
}
const authId = created.user?.id;

// 3. Verify trigger đã tạo profile
const { data: profile, error: pErr } = await supabase
  .from('profiles')
  .select('id, username, role, branch_id')
  .eq('id', authId)
  .maybeSingle();

if (pErr || !profile) {
  console.error('⚠️  Auth user tạo OK nhưng trigger KHÔNG tạo profile:', pErr?.message || 'not found');
  console.error('   Có thể trigger `on_auth_user_created` chưa được setup. Kiểm tra migration đã chạy chưa.');
  console.error('   Auth user id:', authId, '— cần INSERT profile bằng tay hoặc xoá user này.');
  process.exit(1);
}

// 4. Sys_admin: hash PIN và UPDATE profiles.sys_admin_pin_hash
if (role === 'sys_admin') {
  const pinHash = bcrypt.hashSync(pin, 10);
  const { error: updErr } = await supabase
    .from('profiles')
    .update({ sys_admin_pin_hash: pinHash })
    .eq('id', authId);
  if (updErr) {
    console.error('⚠️  Profile tạo OK nhưng UPDATE PIN hash thất bại:', updErr.message);
    console.error('   Sys_admin sẽ không unlock được PIN gate. Chạy tay SQL:');
    console.error(`   UPDATE profiles SET sys_admin_pin_hash = '${pinHash}' WHERE id = '${authId}';`);
    process.exit(1);
  }
}

console.log('\n✅ Thành công!');
console.log(`   id:         ${profile.id}`);
console.log(`   username:   ${profile.username}`);
console.log(`   role:       ${profile.role}`);
console.log(`   branch_id:  ${profile.branch_id}`);

if (role === 'sys_admin') {
  console.log(`\n🔐 GHI NHỚ (KHÔNG chia sẻ):`);
  console.log(`   username: ${username}`);
  console.log(`   password: ${password}`);
  console.log(`   PIN:      ${pin}`);
  console.log(`\n→ Sys_admin login lần đầu:`);
  console.log(`   1. Nhập username + password bình thường.`);
  console.log(`   2. App force enroll MFA (scan QR bằng Google Authenticator).`);
  console.log(`   3. Lưu recovery codes hiện lên (8 codes, hiển thị 1 LẮN duy nhất).`);
  console.log(`   4. Vào Quản Trị Hệ Thống. Khi sửa data business, nhập PIN 6 số.`);
} else {
  console.log(`\n→ User có thể login vào app bằng username "${username}" và password vừa set.`);
}
