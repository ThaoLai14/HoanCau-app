#!/usr/bin/env node
/**
 * scripts/set-user-email.mjs
 * ============================================================================
 * Đặt EMAIL THẬT cho 1 tài khoản (thường là sys_admin) để bật "quên mật khẩu"
 * qua email. Đổi `auth.users.email` sang email thật (vd Gmail), auto-confirm.
 *
 * Sau khi chạy: tài khoản đó đăng nhập bằng CHÍNH email thật đó (gõ đủ email vào
 * ô "Tên đăng nhập"), và dùng "Quên mật khẩu?" ở màn login để nhận link reset.
 * (Cần đã cấu hình SMTP trong Supabase thì email mới gửi được.)
 *
 * Usage:
 *   node scripts/set-user-email.mjs --username sys --email boss@gmail.com
 *
 * Đọc service_role key từ scripts/.env.migration.local (KHÔNG commit).
 * ============================================================================
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ---------- Parse args -------------------------------------------------------
const opts = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--help' || a === '-h') opts.help = true;
  else if (a.startsWith('--')) opts[a.slice(2)] = process.argv[++i];
}
if (opts.help) {
  console.log(`Usage:
  node scripts/set-user-email.mjs --username <username> --email <email thật>

VD:
  node scripts/set-user-email.mjs --username sys --email boss@gmail.com
`);
  process.exit(0);
}

// ---------- Load .env.migration.local ---------------------------------------
const scriptDir = dirname(fileURLToPath(import.meta.url));
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

// ---------- Validate ---------------------------------------------------------
const username = String(opts.username || '').trim().toLowerCase();
const email = String(opts.email || '').trim();
const errs = [];
if (!username) errs.push('thiếu --username');
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errs.push('--email không hợp lệ');
if (errs.length) {
  console.error('❌ Sai tham số:');
  for (const e of errs) console.error('   -', e);
  process.exit(1);
}

// ---------- Main -------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: profile, error: pErr } = await supabase
  .from('profiles')
  .select('id, username, role')
  .eq('username', username)
  .maybeSingle();
if (pErr) { console.error('❌ Lỗi đọc profiles:', pErr.message); process.exit(1); }
if (!profile) { console.error(`❌ Không tìm thấy user "${username}"`); process.exit(1); }

const { error: uErr } = await supabase.auth.admin.updateUserById(profile.id, {
  email,
  email_confirm: true,
});
if (uErr) { console.error('❌ Lỗi đổi email:', uErr.message); process.exit(1); }

console.log(`✅ Đã đặt email cho "${username}" (role=${profile.role}) → ${email}`);
console.log(`   Tài khoản này giờ đăng nhập bằng email: ${email}`);
console.log(`   "Quên mật khẩu?" ở màn login sẽ gửi link reset về email này (cần SMTP đã bật).`);
