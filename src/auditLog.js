// src/auditLog.js
// Change: add-audit-log
// Ref: openspec/changes/add-audit-log/design.md §3 (logAudit + fetchAuditLog), §5 (diffObjects)
//
// Public API:
//   - logAudit(payload)           → insert 1 row vào audit_log (fail-safe, console.warn)
//   - fetchAuditLog({...})        → SELECT rows cho 1 entity, newest first
//   - diffObjects(a, b, allowed)  → tính diff của các field allowed → object {field:[old,new]}
//   - BILL_AUDIT_FIELDS / CLIENT_AUDIT_FIELDS → whitelist field
//
// Session shape: đọc từ localStorage 'hc_session' = { id, username, full_name, role, branch_id, branch_code }

import { supabase } from "./supabaseClient";

function getSession() {
  try {
    const raw = localStorage.getItem("hc_session");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Insert 1 row vào audit_log. Fail-safe: mọi lỗi → console.warn, không throw.
 * @param {object} p
 * @param {"bill"|"client"|"expense"|"session"} p.entityType
 * @param {string|null} p.entityId
 * @param {string|null} p.entityLabel
 * @param {string} p.action
 * @param {object|null} [p.changes]
 * @param {string|null} [p.note]
 */
export async function logAudit({ entityType, entityId, entityLabel, action, changes, note }) {
  try {
    const session = getSession();
    if (!session) {
      console.warn("[audit] no session, skip log", { action });
      return;
    }
    const { error } = await supabase.from("audit_log").insert({
      user_id: session.id || null,
      username: session.username || "unknown",
      full_name: session.full_name || session.username || "unknown",
      user_role: session.role || "unknown",
      entity_type: entityType,
      entity_id: entityId || null,
      entity_label: entityLabel || null,
      action,
      changes: changes || null,
      note: note || null,
    });
    if (error) console.warn("[audit] insert failed:", error.message);
  } catch (e) {
    console.warn("[audit] exception:", e?.message || e);
  }
}

/**
 * Fetch tất cả audit entries cho 1 entity, sort newest first.
 * Ném lỗi nếu Supabase fail (UI xử lý loading/error state).
 */
export async function fetchAuditLog({ entityType, entityId }) {
  if (!entityType || !entityId) return [];
  const { data, error } = await supabase
    .from("audit_log")
    .select("*")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

/**
 * Tính diff giữa 2 object trên các field allowed. Loại bỏ noise
 * (null vs '', undefined vs null).
 * @returns {object|null} { field: [old, new] } hoặc null nếu không có gì đổi
 */
export function diffObjects(before, after, allowedFields) {
  const result = {};
  for (const f of allowedFields) {
    let a = before?.[f];
    let b = after?.[f];
    if (a === undefined) a = null;
    if (b === undefined) b = null;
    // Coerce empty string ↔ null làm cùng nghĩa để tránh diff giả
    if ((a === "" && b === null) || (a === null && b === "")) continue;
    // So sánh number tolerant (nhập từ input là string, DB là number)
    if (a != null && b != null && !isNaN(Number(a)) && !isNaN(Number(b))
        && (typeof a === "number" || typeof b === "number")) {
      if (Number(a) === Number(b)) continue;
    }
    if (a === b) continue;
    result[f] = [a, b];
  }
  return Object.keys(result).length ? result : null;
}

// Whitelist field cho từng entity (không track FK id, timestamps, cache columns)
export const BILL_AUDIT_FIELDS = [
  "shipping_fee", "payment_status", "delivery_status", "delivery_address",
  "is_home_delivery", "goods_type", "goods_value", "package_count",
  "special_stars", "no_declared_value", "self_packed", "risk_warning",
  "require_id_check", "order_note", "export_vat",
  "sender_name_text", "sender_phone_text",
  "receiver_name_text", "receiver_phone_text",
];

export const CLIENT_AUDIT_FIELDS = [
  "fullname", "address", "is_blacklist", "blacklist_reason",
];
