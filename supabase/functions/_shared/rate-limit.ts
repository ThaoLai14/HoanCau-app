// Rate limit đơn giản in-memory. Deno instance sống dài giữa requests.
// Không persist giữa cold start (chấp nhận — sys_admin action rare).
const buckets = new Map<string, number[]>();

/**
 * Trả true nếu OK gọi tiếp; false nếu đã vượt hạn ngạch.
 * @param userId       Key phân biệt user
 * @param maxRequests  Số request tối đa trong window
 * @param windowMs     Window ms (60_000 = 1 phút)
 */
export function checkRateLimit(userId: string, maxRequests = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  const bucket = buckets.get(userId) || [];
  // Xóa timestamps ngoài window
  const fresh = bucket.filter((t) => now - t < windowMs);
  if (fresh.length >= maxRequests) {
    buckets.set(userId, fresh);
    return false;
  }
  fresh.push(now);
  buckets.set(userId, fresh);
  return true;
}
