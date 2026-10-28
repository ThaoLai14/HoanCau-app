#!/usr/bin/env node
/**
 * scripts/reset-sys-admin-password.mjs
 * ============================================================================
 * Đặt lại mật khẩu cho 1 tài khoản (mặc định sys_admin) — DÙNG KHI QUÊN MẬT KHẨU.
 * Mật khẩu mới được NHẬP TRỰC TIẾP vào terminal (ẩn bằng dấu *), KHÔNG truyền qua
 * tham số dòng lệnh (tránh lưu vào lịch sử shell) và KHÔNG hiện ra màn hình.
 *
 * Usage:
 *   node scripts/reset-sys-admin-password.mjs            (đặt cho sys_admin)
 *   node scripts/reset-sys-admin-password.mjs hc_nguyet  (đặt cho user khác)
 *
 * Đọc service_role key từ scripts/.env.migration.local.
 * ============================================================================
 */
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import readline from 'node:readline';

const scriptDir = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(scriptDir, '.env.migration.local'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const username = (process.argv[2] || 'sys_admin').trim().toLowerCase();

// Nhập mật khẩu ẩn (hiện dấu *).
function askHidden(query) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let first = true;
    rl._writeToOutput = function (s) {
      if (first) { process.stdout.write(query); first = false; return; }
      if (s.includes('\n') || s.includes('\r')) { process.stdout.write('\n'); return; }
      process.stdout.write('*');
    };
    rl.question(query, (val) => { rl.close(); resolve(val); });
  });
}

const pw1 = await askHidden('Nhập mật khẩu MỚI (>=8 ký tự): ');
if (!pw1 || pw1.length < 8) { console.error('\n❌ Mật khẩu phải >= 8 ký tự.'); process.exit(1); }
const pw2 = await askHidden('Nhập lại mật khẩu mới: ');
if (pw1 !== pw2) { console.error('\n❌ Hai lần nhập không khớp.'); process.exit(1); }

const { data: prof, error: pErr } = await supabase
  .from('profiles').select('id, username, full_name, role').eq('username', username).maybeSingle();
if (pErr || !prof) { console.error('\n❌ Không tìm thấy user:', username); process.exit(1); }

const { error } = await supabase.auth.admin.updateUserById(prof.id, { password: pw1 });
if (error) { console.error('\n❌ Lỗi:', error.message); process.exit(1); }

console.log(`\n✅ Đã đặt lại mật khẩu cho ${prof.username} (${prof.full_name}, ${prof.role}).`);
console.log('   Giờ đăng nhập bằng email tài khoản này + mật khẩu vừa đặt.');
process.exit(0);
