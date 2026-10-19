// Module-level PIN gate store — cho phép handler ở anywhere (kể cả ngoài
// React tree của Provider) gọi requireSysAdminUnlock() được.
// Provider register callback vào đây khi mount.

let requestFn = null;

export function setPinRequestFn(fn) {
  requestFn = fn;
}

/**
 * Trả Promise<boolean>:
 *   - Nếu chưa có provider mount hoặc user không phải sys_admin → true (không gate).
 *   - Nếu chưa unlock → mở modal, user nhập PIN → true nếu OK, false nếu cancel/sai.
 */
export function requireSysAdminUnlock() {
  if (!requestFn) return Promise.resolve(true);
  return requestFn();
}
