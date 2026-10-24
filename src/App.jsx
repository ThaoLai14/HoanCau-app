import React, { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from "./supabaseClient";
import LoginScreen from "./LoginScreen";
import ClientAutocomplete from "./ClientAutocomplete";
import { logAudit, fetchAuditLog, diffObjects, BILL_AUDIT_FIELDS, CLIENT_AUDIT_FIELDS } from "./auditLog";
import { ACTION_LABELS, renderChanges, formatVnd as auditFormatVnd } from "./auditLabels";
import BillHistorySection from "./BillHistorySection";
import ClientHistorySection from "./ClientHistorySection";
import ExpenseHistorySection from "./ExpenseHistorySection";
import SysAdminPanel from "./SysAdminPanel";
import MyAccountScreen from "./MyAccountScreen";
import ResetPasswordScreen from "./ResetPasswordScreen";
import SessionMonitor from "./SessionMonitor";
import MfaFlow from "./MfaFlow";
import { SysAdminPinProvider, useSysAdminUnlock } from "./SysAdminPinModal";
import { requireSysAdminUnlock } from "./pinGateStore";
import logoHC from "./assets/Logo HC.png";

// Helper định dạng tiền VND
const formatVND = (value) => {
if (!value) return "0 đ";
return new Intl.NumberFormat("vi-VN", {
  style: "currency",
  currency: "VND",
}).format(value);
};

// Hàm sinh mã ngày hệ thống (Fix bug getDayCode cứng)
const getDayCode = (dayIndex) => {
const adjustedIndex = dayIndex - 1;
const letterIndex = Math.floor(adjustedIndex / 99);
const numberPart = (adjustedIndex % 99) + 1;
const letter = String.fromCharCode(65 + letterIndex);
const numberStr = numberPart.toString().padStart(2, "0");
return `${letter}${numberStr}`;
};

// ============================================================
// add-server-session: session (business_date + day_counter + bill_seq) sống trên DB
// bảng `branch_sessions` — thay thế localStorage per-device.
// Format bill_code giữ nguyên "SSXXDDD" (seq2 + branch + day_counter e.g. "A02")
// day_counter được lưu TEXT nguyên dạng "A01".."A99","B01",... để reserve backward-compat.
// ============================================================

// Lấy VN today (YYYY-MM-DD)
const getVNTodayDate = () => {
  const now = new Date();
  const vn = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return vn.toISOString().slice(0, 10);
};

// Cutoff giờ VN sau đó phải hỏi xác nhận đã xuất bến chưa trước khi tạo đơn chính thức.
const DEPARTURE_CUTOFF_HOUR = 16;
const DEPARTURE_CUTOFF_MIN = 30;

// True nếu bây giờ (giờ VN) đã ≥ CUTOFF.
const isAfterVNDepartureCutoff = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Ho_Chi_Minh",
  }).formatToParts(new Date());
  const h = Number(parts.find(p => p.type === "hour")?.value || 0);
  const m = Number(parts.find(p => p.type === "minute")?.value || 0);
  return h > DEPARTURE_CUTOFF_HOUR || (h === DEPARTURE_CUTOFF_HOUR && m >= DEPARTURE_CUTOFF_MIN);
};

// Giờ VN hiện tại dạng "HH:MM" (24h) — dùng cho nhắc nhở theo mốc giờ.
const getVNNowHHMM = () => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Ho_Chi_Minh",
  }).formatToParts(new Date());
  const h = parts.find(p => p.type === "hour")?.value || "00";
  const m = parts.find(p => p.type === "minute")?.value || "00";
  return `${h}:${m}`;
};

// Nhắc nhở hằng ngày (hiện mọi màn hình, trừ boss & sys_admin). Hiện 1 lần/ngày, có nút đóng.
const DAILY_REMINDERS = [
  {
    id: "check-warehouse", time: "16:00", icon: "📋",
    title: "Nhắc kiểm danh sách bốc xếp",
    message: "Đã 16:00 — vui lòng kiểm tra lại danh sách hàng hóa bốc xếp hôm nay (Trong / Ngoài / Hàng ghép) trước khi xe chạy.",
  },
  {
    id: "xuat-ben", time: "16:40", icon: "🚛",
    title: "Nhắc bấm Xuất Bến",
    message: "Đã 16:40 — nhớ bấm \"Xuất Bến\" để chốt chuyến và cập nhật mã đơn tiếp theo cho ngày mới.",
  },
];

// Cộng N ngày cho date YYYY-MM-DD → trả YYYY-MM-DD
const addDaysISO = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Parse day_counter TEXT (vd "A02") → numeric counter cho getDayCode
const parseDayCounterText = (text) => {
  if (!text || typeof text !== 'string') return 1;
  const m = text.match(/^([A-Z])(\d{1,3})$/);
  if (!m) return 1;
  const letterIndex = m[1].charCodeAt(0) - 65;
  const num = parseInt(m[2], 10) || 1;
  return letterIndex * 99 + num;
};

// day_counter kế tiếp: "A02" → "A03"; "A99" → "B01"
const nextDayCounterText = (text) => {
  const counter = parseDayCounterText(text);
  return getDayCode(counter + 1);
};

// Fetch session của branch. Auto-roll nếu business_date < todayVN.
const fetchBranchSession = async (branchId) => {
  if (!branchId) return null;
  try {
    const { data: row, error } = await supabase
      .from('branch_sessions')
      .select('*')
      .eq('branch_id', branchId)
      .maybeSingle();
    if (error) { console.error('fetchBranchSession error:', error); return null; }
    if (!row) return null;
    const todayVN = getVNTodayDate();
    if (row.business_date < todayVN) {
      // Lazy counter: chỉ tăng day_counter nếu chuyến cũ có bill thật (bill_seq > 1).
      // Chuyến rỗng (chỉ có draft hoặc không có gì) không "đốt" mã — giữ nguyên counter.
      const hadBillsLastPeriod = (row.bill_seq || 1) > 1;
      const newCounter = hadBillsLastPeriod ? nextDayCounterText(row.day_counter) : row.day_counter;
      const { data: rolled, error: rollErr } = await supabase
        .from('branch_sessions')
        .update({
          business_date: todayVN,
          day_counter: newCounter,
          bill_seq: 1,
          session_start: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('branch_id', branchId)
        .select().single();
      if (rollErr) { console.error('auto-roll session error:', rollErr); return row; }
      return rolled;
    }
    return row;
  } catch (err) {
    console.error('fetchBranchSession fatal:', err);
    return null;
  }
};

// Xuất Bến: business_date = max(current, todayVN) + 1; day_counter++; bill_seq = 1.
const advanceBranchSession = async (branchId, userId) => {
  if (!branchId) return null;
  try {
    const { data: cur, error: curErr } = await supabase
      .from('branch_sessions')
      .select('day_counter, business_date')
      .eq('branch_id', branchId)
      .single();
    if (curErr || !cur) throw curErr || new Error('Không tìm thấy session chi nhánh');
    const todayVN = getVNTodayDate();
    const baseDate = cur.business_date > todayVN ? cur.business_date : todayVN;
    const newBusinessDate = addDaysISO(baseDate, 1);
    const newCounter = nextDayCounterText(cur.day_counter);
    const { data: rolled, error: updErr } = await supabase
      .from('branch_sessions')
      .update({
        business_date: newBusinessDate,
        day_counter: newCounter,
        bill_seq: 1,
        session_start: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        updated_by: userId || null,
      })
      .eq('branch_id', branchId)
      .select().single();
    if (updErr) throw updErr;
    return rolled;
  } catch (err) {
    console.error('advanceBranchSession error:', err);
    return null;
  }
};

// Build bill_code sync từ session cache: "{seq2}{branchCode}{day_counter}" = "01SGA02"
const buildBillCodeFromSession = (branchCode, session) => {
  if (!branchCode || !session) return '';
  const seqPad = String(session.bill_seq || 1).padStart(2, '0');
  return `${seqPad}${branchCode}${session.day_counter}`;
};

// Sau khi INSERT bill thành công, tăng bill_seq trong DB.
// Race: 2 user concurrent → cả 2 fetch seq=N, cùng set N+1 → next fetch = N+1 → conflict UNIQUE → I-9 retry.
const incrementBillSeqOnDB = async (branchId) => {
  if (!branchId) return null;
  try {
    const { data: cur } = await supabase
      .from('branch_sessions')
      .select('bill_seq')
      .eq('branch_id', branchId)
      .single();
    if (!cur) return null;
    const newSeq = (cur.bill_seq || 0) + 1;
    const { data: updated, error } = await supabase
      .from('branch_sessions')
      .update({ bill_seq: newSeq, updated_at: new Date().toISOString() })
      .eq('branch_id', branchId)
      .select().single();
    if (error) throw error;
    return updated;
  } catch (err) {
    console.error('incrementBillSeqOnDB error:', err);
    return null;
  }
};

// I-9: sau conflict UNIQUE, refetch session (auto-roll nếu qua ngày) → build lại code.
// KHÔNG tự tăng seq — vì conflict = seq hiện tại của DB đã bị người khác lấy → refetch sẽ có seq mới.
const computeBillCodeFromDB = async (branchUUID, branchCode) => {
  const fresh = await fetchBranchSession(branchUUID);
  if (!fresh) return '';
  return buildBillCodeFromSession(branchCode, fresh);
};

// I-9: Kiểm tra lỗi Postgres UNIQUE violation trên (branch_id, bill_code).
const isBillCodeConflict = (err) => {
  if (!err) return false;
  const code = err.code || err.details?.code;
  const msg = (err.message || '') + ' ' + (err.details || '');
  return code === '23505' && /bills_branch_code_uniq|bills_branch_bill_code/i.test(msg);
};

// Lấy ngày hiện tại (giờ VN, KHÔNG lệ thuộc timezone máy/browser) định dạng dd/mm/yyyy
const getTodayFormatted = () => {
const [yyyy, mm, dd] = getVNTodayDate().split('-');
return `${dd}/${mm}/${yyyy}`;
};

// Lấy ngày mai (giờ VN) định dạng dd/mm/yyyy
const getTomorrowFormatted = () => {
const [yyyy, mm, dd] = addDaysISO(getVNTodayDate(), 1).split('-');
return `${dd}/${mm}/${yyyy}`;
};

// Lấy Y-M-D THEO TIMEZONE CỦA MÁY cho 1 Date object cụ thể — dùng cho phép cộng/trừ ngày
// tự-nhất-quán (vd tính "ngày hôm trước") KHÔNG liên quan đến "hôm nay" thực tế.
// KHÔNG dùng hàm này để lấy "hôm nay" — dùng getVNTodayDate() cho việc đó.
const getLocalDateString = (date = new Date()) => {
const yyyy = date.getFullYear();
const mm = String(date.getMonth() + 1).padStart(2, '0');
const dd = String(date.getDate()).padStart(2, '0');
return `${yyyy}-${mm}-${dd}`;
};

// Revamp §17: convert UTC ISO timestamp → VN calendar date (YYYY-MM-DD).
// Postgres created_at là UTC (TIMESTAMPTZ). Ở filter doanh thu, user chọn ngày VN → cần shift +7h trước khi slice.
// KHÔNG dùng cho `business_date` (là DATE column, đã ở VN).
const toVNDate = (ts) => {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return new Date(d.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// Parse dd/mm/yyyy → ISO string (UTC), trả về null nếu sai định dạng
const parseVNDateToISO = (str) => {
if (!str) return null;
const m = String(str).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
if (!m) return null;
const [, dd, mm, yyyy] = m;
const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
if (isNaN(d.getTime())) return null;
return d.toISOString();
};

// ====== DEBT COLLECTION: Group bills by customer (D1–D9 chốt 2026-07-01) ======
// Filter: is_delete=false + delivery_status!='cancelled' + payment_status IN ('unpaid','quote_later').
// Default (includePending=false): chỉ 'delivered'. Toggle ON: thêm 'pending + unpaid'.
// 'pending + quote_later' KHÔNG bao giờ hiện (D4).
// Group key theo thứ tự fallback: receiver_id → sender_id → per-bill anon.
// totalDebt: SUM(shipping_fee - paid) qua các bill của khách, TRỪ bill quote_later (chưa xác định cước).
const groupBillsByCustomer = (bills, includePending) => {
  const filtered = (bills || []).filter((b) => {
    if (!b) return false;
    if (b.is_delete) return false;
    if (b.delivery_status === 'cancelled') return false;
    if (!['unpaid', 'quote_later'].includes(b.payment_status)) return false;
    if (b.delivery_status === 'delivered') return true;
    if (b.delivery_status === 'returned') return true; // add-return-and-destroy-flow: đơn quay đầu chưa thu = công nợ
    if (b.delivery_status === 'pending' && includePending) return true;
    return false;
  });

  const pickName = (obj) => {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (typeof obj === 'object') return obj.fullname || '';
    return '';
  };

  const groups = new Map();
  for (const b of filtered) {
    let key;
    let customerId = null;
    let name = '';
    let phone = '';
    if (b.receiver_id) {
      key = `r:${b.receiver_id}`;
      customerId = b.receiver_id;
      name = pickName(b.receiver) || '(Khách đã xoá)';
      phone = b.receiver_phone?.phone_number || '';
    } else if (b.sender_id) {
      key = `s:${b.sender_id}`;
      customerId = b.sender_id;
      name = pickName(b.sender) || '(Khách đã xoá)';
      phone = b.sender_phone?.phone_number || '';
    } else {
      key = `__anon_${b.id}`;
      name = 'Khách vãng lai';
      phone = '';
    }
    if (!groups.has(key)) {
      groups.set(key, { key, customerId, name, phone, bills: [] });
    } else if (!groups.get(key).phone && phone) {
      // Nếu group đã tạo trước đó chưa có phone → điền từ bill này
      groups.get(key).phone = phone;
    }
    groups.get(key).bills.push(b);
  }

  return Array.from(groups.values()).map((g) => {
    const totalDebt = g.bills.reduce((sum, b) => {
      if (b.payment_status === 'quote_later') return sum;
      const fee = Number(b.shipping_fee || 0) + Number(b.return_fee || 0); // cộng cước hoàn (nếu có)
      const paid = Number(b.actual_amount_paid || 0);
      return sum + Math.max(0, fee - paid);
    }, 0);
    const quoteLaterCount = g.bills.filter((b) => b.payment_status === 'quote_later').length;
    return {
      ...g,
      totalDebt,
      hasQuoteLater: quoteLaterCount > 0,
      quoteLaterCount,
      billCount: g.bills.length,
    };
  });
};

// Helper render tên client an toàn (Fix bug render object)
const displayName = (clientField) => {
if (!clientField) return '—';
if (typeof clientField === 'string') return clientField;
if (typeof clientField === 'object') return clientField.fullname || '—';
return '—';
};

// Định dạng số với dấu chấm ngăn cách (không kèm đơn vị)
const formatNumber = (val) => {
  if (val === "" || val == null) return "";
  const digits = String(val).replace(/\D/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("vi-VN");
};

// Định dạng datetime kiểu "dd/MM/yyyy HH:mm" theo giờ VN (Asia/Ho_Chi_Minh).
// Force timezone để không lệ thuộc timezone của trình duyệt / server.
const formatDateTime = (val) => {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
    timeZone: "Asia/Ho_Chi_Minh",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}`;
};

// ====== DESIGN TOKENS ======
// Hệ thống class thống nhất cho toàn app — neutral gray + accent cam (orange-600)
// Chỉ dùng màu khác (green/amber/red) khi thật sự cần báo trạng thái.
const ui = {
  // Typography
  caption:       "text-[11px] text-gray-500",                                  // metadata, timestamp
  label:         "text-[11px] font-semibold text-gray-500 uppercase tracking-wide", // label trên field
  helper:        "text-xs text-gray-500",                                       // hint / mô tả nhỏ
  body:          "text-sm text-gray-700",                                       // body chính
  value:         "text-sm font-medium text-gray-900",                           // giá trị hiển thị
  valueStrong:   "text-sm font-bold text-gray-900",                             // giá trị quan trọng
  mono:          "font-mono text-sm text-gray-800",                             // SĐT, mã
  sectionTitle:  "text-sm font-bold text-gray-800",                             // tiêu đề card / sub-section
  screenTitle:   "text-base font-bold text-gray-900",                           // tiêu đề screen
  brandValue:    "text-lg font-bold text-orange-600 font-mono tracking-wide",   // mã bill, số nổi bật

  // Cards / containers
  card:          "bg-white border border-gray-200 rounded-lg p-4",
  cardMuted:     "bg-gray-50 border border-gray-200 rounded-lg p-4",
  cardHeader:    "border-l-2 border-orange-500 pl-2",
  divider:       "border-t border-gray-200 pt-5 mt-5",

  // Buttons
  btnPrimary:    "px-4 py-2 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded-md transition",
  btnSecondary:  "px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition",
  btnSuccess:    "px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-md transition",
  btnDanger:     "px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md transition",

  // Alerts (chỉ dùng khi cần thông báo trạng thái)
  alertInfo:     "bg-gray-50 border border-gray-200 text-gray-700 rounded-lg p-3 text-sm",
  alertWarning:  "bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 text-sm",
  alertDanger:   "bg-red-50 border border-red-200 text-red-900 rounded-lg p-3 text-sm",
  alertSuccess:  "bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-lg p-3 text-sm",

  // Inputs
  input:         "w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-orange-500 focus:border-orange-500",

  // Status badges (dùng dot thay vì màu nền lòe loẹt)
  statusPaid:    "inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700",
  statusUnpaid:  "inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700",
  statusFree:    "inline-flex items-center gap-1.5 text-sm font-semibold text-purple-700",
  statusDelivered: "inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700",
  statusPending: "inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700",
  statusCancelled: "inline-flex items-center gap-1.5 text-sm font-semibold text-red-700",
};

// ====== VN DATE INPUT (thay <input type="date"> để hiển thị dd/mm/yyyy) ======
// Chrome/Edge quyết định format date input theo browser UI language, KHÔNG theo <html lang>.
// Nên ta dùng text input + mask + parse thủ công để force dd/mm/yyyy.
// API tương thích: value/onChange nhận YYYY-MM-DD (giống <input type="date">).

const formatISODateToVN = (iso) => {
  if (!iso || typeof iso !== 'string') return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
};

const parseVNDateToISODate = (vn) => {
  if (!vn || typeof vn !== 'string') return '';
  const m = vn.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  const yyyy = m[3];
  const dNum = Number(dd), mNum = Number(mm), yNum = Number(yyyy);
  if (dNum < 1 || dNum > 31 || mNum < 1 || mNum > 12 || yNum < 1900 || yNum > 3000) return '';
  const d = new Date(yNum, mNum - 1, dNum);
  if (d.getFullYear() !== yNum || d.getMonth() !== mNum - 1 || d.getDate() !== dNum) return '';
  return `${yyyy}-${mm}-${dd}`;
};

// Auto-mask: user gõ chỉ chữ số → tự chèn dấu / thành dd/mm/yyyy
const applyDateMask = (raw) => {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
};

const VN_WEEKDAYS = ["CN", "T2", "T3", "T4", "T5", "T6", "T7"];

// Ngày hôm nay theo giờ local, dạng YYYY-MM-DD.
const localTodayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

// Tên chi nhánh đầy đủ (không viết tắt) để hiển thị.
const branchFullName = (code) =>
  code === "SG" ? "Sài Gòn" : code === "GL" ? "Gia Lai" : code === "ALL" ? "Cả 2 chi nhánh" : code;

// "YYYY-MM" → "MM/YYYY" (hoặc sep khác, ví dụ "MM-YYYY").
const formatMonthDisplay = (ym, sep = "/") => {
  const [y, m] = (ym || "").split("-");
  return (m && y) ? `${m}${sep}${y}` : (ym || "");
};

// Ô nhập tiền (VND) có định dạng ngàn: state cục bộ để không nhảy con trỏ / mất ký tự khi gõ nhanh.
function MoneyInput({ value, onChange, className, placeholder, required, autoFocus }) {
  // Nhập theo đơn vị NGHÌN: gõ 5 → 5.000, 50 → 50.000 (tự thêm "000" ở đuôi).
  // base = phần người dùng gõ; giá trị thật phát ra = base * 1000.
  const SUFFIX = ".000";
  const toBase = (v) => {
    const n = Number(v);
    if (!v || !n) return "";
    return String(Math.round(n / 1000));
  };
  const [base, setBase] = useState(() => toBase(value));
  const focusedRef = useRef(false);
  const inputRef = useRef(null);
  useEffect(() => {
    if (!focusedRef.current) setBase(toBase(value));
  }, [value]);

  const display = base === "" ? "" : formatNumber(base) + SUFFIX;

  // Đặt con trỏ ngay trước ".000" để gõ/xoá luôn tác động vào phần base.
  const pinCursor = (baseStr) => {
    const el = inputRef.current;
    if (!el) return;
    const pos = baseStr === "" ? 0 : formatNumber(baseStr).length;
    requestAnimationFrame(() => { try { el.setSelectionRange(pos, pos); } catch (_) { /* ignore */ } });
  };

  const handleChange = (e) => {
    let digits = e.target.value.replace(/\D/g, "");
    // Bỏ tối đa 3 số 0 ở đuôi (phần "000" tự thêm) để lấy lại base người gõ.
    if (digits) digits = digits.replace(/0{1,3}$/, "");
    const newBase = digits;
    setBase(newBase);
    onChange(newBase === "" ? "" : String(Number(newBase) * 1000));
    if (newBase !== "") pinCursor(newBase);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      autoFocus={autoFocus}
      required={required}
      placeholder={placeholder}
      className={className}
      value={display}
      onFocus={() => { focusedRef.current = true; if (base !== "") pinCursor(base); }}
      onChange={handleChange}
      onBlur={() => { focusedRef.current = false; }}
    />
  );
}

// Tooltip hiện NGAY khi hover (không có delay ~1s như thuộc tính title mặc định).
// Dùng portal để không bị container overflow của bảng cắt.
function HoverTooltip({ label, children, className }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState(null);
  const ref = useRef(null);
  const showTip = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: r.left + r.width / 2, top: r.top - 6 });
    setShow(true);
  };
  const hideTip = () => setShow(false);
  return (
    <span ref={ref} onMouseEnter={showTip} onMouseLeave={hideTip} className={`inline-block cursor-help ${className || ""}`}>
      {children}
      {show && pos && createPortal(
        <div
          className="pointer-events-none bg-gray-900 text-white text-[11px] font-normal px-2 py-1 rounded shadow-lg max-w-xs whitespace-normal"
          style={{ position: "fixed", left: pos.left, top: pos.top, transform: "translate(-50%, -100%)", zIndex: 9999 }}
        >
          {label}
        </div>,
        document.body
      )}
    </span>
  );
}

// Ô "Hàng Ghép": state cục bộ để gõ không bị realtime refetch ghi đè; chỉ lưu DB khi rời ô.
function CombinedGoodsInput({ value, disabled, onSave, title }) {
  const [text, setText] = useState(value ?? '');
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) setText(value ?? '');
  }, [value]);
  return (
    <input
      type="text"
      value={text}
      disabled={disabled}
      onFocus={() => { focusedRef.current = true; }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => { focusedRef.current = false; onSave(text); }}
      className="w-16 px-2 py-1 text-sm text-center border-2 border-gray-300 rounded bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
      title={title}
    />
  );
}

function VNDateInput({ value, onChange, className, placeholder, ...rest }) {
  const [text, setText] = useState(() => formatISODateToVN(value));
  const [open, setOpen] = useState(false);
  const [viewYM, setViewYM] = useState(() => {
    const base = (value && /^\d{4}-\d{2}/.test(value)) ? value : localTodayISO();
    const [y, m] = base.split("-").map(Number);
    return { y, m };
  });
  const skipNextSyncRef = useRef(false);
  const wrapRef = useRef(null);
  const popupRef = useRef(null);
  const [pos, setPos] = useState(null); // { left, top, width } cho popup fixed (tránh bị cha overflow cắt)

  useEffect(() => {
    if (skipNextSyncRef.current) {
      skipNextSyncRef.current = false;
      return;
    }
    setText(formatISODateToVN(value));
  }, [value]);

  useEffect(() => {
    if (open && value && /^\d{4}-\d{2}/.test(value)) {
      const [y, m] = value.split("-").map(Number);
      setViewYM({ y, m });
    }
  }, [open]);

  // Tính vị trí popup theo ô input (fixed), kẹp trong viewport, cập nhật khi cuộn/resize.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const popW = 272, popH = 320, margin = 8;
      let left = r.left;
      if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
      if (left < margin) left = margin;
      let top = r.bottom + 4;
      if (top + popH > window.innerHeight - margin) {
        const above = r.top - popH - 4;
        if (above >= margin) top = above;
      }
      setPos({ left, top, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const emit = (nextIso) => {
    skipNextSyncRef.current = true;
    onChange({ target: { value: nextIso } });
  };

  const handleChange = (e) => {
    const masked = applyDateMask(e.target.value);
    setText(masked);
    if (masked === '') { emit(''); return; }
    const iso = parseVNDateToISODate(masked);
    if (iso) emit(iso);
  };

  const handleBlur = () => {
    if (text === '') return;
    const iso = parseVNDateToISODate(text);
    if (!iso) setText(formatISODateToVN(value));
  };

  const pick = (y, m, d) => {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    setText(formatISODateToVN(iso));
    emit(iso);
    setOpen(false);
  };

  const prevMonth = () => setViewYM(v => v.m === 1 ? { y: v.y - 1, m: 12 } : { y: v.y, m: v.m - 1 });
  const nextMonth = () => setViewYM(v => v.m === 12 ? { y: v.y + 1, m: 1 } : { y: v.y, m: v.m + 1 });

  const firstDow = new Date(viewYM.y, viewYM.m - 1, 1).getDay();
  const daysInMonth = new Date(viewYM.y, viewYM.m, 0).getDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const todayISO = localTodayISO();
  // Dropdown năm: 2020 → năm nay +2, mở rộng nếu view đang ở ngoài khoảng.
  const nowY = new Date().getFullYear();
  const ymYears = [];
  for (let y = Math.min(2020, viewYM.y); y <= Math.max(nowY + 2, viewYM.y); y++) ymYears.push(y);

  return (
    <span
      ref={wrapRef}
      className="relative"
      style={{ display: /\bw-full\b/.test(className || '') ? 'block' : 'inline-block' }}
    >
      <input
        type="text"
        value={text}
        onChange={handleChange}
        onBlur={handleBlur}
        placeholder={placeholder || 'dd/mm/yyyy'}
        inputMode="numeric"
        maxLength={10}
        className={className}
        style={{ paddingRight: '1.75rem' }}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        tabIndex={-1}
        title="Chọn từ lịch"
        aria-label="Mở lịch chọn ngày"
        className="absolute top-1/2 -translate-y-1/2 right-1.5 p-0.5 text-gray-400 hover:text-orange-600 leading-none"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="bg-white border rounded-lg shadow-xl p-2 text-sm"
          style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: '16rem', zIndex: 9999 }}
        >
          <div className="flex items-center justify-between mb-2 gap-1">
            <button type="button" onClick={prevMonth} className="px-2 py-1 rounded hover:bg-gray-100 text-orange-600 font-bold">‹</button>
            <div className="flex items-center gap-1">
              <select
                value={viewYM.m}
                onChange={(e) => setViewYM(v => ({ ...v, m: Number(e.target.value) }))}
                className="border rounded px-1 py-0.5 text-sm font-semibold text-gray-800 outline-none focus:border-orange-500 cursor-pointer"
              >
                {Array.from({ length: 12 }, (_, i) => i + 1).map(m => <option key={m} value={m}>Tháng {m}</option>)}
              </select>
              <select
                value={viewYM.y}
                onChange={(e) => setViewYM(v => ({ ...v, y: Number(e.target.value) }))}
                className="border rounded px-1 py-0.5 text-sm font-semibold text-gray-800 outline-none focus:border-orange-500 cursor-pointer"
              >
                {ymYears.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button type="button" onClick={nextMonth} className="px-2 py-1 rounded hover:bg-gray-100 text-orange-600 font-bold">›</button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center text-[11px] font-semibold text-gray-500 mb-1">
            {VN_WEEKDAYS.map(w => <div key={w}>{w}</div>)}
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />;
              const iso = `${viewYM.y}-${String(viewYM.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isSel = value === iso;
              const isToday = todayISO === iso;
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => pick(viewYM.y, viewYM.m, d)}
                  className={`py-1 rounded text-sm transition ${isSel ? 'bg-orange-500 text-white font-bold' : isToday ? 'ring-1 ring-orange-400 text-orange-700 hover:bg-orange-50' : 'hover:bg-orange-100 text-gray-700'}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
          <div className="flex justify-between mt-2 pt-2 border-t text-xs font-semibold">
            <button
              type="button"
              onClick={() => { const t = todayISO; const [y, m, d] = t.split('-').map(Number); pick(y, m, d); }}
              className="text-orange-600 hover:underline"
            >Hôm nay</button>
            <button
              type="button"
              onClick={() => { setText(''); emit(''); setOpen(false); }}
              className="text-gray-500 hover:underline"
            >Xóa</button>
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}

// ====== VN MONTH INPUT (thay <input type="month">) — popup chọn tháng tiếng Việt ======
// value/onChange nhận "YYYY-MM" (giống <input type="month">).
function VNMonthInput({ value, onChange, className }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const popupRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [viewYear, setViewYear] = useState(() =>
    (value && /^\d{4}-\d{2}/.test(value)) ? Number(value.slice(0, 4)) : new Date().getFullYear()
  );

  useEffect(() => {
    if (open && value && /^\d{4}-\d{2}/.test(value)) setViewYear(Number(value.slice(0, 4)));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const update = () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return;
      const popW = 240, popH = 200, margin = 8;
      let left = r.left;
      if (left + popW > window.innerWidth - margin) left = window.innerWidth - popW - margin;
      if (left < margin) left = margin;
      let top = r.bottom + 4;
      if (top + popH > window.innerHeight - margin) {
        const above = r.top - popH - 4;
        if (above >= margin) top = above;
      }
      setPos({ left, top, width: r.width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (wrapRef.current && wrapRef.current.contains(e.target)) return;
      if (popupRef.current && popupRef.current.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const curY = value && /^\d{4}-\d{2}/.test(value) ? Number(value.slice(0, 4)) : null;
  const curM = value && /^\d{4}-\d{2}/.test(value) ? Number(value.slice(5, 7)) : null;
  const pick = (m) => { onChange({ target: { value: `${viewYear}-${String(m).padStart(2, "0")}` } }); setOpen(false); };
  const label = (value && /^\d{4}-\d{2}/.test(value)) ? `Tháng ${Number(value.slice(5, 7))}/${value.slice(0, 4)}` : "Chọn tháng";
  const nowY = new Date().getFullYear();
  const yearOpts = [];
  for (let y = Math.min(2020, viewYear); y <= Math.max(nowY + 2, viewYear); y++) yearOpts.push(y);

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button type="button" onClick={() => setOpen(o => !o)} className={(className || "") + " text-left"}>
        {label}
      </button>
      {open && pos && createPortal(
        <div
          ref={popupRef}
          className="bg-white border rounded-lg shadow-xl p-2"
          style={{ position: 'fixed', left: pos.left, top: pos.top, minWidth: '14rem', zIndex: 9999 }}
        >
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={() => setViewYear(y => y - 1)} className="px-2 py-1 rounded hover:bg-gray-100 text-orange-600 font-bold">‹</button>
            <select
              value={viewYear}
              onChange={(e) => setViewYear(Number(e.target.value))}
              className="border rounded px-1 py-0.5 text-sm font-bold text-gray-800 outline-none focus:border-orange-500 cursor-pointer"
            >
              {yearOpts.map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button type="button" onClick={() => setViewYear(y => y + 1)} className="px-2 py-1 rounded hover:bg-gray-100 text-orange-600 font-bold">›</button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map(m => (
              <button
                key={m}
                type="button"
                onClick={() => pick(m)}
                className={`py-1.5 rounded text-sm transition ${curY === viewYear && curM === m ? 'bg-orange-500 text-white font-bold' : 'hover:bg-orange-100 text-gray-700'}`}
              >
                Tháng {m}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </span>
  );
}

export default function App() {
// --- AUTH STATE (Custom: query bảng public.users) ---
// Khởi tạo session đồng bộ từ localStorage để tránh flash mã bill chi nhánh sai
// (nếu đọc trong useEffect, render đầu tiên sẽ dùng default "SG")
const [session, setSession] = useState(() => {
  try {
    const raw = localStorage.getItem("hc_session");
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
});
const [authLoading, setAuthLoading] = useState(false);
const [recoveryMode, setRecoveryMode] = useState(false); // mở app từ link quên mật khẩu

const userRole = session?.role || "member"; // admin | member | boss
const userFullname = session?.full_name || session?.username || "User";
const loggedBranch = session?.branch_code || "SG"; // SG | GL

const [currentTab, setCurrentScreenRaw] = useState(() => {
  // Landing screen theo role, kể cả khi refresh trang (session khôi phục từ localStorage).
  try {
    const raw = localStorage.getItem("hc_session");
    const sess = raw ? JSON.parse(raw) : null;
    if (sess?.role === "sys_admin") return "sys-admin";
    if (sess?.role === "boss") return "revenue";
  } catch (_) { /* fallback bên dưới */ }
  return "bills"; // 'clients' | 'bills' | 'warehouse' | 'all-bills' | 'revenue' | 'debt'
});
const [sidebarOpen, setSidebarOpen] = useState(false);
const setCurrentScreen = (s) => { setCurrentScreenRaw(s); setSidebarOpen(false); };
const [currentBranch, setCurrentBranch] = useState(loggedBranch);
const [loading, setLoading] = useState(false);

// --- TRẠNG THÁI TOAST & MODAL (FIX BUG ALERT / CONFIRM) ---
const [toastMessage, setToastMessage] = useState("");
const [toastType, setToastType] = useState("success"); // success | error
const [confirmDialog, setConfirmDialog] = useState(null); // { title, message, onConfirm, confirmText, danger }
const [cancelDialog, setCancelDialog] = useState(null);   // { bill, reason } — dialog hủy đơn có input lý do
// Popup hoàn hàng / tiêu hủy. { bill, step:'choose'|'return'|'destroy', returnFee, reason }
const [returnDialog, setReturnDialog] = useState(null);
// sys_admin sửa lại cước hoàn (về) trên đơn returned. null = không sửa; string = đang sửa.
const [editReturnFee, setEditReturnFee] = useState(null);
// Nhắc nhở hằng ngày (16:00 kiểm bốc xếp, 16:40 xuất bến). { id, title, message, icon } | null
const [dailyReminder, setDailyReminder] = useState(null);
// Chống double-submit (tạo đơn / xuất bến / lưu nháp): ref chặn đồng thời + state để disable nút.
const [isSubmitting, setIsSubmitting] = useState(false);
const submittingRef = useRef(false);
// Popup xác nhận xuất bến khi tạo đơn sau CUTOFF. { branch, billData, mode: 'create'|'convert', draftId? }
const [departureConfirmDialog, setDepartureConfirmDialog] = useState(null);

// --- TRẠNG THÁI HỆ THỐNG ---
// add-server-session: session sống trên DB. Chỉ cache local để build bill_code UI nhanh.
const [branchIdByCode, setBranchIdByCode] = useState({});  // { SG: uuid, GL: uuid }
const [branchInfoById, setBranchInfoById] = useState({});  // { <uuid>: { address, hotline } }
const [branchSessions, setBranchSessions] = useState({});  // { SG: sessionRow, GL: sessionRow }
const [reservedBillCode, setReservedBillCode] = useState(""); // Mã bill đã reserve (preview = thật)

// --- TRẠNG THÁI DỮ LIỆU THỰC TẾ ---
const [clients, setClients] = useState([]);
const [bills, setBills] = useState([]);
const [expenses, setExpenses] = useState([]);
// Revamp §5: doanh thu tính từ bill_payment_details thay vì bills.shipping_fee
const [payments, setPayments] = useState([]);

// --- FILTERS cho TỔNG HỢP ĐƠN HÀNG ---
const [allBillsTab, setAllBillsTab] = useState(loggedBranch || "SG"); // "SG" | "GL"
const [allBillsPage, setAllBillsPage] = useState(1);
const BILLS_PER_PAGE = 100;
const [allBillsFilter, setAllBillsFilter] = useState({
  billCode: "",
  delivery: "all",      // "all" | "delivered" | "pending" | "draft" | "cancelled"
  payment: "all",       // "all" | "paid" | "unpaid"
  businessFrom: "",
  businessTo: "",
  deliveryFrom: "",
  deliveryTo: "",
  phone: "",
  homeDeliveryOnly: false, // Toggle: chỉ hiện đơn giao tận nhà chưa giao
});

// --- FORM TẠO ĐƠN HÀNG (TAB 7.1) ---
const [activeSubTab, setActiveSubTab] = useState("create");
const [senderName, setSenderName] = useState("");
const [senderPhone, setSenderPhone] = useState("");
const [receiverName, setReceiverName] = useState("");
const [receiverPhone, setReceiverPhone] = useState("");
const [sendDate, setSendDate] = useState(getTodayFormatted());
const [expectedDeliveryDate, setExpectedDeliveryDate] = useState(getTomorrowFormatted());
const [goodsType, setGoodsType] = useState("");
const [goodsValue, setGoodsValue] = useState("");
const [shippingFee, setShippingFee] = useState("");
const [packageCount, setPackageCount] = useState("");
const [isHomeDelivery, setIsHomeDelivery] = useState(false);
const [deliveryAddress, setDeliveryAddress] = useState("");
const [isPaidImmediately, setIsPaidImmediately] = useState(false);
const [isFreeShipping, setIsFreeShipping] = useState(false);   // đơn miễn phí (không thu cước)
const [feeQuoteLater, setFeeQuoteLater] = useState(false);     // báo giá cước sau
const [specialStars, setSpecialStars] = useState(0);
const [starsManual, setStarsManual] = useState(false);
const [requireIdCheck, setRequireIdCheck] = useState(false);
const [riskWarning, setRiskWarning] = useState(false);          // rủi ro bể vỡ
const [selfPacked, setSelfPacked] = useState(false);            // khách tự đóng gói
const [noDeclaredValue, setNoDeclaredValue] = useState(false);  // không kê khai giá trị
const [exportVat, setExportVat] = useState(false);              // xuất VAT
const [orderNote, setOrderNote] = useState("");                 // ghi chú đơn
const [showBillPreview, setShowBillPreview] = useState(false);  // hiển thị biên nhận in
const [billPreviewSingle, setBillPreviewSingle] = useState(false); // true = chỉ in 1 bản (bill giao cho khách)
const [showRevenueDetail, setShowRevenueDetail] = useState(false); // modal chi tiết doanh thu

// --- MÀN CÔNG NỢ (add-debt-collection-screen) ---
const [debtQuery, setDebtQuery] = useState("");
const [debtIncludePending, setDebtIncludePending] = useState(false);
const [debtSortMode, setDebtSortMode] = useState("debt_desc"); // 'debt_desc' | 'debt_asc'
const [debtExpanded, setDebtExpanded] = useState(() => new Set());
const [debtRefreshing, setDebtRefreshing] = useState(false);

// --- FORM THÀNH VIÊN KHÁCH HÀNG (SCREEN 6) ---
const [newClientName, setNewClientName] = useState("");
const [newClientPhone, setNewClientPhone] = useState("");
const [newClientPhoneSec, setNewClientPhoneSec] = useState("");
// add-client-phone-history §2.1: lưu list SĐT cũ (read-only) của khách đang edit.
// Populate từ DB khi enter edit mode + append optimistic khi user demote số chính/phụ.
const [newClientOldPhones, setNewClientOldPhones] = useState([]);
const [newClientAddress, setNewClientAddress] = useState("");
const [isBlacklist, setIsBlacklist] = useState(false);
const [blacklistReason, setBlacklistReason] = useState("");
const [editingClientId, setEditingClientId] = useState(null);
const [clientSearch, setClientSearch] = useState("");
const [clientPage, setClientPage] = useState(1);
const CLIENTS_PER_PAGE = 50;
const [warehouseBranch, setWarehouseBranch] = useState(loggedBranch); // SG | GL
const [warehouseDate, setWarehouseDate] = useState(getVNTodayDate());
const [warehousePage, setWarehousePage] = useState(1);
const WAREHOUSE_PER_PAGE = 150;

// --- FORM CHI TIẾT THANH TOÁN / GIAO NHẬN (TAB 7.2) ---
const [selectedBill, setSelectedBill] = useState(null);
const [previousTab, setPreviousTab] = useState(null); // nhớ tab trước đó để "Quay lại" đúng chỗ
const [editingDraftId, setEditingDraftId] = useState(null); // ID của bill draft đang chỉnh sửa
const [editingBillId, setEditingBillId] = useState(null);   // ID của bill chính thức (pending+unpaid) admin đang sửa
const [editingBillCode, setEditingBillCode] = useState(""); // mã bill gốc để hiển thị khi edit
// Đơn "chưa có cước" (quote_later): member/admin chỉ được sửa đúng ô cước phí, không đụng field khác.
const [feeOnlyEditMode, setFeeOnlyEditMode] = useState(false);
// N-4: snapshot form state khi admin bấm "Sửa Đơn" để tính diff trước khi submit
const editBillSnapshotRef = useRef(null);
// add-audit-log §5.4: refresh key để force re-fetch audit_log sau mỗi mutation
const [billHistoryRefreshKey, setBillHistoryRefreshKey] = useState(0);
const [clientHistoryRefreshKey, setClientHistoryRefreshKey] = useState(0);
const [expenseHistoryRefreshKey, setExpenseHistoryRefreshKey] = useState(0);
// Lịch sử audit phiếu chi — theo KỲ đang xem (ngày/tháng/năm + chi nhánh), KHÔNG theo từng phiếu
// (phiếu bị xoá mềm vẫn phải giữ được lịch sử, xem §14.19 fix).
const [expensePeriodAudit, setExpensePeriodAudit] = useState([]);
const [expensePeriodAuditLoading, setExpensePeriodAuditLoading] = useState(false);
const [expensePeriodAuditError, setExpensePeriodAuditError] = useState(null);
const [editDiffList, setEditDiffList] = useState([]);        // [{ field, label, oldFormatted, newFormatted }]
const [pendingEditBillData, setPendingEditBillData] = useState(null); // billData chờ user confirm
const [showEditDiffModal, setShowEditDiffModal] = useState(false);
const [payOption, setPayOption] = useState(""); // "" | full | unpaid | actual  — KHÔNG default, bắt user chọn
const [actualAmountPaid, setActualAmountPaid] = useState("");
const [recipientType, setRecipientType] = useState(""); // "" | self | helper — KHÔNG default, bắt user chọn
const [repName, setRepName] = useState("");
const [repPhone, setRepPhone] = useState("");
const [repRole, setRepRole] = useState(""); // revamp: default rỗng, admin/user tự nhập/chọn "Shipper / Người thân / ..." khi recipientType='helper'
// (§10.1) State `deliveryDate` đã gỡ — không render ở UI; delivery_date DB set = now() trong handleConfirmDelivery.
// Revamp §3.4 + §D8: ghi chú thanh toán riêng (chỉ dùng khi thu nợ delivered+unpaid → paid)
const [paymentNote, setPaymentNote] = useState("");

// --- FORM CHI TIÊU ---
const [expAmount, setExpAmount] = useState("");
const [expNote, setExpNote] = useState("");
// expand-revenue-reporting: category + loại kỳ (ngày/tháng) cho phiếu chi
const [expCategoryId, setExpCategoryId] = useState("");
const [expPeriodType, setExpPeriodType] = useState("day"); // 'day' | 'month'
const [expPeriodMonth, setExpPeriodMonth] = useState(() => getVNTodayDate().slice(0, 7)); // "YYYY-MM"
// Revamp §18: state cho edit + soft-delete expense
const [editingExpense, setEditingExpense] = useState(null); // {id, amount, note, created_at, branch_id, branch_code}
const [expEditAmount, setExpEditAmount] = useState("");
const [expEditNote, setExpEditNote] = useState("");
const [expEditCategoryId, setExpEditCategoryId] = useState("");
const [confirmDeleteExpense, setConfirmDeleteExpense] = useState(null); // expense object hoặc null
// expand-revenue-reporting: danh mục chi phí + khóa sổ tháng
const [expenseCategories, setExpenseCategories] = useState([]); // [{id, name, is_active}]
const [monthlyCloses, setMonthlyCloses] = useState([]);          // [{branch_id, period_month, status}]
const [monthClosePrompt, setMonthClosePrompt] = useState(null);  // { branchCode, periodMonth, daysLeft } | null
const [monthCloseDismissed, setMonthCloseDismissed] = useState(() => new Set()); // keys "SG:2026-10" boss đã bấm "Chưa"

// --- MÀN DOANH THU: tab + lọc ngày/tháng/năm ---
const [revenueTab, setRevenueTab] = useState(loggedBranch === "GL" ? "GL" : "SG");
const [revenueFilterType, setRevenueFilterType] = useState("day"); // "day" | "month" | "year"
const [revenueDate, setRevenueDate] = useState(getVNTodayDate());
const [revenueMonth, setRevenueMonth] = useState(() => getVNTodayDate().slice(0, 7));
const [revenueYear, setRevenueYear] = useState(() => getVNTodayDate().slice(0, 4));
const [revenueDetailPage, setRevenueDetailPage] = useState(1);
const REVENUE_BILLS_PER_PAGE = 100;

// (Session đã được khôi phục đồng bộ trong useState initializer ở trên)

// add-supabase-auth-and-rls: sync với Supabase Auth
// Cache localStorage 'hc_session' vẫn dùng cho UI + auditLog, NHƯNG source of truth là Supabase Auth JWT.
// Nếu Auth session không còn (refresh token expired, signOut từ tab khác, cache stale) → clear cache + force LoginScreen.
useEffect(() => {
  let unsub = null;
  (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const cached = (() => {
        try { return JSON.parse(localStorage.getItem("hc_session") || "null"); } catch { return null; }
      })();
      if (!data.session) {
        // Auth expired / signed out → clear cache
        if (cached) {
          localStorage.removeItem("hc_session");
          setSession(null);
        }
      } else if (cached && cached.id !== data.session.user.id) {
        // Cache lệch id (data cũ trước migration) → clear để force login lại
        localStorage.removeItem("hc_session");
        setSession(null);
        await supabase.auth.signOut();
      } else if (data.session && cached) {
        // Re-fetch profile → cập nhật cache nếu admin đã đổi full_name/role/branch của user này.
        try {
          const { data: prof } = await supabase
            .from("profiles")
            .select("id, username, full_name, role, branch_id, branches:branch_id(branch_code)")
            .eq("id", data.session.user.id)
            .single();
          if (prof) {
            const fresh = {
              id: prof.id,
              username: prof.username,
              full_name: prof.full_name,
              role: prof.role,
              branch_id: prof.branch_id,
              branch_code: prof.branches?.branch_code || cached.branch_code || null,
            };
            const changed = ["full_name", "role", "branch_id", "branch_code", "username"]
              .some((k) => cached[k] !== fresh[k]);
            if (changed) {
              localStorage.setItem("hc_session", JSON.stringify(fresh));
              setSession(fresh);
            }
          }
        } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }

    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        localStorage.removeItem("hc_session");
        setSession(null);
      } else if (event === "PASSWORD_RECOVERY") {
        // Mở app từ link "quên mật khẩu" → hiện màn đặt lại mật khẩu.
        setRecoveryMode(true);
      }
    });
    unsub = sub;
  })();
  return () => { unsub?.subscription?.unsubscribe?.(); };
}, []);

// add-server-session §3: Sau login, load branchId map + session cho 2 chi nhánh.
// Admin cần cả SG+GL vì có thể switch tab. Staff chỉ cần chi nhánh mình.
useEffect(() => {
  if (!session) return;
  (async () => {
    try {
      const { data: branches } = await supabase
        .from('branches')
        .select('id, branch_code, address, hotline, address_note');
      if (!branches) return;
      const idMap = Object.fromEntries(branches.map(b => [b.branch_code, b.id]));
      setBranchIdByCode(idMap);
      // Cache branch info (address, hotline, note) để snapshot lúc tạo bill.
      const infoMap = Object.fromEntries(branches.map(b => [b.id, {
        address: b.address || null,
        hotline: b.hotline || null,
        address_note: b.address_note || null,
      }]));
      setBranchInfoById(infoMap);
      const codes = session.role === 'admin' ? ['SG', 'GL'] : [session.branch_code].filter(Boolean);
      const results = await Promise.all(
        codes.map(code => idMap[code] ? fetchBranchSession(idMap[code]).then(s => [code, s]) : Promise.resolve([code, null]))
      );
      const sess = {};
      for (const [code, s] of results) if (s) sess[code] = s;
      setBranchSessions(sess);
    } catch (err) {
      console.error('Load branch sessions error:', err);
    }
  })();
}, [session?.id]);

// Khi user login, đồng bộ currentBranch theo chi nhánh của user
useEffect(() => {
  if (session) setCurrentBranch(loggedBranch);
}, [session?.id, loggedBranch]);

// Đồng bộ tab chi nhánh theo currentBranch khi login (Fix: NV GL mở app luôn thấy tab GL)
useEffect(() => {
  if (session?.branch_code) {
    setWarehouseBranch(session.branch_code);
    setAllBillsTab(session.branch_code);
    setRevenueTab(session.branch_code);
  }
}, [session?.id]);

// Tải dữ liệu thực tế từ Supabase khi đã có session
useEffect(() => {
  if (session) fetchData();
}, [session]);

// Tự đồng bộ: Realtime (cần bật publication, xem enable-realtime.sql) + refetch khi quay lại tab.
const fetchDataRef = useRef(null);
useEffect(() => {
  if (!session) return;
  let timer = null;
  const scheduleRefetch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fetchDataRef.current?.({ silent: true }), 800);
  };
  const channel = supabase.channel("app-data-sync");
  ["bills", "bill_payment_details", "expenses", "clients", "client_phones", "branch_sessions"].forEach((table) => {
    channel.on("postgres_changes", { event: "*", schema: "public", table }, scheduleRefetch);
  });
  channel.subscribe();
  const onVisible = () => {
    if (document.visibilityState === "visible") scheduleRefetch();
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("online", scheduleRefetch);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("online", scheduleRefetch);
    supabase.removeChannel(channel);
  };
}, [session?.id]);

// add-server-session: Khi đổi branch (admin switch), refresh session cache cho branch mới rồi rebuild reservedBillCode.
useEffect(() => {
  if (!session || !currentBranch) return;
  const bId = branchIdByCode[currentBranch];
  if (!bId) return;
  (async () => {
    const sess = await fetchBranchSession(bId);
    if (sess) setBranchSessions(prev => ({ ...prev, [currentBranch]: sess }));
  })();
}, [currentBranch, session?.id, branchIdByCode]);

// Reserve mã bill khi mở form tạo đơn (Fix bug mã preview khác mã thật)
useEffect(() => {
  if (session && currentTab === "bills" && activeSubTab === "create") {
    reserveBillCode();
  }
}, [session, currentTab, activeSubTab, currentBranch, branchSessions]);

// Sync form Thanh toán/Phát hàng với data của bill đang chọn
// → tránh hiện default "full"/"self" đè lên giá trị đã lưu trong DB
useEffect(() => {
  if (!selectedBill) {
    setPayOption("");
    setActualAmountPaid("");
    setRecipientType("");
    setRepName("");
    setRepPhone("");
    setRepRole("");
    setPaymentNote("");
    return;
  }
  // Không set default cho payOption — bắt user chọn khi Hoàn tất giao hàng.
  // Ngoại lệ: pre-paid/free hiển thị radio khóa sẵn trong JSX, không phụ thuộc payOption.
  setPayOption("");
  setActualAmountPaid("");
  // Load recipient CHỈ khi bill đã giao; pending → luôn rỗng (bắt user chọn khi Hoàn tất giao).
  if (selectedBill.delivery_status === "delivered") {
    setRecipientType(selectedBill.recipient_type || "");
    setRepName(selectedBill.actual_recipient_name || "");
    setRepPhone(selectedBill.actual_recipient_phone || "");
    setRepRole(selectedBill.actual_recipient_role || "");
  } else {
    setRecipientType("");
    setRepName("");
    setRepPhone("");
    setRepRole("");
  }
  setPaymentNote("");
  // (§10.1) Không cần sync deliveryDate nữa — đã gỡ state.
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [selectedBill?.id]);

// Fix #3: Clear địa chỉ giao hàng khi đổi người nhận
useEffect(() => {
  if (receiverName.trim()) {
    setDeliveryAddress("");
  }
}, [receiverName]);

// N-1 fix (fix-shipment-intake-issues §9.2): Ngày giao dự kiến auto-derive = sendDate + 1.
// Cho phép user override thủ công sau khi useEffect chạy (chỉ chạy khi sendDate thay đổi).
useEffect(() => {
  if (!sendDate || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(sendDate.trim())) return;
  const m = sendDate.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  if (isNaN(d.getTime())) return;
  d.setDate(d.getDate() + 1);
  const nd = String(d.getDate()).padStart(2, '0');
  const nm = String(d.getMonth() + 1).padStart(2, '0');
  const ny = d.getFullYear();
  setExpectedDeliveryDate(`${nd}/${nm}/${ny}`);
}, [sendDate]);

// Reset form tạo đơn khi rời tab "Phiếu Gửi Hàng" — lần sau quay lại sẽ ở mode tạo mới
useEffect(() => {
  if (currentTab !== "bills") {
    setSelectedBill(null);
    resetCreateBillForm();
  }
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [currentTab]);

// Fix #7: Clear form khi logout
useEffect(() => {
  if (!session) {
    setSenderName("");
    setSenderPhone("");
    setReceiverName("");
    setReceiverPhone("");
    setSendDate(getTodayFormatted());
    setExpectedDeliveryDate(getTomorrowFormatted());
    setGoodsType("");
    setGoodsValue("");
    setShippingFee("");
    setPackageCount("");
    setIsHomeDelivery(false);
    setDeliveryAddress("");
    setIsPaidImmediately(false);
    setIsFreeShipping(false);
    setFeeQuoteLater(false);
    setRequireIdCheck(false);
    setStarsManual(false);
    setSpecialStars(0);
    setRiskWarning(false);
    setSelfPacked(false);
    setNoDeclaredValue(false);
    setExportVat(false);
    setOrderNote("");
  }
}, [session]);

// Callback truyền cho LoginScreen để gán session sau khi login OK
const handleLoginSuccess = (sess) => {
  localStorage.setItem("hc_session", JSON.stringify(sess));
  setSession(sess);
  // Sys_admin landing = trang Quản Trị; boss landing = Quản Lý Doanh Thu; các role khác landing = Phiếu Gửi Hàng
  if (sess.role === "sys_admin") {
    setCurrentScreen("sys-admin");
  } else if (sess.role === "boss") {
    setCurrentScreen("revenue");
  } else {
    setCurrentScreen("bills");
    setActiveSubTab("create");
    setSelectedBill(null);
  }
};

// Hàm logout — signOut Supabase Auth (invalidate JWT + refresh token) + clear cache
const handleLogout = async () => {
  try {
    await supabase.auth.signOut();
  } catch (_) {
    // signOut fail vẫn tiếp tục clear local state
  }
  localStorage.removeItem("hc_session");
  setSession(null);
  resetCreateBillForm();
};

// Handler cho SessionMonitor khi phát hiện disabled/idle → auto logout
const handleForceLogout = async (reason) => {
  await handleLogout();
  showToast(reason || "Phiên đăng nhập đã kết thúc", "error");
};

// Callback khi MfaFlow hoàn tất (sys_admin đã enroll + verify TOTP đạt aal2)
const handleMfaComplete = () => {
  // Không cần làm gì — flow chỉ block render, khi xong flow tự return null.
};

// Hàm hiển thị Toast thông báo nhanh (Thay thế alert)
const showToast = (message, type = "success") => {
  setToastMessage(message);
  setToastType(type);
  setTimeout(() => {
    setToastMessage("");
  }, 3000);
};

// Confirm dialog (thay window.confirm)
const askConfirm = ({ title = "Xác nhận", message, confirmText = "Xác nhận", danger = false }) => {
  return new Promise((resolve) => {
    setConfirmDialog({
      title,
      message,
      confirmText,
      danger,
      onConfirm: () => { setConfirmDialog(null); resolve(true); },
      onCancel: () => { setConfirmDialog(null); resolve(false); }
    });
  });
};

const fetchData = async (opts) => {
  const silent = opts?.silent === true;
  if (!silent) setLoading(true);
  try {
    // 1. Lấy danh sách khách hàng & SĐT kèm theo (Fix bug client_phones rỗng)
    const { data: clientsData, error: errC } = await supabase
      .from("clients")
      .select(`*, client_phones(*)`)
      .eq("is_delete", false);
    if (errC) throw errC;
    setClients(clientsData || []);

    // 2. Lấy danh sách hóa đơn (Fix bug JOIN lấy tên người gửi/nhận thực tế)
    const { data: billsData, error: errB } = await supabase
      .from("bills")
      .select(`
        *,
        sender:clients!sender_id(fullname),
        receiver:clients!receiver_id(fullname),
        sender_phone:client_phones!sender_phone_id(phone_number),
        receiver_phone:client_phones!receiver_phone_id(phone_number),
        branch:branches!branch_id(branch_code, address, hotline, address_note),
        current_branch:branches!current_branch_id(branch_code),
        creator:profiles!created_by(id, username, full_name),
        deliverer:profiles!delivered_by(id, username, full_name)
      `)
      .eq("is_delete", false)
      .order("created_at", { ascending: false });
    
    if (errB) throw errB;
    setBills(billsData || []);

    // add-server-session: bill_seq lấy từ branch_sessions (đã có state cache).
    // Refresh session cho chi nhánh hiện tại để đảm bảo bill_seq mới nhất sau khi fetchData
    // (case: staff khác vừa tạo bill xong).
    if (currentBranch && branchIdByCode[currentBranch]) {
      const sess = await fetchBranchSession(branchIdByCode[currentBranch]);
      if (sess) setBranchSessions(prev => ({ ...prev, [currentBranch]: sess }));
    }

    // 3. Lấy danh sách chi tiêu
    const { data: expensesData, error: errE } = await supabase
      .from("expenses")
      .select(`*, branch:branches!branch_id(branch_code)`)
      .eq("is_delete", false);
    if (errE) throw errE;
    setExpenses(expensesData || []);

    // 4. Revamp §5.1: Lấy danh sách thanh toán (nguồn truth cho doanh thu)
    //    Join branch + collector; bill.delivery_status/is_delete để filter cancelled (§15.1-15.2)
    const { data: paymentsData, error: errP } = await supabase
      .from("bill_payment_details")
      .select(`
        id, bill_id, amount_paid, branch_id, created_at, collected_by, note,
        branch:branches!branch_id(branch_code),
        collector:profiles!collected_by(id, full_name, username),
        bill:bills!bill_id(bill_code, delivery_status, is_delete, sender_name_text, receiver_name_text, goods_type, shipping_fee)
      `)
      .order("created_at", { ascending: false });
    if (errP) throw errP;
    setPayments(paymentsData || []);

    // expand-revenue-reporting: danh mục chi phí (dùng chung 2 chi nhánh)
    // Non-fatal: nếu migration chưa chạy (bảng chưa tồn tại) thì bỏ qua, không chặn luồng.
    const { data: catData, error: errCat } = await supabase
      .from("expense_categories")
      .select("id, name, is_active")
      .order("created_at", { ascending: true });
    if (errCat) {
      console.warn("[expense_categories] chưa sẵn sàng:", errCat.message);
    } else {
      setExpenseCategories(catData || []);
    }

    // expand-revenue-reporting: trạng thái khóa sổ tháng (chỉ admin/boss/sys_admin đọc được qua RLS)
    const { data: mcData } = await supabase
      .from("monthly_closes")
      .select("branch_id, period_month, status, closed_by, closed_at");
    setMonthlyCloses(mcData || []);
  } catch (err) {
    console.error("Lỗi lấy dữ liệu:", err.message);
  } finally {
    if (!silent) setLoading(false);
  }
};
fetchDataRef.current = fetchData;

// Reserve mã bill khi mở form (dùng session cache; auto-fetch nếu thiếu).
const reserveBillCode = async () => {
  if (!session || !currentBranch) { setReservedBillCode("---"); return; }
  try {
    let sess = branchSessions[currentBranch];
    if (!sess) {
      const bId = branchIdByCode[currentBranch];
      if (!bId) { setReservedBillCode("---"); return; }
      sess = await fetchBranchSession(bId);
      if (sess) setBranchSessions(prev => ({ ...prev, [currentBranch]: sess }));
    }
    if (!sess) { setReservedBillCode("---"); return; }
    setReservedBillCode(buildBillCodeFromSession(currentBranch, sess));
  } catch (err) {
    console.error("Lỗi reserve mã:", err);
    setReservedBillCode("ERR");
  }
};

// Xử lý "Xuất Bến" — cập nhật branch_sessions trên server.
// Ảnh hưởng ĐỒNG BỘ mọi máy đang login vào cùng chi nhánh.
// Rule: chỉ user (bất kỳ role) cùng branch với warehouseBranch mới xuất bến được.
// opts.skipConfirm: bỏ bước askConfirm (khi đã xác nhận ở nơi khác, VD popup tạo đơn ngày mai).
// opts.skipTripChecks: bỏ validation "chuyến có đơn" + "khớp số kiện Trong/Ngoài" — dùng khi user đã
//   xác nhận xe ĐÃ xuất bến (đếm số kiện lúc này vô nghĩa; thủ kho vẫn sửa count sau được).
// Trả về session mới (rolled) nếu thành công, null nếu bị chặn/lỗi.
const performDeparture = async (branch, opts = {}) => {
  if (!branch) { showToast("Chưa xác định chi nhánh kho!", "error"); return null; }
  if (session?.role === 'boss') {
    showToast('Boss chỉ được xem, không được xuất bến.', 'error');
    return null;
  }
  if (branch !== session?.branch_code) {
    showToast(`Chỉ nhân viên chi nhánh ${branch} mới được xuất bến kho ${branch}!`, 'error');
    return null;
  }
  if (!opts.skipTripChecks) {
    // Defense-in-depth: block xuất bến khi chuyến hiện tại chưa có bill thật.
    const curSeq = branchSessions[branch]?.bill_seq ?? 1;
    if (curSeq <= 1) {
      showToast(`Chuyến hiện tại của kho ${branch} chưa có đơn hàng nào — không thể xuất bến!`, 'error');
      return null;
    }
    // Defense-in-depth: block xuất bến nếu còn đơn chưa điền đủ / chưa khớp số kiện Trong-Ngoài của chuyến hiện tại.
    const tripBusinessDate = branchSessions[branch]?.business_date;
    const tripBills = bills.filter(b =>
      b.branch?.branch_code === branch &&
      b.delivery_status !== 'draft' &&
      b.delivery_status !== 'cancelled' &&
      b.business_date === tripBusinessDate
    );
    const incompleteBills = tripBills.filter(b => {
      const inside = b.inside_count;
      const outside = b.outside_count;
      if (inside === null || inside === undefined || outside === null || outside === undefined) return true;
      return (Number(inside) + Number(outside)) !== Number(b.package_count || 0);
    });
    if (incompleteBills.length > 0) {
      showToast(`Còn ${incompleteBills.length} đơn chưa điền đủ hoặc chưa khớp số kiện Trong/Ngoài — vui lòng kiểm tra lại!`, 'error');
      return null;
    }
  }
  const bId = branchIdByCode[branch];
  if (!bId) { showToast("Không tìm thấy chi nhánh trong DB!", "error"); return null; }
  const branchLabel = branch === "SG" ? "Sài Gòn (SG)" : "Gia Lai (GL)";
  const curSess = branchSessions[branch];

  if (!opts.skipConfirm) {
    const ok = await askConfirm({
      title: `Xác nhận xuất bến — ${branchLabel}`,
      confirmText: "Xuất bến",
    });
    if (!ok) return null;
  }

  const rolled = await advanceBranchSession(bId, session?.id);
  if (!rolled) { showToast("Lỗi xuất bến — vui lòng thử lại!", "error"); return null; }

  setBranchSessions(prev => ({ ...prev, [branch]: rolled }));

  // Audit log (add-audit-log §11.3 session_departure)
  try {
    logAudit({
      entityType: "session",
      entityId: bId,
      entityLabel: `${branch}/${rolled.business_date}`,
      action: "session_departure",
      changes: {
        day_counter: [curSess?.day_counter || null, rolled.day_counter],
        business_date: [curSess?.business_date || null, rolled.business_date],
        bill_seq: [curSess?.bill_seq ?? null, rolled.bill_seq],
      },
      note: `Xuất bến ${branchLabel}`,
    });
  } catch (e) { console.warn('Audit log departure failed (non-fatal):', e); }

  if (branch === currentBranch) {
    setReservedBillCode(buildBillCodeFromSession(branch, rolled));
  }

  showToast(
    `Đã xuất bến kho ${branch}! Mã đơn hàng mới sẽ bắt đầu từ ${buildBillCodeFromSession(branch, rolled)}`,
    "success"
  );
  return rolled;
};

const handleDeparture = async () => {
  await performDeparture(warehouseBranch);
};

// In danh sách bốc xếp — mở tab preview với table + nút In / Tải Excel (.xls).
// Xuất TOÀN BỘ đơn theo filter (branch + business_date), KHÔNG áp dụng pagination.
const handlePrintWarehouseList = () => {
  const rows = bills.filter(b =>
    (b.current_branch?.branch_code || b.branch?.branch_code) === warehouseBranch &&
    b.delivery_status !== 'draft' &&
    b.delivery_status !== 'cancelled' &&
    b.delivery_status !== 'destroyed' &&
    b.business_date === warehouseDate
  ).sort((a, b) => (a.bill_code || "zzzz").localeCompare(b.bill_code || "zzzz"));
  const branchLabel = warehouseBranch === "SG" ? "Sài Gòn" : "Gia Lai";
  const esc = (v) => String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const feeCell = (b) => {
    if (b.payment_status === "free") return "Miễn phí";
    if (b.payment_status === "quote_later") return "Chưa có cước";
    return formatVND(b.shipping_fee);
  };
  // Excel/Word HTML importer strips <style> border → dùng inline style + border="1" attribute
  const cellStyle = 'border:1px solid #000;padding:4px 6px;vertical-align:top;word-break:break-word';
  const hdrStyle = 'border:1px solid #000;padding:4px 6px;background:#e5e7eb;font-weight:700;text-align:center';
  const tbody = rows.map((b, i) => `
    <tr>
      <td class="center" style="${cellStyle};text-align:center">${i + 1}</td>
      <td class="mono bold" style="${cellStyle};font-family:Consolas,monospace;font-weight:700">${esc(b.bill_code || "(Nháp)")}</td>
      <td style="${cellStyle}">${esc(b.sender_name_text || "—")}</td>
      <td style="${cellStyle}">${esc(b.receiver_name_text || "—")}</td>
      <td style="${cellStyle}">${esc(b.goods_type || "")}</td>
      <td class="center" style="${cellStyle};text-align:center">${b.package_count ?? 0}</td>
      <td class="right" style="${cellStyle};text-align:right;white-space:nowrap">${esc(feeCell(b))}</td>
      <td class="center" style="${cellStyle};text-align:center">${b.inside_count ?? ""}</td>
      <td class="center" style="${cellStyle};text-align:center">${b.outside_count ?? ""}</td>
      <td style="${cellStyle}">${esc(b.combined_goods || "")}</td>
    </tr>`).join("");
  const emptyRow = rows.length === 0
    ? `<tr><td colspan="10" class="center italic" style="${cellStyle};padding:24px;text-align:center;color:#888">Không có đơn hàng nào</td></tr>`
    : "";
  const fileBase = `danh-sach-boc-xep-${warehouseBranch}-${warehouseDate}`;
  const title = `Danh sách bốc xếp ${branchLabel} - ${warehouseDate}`;
  // colgroup: tối ưu diện tích — Người gửi/nhận rộng, Trong/Ngoài/Giá/Hàng ghép hẹp.
  const colgroup = `<colgroup>
    <col style="width:5%"><col style="width:10%"><col style="width:17%"><col style="width:17%"><col style="width:14%"><col style="width:6%"><col style="width:12%"><col style="width:6%"><col style="width:6%"><col style="width:7%">
  </colgroup>`;
  const titleRows = `
        <tr><td colspan="10" style="border:none;text-align:center;font-size:15px;font-weight:700;padding:6px 0 2px">DANH SÁCH BỐC XẾP HÀNG HÓA — ${esc(branchLabel.toUpperCase())}</td></tr>
        <tr><td colspan="10" style="border:none;text-align:center;font-size:11px;color:#555;padding:0 0 8px">Ngày: <b>${esc(warehouseDate)}</b> &nbsp;•&nbsp; Tổng số đơn: <b>${rows.length}</b></td></tr>`;
  const headerRow = `
        <tr>
          <th style="${hdrStyle};text-align:center">STT</th>
          <th style="${hdrStyle}">Mã Đơn Hàng</th>
          <th style="${hdrStyle}">Người Gửi</th>
          <th style="${hdrStyle}">Người Nhận</th>
          <th style="${hdrStyle}">Mặt hàng</th>
          <th style="${hdrStyle}">Số kiện</th>
          <th style="${hdrStyle}">Giá cước</th>
          <th style="${hdrStyle}">Trong</th>
          <th style="${hdrStyle}">Ngoài</th>
          <th style="${hdrStyle}">Hàng Ghép</th>
        </tr>`;
  const tableHtml = `<table id="report" border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%;table-layout:fixed;border:1px solid #000">
      ${colgroup}
      <thead>${titleRows}${headerRow}</thead>
      <tbody>${tbody}${emptyRow}</tbody>
    </table>`;
  // Style riêng cho Word (.doc): section + footer số trang.
  const wordStyle = `
@page Section1 { size:595.3pt 841.9pt; margin:10mm 10mm 16mm 10mm; mso-footer:f1; mso-footer-margin:8mm; }
div.Section1 { page:Section1; }
body{font-family:'Segoe UI',Arial,sans-serif;color:#000;font-size:10pt}
table{border-collapse:collapse;width:100%;table-layout:fixed}
td,th{border:1px solid #000;padding:3pt 5pt;vertical-align:top;word-break:break-word}
thead{display:table-header-group}
p.MsoFooter{margin:0}`;
  // Footer Word: IF NUMPAGES>1 → "PAGE/NUMPAGES", else rỗng (ẩn khi chỉ 1 trang).
  const wordFooter = `<div style='mso-element:footer' id='f1'><p class='MsoFooter' style='text-align:right;font-size:9pt;color:#555'><!--[if supportFields]><span style='mso-element:field-begin'></span> IF <span style='mso-element:field-begin'></span> NUMPAGES <span style='mso-element:field-separator'></span>1<span style='mso-element:field-end'></span> &gt; 1 "<span style='mso-element:field-begin'></span> PAGE <span style='mso-element:field-separator'></span>1<span style='mso-element:field-end'></span>/<span style='mso-element:field-begin'></span> NUMPAGES <span style='mso-element:field-separator'></span>1<span style='mso-element:field-end'></span>" "" <span style='mso-element:field-separator'></span><span style='mso-element:field-end'></span><![endif]--></p></div>`;
  const html = `<!DOCTYPE html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  html,body{margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;color:#222;background:#f3f4f6;padding:16px 0}
  .sheet{background:#fff;width:190mm;min-height:277mm;margin:0 auto;padding:10mm;box-shadow:0 2px 8px rgba(0,0,0,.1);box-sizing:border-box}
  .toolbar{max-width:190mm;margin:0 auto 12px;display:flex;gap:8px;padding:0 10mm;box-sizing:border-box}
  .toolbar button{padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;border:1px solid #d97706;background:#f97316;color:#fff;border-radius:6px}
  .toolbar button.secondary{background:#fff;color:#d97706}
  table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed}
  th,td{border:1px solid #000;padding:4px 6px;vertical-align:top}
  th{text-align:left;font-weight:700}
  .center{text-align:center}
  .right{text-align:right}
  .mono{font-family:'Consolas','Courier New',monospace}
  .bold{font-weight:700}
  tr{page-break-inside:avoid}
  thead{display:table-header-group}
  @media print{
    body{background:#fff;padding:0}
    .toolbar{display:none}
    .sheet{width:auto;min-height:0;margin:0;padding:8mm 10mm;box-shadow:none}
  }
</style></head><body>
  <div class="toolbar">
    <button onclick="window.print()">🖨️ In</button>
    <button class="secondary" onclick="downloadWord()">📄 Tải Word (.doc)</button>
    <button class="secondary" onclick="downloadExcel()">📥 Tải Excel (.xls)</button>
  </div>
  <div class="sheet">
    ${tableHtml}
  </div>
<script>
var FILE_BASE = ${JSON.stringify(fileBase)};
var WORD_STYLE = ${JSON.stringify(wordStyle)};
var WORD_FOOTER = ${JSON.stringify(wordFooter)};
function downloadBlob(content, mime, ext){
  var blob = new Blob(['\\uFEFF' + content], { type: mime });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = FILE_BASE + ext;
  document.body.appendChild(a); a.click();
  setTimeout(function(){ URL.revokeObjectURL(url); a.remove(); }, 500);
}
function downloadExcel(){
  var tableHtml = document.getElementById('report').outerHTML;
  var xls = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">' +
    '<head><meta charset="utf-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>BocXep</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>' + tableHtml + '</body></html>';
  downloadBlob(xls, 'application/vnd.ms-excel', '.xls');
}
function downloadWord(){
  var tableHtml = document.getElementById('report').outerHTML;
  var doc = "<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>" +
    "<head><meta charset='utf-8'><style>" + WORD_STYLE + "</style></head>" +
    "<body><div class='Section1'>" + tableHtml + "</div>" + WORD_FOOTER + "</body></html>";
  downloadBlob(doc, 'application/msword', '.doc');
}
</script>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) {
    showToast("Popup bị chặn — vui lòng cho phép popup và thử lại.", "error");
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
};

// Tự động đánh sao theo giá trị hàng hóa (chỉ khi NV chưa chọn tay)
useEffect(() => {
  if (starsManual) return;
  const value = Number(goodsValue) || 0;
  if (value >= 10000000) {
    setSpecialStars(2);
  } else if (value >= 5000000) {
    setSpecialStars(1);
  } else {
    setSpecialStars(0);
  }
}, [goodsValue, starsManual]);

// --- XỬ LÝ NGHIỆP VỤ ĐỌC / GHI TRỰC TIẾP SUPABASE ---

// 1. Thêm hoặc cập nhật khách hàng từ Screen 6
const resetClientForm = () => {
  setNewClientName("");
  setNewClientPhone("");
  setNewClientPhoneSec("");
  setNewClientOldPhones([]); // §2.2
  setNewClientAddress("");
  setIsBlacklist(false);
  setBlacklistReason("");
  setEditingClientId(null);
};

// add-client-phone-history §3.1: refactor — populate `newClientOldPhones`,
// scroll to top, focus ô Họ tên, GIỮ `clientPage` (không reset pagination).
const handleStartEditClient = (c) => {
  const phones = c.client_phones || [];
  const primary = phones.find(p => p.type === "primary");
  const secondary = phones.find(p => p.type === "secondary");
  const olds = phones.filter(p => p.type === "old");
  setEditingClientId(c.id);
  setNewClientName(c.fullname || "");
  setNewClientPhone(primary?.phone_number || "");
  setNewClientPhoneSec(secondary?.phone_number || "");
  setNewClientOldPhones(olds.map(p => p.phone_number));
  setNewClientAddress(c.address || "");
  setIsBlacklist(!!c.is_blacklist);
  setBlacklistReason(c.blacklist_reason || "");
  // KHÔNG đụng setClientPage (D8: giữ phân trang)
  window.scrollTo({ top: 0, behavior: "smooth" });
  // Delay nhỏ để scroll xong + form re-render, sau đó focus ô Họ tên
  setTimeout(() => {
    document.querySelector('input[data-client-form-fullname]')?.focus();
  }, 100);
};

const handleAddClient = async (e) => {
  e.preventDefault();
  const name = (newClientName || "").trim();
  const primary = (newClientPhone || "").trim();
  const secondary = (newClientPhoneSec || "").trim();
  if (!name || !primary) return;

  // §5.3: validate s\u1ed1 ch\u00ednh \u2260 s\u1ed1 ph\u1ee5 (n\u1ebfu c\u1ea3 2 c\u00f3 gi\u00e1 tr\u1ecb)
  if (secondary && secondary === primary) {
    showToast("SĐT chính và phụ phải khác nhau!", "error");
    return;
  }

  // add-client-phone-history §5: compare-and-diff rewrite.
  // Ref: openspec/changes/add-client-phone-history/design.md §3 (state machine + ops).
  // TUYỆT ĐỐI KHÔNG DELETE row client_phones — chỉ INSERT mới + UPDATE type='old'
  // để bảo toàn FK bill cũ (bills.sender_phone_id / receiver_phone_id).

  // Snapshot initial state (edit mode)
  let initial = { primary: null, secondary: null, olds: [], client: null };
  if (editingClientId) {
    const cur = clients.find(c => c.id === editingClientId);
    if (cur) {
      const phones = cur.client_phones || [];
      initial = {
        client: cur,
        primary: phones.find(p => p.type === "primary") || null,
        secondary: phones.find(p => p.type === "secondary") || null,
        olds: phones.filter(p => p.type === "old"),
      };
    }
  }

  // §5.1: modal prompt khi đổi số chính
  if (editingClientId && initial.primary && primary !== initial.primary.phone_number) {
    const ok = await askConfirm({
      title: "Số chính đã được thay đổi",
      message: `Cũ: ${initial.primary.phone_number}\nMới: ${primary}\n\nSố cũ sẽ được lưu vào lịch sử (\"Số cũ\") để bảo toàn các bill trước đây.`,
      confirmText: "Xác nhận",
      cancelText: "Huỷ",
    });
    if (!ok) return;
    // §5.8: optimistic update UI list Số cũ trước khi fetchData
    setNewClientOldPhones(prev => [...prev, initial.primary.phone_number]);
  } else if (editingClientId) {
    // Confirm chung cho các trường hợp edit khác (nếu chỉ đổi tên/địa chỉ) — như cũ
    const ok = await askConfirm({
      title: "Cập nhật khách hàng?",
      message: `Bạn có chắc muốn lưu thay đổi cho khách hàng "${name}"?`,
      confirmText: "Cập nhật",
    });
    if (!ok) return;
  }

  try {
    let clientId = editingClientId;

    // Ops UPDATE clients (add hoặc edit)
    if (editingClientId) {
      const { error: updErr } = await supabase
        .from("clients")
        .update({
          fullname: name,
          address: newClientAddress,
          is_blacklist: isBlacklist,
          blacklist_reason: isBlacklist ? blacklistReason : "",
        })
        .eq("id", editingClientId);
      if (updErr) throw updErr;
    } else {
      const { data: client, error: clientErr } = await supabase
        .from("clients")
        .insert({
          fullname: name,
          address: newClientAddress,
          is_blacklist: isBlacklist,
          blacklist_reason: isBlacklist ? blacklistReason : "",
        })
        .select()
        .single();
      if (clientErr) throw clientErr;
      clientId = client.id;
    }

    // §5.4-5.5: build ops phones (sequential, KHÔNG có DELETE)
    // Primary
    if (!initial.primary) {
      // Add mode HOẶC edge case khách cũ chưa có primary
      const { error } = await supabase.from("client_phones").insert({
        client_id: clientId, phone_number: primary, type: "primary",
      });
      if (error) throw error;
    } else if (primary !== initial.primary.phone_number) {
      // Demote cũ + insert mới
      const { error: e1 } = await supabase.from("client_phones")
        .update({ type: "old" }).eq("id", initial.primary.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("client_phones").insert({
        client_id: clientId, phone_number: primary, type: "primary",
      });
      if (e2) throw e2;
    }
    // else: no-op (primary không đổi)

    // Secondary
    if (!initial.secondary && secondary) {
      // Thêm số phụ mới
      const { error } = await supabase.from("client_phones").insert({
        client_id: clientId, phone_number: secondary, type: "secondary",
      });
      if (error) throw error;
    } else if (initial.secondary && !secondary) {
      // Xoá số phụ → silent demote thành 'old' (D6)
      const { error } = await supabase.from("client_phones")
        .update({ type: "old" }).eq("id", initial.secondary.id);
      if (error) throw error;
      setNewClientOldPhones(prev => [...prev, initial.secondary.phone_number]);
    } else if (initial.secondary && secondary !== initial.secondary.phone_number) {
      // Đổi số phụ → silent demote + insert mới
      const { error: e1 } = await supabase.from("client_phones")
        .update({ type: "old" }).eq("id", initial.secondary.id);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("client_phones").insert({
        client_id: clientId, phone_number: secondary, type: "secondary",
      });
      if (e2) throw e2;
      setNewClientOldPhones(prev => [...prev, initial.secondary.phone_number]);
    }
    // else: no-op

    // §4.2 / §4.3 audit
    if (!editingClientId) {
      // Add mode → client_create với snapshot
      logAudit({
        entityType: "client",
        entityId: clientId,
        entityLabel: name,
        action: "client_create",
        changes: {
          fullname: [null, name],
          address: [null, newClientAddress],
          is_blacklist: [null, isBlacklist],
          phone_primary: [null, primary],
          ...(secondary ? { phone_secondary: [null, secondary] } : {}),
        },
        note: "Qua QL Khách hàng",
      });
    } else {
      // Edit mode → tính diff clients fields + phone changes
      const clientDiff = diffObjects(
        {
          fullname: initial.client?.fullname,
          address: initial.client?.address,
          is_blacklist: initial.client?.is_blacklist,
          blacklist_reason: initial.client?.blacklist_reason,
        },
        {
          fullname: name,
          address: newClientAddress,
          is_blacklist: isBlacklist,
          blacklist_reason: isBlacklist ? blacklistReason : "",
        },
        CLIENT_AUDIT_FIELDS
      );
      const phoneDiff = {};
      if (initial.primary && primary !== initial.primary.phone_number) {
        phoneDiff.phone_primary = [initial.primary.phone_number, primary];
        phoneDiff.phone_demoted_to_old = [null, initial.primary.phone_number];
      } else if (!initial.primary && primary) {
        phoneDiff.phone_primary = [null, primary];
      }
      if (initial.secondary && !secondary) {
        phoneDiff.phone_secondary = [initial.secondary.phone_number, null];
        phoneDiff.phone_demoted_to_old = [
          ...(phoneDiff.phone_demoted_to_old ? [phoneDiff.phone_demoted_to_old[1]] : [null]),
          initial.secondary.phone_number,
        ];
      } else if (initial.secondary && secondary !== initial.secondary.phone_number) {
        phoneDiff.phone_secondary = [initial.secondary.phone_number, secondary];
      } else if (!initial.secondary && secondary) {
        phoneDiff.phone_secondary = [null, secondary];
      }
      const changes = { ...(clientDiff || {}), ...phoneDiff };
      if (Object.keys(changes).length > 0) {
        // Nếu chỉ đổi is_blacklist (± blacklist_reason) → action = 'client_blacklist'
        const onlyBlacklist = Object.keys(changes).every(k => k === "is_blacklist" || k === "blacklist_reason");
        logAudit({
          entityType: "client",
          entityId: clientId,
          entityLabel: name,
          action: onlyBlacklist ? "client_blacklist" : "client_update",
          changes,
        });
      }
    }

    showToast(editingClientId ? "Đã cập nhật khách hàng!" : "Đã lưu Khách Hàng mới thành công!");
    fetchData();
    setClientHistoryRefreshKey(k => k + 1);
    resetClientForm();
  } catch (err) {
    showToast("Lỗi lưu khách hàng: " + err.message, "error");
  }
};

// Helper: Reset form tạo đơn
const resetCreateBillForm = () => {
  setSenderName("");
  setSenderPhone("");
  setReceiverName("");
  setReceiverPhone("");
  setSendDate(getTodayFormatted());
  setExpectedDeliveryDate(getTomorrowFormatted());
  setGoodsType("");
  setGoodsValue("");
  setShippingFee("");
  setPackageCount("");
  setIsHomeDelivery(false);
  setDeliveryAddress("");
  setIsPaidImmediately(false);
  setIsFreeShipping(false);
  setFeeQuoteLater(false);
  setRequireIdCheck(false);
  setStarsManual(false);
  setSpecialStars(0);
  setRiskWarning(false);
  setSelfPacked(false);
  setNoDeclaredValue(false);
  setExportVat(false);
  setOrderNote("");
  setCurrentBranch(loggedBranch); // Reset về chi nhánh của user đang login
  setEditingDraftId(null);
  setEditingBillId(null);
  setEditingBillCode("");
  setFeeOnlyEditMode(false);
  // N-4: reset snapshot + diff modal state
  editBillSnapshotRef.current = null;
  setEditDiffList([]);
  setPendingEditBillData(null);
  setShowEditDiffModal(false);
};

// N-4: dictionaries + helpers cho diff modal khi admin sửa đơn
const FIELD_LABELS = {
  senderName: "Tên người gửi",
  senderPhone: "SĐT người gửi",
  receiverName: "Tên người nhận",
  receiverPhone: "SĐT người nhận",
  goodsType: "Mặt hàng",
  goodsValue: "Giá trị hàng",
  packageCount: "Số kiện",
  shippingFee: "Cước phí",
  noDeclaredValue: "Không kê giá trị",
  isHomeDelivery: "Giao tận nhà",
  deliveryAddress: "Địa chỉ giao",
  requireIdCheck: "Yêu cầu check CCCD",
  selfPacked: "Khách tự đóng gói",
  riskWarning: "Cảnh báo rủi ro",
  exportVat: "Xuất VAT",
  orderNote: "Ghi chú",
  specialStars: "Sao đặc biệt",
  paymentStatus: "Trạng thái thanh toán",
};

const ENUM_LABELS_PAYMENT = {
  paid: "Đã thanh toán",
  unpaid: "Chưa thanh toán",
  free: "Miễn phí",
  quote_later: "Báo giá sau",
};

const formatFieldValue = (field, value) => {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Có" : "Không";
  if (field === "shippingFee" || field === "goodsValue") {
    const n = Number(value);
    if (!isNaN(n) && n !== 0) return n.toLocaleString("vi-VN") + " đ";
    if (n === 0) return "0 đ";
    return String(value);
  }
  if (field === "paymentStatus") return ENUM_LABELS_PAYMENT[value] || value;
  if (field === "specialStars") return value ? `${value} ⭐` : "0";
  return String(value);
};

// Chuẩn hóa value cho snapshot: string trim, number → string; boolean giữ nguyên
const _norm = (v) => {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v;
  return String(v).trim();
};

const buildEditSnapshot = (bill) => ({
  senderName: _norm(bill.sender_name_text),
  senderPhone: _norm(bill.sender_phone_text),
  receiverName: _norm(bill.receiver_name_text),
  receiverPhone: _norm(bill.receiver_phone_text),
  goodsType: _norm(bill.goods_type),
  goodsValue: _norm(bill.goods_value),
  packageCount: _norm(bill.package_count || 1),
  shippingFee: _norm(bill.shipping_fee),
  noDeclaredValue: !!bill.no_declared_value,
  isHomeDelivery: !!bill.is_home_delivery,
  deliveryAddress: _norm(bill.delivery_address),
  requireIdCheck: !!bill.require_id_check,
  selfPacked: !!bill.self_packed,
  riskWarning: !!bill.risk_warning,
  exportVat: !!bill.export_vat,
  orderNote: _norm(bill.order_note),
  specialStars: Number(bill.special_stars || 0),
  paymentStatus: bill.payment_status,
});

const buildCurrentSnapshotFromBillData = (data) => ({
  senderName: _norm(data.senderName),
  senderPhone: _norm(data.senderPhone),
  receiverName: _norm(data.receiverName),
  receiverPhone: _norm(data.receiverPhone),
  goodsType: _norm(data.goodsType),
  goodsValue: _norm(data.noDeclaredValue ? 0 : data.goodsValue),
  packageCount: _norm(data.packageCount || 1),
  shippingFee: _norm((data.isFreeShipping || data.feeQuoteLater) ? 0 : data.shippingFee),
  noDeclaredValue: !!data.noDeclaredValue,
  isHomeDelivery: !!data.isHomeDelivery,
  deliveryAddress: _norm(data.isHomeDelivery ? data.deliveryAddress : ""),
  requireIdCheck: !!data.requireIdCheck,
  selfPacked: !!data.selfPacked,
  riskWarning: !!data.riskWarning,
  exportVat: !!data.exportVat,
  orderNote: _norm(data.orderNote),
  specialStars: Number(data.specialStars || 0),
  paymentStatus: data.isFreeShipping ? "free"
    : data.feeQuoteLater ? "quote_later"
    : data.isPaidImmediately ? "paid"
    : "unpaid",
});

const computeEditDiff = (snapshot, current) => {
  const diffs = [];
  const fields = Object.keys(FIELD_LABELS);
  for (const f of fields) {
    const oldV = snapshot[f];
    const newV = current[f];
    if (JSON.stringify(oldV) !== JSON.stringify(newV)) {
      diffs.push({
        field: f,
        label: FIELD_LABELS[f],
        oldFormatted: formatFieldValue(f, oldV),
        newFormatted: formatFieldValue(f, newV),
      });
    }
  }
  return diffs;
};

// 2. Tạo đơn hàng mới (Tab 7.1) - submit đi thẳng, khách chưa có trong DB sẽ được tự động tạo
// Chạy 1 hành động ghi dữ liệu kiểu "độc quyền" — chặn double-submit (ref sync + state disable nút).
const runExclusive = async (fn) => {
  if (submittingRef.current) return;
  submittingRef.current = true;
  setIsSubmitting(true);
  try { return await fn(); }
  finally { submittingRef.current = false; setIsSubmitting(false); }
};

const handleStartCreateBill = async (e) => {
  e.preventDefault();

  // Validate tối thiểu
  if (!senderName.trim() || !receiverName.trim()) {
    showToast("Vui lòng nhập tên người gửi và người nhận!", "error");
    return;
  }
  if (!goodsType.trim()) {
    showToast("Vui lòng nhập mặt hàng!", "error");
    return;
  }
  // Cước phí bắt buộc TRỪ KHI đơn miễn phí hoặc báo giá sau
  if (!isFreeShipping && !feeQuoteLater && !shippingFee) {
    showToast("Vui lòng nhập cước phí!", "error");
    return;
  }
  if (!packageCount || Number(packageCount) < 1) {
    showToast("Vui lòng nhập số kiện hàng (tối thiểu 1)!", "error");
    return;
  }
  // Fix #4: Validate địa chỉ khi checkbox giao hàng tận nơi
  if (isHomeDelivery && !deliveryAddress.trim()) {
    showToast("Vui lòng nhập địa chỉ giao hàng!", "error");
    return;
  }
  // Rule: đơn giao tận nơi bắt buộc thanh toán trước.
  if (isHomeDelivery && !isPaidImmediately && !isFreeShipping) {
    showToast(
      feeQuoteLater
        ? "Đơn giao tận nơi bắt buộc thanh toán trước — bỏ 'Báo giá cước sau' để nhập cước và thu tiền!"
        : "Đơn giao tận nơi bắt buộc thanh toán trước — Thu tiền khách và chọn 'Đã thanh toán'!",
      "error"
    );
    return;
  }
  // Ghi chú required khi có yêu cầu đối chiếu CCCD (thông tin nhạy cảm, cần lưu lại)
  if (requireIdCheck && !orderNote.trim()) {
    showToast("Vui lòng nhập thông tin CCCD vào ô Ghi chú!", "error");
    return;
  }

  const billData = {
    senderName: senderName.trim(),
    senderPhone: senderPhone.trim(),
    receiverName: receiverName.trim(),
    receiverPhone: receiverPhone.trim(),
    sendDate: sendDate.trim(),
    expectedDeliveryDate: expectedDeliveryDate.trim(),
    goodsType: goodsType.trim(),
    goodsValue: noDeclaredValue ? "" : goodsValue,
    shippingFee,
    packageCount,
    isHomeDelivery,
    deliveryAddress,
    isPaidImmediately,
    isFreeShipping,
    feeQuoteLater,
    specialStars: noDeclaredValue ? 0 : specialStars,
    requireIdCheck,
    riskWarning,
    selfPacked,
    noDeclaredValue,
    exportVat,
    orderNote: orderNote.trim(),
    isDraft: false,
  };

  if (editingBillId) {
    // N-4: admin đang sửa đơn chính thức — compute diff so với snapshot lúc mở form
    const snap = editBillSnapshotRef.current;
    if (!snap) {
      // Fallback: nếu vì lý do gì snapshot bị mất → submit thẳng không diff
      await executeUpdateDraft(editingBillId, billData);
      return;
    }
    const currentSnap = buildCurrentSnapshotFromBillData(billData);
    const diffs = computeEditDiff(snap, currentSnap);
    if (diffs.length === 0) {
      showToast("Không có thay đổi nào để cập nhật", "info");
      return;
    }
    setEditDiffList(diffs);
    setPendingEditBillData(billData);
    setShowEditDiffModal(true);
    return; // chờ user confirm ở modal
  } else if (editingDraftId) {
    // Convert draft → pending: check cutoff (không áp dụng sys_admin, không hỏi nếu đã xuất bến).
    if (userRole !== "sys_admin" && isAfterVNDepartureCutoff()) {
      const sess = branchSessions[currentBranch];
      const todayVN = getVNTodayDate();
      const alreadyDeparted = sess && sess.business_date > todayVN;
      if (!alreadyDeparted) {
        setDepartureConfirmDialog({
          branch: currentBranch,
          billData,
          mode: "convert",
          draftId: editingDraftId,
          stage: "choice",
        });
        return;
      }
    }
    // Submit draft as official bill (convert draft to pending)
    await executeConvertDraftToBill(editingDraftId, billData);
  } else {
    // Tạo đơn mới: check cutoff (không áp dụng sys_admin, không hỏi nếu đã xuất bến).
    if (userRole !== "sys_admin" && isAfterVNDepartureCutoff()) {
      const sess = branchSessions[currentBranch];
      const todayVN = getVNTodayDate();
      const alreadyDeparted = sess && sess.business_date > todayVN;
      if (!alreadyDeparted) {
        setDepartureConfirmDialog({
          branch: currentBranch,
          billData,
          mode: "create",
          stage: "choice",
        });
        return;
      }
    }
    // Create new bill
    await executeCreateBill(billData);
  }
};

// N-4: user OK ở modal diff → submit update
const handleConfirmEditBill = async () => {
  setShowEditDiffModal(false);
  if (!editingBillId || !pendingEditBillData) return;
  const data = pendingEditBillData;
  setPendingEditBillData(null);
  setEditDiffList([]);
  await executeUpdateDraft(editingBillId, data);
};

// N-4: user Cancel ở modal → đóng modal, giữ form nguyên (user có thể chỉnh tiếp)
const handleCancelEditBill = () => {
  setShowEditDiffModal(false);
  setPendingEditBillData(null);
  setEditDiffList([]);
};

// Popup xuất bến — user xác nhận CHƯA xuất bến → tiếp tục tạo đơn chính thức.
const handleDepartureConfirmProceed = async () => {
  const dlg = departureConfirmDialog;
  setDepartureConfirmDialog(null);
  if (!dlg) return;
  if (dlg.mode === "convert") {
    await executeConvertDraftToBill(dlg.draftId, dlg.billData);
  } else {
    await executeCreateBill(dlg.billData);
  }
};

// Popup xuất bến — user chọn "Tạo đơn cho ngày mai" + xác nhận xe ĐÃ xuất bến:
// "Rồi" ≡ Xuất Bến (advance session + audit + cập nhật mã), BỎ QUA check số kiện Trong/Ngoài
// (xe đã đi, đếm lại vô nghĩa; thủ kho vẫn sửa count sau được), rồi tạo đơn cho chuyến mai.
const handleDepartureCreateTomorrow = async () => {
  const dlg = departureConfirmDialog;
  if (!dlg) return;
  const rolled = await performDeparture(dlg.branch, { skipConfirm: true, skipTripChecks: true });
  if (!rolled) {
    // Lỗi khác (quyền / DB) → quay lại bước chọn.
    setDepartureConfirmDialog({ ...dlg, stage: "choice" });
    return;
  }
  setDepartureConfirmDialog(null);
  if (dlg.mode === "convert") {
    await executeConvertDraftToBill(dlg.draftId, dlg.billData, { ignoreReservedCode: true });
  } else {
    await executeCreateBill(dlg.billData, { ignoreReservedCode: true });
  }
};

// 2b. Lưu nháp (Fix #1)
const handleSaveDraft = async () => {
  if (!senderName.trim() || !receiverName.trim()) {
    showToast("Vui lòng nhập ít nhất tên người gửi và người nhận!", "error");
    return;
  }

  const draftData = {
    senderName: senderName.trim(),
    senderPhone: senderPhone.trim(),
    receiverName: receiverName.trim(),
    receiverPhone: receiverPhone.trim(),
    sendDate: sendDate.trim(),
    expectedDeliveryDate: expectedDeliveryDate.trim(),
    goodsType: goodsType.trim(),
    goodsValue: noDeclaredValue ? "" : goodsValue,
    shippingFee,
    packageCount,
    isHomeDelivery,
    deliveryAddress,
    isPaidImmediately,
    isFreeShipping,
    feeQuoteLater,
    specialStars: noDeclaredValue ? 0 : specialStars,
    requireIdCheck,
    riskWarning,
    selfPacked,
    noDeclaredValue,
    exportVat,
    orderNote: orderNote.trim(),
    isDraft: true,
  };

  if (editingDraftId) {
    // Update existing draft
    await executeUpdateDraft(editingDraftId, draftData);
  } else {
    // Create new draft
    await executeCreateBill(draftData);
  }
};

// I-6 + N-12 + N-13: Helper thống nhất resolve khách hàng cho intake.
// - Match combo (LOWER(fullname), phone_number) → dùng client_id cũ, KHÔNG sửa fullname/blacklist/phones.
// - N-13: nếu isReceiver + isHomeDelivery + address khác → update clients.address silent.
// - N-12: nếu không SĐT → return null (KHÔNG insert clients/client_phones).
// - Không match → insert clients + client_phones (chỉ khi có SĐT).
// Returns { clientId, phoneId, isNew, addressUpdated }.
const resolveOrCreateClient = async ({ fullname, phone, isReceiver, isHomeDelivery, deliveryAddress }) => {
  const name = (fullname || "").trim();
  const phoneTrim = (phone || "").trim();
  if (!name) throw new Error("fullname required");

  // N-12: không SĐT → không động clients/client_phones
  if (!phoneTrim) {
    return { clientId: null, phoneId: null, isNew: false, addressUpdated: false };
  }

  // Match combo (LOWER(fullname), phone_number) qua client_phones JOIN clients
  const { data: phoneRows, error: matchErr } = await supabase
    .from("client_phones")
    .select("id, client_id, clients(id, fullname, address, is_delete)")
    .eq("phone_number", phoneTrim);
  if (matchErr) throw matchErr;

  const match = (phoneRows || []).find(
    (r) =>
      r.clients &&
      !r.clients.is_delete &&
      (r.clients.fullname || "").toLowerCase() === name.toLowerCase()
  );

  if (match) {
    // N-13: address là exception — update silent nếu receiver + home delivery + address khác
    let addressUpdated = false;
    if (isReceiver && isHomeDelivery && deliveryAddress) {
      const newAddr = deliveryAddress.trim();
      const oldAddr = match.clients.address || "";
      if (newAddr && newAddr !== oldAddr) {
        const { error: updAddrErr } = await supabase
          .from("clients")
          .update({ address: newAddr })
          .eq("id", match.client_id);
        if (updAddrErr) throw updAddrErr;
        addressUpdated = true;
        logAudit({
          entityType: "client",
          entityId: match.client_id,
          entityLabel: match.clients.fullname || name,
          action: "client_update",
          changes: { address: [oldAddr || null, newAddr] },
          note: "Qua tạo đơn",
        });
      }
    }
    return { clientId: match.client_id, phoneId: match.id, isNew: false, addressUpdated };
  }

  // Không match → tạo client mới + phone
  const newAddress = isReceiver && isHomeDelivery ? (deliveryAddress || "").trim() : "";
  const { data: newClient, error: cErr } = await supabase
    .from("clients")
    .insert({ fullname: name, address: newAddress, is_blacklist: false, is_delete: false })
    .select()
    .single();
  if (cErr) throw cErr;

  const { data: newPhone, error: pErr } = await supabase
    .from("client_phones")
    .insert({ client_id: newClient.id, phone_number: phoneTrim, type: "primary" })
    .select()
    .single();
  if (pErr) throw pErr;

  // §4.1: log client_create (source = intake)
  logAudit({
    entityType: "client",
    entityId: newClient.id,
    entityLabel: name,
    action: "client_create",
    changes: {
      fullname: [null, name],
      phone_primary: [null, phoneTrim],
      ...(newAddress ? { address: [null, newAddress] } : {}),
    },
    note: "Qua tạo đơn",
  });

  return { clientId: newClient.id, phoneId: newPhone.id, isNew: true, addressUpdated: false };
};

// 2c. Update existing draft bill
const executeUpdateDraft = async (draftId, data) => {
  if (!data || !draftId) return;
  if (!(await requireSysAdminUnlock())) return;
  setLoading(true);

  try {
    const { data: branchData } = await supabase
      .from("branches")
      .select("id")
      .eq("branch_code", currentBranch)
      .single();
    
    const branchUUID = branchData ? branchData.id : null;

    // I-6 + N-12 + N-13: resolve thống nhất qua helper
    const senderRes = await resolveOrCreateClient({
      fullname: data.senderName,
      phone: data.senderPhone,
      isReceiver: false,
      isHomeDelivery: false,
      deliveryAddress: "",
    });
    if (senderRes.isNew) {
      showToast(`Đã lưu khách mới ${data.senderName.trim()} vào danh sách khách hàng`, "success");
    }

    const receiverRes = await resolveOrCreateClient({
      fullname: data.receiverName,
      phone: data.receiverPhone,
      isReceiver: true,
      isHomeDelivery: data.isHomeDelivery || false,
      deliveryAddress: data.deliveryAddress || "",
    });
    if (receiverRes.isNew) {
      showToast(`Đã lưu khách mới ${data.receiverName.trim()} vào danh sách khách hàng`, "success");
    }

    // add-server-session §5.4: refresh session để đồng bộ business_date với chuyến hiện tại.
    // (Nếu draft tạo hôm qua, hôm nay user mở sửa → auto-move sang business_date hôm nay.)
    const updateSess = await fetchBranchSession(branchUUID);
    if (updateSess) setBranchSessions(prev => ({ ...prev, [currentBranch]: updateSess }));

    const updatePayload = {
      branch_id: branchUUID,
      sender_id: senderRes.clientId,
      sender_phone_id: senderRes.phoneId,
      receiver_id: receiverRes.clientId,
      receiver_phone_id: receiverRes.phoneId,
      // N-12: snapshot tên/SĐT — source of truth cho render bill
      sender_name_text:    data.senderName.trim(),
      sender_phone_text:   data.senderPhone?.trim() || null,
      receiver_name_text:  data.receiverName.trim(),
      receiver_phone_text: data.receiverPhone?.trim() || null,
      goods_type: data.goodsType || null,
      goods_value: data.noDeclaredValue ? 0 : (data.goodsValue ? parseInt(data.goodsValue) : 0),
      package_count: data.packageCount || 1,
      shipping_fee: data.isFreeShipping || data.feeQuoteLater
        ? 0
        : (data.shippingFee ? parseInt(data.shippingFee) : 0),
      special_stars: data.specialStars || 0,
      is_home_delivery: data.isHomeDelivery || false,
      delivery_address: data.isHomeDelivery ? (data.deliveryAddress || null) : null,
      payment_status: data.isFreeShipping ? "free" : (data.feeQuoteLater ? "quote_later" : (data.isPaidImmediately ? "paid" : "unpaid")),
      delivery_status: data.isDraft ? "draft" : "pending",
      require_id_check: data.requireIdCheck || false,
      self_packed: data.selfPacked || false,
      risk_warning: data.riskWarning || false,
      no_declared_value: data.noDeclaredValue || false,
      export_vat: data.exportVat || false,
      order_note: data.orderNote || null,
      // Ngày giao dự kiến (text dd/mm/yyyy).
      expected_delivery_date: data.expectedDeliveryDate || null,
      // add-server-session §5.4: cập nhật business_date theo session hiện tại — CHỈ áp dụng cho draft
      // (draft chưa có business_date cố định). Bill CHÍNH THỨC (đã có bill_code) phải giữ nguyên
      // business_date gốc — nếu không, sửa đơn/cập nhật cước sẽ vô tình đẩy "Ngày gửi" sang hôm nay,
      // làm hỏng rule cross-branch delivery (hasArrived dựa trên business_date < today).
      ...(data.isDraft && updateSess ? { business_date: updateSess.business_date } : {}),
    };

    // TODO(revamp-payment-and-revenue-model): audit log integration (interlocks change add-audit-log).
    // Fetch old row TRƯỚC update để detect transition payment_status → paid (§7.1) + diff cho audit (§3.3)
    const { data: oldBill } = await supabase
      .from("bills")
      .select("*")
      .eq("id", draftId)
      .single();

    const { error: updateError } = await supabase
      .from("bills")
      .update(updatePayload)
      .eq("id", draftId);

    if (updateError) throw updateError;

    // §3.3: log bill_update với diff các field trong whitelist. Skip nếu không có gì đổi.
    const billDiff = diffObjects(oldBill, updatePayload, BILL_AUDIT_FIELDS);
    if (billDiff) {
      logAudit({
        entityType: "bill",
        entityId: draftId,
        entityLabel: oldBill?.bill_code || "Nháp",
        action: "bill_update",
        changes: billDiff,
      });
    }

    // §7.1: nếu chuyển từ unpaid|quote_later → paid (không phải free) → INSERT payment_details
    const newStatus = updatePayload.payment_status;
    const wasUnpaid = oldBill && oldBill.payment_status !== "paid" && oldBill.payment_status !== "free";
    if (wasUnpaid && newStatus === "paid") {
      const feeToInsert = updatePayload.shipping_fee || 0;
      if (feeToInsert > 0) {
        const { error: payErr } = await supabase.from("bill_payment_details").insert({
          bill_id: draftId,
          amount_paid: feeToInsert,
          branch_id: session?.branch_id || branchUUID,
          collected_by: session?.id || null,
          note: null,
        });
        if (payErr) throw payErr;
        await refreshBillActualPaid(draftId);
        // §12.3: log payment_received cho update flow (unpaid → paid)
        logAudit({
          entityType: "bill",
          entityId: draftId,
          entityLabel: oldBill?.bill_code || "Nháp",
          action: "bill_payment_received",
          changes: { payment_status: [oldBill.payment_status, "paid"], amount_paid: [null, feeToInsert] },
          note: "Thu cước lúc sửa đơn",
        });
      }
    }

    showToast(data.isDraft ? "Cập nhật đơn nháp thành công!" : "Cập nhật đơn hàng thành công!", "success");
    fetchData();
    // Rule 7: sau khi c\u1eadp nh\u1eadt \u0111\u01a1n ch\u00ednh th\u1ee9c \u2192 re-fetch v\u00e0 m\u1edf l\u1ea1i bill detail v\u1edbi info m\u1edbi.
    const isEditingPendingBill = !data.isDraft
      && oldBill?.delivery_status === "pending"
      && !!oldBill?.bill_code;
    if (isEditingPendingBill) {
      const { data: fresh } = await supabase
        .from("bills")
        .select(`
          *,
          sender:clients!sender_id(fullname),
          receiver:clients!receiver_id(fullname),
          sender_phone:client_phones!sender_phone_id(phone_number),
          receiver_phone:client_phones!receiver_phone_id(phone_number),
          branch:branches!branch_id(branch_code, address, hotline, address_note),
          creator:profiles!created_by(id, username, full_name),
          deliverer:profiles!delivered_by(id, username, full_name)
        `)
        .eq("id", draftId)
        .single();
      if (fresh) setSelectedBill(fresh);
    }
    // Lưu nháp: giữ nguyên màn hình đang sửa (không reset form / không nhảy sang tạo đơn mới).
    if (!data.isDraft) {
      resetCreateBillForm();
    }
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    console.error("Error updating draft:", err);
    showToast((data.isDraft ? "Lỗi cập nhật nháp: " : "Lỗi cập nhật đơn hàng: ") + err.message, "error");
  } finally {
    setLoading(false);
  }
};

// 2d. Convert draft to official bill (assign bill_code and set status to pending)
const executeConvertDraftToBill = async (draftId, data, opts) => {
  if (!data || !draftId) return;
  setLoading(true);

  try {
    const { data: branchData } = await supabase
      .from("branches")
      .select("id")
      .eq("branch_code", currentBranch)
      .single();
    
    const branchUUID = branchData ? branchData.id : null;

    // add-server-session §5.3: refresh session (auto-roll qua ngày) trước khi tính bill_code.
    let convertSess = await fetchBranchSession(branchUUID);
    if (!convertSess) { throw new Error("Không tải được session chi nhánh"); }
    setBranchSessions(prev => ({ ...prev, [currentBranch]: convertSess }));

    // Use reserved bill code if available, otherwise build from session
    // ignoreReservedCode: khi tạo đơn cho chuyến mai (vừa advance session) → mã reserve cũ của hôm nay không còn đúng.
    let billCode = opts?.ignoreReservedCode ? buildBillCodeFromSession(currentBranch, convertSess) : reservedBillCode;
    if (!billCode || billCode === "---" || billCode === "ERR" || billCode === "Đang tải...") {
      billCode = buildBillCodeFromSession(currentBranch, convertSess);
    }

    // I-6 + N-12 + N-13: resolve thống nhất qua helper
    const senderRes = await resolveOrCreateClient({
      fullname: data.senderName,
      phone: data.senderPhone,
      isReceiver: false,
      isHomeDelivery: false,
      deliveryAddress: "",
    });
    if (senderRes.isNew) {
      showToast(`Đã lưu khách mới ${data.senderName.trim()} vào danh sách khách hàng`, "success");
    }

    const receiverRes = await resolveOrCreateClient({
      fullname: data.receiverName,
      phone: data.receiverPhone,
      isReceiver: true,
      isHomeDelivery: data.isHomeDelivery || false,
      deliveryAddress: data.deliveryAddress || "",
    });
    if (receiverRes.isNew) {
      showToast(`Đã lưu khách mới ${data.receiverName.trim()} vào danh sách khách hàng`, "success");
    }

    const updatePayload = {
      branch_id: branchUUID,
      bill_code: billCode,
      // Snapshot address + hotline + note chi nhánh khi convert draft → pending (bill in cho khách).
      branch_address_snapshot: (branchInfoById[branchUUID] || {}).address || null,
      branch_hotline_snapshot: (branchInfoById[branchUUID] || {}).hotline || null,
      branch_address_note_snapshot: (branchInfoById[branchUUID] || {}).address_note || null,
      sender_id: senderRes.clientId,
      sender_phone_id: senderRes.phoneId,
      receiver_id: receiverRes.clientId,
      receiver_phone_id: receiverRes.phoneId,
      // N-12: snapshot tên/SĐT — source of truth cho render bill
      sender_name_text:    data.senderName.trim(),
      sender_phone_text:   data.senderPhone?.trim() || null,
      receiver_name_text:  data.receiverName.trim(),
      receiver_phone_text: data.receiverPhone?.trim() || null,
      goods_type: data.goodsType || null,
      goods_value: data.noDeclaredValue ? 0 : (data.goodsValue ? parseInt(data.goodsValue) : 0),
      package_count: data.packageCount || 1,
      shipping_fee: data.isFreeShipping || data.feeQuoteLater
        ? 0
        : (data.shippingFee ? parseInt(data.shippingFee) : 0),
      special_stars: data.specialStars || 0,
      is_home_delivery: data.isHomeDelivery || false,
      delivery_address: data.isHomeDelivery ? (data.deliveryAddress || null) : null,
      payment_status: data.isFreeShipping ? "free" : (data.feeQuoteLater ? "quote_later" : (data.isPaidImmediately ? "paid" : "unpaid")),
      delivery_status: "pending",
      require_id_check: data.requireIdCheck || false,
      self_packed: data.selfPacked || false,
      risk_warning: data.riskWarning || false,
      no_declared_value: data.noDeclaredValue || false,
      export_vat: data.exportVat || false,
      order_note: data.orderNote || null,
      created_by: session?.id || null,
      // Snapshot tên nhân viên tạo đơn — không đổi khi admin sửa full_name sau này.
      creator_name_snapshot: session?.full_name || session?.username || null,
      // Ngày giao dự kiến (text dd/mm/yyyy).
      expected_delivery_date: data.expectedDeliveryDate || null,
      // add-server-session §5.3 + I-4: business_date từ session (ngày kinh doanh, có thể là mai nếu đã xuất bến).
      business_date: convertSess.business_date,
      // Convert draft → pending: cập nhật created_at = now() để bill mới submit hiện đúng thứ tự
      // (mặc dù created_at cũ là lúc lưu nháp, thời điểm "vào hệ thống" thực sự là lúc submit).
      created_at: new Date().toISOString(),
    };

    // I-9: retry tối đa 3 lần nếu bị conflict UNIQUE(branch_id, bill_code)
    const MAX_RETRY = 3;
    let convertOk = false;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const { error: updateError } = await supabase
        .from("bills")
        .update({ ...updatePayload, bill_code: billCode })
        .eq("id", draftId);
      if (!updateError) { convertOk = true; break; }
      if (!isBillCodeConflict(updateError)) throw updateError;
      console.warn(`[I-9] bill_code ${billCode} bị trùng khi convert draft, retry lần ${attempt + 1}/${MAX_RETRY}`);
      lastErr = updateError;
      billCode = await computeBillCodeFromDB(branchUUID, currentBranch);
    }
    if (!convertOk) throw lastErr || new Error("Không thể tạo mã bill duy nhất sau nhiều lần thử");

    // add-server-session §5.3: tăng bill_seq trong DB cho lần tạo bill kế tiếp
    const updatedSess = await incrementBillSeqOnDB(branchUUID);
    if (updatedSess) setBranchSessions(prev => ({ ...prev, [currentBranch]: updatedSess }));

    // Revamp §7.2: nếu convert với isPaidImmediately → insert payment row (branch=login, collected_by=login)
    if (data.isPaidImmediately && !data.isFreeShipping && !data.feeQuoteLater) {
      const { error: payErr } = await supabase.from("bill_payment_details").insert({
        bill_id: draftId,
        amount_paid: Number(data.shippingFee) || 0,
        branch_id: session?.branch_id || branchUUID,
        collected_by: session?.id || null,
        note: null,
      });
      if (payErr) throw payErr;
      await refreshBillActualPaid(draftId);
      // §12.3: log payment_received cho convert flow
      logAudit({
        entityType: "bill",
        entityId: draftId,
        entityLabel: billCode,
        action: "bill_payment_received",
        changes: { payment_status: [null, "paid"], amount_paid: [null, Number(data.shippingFee) || 0] },
        note: "Thu cước lúc convert draft",
      });
    }

    // §3.4: log bill_update cho convert draft → pending (đánh dấu chuyển trạng thái)
    logAudit({
      entityType: "bill",
      entityId: draftId,
      entityLabel: billCode,
      action: "bill_update",
      changes: {
        delivery_status: ["draft", "pending"],
        bill_code: [null, billCode],
      },
      note: "Convert nháp thành đơn chính thức",
    });

    showToast(`Đã tạo đơn hàng ${billCode} thành công!`, "success");
    fetchData();
    resetCreateBillForm();
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    console.error("Error converting draft to bill:", err);
    showToast("Lỗi tạo đơn hàng: " + err.message, "error");
  } finally {
    setLoading(false);
  }
};

// 3. Thực thi tạo đơn hàng (Fix bug .single() trùng tên, thiếu liên kết SĐT)
const executeCreateBill = async (data, opts) => {
  if (!data) return;
  setLoading(true);

  try {
    const { data: branchData } = await supabase
      .from("branches")
      .select("id")
      .eq("branch_code", currentBranch)
      .single();
    
    const branchUUID = branchData ? branchData.id : null;

    // add-server-session §5.2: refresh session (auto-roll qua ngày) cho cả draft + bill chính thức.
    // Draft cần business_date từ session (nên xuất bến sẽ push draft sang ngày mới đúng).
    let createSess = await fetchBranchSession(branchUUID);
    if (!createSess) { throw new Error("Không tải được session chi nhánh"); }
    setBranchSessions(prev => ({ ...prev, [currentBranch]: createSess }));

    // Draft bills không cần mã, chỉ tạo mã khi submit thành đơn chính thức
    let generatedCode = null;

    if (!data.isDraft) {
      // Dùng mã đã reserve (mã preview = mã thật). ignoreReservedCode: chuyến mai → build mã từ session mới.
      generatedCode = opts?.ignoreReservedCode ? buildBillCodeFromSession(currentBranch, createSess) : reservedBillCode;
      // Fallback: nếu chưa có mã reserve, build từ session
      if (!generatedCode || generatedCode === "---" || generatedCode === "ERR") {
        generatedCode = buildBillCodeFromSession(currentBranch, createSess);
      }
    }

    // BƯỚC A+B: I-6 + N-12 + N-13 — resolve thống nhất qua helper
    const senderRes = await resolveOrCreateClient({
      fullname: data.senderName,
      phone: data.senderPhone,
      isReceiver: false,
      isHomeDelivery: false,
      deliveryAddress: "",
    });
    if (senderRes.isNew) {
      showToast(`Đã lưu khách mới ${data.senderName.trim()} vào danh sách khách hàng`, "success");
    }
    const senderUUID = senderRes.clientId;
    const senderPhoneUUID = senderRes.phoneId;

    const receiverRes = await resolveOrCreateClient({
      fullname: data.receiverName,
      phone: data.receiverPhone,
      isReceiver: true,
      isHomeDelivery: data.isHomeDelivery || false,
      deliveryAddress: data.deliveryAddress || "",
    });
    if (receiverRes.isNew) {
      showToast(`Đã lưu khách mới ${data.receiverName.trim()} vào danh sách khách hàng`, "success");
    }
    const receiverUUID = receiverRes.clientId;
    const receiverPhoneUUID = receiverRes.phoneId;

    // BƯỚC C: Tạo Bill dưới Supabase — I-9: retry tối đa 3 lần nếu bị conflict UNIQUE(branch_id, bill_code)
    const bInfo = branchInfoById[branchUUID] || {};
    const buildBillPayload = (billCode) => ({
      bill_code: billCode,
      branch_id: branchUUID,
      // Snapshot address + hotline + note chi nhánh tại thời điểm tạo bill (dùng in bill).
      branch_address_snapshot: bInfo.address || null,
      branch_hotline_snapshot: bInfo.hotline || null,
      branch_address_note_snapshot: bInfo.address_note || null,
      sender_id: senderUUID,
      sender_phone_id: senderPhoneUUID,
      receiver_id: receiverUUID,
      receiver_phone_id: receiverPhoneUUID,
      // N-12: snapshot tên/SĐT — source of truth cho render bill
      sender_name_text:    data.senderName.trim(),
      sender_phone_text:   data.senderPhone?.trim() || null,
      receiver_name_text:  data.receiverName.trim(),
      receiver_phone_text: data.receiverPhone?.trim() || null,
      goods_type: data.goodsType,
      goods_value: data.noDeclaredValue ? 0 : (Number(data.goodsValue) || 0),
      shipping_fee: data.isFreeShipping || data.feeQuoteLater
        ? 0
        : (data.shippingFee ? Number(data.shippingFee) : 0),
      package_count: Number(data.packageCount) || 1,
      is_home_delivery: data.isHomeDelivery,
      delivery_address: data.isHomeDelivery ? data.deliveryAddress : null,
      payment_status: data.isFreeShipping ? "free" : (data.feeQuoteLater ? "quote_later" : (data.isPaidImmediately ? "paid" : "unpaid")),
      delivery_status: data.isDraft ? "draft" : "pending",
      special_stars: data.noDeclaredValue ? 0 : data.specialStars,
      require_id_check: data.requireIdCheck,
      risk_warning: data.riskWarning,
      self_packed: data.selfPacked,
      no_declared_value: data.noDeclaredValue,
      export_vat: data.exportVat,
      order_note: data.orderNote || null,
      goods_location: "out",
      created_by: session?.id || null,
      // Snapshot tên nhân viên tạo đơn — không đổi khi admin sửa full_name sau này.
      creator_name_snapshot: session?.full_name || session?.username || null,
      // Ngày giao dự kiến (text dd/mm/yyyy, nhân viên có thể override).
      expected_delivery_date: data.expectedDeliveryDate || null,
      // add-server-session §5.2 + I-4 fix: business_date lấy từ session (không phải NOW()).
      // Nếu đã xuất bến → business_date = mai; draft cũng phải theo session.
      business_date: createSess.business_date,
    });

    let newBill = null;
    let currentBillCode = generatedCode;
    if (data.isDraft) {
      // Draft không có bill_code → không có conflict, insert 1 lần
      const { data: bill, error: billErr } = await supabase
        .from("bills")
        .insert(buildBillPayload(currentBillCode))
        .select().single();
      if (billErr) throw billErr;
      newBill = bill;
    } else {
      const MAX_RETRY = 3;
      let lastErr = null;
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        const { data: bill, error: billErr } = await supabase
          .from("bills")
          .insert(buildBillPayload(currentBillCode))
          .select().single();
        if (!billErr) { newBill = bill; break; }
        if (!isBillCodeConflict(billErr)) throw billErr;
        // Race: có bill khác vừa chiếm mã này → recompute từ DB rồi retry
        console.warn(`[I-9] bill_code ${currentBillCode} bị trùng, retry lần ${attempt + 1}/${MAX_RETRY}`);
        lastErr = billErr;
        currentBillCode = await computeBillCodeFromDB(branchUUID, currentBranch);
      }
      if (!newBill) throw lastErr || new Error("Không thể tạo mã bill duy nhất sau nhiều lần thử");
    }

    // BƯỚC D: Tạo dòng tiền (revamp §6.1 branch=login, §7.3 collected_by, §8 refresh cache)
    if (data.isPaidImmediately && !data.isFreeShipping && !data.feeQuoteLater) {
      const { error: payErr } = await supabase.from("bill_payment_details").insert({
        bill_id: newBill.id,
        amount_paid: Number(data.shippingFee) || 0,
        branch_id: session?.branch_id || branchUUID, // §D3: chi nhánh nhân viên login
        collected_by: session?.id || null,           // §D8
        note: null,                                   // intake: không có note
      });
      if (payErr) throw payErr;
      await refreshBillActualPaid(newBill.id);
      // §12.3: log payment_received cho intake paid-immediately
      logAudit({
        entityType: "bill",
        entityId: newBill.id,
        entityLabel: newBill.bill_code,
        action: "bill_payment_received",
        changes: { payment_status: [null, "paid"], amount_paid: [null, Number(data.shippingFee) || 0] },
        note: "Thu cước lúc tạo bill",
      });
    }

    // §3.1 / §3.2: log bill_create (cả draft và pending) — snapshot key fields
    logAudit({
      entityType: "bill",
      entityId: newBill.id,
      entityLabel: newBill.bill_code || "Nháp",
      action: "bill_create",
      changes: {
        shipping_fee: [null, newBill.shipping_fee],
        payment_status: [null, newBill.payment_status],
        delivery_status: [null, newBill.delivery_status],
        sender_name_text: [null, newBill.sender_name_text],
        sender_phone_text: [null, newBill.sender_phone_text],
        receiver_name_text: [null, newBill.receiver_name_text],
        receiver_phone_text: [null, newBill.receiver_phone_text],
        package_count: [null, newBill.package_count],
        order_note: [null, newBill.order_note],
      },
      note: data.isDraft ? "Nháp" : null,
    });

    showToast(
      data.isDraft 
        ? "Đã lưu nháp thành công!" 
        : `Đã lưu thành công Đơn Hàng mã: ${newBill.bill_code}!`
    );

    // add-server-session §5.2: Chỉ tăng bill_seq trên DB khi tạo BILL CHÍNH THỨC (draft không dùng bill_code).
    if (!data.isDraft) {
      const updatedSess = await incrementBillSeqOnDB(branchUUID);
      if (updatedSess) setBranchSessions(prev => ({ ...prev, [currentBranch]: updatedSess }));
    }

    fetchData();

    // Reserve mã mới cho đơn tiếp theo
    reserveBillCode();

    // Reset Form (Fix #1: Clear form sau khi lưu nháp/đơn)
    resetCreateBillForm();
  } catch (err) {
    showToast("Lỗi tạo đơn hàng: " + err.message, "error");
  } finally {
    setLoading(false);
  }
};

// 4. Revamp payment & revenue: TÁCH thành 2 handler độc lập.
//    - handleConfirmDelivery: bill pending → delivered (có thể kèm thanh toán full/actual, hoặc để unpaid).
//    - handleConfirmPayment:  bill delivered+unpaid → delivered+paid (chỉ thanh toán, KHÔNG đụng delivery fields).

// Helper §8.1: sau mỗi INSERT bill_payment_details, tính lại SUM và cache vào bills.actual_amount_paid.
// Lỗi ở đây không throw (giống audit log) — doanh thu vẫn đọc từ payment_details là nguồn truth.
const refreshBillActualPaid = async (billId) => {
  try {
    const { data, error } = await supabase
      .from("bill_payment_details")
      .select("amount_paid")
      .eq("bill_id", billId);
    if (error) throw error;
    const total = (data || []).reduce((s, p) => s + Number(p.amount_paid || 0), 0);
    const { error: updErr } = await supabase
      .from("bills")
      .update({ actual_amount_paid: total })
      .eq("id", billId);
    if (updErr) throw updErr;
    return total;
  } catch (err) {
    console.warn("[refreshBillActualPaid] non-fatal:", err?.message || err);
    return null;
  }
};

// Xác nhận GIAO HÀNG. Bill phải đang `pending`.
const handleConfirmDelivery = async () => {
  if (!selectedBill) return;
  if (session?.role === 'boss') {
    showToast('Boss chỉ được xem, không được xác nhận giao hàng.', 'error');
    return;
  }
  if (!(await requireSysAdminUnlock())) return;
  // §Bugfix: đọc lại bill mới nhất từ DB thay vì tin local state `selectedBill` —
  // tránh trường hợp chi nhánh khác vừa cập nhật payment_status/delivery_status
  // (VD: SG vừa thu tiền) nhưng máy đang xem (GL) chưa refetch → thu tiền/log trùng.
  const { data: liveBill, error: liveErr } = await supabase
    .from("bills")
    .select("id, delivery_status, payment_status, shipping_fee, branch_id, bill_code")
    .eq("id", selectedBill.id)
    .single();
  if (liveErr || !liveBill) {
    showToast("Không tải được dữ liệu đơn hàng mới nhất — vui lòng thử lại!", "error");
    return;
  }
  if (liveBill.delivery_status !== "pending") {
    showToast("Bill này không ở trạng thái chờ giao — không thể xác nhận giao lần nữa!", "error");
    return;
  }
  // §14.37: đơn quote_later phải cập nhật cước trước — bypass cho sys_admin.
  if (liveBill.payment_status === "quote_later" && userRole !== "sys_admin") {
    showToast("Đơn chưa có cước phí — vui lòng cập nhật cước trước khi xác nhận giao hàng!", "error");
    return;
  }

  // Validate người nhận hàng
  if (!recipientType) {
    showToast("Vui lòng chọn người nhận hàng (Chính chủ / Nhận giùm / Giao tận nhà)!", "error");
    return;
  }
  if (recipientType === "helper" && !repName.trim()) {
    showToast("Vui lòng nhập Thông tin người nhận (Người nhà, shipper...)!", "error");
    return;
  }

  // Validate trạng thái thanh toán (bỏ qua nếu đơn miễn phí / báo giá sau / pre-paid lúc tạo)
  const isFreeBill = liveBill.payment_status === "free";
  const isQuoteLater = liveBill.payment_status === "quote_later";
  const wasPrePaid = liveBill.payment_status === "paid";
  // Quote_later: buộc payOption='unpaid' (không cho thu tại giao vì chưa có cước)
  if (!isFreeBill && !isQuoteLater && !wasPrePaid && !payOption) {
    showToast("Vui lòng chọn trạng thái thanh toán!", "error");
    return;
  }

  // Validate số tiền thực tế
  if (!isFreeBill && payOption === "actual") {
    const n = Number(actualAmountPaid);
    if (!actualAmountPaid || isNaN(n) || n <= 0) {
      showToast("Vui lòng nhập số tiền trả thực tế hợp lệ!", "error");
      return;
    }
    // Rule 6: b\u1eaft nh\u1eadp l\u00fd do khi thu ti\u1ec1n kh\u00f4ng \u0111\u1ee7 c\u01b0\u1edbc \u2192 tr\u00e1nh audit tr\u1ed1ng.
    if (!paymentNote?.trim()) {
      showToast("Vui l\u00f2ng nh\u1eadp l\u00fd do thu thi\u1ebfu / thu kh\u00e1c!", "error");
      return;
    }
  }

  const deliveryISO = new Date().toISOString();

  const ok = await askConfirm({
    title: "Xác nhận giao hàng?",
    message: `Bạn có chắc muốn xác nhận giao đơn ${selectedBill.bill_code || ""}?\nThao tác này sẽ đổi trạng thái sang "Đã giao".`,
    confirmText: "Xác nhận giao"
  });
  if (!ok) return;

  try {
    // Rule 2: nếu bill đã pre-paid (thu tiền lúc tạo) → KHÔNG tạo payment mới + không toast "đã thu" → tránh duplicate audit.
    // Update bill fields (delivery + optional payment)
    const shouldCollectNow = !wasPrePaid && !isFreeBill && !isQuoteLater
      && (payOption === "full" || payOption === "actual");
    const newPaymentStatus = wasPrePaid
      ? "paid"
      : isFreeBill
        ? "free"
        : isQuoteLater
          ? "quote_later" // giữ nguyên; user sẽ chốt sau khi có cước (qua "Xác nhận thanh toán")
          : (shouldCollectNow ? "paid" : "unpaid");

    const { error: billErr } = await supabase
      .from("bills")
      .update({
        delivery_status: "delivered",
        payment_status: newPaymentStatus,
        delivery_date: deliveryISO,
        recipient_type: recipientType,
        actual_recipient_name: recipientType === "helper" ? repName.trim() : null,
        actual_recipient_phone: null,
        actual_recipient_role: null,
        delivered_by: session?.id || null,
        deliverer_name_snapshot: session?.full_name || session?.username || null,
      })
      .eq("id", selectedBill.id);
    if (billErr) throw billErr;

    // Insert payment row (§6.1 branch = login branch, §7 always-insert on paid, §D8 collected_by + note)
    if (shouldCollectNow) {
      const finalAmount = payOption === "full"
        ? Number(liveBill.shipping_fee) || 0
        : Number(actualAmountPaid) || 0;
      const { error: payErr } = await supabase.from("bill_payment_details").insert({
        bill_id: selectedBill.id,
        amount_paid: finalAmount,
        branch_id: session?.branch_id || liveBill.branch_id, // fallback nếu session chưa có branch_id
        collected_by: session?.id || null,
        // Rule 6: khi chọn số tiền thực tế, lưu lý do (nhân viên nhập trong form).
        note: payOption === "actual" ? (paymentNote?.trim() || null) : null,
      });
      if (payErr) throw payErr;
      // §8: refresh cache actual_amount_paid
      await refreshBillActualPaid(selectedBill.id);
    }

    showToast(shouldCollectNow ? "Đã xác nhận giao hàng & thu tiền!" : "Đã xác nhận giao hàng!", "success");
    // §12.1: log bill_delivered
    logAudit({
      entityType: "bill",
      entityId: selectedBill.id,
      entityLabel: selectedBill.bill_code,
      action: "bill_delivered",
      changes: {
        delivery_status: ["pending", "delivered"],
        recipient_type: [null, recipientType],
      },
      note: recipientType === "helper" ? `Người nhận: ${repName.trim()}` : null,
    });
    // §12.3: nếu vừa thu tiền → log riêng 1 entry payment_received
    if (shouldCollectNow) {
      const finalAmount = payOption === "full"
        ? Number(liveBill.shipping_fee) || 0
        : Number(actualAmountPaid) || 0;
      logAudit({
        entityType: "bill",
        entityId: selectedBill.id,
        entityLabel: selectedBill.bill_code,
        action: "bill_payment_received",
        changes: { payment_status: [liveBill.payment_status, "paid"], amount_paid: [null, finalAmount] },
        note: payOption === "actual" && paymentNote?.trim()
          ? `Thu cước lúc giao hàng — ${paymentNote.trim()}`
          : "Thu cước lúc giao hàng",
      });
    }
    // §9: STAY ON PAGE — không clear selectedBill, không đổi tab. Refetch để state machine render đúng.
    await fetchData();
    // Re-fetch bill hi\u1ec7n t\u1ea1i \u2192 selectedBill c\u00f3 info m\u1edbi (delivery_status, deliverer, payment_status\u2026).
    const { data: fresh } = await supabase
      .from("bills")
      .select(`
        *,
        sender:clients!sender_id(fullname),
        receiver:clients!receiver_id(fullname),
        sender_phone:client_phones!sender_phone_id(phone_number),
        receiver_phone:client_phones!receiver_phone_id(phone_number),
        branch:branches!branch_id(branch_code, address, hotline, address_note),
        creator:profiles!created_by(id, username, full_name),
        deliverer:profiles!delivered_by(id, username, full_name)
      `)
      .eq("id", selectedBill.id)
      .single();
    if (fresh) setSelectedBill(fresh);
    // Reset các input tạm (giữ selectedBill để user thấy state mới)
    setPayOption("");
    setActualAmountPaid("");
    setPaymentNote("");
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi xác nhận giao hàng: " + err.message, "error");
  }
};

// Xác nhận THANH TOÁN. Bill phải đang `delivered + unpaid` (hoặc `delivered + quote_later` sau khi có cước).
const handleConfirmPayment = async () => {
  if (!selectedBill) return;
  if (session?.role === 'boss') {
    showToast('Boss chỉ được xem, không được xác nhận thanh toán.', 'error');
    return;
  }
  if (!(await requireSysAdminUnlock())) return;
  // §Bugfix: đọc lại bill mới nhất từ DB — tránh local state stale (chi nhánh khác vừa
  // cập nhật payment_status) dẫn đến thu tiền/log trùng.
  const { data: liveBill, error: liveErr } = await supabase
    .from("bills")
    .select("id, delivery_status, payment_status, shipping_fee, branch_id, bill_code")
    .eq("id", selectedBill.id)
    .single();
  if (liveErr || !liveBill) {
    showToast("Không tải được dữ liệu đơn hàng mới nhất — vui lòng thử lại!", "error");
    return;
  }
  if (liveBill.delivery_status !== "delivered") {
    showToast("Bill chưa được giao — vui lòng xác nhận giao hàng trước!", "error");
    return;
  }
  if (liveBill.payment_status === "paid") {
    showToast("Bill này đã thanh toán rồi!", "info");
    return;
  }
  if (liveBill.payment_status === "free") {
    showToast("Bill miễn phí không cần thu tiền!", "info");
    return;
  }

  // Validate payOption ∈ {full, actual} — KHÔNG có unpaid ở màn thu tiền
  if (!payOption || payOption === "unpaid") {
    showToast("Vui lòng chọn trạng thái thanh toán (Đủ / Trả thiếu)!", "error");
    return;
  }
  if (payOption === "actual") {
    const n = Number(actualAmountPaid);
    if (!actualAmountPaid || isNaN(n) || n <= 0) {
      showToast("Vui lòng nhập số tiền trả thực tế hợp lệ!", "error");
      return;
    }
    // Đồng bộ behavior với handleConfirmDelivery (Rule 6): bắt nhập lý do khi thu thiếu.
    if (!paymentNote?.trim()) {
      showToast("Vui lòng nhập lý do thu thiếu / thu khác!", "error");
      return;
    }
  }

  // Với quote_later: bắt buộc phải có shipping_fee đã cập nhật > 0 mới thu được
  if (liveBill.payment_status === "quote_later" && (!liveBill.shipping_fee || Number(liveBill.shipping_fee) <= 0)) {
    showToast("Bill này đang ở trạng thái báo giá sau — vui lòng cập nhật cước phí ở form sửa đơn trước khi thu tiền!", "error");
    return;
  }

  const ok = await askConfirm({
    title: "Xác nhận thanh toán?",
    message: `Bạn có chắc muốn ghi nhận thanh toán cho đơn ${selectedBill.bill_code || ""}?`,
    confirmText: "Xác nhận thanh toán"
  });
  if (!ok) return;

  try {
    // Update bill payment_status = paid (KHÔNG động delivery fields)
    const { error: billErr } = await supabase
      .from("bills")
      .update({ payment_status: "paid" })
      .eq("id", selectedBill.id);
    if (billErr) throw billErr;

    // Insert payment row (branch = login branch — §D3)
    const finalAmount = payOption === "full"
      ? Number(liveBill.shipping_fee) || 0
      : Number(actualAmountPaid) || 0;
    const { error: payErr } = await supabase.from("bill_payment_details").insert({
      bill_id: selectedBill.id,
      amount_paid: finalAmount,
      branch_id: session?.branch_id || liveBill.branch_id,
      collected_by: session?.id || null,
      note: paymentNote.trim() || null,
    });
    if (payErr) throw payErr;

    // §8: refresh cache
    await refreshBillActualPaid(selectedBill.id);
    // §12.2: log payment_received (thu nợ sau khi đã giao)
    logAudit({
      entityType: "bill",
      entityId: selectedBill.id,
      entityLabel: selectedBill.bill_code,
      action: "bill_payment_received",
      changes: { payment_status: [liveBill.payment_status, "paid"], amount_paid: [null, finalAmount] },
      note: paymentNote.trim() || null,
    });

    showToast(`Đã ghi nhận thanh toán ${finalAmount.toLocaleString("vi-VN")} đ!`, "success");
    // §9: STAY ON PAGE
    await fetchData();
    // Re-fetch bill hi\u1ec7n t\u1ea1i \u2192 selectedBill c\u00f3 payment_status m\u1edbi.
    const { data: fresh } = await supabase
      .from("bills")
      .select(`
        *,
        sender:clients!sender_id(fullname),
        receiver:clients!receiver_id(fullname),
        sender_phone:client_phones!sender_phone_id(phone_number),
        receiver_phone:client_phones!receiver_phone_id(phone_number),
        branch:branches!branch_id(branch_code, address, hotline, address_note),
        creator:profiles!created_by(id, username, full_name),
        deliverer:profiles!delivered_by(id, username, full_name)
      `)
      .eq("id", selectedBill.id)
      .single();
    if (fresh) setSelectedBill(fresh);
    setPayOption("");
    setActualAmountPaid("");
    setPaymentNote("");
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi xác nhận thanh toán: " + err.message, "error");
  }
};

// Backwards-compat wrapper cho các entry point cũ (nếu có). Sẽ được xóa sau §14 archive.
const handleSavePaymentAndDelivery = async () => {
  if (!selectedBill) return;
  if (selectedBill.delivery_status === "pending") {
    await handleConfirmDelivery();
  } else if (selectedBill.delivery_status === "delivered" && selectedBill.payment_status !== "paid" && selectedBill.payment_status !== "free") {
    await handleConfirmPayment();
  } else {
    showToast("Đơn này không cần cập nhật thêm.", "info");
  }
};

// 4b. Hủy đơn (draft VÀ pending đều soft-cancel: set delivery_status='cancelled' + prepend lý do)
const handleConfirmCancelBill = async () => {
  if (!cancelDialog) return;
  if (!(await requireSysAdminUnlock())) return;
  const { bill, reason } = cancelDialog;
  const reasonTrim = (reason || "").trim();
  if (!reasonTrim) {
    showToast("Vui lòng nhập lý do hủy đơn!", "error");
    return;
  }
  try {
    const oldStatus = bill.delivery_status; // 'draft' | 'pending' | 'delivered'
    const isDraft = oldStatus === "draft";

    // Soft-cancel cho cả draft lẫn pending: giữ mã (nếu có), set trạng thái = cancelled, lưu lý do vào order_note
    const existingNote = (bill.order_note || "").trim();
    const newNote = existingNote
      ? `[LÝ DO HỦY]: ${reasonTrim}\n\n[Ghi chú gốc]: ${existingNote}`
      : `[LÝ DO HỦY]: ${reasonTrim}`;
    const { error } = await supabase
      .from("bills")
      .update({ delivery_status: "cancelled", order_note: newNote })
      .eq("id", bill.id);
    if (error) throw error;

    logAudit({
      entityType: "bill",
      entityId: bill.id,
      entityLabel: bill.bill_code || "Nháp",
      action: "bill_cancel",
      changes: { delivery_status: [oldStatus, "cancelled"] },
      note: reasonTrim,
    });

    // Refund flow: draft chưa có payment → skip; pending/delivered có thể đã thu tiền → check
    if (isDraft) {
      showToast("Đã hủy đơn nháp!");
    } else {
      try {
        const { data: paidRows } = await supabase
          .from("bill_payment_details")
          .select("amount_paid")
          .eq("bill_id", bill.id);
        const refundAmount = (paidRows || []).reduce((s, r) => s + Number(r.amount_paid || 0), 0);
        if (refundAmount > 0) {
          const { data: refundRow, error: expErr } = await supabase.from("expenses").insert({
            amount: refundAmount,
            note: `Hoàn tiền cho bill ${bill.bill_code}`,
            branch_id: bill.branch_id, // §16.1: branch của bill (chi nhánh đã thu tiền), KHÔNG session
            created_by: session?.id || null,
          }).select("id").single();
          if (expErr) {
            console.warn("[refund expense] non-fatal:", expErr?.message);
            showToast(`Đã hủy đơn ${bill.bill_code} nhưng lỗi tạo phiếu hoàn tiền: ${expErr.message}`, "error");
          } else {
            showToast(`Đã hủy đơn ${bill.bill_code} — tạo phiếu hoàn tiền ${refundAmount.toLocaleString("vi-VN")} đ.`, "success");
            // §16.2: log refund_created
            logAudit({
              entityType: "expense",
              entityId: refundRow?.id || null,
              entityLabel: `Hoàn tiền cho bill ${bill.bill_code}`,
              action: "refund_created",
              changes: { amount: [null, refundAmount], source_bill: [null, bill.bill_code] },
              note: "Auto tạo khi cancel bill có payment",
            });
          }
        } else {
          showToast(`Đã hủy đơn ${bill.bill_code}!`);
        }
      } catch (refundErr) {
        console.warn("[refund lookup] non-fatal:", refundErr?.message);
        showToast(`Đã hủy đơn ${bill.bill_code}!`);
      }
    }
    setCancelDialog(null);
    setSelectedBill(null);
    setActiveSubTab("create");
    resetCreateBillForm();
    fetchData();
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi hủy đơn: " + err.message, "error");
  }
};

// 5. Cập nhật vị trí kho tự động (Màn hình 8) — auto save, không hỏi confirm
const handleToggleLocation = async (billId, newLoc) => {
  try {
    const { error } = await supabase
      .from("bills")
      .update({ goods_location: newLoc })
      .eq("id", billId);

    if (error) throw error;
    setBills(prev => prev.map(b => b.id === billId ? { ...b, goods_location: newLoc } : b));
    showToast("Đã cập nhật vị trí kho thực tế!");
  } catch (err) {
    showToast("Lỗi cập nhật kho: " + err.message, "error");
  }
};

// 5b. Cập nhật số kiện trong/ngoài (Màn hình 8)
// Rule: chỉ nhân viên cùng branch với bill mới được update. Boss + admin/member khác branch → deny.
const handleUpdateLocationCounts = async (billId, field, value) => {
  // Nếu rỗng thì set null, không thì parse thành số
  const numValue = value === '' ? null : parseInt(value);
  if (numValue !== null && numValue < 0) return;

  const bill = bills.find(b => b.id === billId);
  if (!bill) return;

  // Boss = read-only
  if (session?.role === 'boss') {
    showToast('Boss chỉ được xem, không được cập nhật.', 'error');
    return;
  }
  // Branch check: chi nhánh đang giữ hàng (current_branch cho đơn hoàn hàng, else gốc) mới update kho được.
  const effBranchCode = bill.current_branch?.branch_code || bill.branch?.branch_code;
  if (effBranchCode !== session?.branch_code) {
    showToast(`Chỉ nhân viên chi nhánh ${effBranchCode} mới được cập nhật kho này!`, 'error');
    return;
  }
  // Rule: qua ngày lịch thì khóa danh sách bốc xếp của ngày cũ. sys_admin bypass.
  if (userRole !== 'sys_admin' && (bill.business_date || '') < getVNTodayDate()) {
    showToast('Đã qua ngày — không sửa được danh sách bốc xếp của ngày cũ!', 'error');
    return;
  }

  try {
    // Update state ngay để UI phản hồi nhanh
    setBills(prev => prev.map(b => b.id === billId ? { ...b, [field]: numValue } : b));

    const newInsideCount = field === 'inside_count' ? numValue : bill.inside_count;
    const newOutsideCount = field === 'outside_count' ? numValue : bill.outside_count;
    const hasValue = newInsideCount !== null || newOutsideCount !== null;
    const total = (newInsideCount ?? 0) + (newOutsideCount ?? 0);

    const { error } = await supabase
      .from("bills")
      .update({ [field]: numValue })
      .eq("id", billId);

    if (error) throw error;

    if (hasValue && total !== bill.package_count) {
      showToast(`⚠️ Tổng kiện (${total}) khác với số kiện đơn hàng (${bill.package_count})`, "error");
    }
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
};

// expand/warehouse: cột "Hàng Ghép" — nhân viên tự điền (text). Local update khi gõ, lưu DB khi blur.
const handleCombinedGoodsSave = async (billId, value) => {
  const bill = bills.find(b => b.id === billId);
  if (!bill) return;
  if (session?.role === 'boss') return;
  const effBranchCode = bill.current_branch?.branch_code || bill.branch?.branch_code;
  if (effBranchCode !== session?.branch_code) {
    showToast(`Chỉ nhân viên chi nhánh ${effBranchCode} mới được cập nhật kho này!`, 'error');
    return;
  }
  // Rule: qua ngày lịch thì khóa danh sách bốc xếp của ngày cũ. sys_admin bypass.
  if (userRole !== 'sys_admin' && (bill.business_date || '') < getVNTodayDate()) {
    showToast('Đã qua ngày — không sửa được danh sách bốc xếp của ngày cũ!', 'error');
    return;
  }
  const clean = (value || "").trim() || null;
  if (clean === (bill.combined_goods ?? null)) return;
  try {
    const { error } = await supabase
      .from("bills")
      .update({ combined_goods: clean })
      .eq("id", billId);
    if (error) throw error;
    setBills(prev => prev.map(b => b.id === billId ? { ...b, combined_goods: clean } : b));
  } catch (err) {
    showToast("Lỗi lưu hàng ghép: " + err.message, "error");
  }
};

// ===== add-return-and-destroy-flow: Hoàn hàng (returned) & Tiêu hủy (destroyed) =====
// Re-fetch 1 bill với đầy đủ join (dùng cho detail view sau mỗi mutation hoàn hàng).
const fetchBillById = async (id) => {
  const { data } = await supabase
    .from("bills")
    .select(`
      *,
      sender:clients!sender_id(fullname),
      receiver:clients!receiver_id(fullname),
      sender_phone:client_phones!sender_phone_id(phone_number),
      receiver_phone:client_phones!receiver_phone_id(phone_number),
      branch:branches!branch_id(branch_code, address, hotline, address_note),
      current_branch:branches!current_branch_id(branch_code),
      creator:profiles!created_by(id, username, full_name),
      deliverer:profiles!delivered_by(id, username, full_name)
    `)
    .eq("id", id)
    .single();
  return data || null;
};

// Quay đầu: chở hàng về người gửi, thu cước (đi + về). business_date → hôm nay;
// current_branch_id = chi nhánh đang giữ (để vào Bốc Xếp chuyến về); giữ mã đơn.
const handleReturnBill = async () => {
  const dlg = returnDialog;
  if (!dlg?.bill) return;
  const bill = dlg.bill;
  const reason = (dlg.reason || "").trim();
  if (!reason) { showToast("Vui lòng nhập lý do hoàn hàng!", "error"); return; }
  if (!(await requireSysAdminUnlock())) return;
  const returnFee = Number(dlg.returnFee) || 0;
  const todayVN = getVNTodayDate();
  const existingNote = (bill.order_note || "").trim();
  const newNote = existingNote
    ? `[HOÀN HÀNG]: ${reason}\n\n[Ghi chú gốc]: ${existingNote}`
    : `[HOÀN HÀNG]: ${reason}`;
  try {
    const { error } = await supabase.from("bills").update({
      delivery_status: "returned",
      return_fee: returnFee,
      current_branch_id: session?.branch_id || bill.branch_id,
      business_date: todayVN,
      return_confirmed_at: null,
      order_note: newNote,
    }).eq("id", bill.id);
    if (error) throw error;
    logAudit({
      entityType: "bill", entityId: bill.id, entityLabel: bill.bill_code,
      action: "bill_returned",
      changes: {
        delivery_status: [bill.delivery_status, "returned"],
        return_fee: [bill.return_fee ?? 0, returnFee],
        business_date: [bill.business_date, todayVN],
      },
      note: reason,
    });
    showToast(`Đã hoàn hàng đơn ${bill.bill_code}!`, "success");
    setReturnDialog(null);
    await fetchData();
    const fresh = await fetchBillById(bill.id);
    if (fresh) setSelectedBill(fresh);
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi hoàn hàng: " + err.message, "error");
  }
};

// Tiêu hủy: chỉ khi đơn KHÔNG còn nợ (paid/free). Hàng bỏ tại chi nhánh nhận, không chuyến về.
const handleDestroyBill = async () => {
  const dlg = returnDialog;
  if (!dlg?.bill) return;
  const bill = dlg.bill;
  const reason = (dlg.reason || "").trim();
  if (!reason) { showToast("Vui lòng nhập lý do tiêu hủy!", "error"); return; }
  if (bill.payment_status !== "paid" && bill.payment_status !== "free") {
    showToast("Đơn còn nợ cước — phải Quay đầu để thu tiền, không được tiêu hủy!", "error");
    return;
  }
  if (!(await requireSysAdminUnlock())) return;
  const existingNote = (bill.order_note || "").trim();
  const newNote = existingNote
    ? `[TIÊU HỦY]: ${reason}\n\n[Ghi chú gốc]: ${existingNote}`
    : `[TIÊU HỦY]: ${reason}`;
  try {
    const { error } = await supabase.from("bills").update({
      delivery_status: "destroyed",
      order_note: newNote,
    }).eq("id", bill.id);
    if (error) throw error;
    logAudit({
      entityType: "bill", entityId: bill.id, entityLabel: bill.bill_code,
      action: "bill_destroyed",
      changes: { delivery_status: [bill.delivery_status, "destroyed"] },
      note: reason,
    });
    showToast(`Đã tiêu hủy đơn ${bill.bill_code}!`, "success");
    setReturnDialog(null);
    await fetchData();
    const fresh = await fetchBillById(bill.id);
    if (fresh) setSelectedBill(fresh);
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi tiêu hủy: " + err.message, "error");
  }
};

// GL xác nhận đã nhận lại hàng (bước 2 của quay đầu). current_branch_id → về chi nhánh gốc.
const handleConfirmReturnArrived = async () => {
  if (!selectedBill) return;
  if (session?.role === "boss") { showToast("Boss chỉ được xem.", "error"); return; }
  if (!(await requireSysAdminUnlock())) return;
  const ok = await askConfirm({
    title: "Xác nhận đã hoàn hàng thành công?",
    message: `Xác nhận hàng của đơn ${selectedBill.bill_code || ""} đã hoàn về cho người gửi.`,
    confirmText: "Xác nhận",
  });
  if (!ok) return;
  try {
    const { error } = await supabase.from("bills").update({
      return_confirmed_at: new Date().toISOString(),
    }).eq("id", selectedBill.id);
    if (error) throw error;
    logAudit({
      entityType: "bill", entityId: selectedBill.id, entityLabel: selectedBill.bill_code,
      action: "bill_return_confirmed",
      changes: {},
    });
    showToast("Đã xác nhận hoàn hàng về thành công!", "success");
    await fetchData();
    const fresh = await fetchBillById(selectedBill.id);
    if (fresh) setSelectedBill(fresh);
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi xác nhận: " + err.message, "error");
  }
};

// sys_admin sửa lại cước hoàn (về) của đơn returned (vd nhập nhầm). Chỉ đổi return_fee.
const handleSaveReturnFee = async () => {
  if (!selectedBill || userRole !== "sys_admin") return;
  if (!(await requireSysAdminUnlock())) return;
  const newFee = Number(editReturnFee) || 0;
  const oldFee = Number(selectedBill.return_fee) || 0;
  if (newFee === oldFee) { setEditReturnFee(null); return; }
  try {
    const { error } = await supabase.from("bills").update({ return_fee: newFee }).eq("id", selectedBill.id);
    if (error) throw error;
    logAudit({
      entityType: "bill", entityId: selectedBill.id, entityLabel: selectedBill.bill_code,
      action: "bill_update",
      changes: { return_fee: [oldFee, newFee] },
      note: "sys_admin sửa cước hoàn",
    });
    showToast("Đã cập nhật cước hoàn!", "success");
    setEditReturnFee(null);
    await fetchData();
    const fresh = await fetchBillById(selectedBill.id);
    if (fresh) setSelectedBill(fresh);
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi cập nhật cước hoàn: " + err.message, "error");
  }
};

// Nhắc nhở hằng ngày: chỉ hiện cho user đã mở app TRƯỚC mốc giờ (không hiện khi login trễ /
// qua ngày / sau 18:00). Mỗi mốc 1 lần/phiên. Trừ boss & sys_admin.
const reminderMountRef = useRef(null);
const reminderShownRef = useRef({});
useEffect(() => {
  if (!session || userRole === "boss" || userRole === "sys_admin") return;
  const toMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  reminderMountRef.current = toMin(getVNNowHHMM()); // giờ mở app (phút trong ngày)
  reminderShownRef.current = {};
  const CLOSE_AT = toMin("18:00");
  const check = () => {
    const nowM = toMin(getVNNowHHMM());
    if (nowM >= CLOSE_AT) return;
    setDailyReminder(curr => {
      if (curr) return curr; // đang hiện 1 cái → chờ user đóng
      for (const r of DAILY_REMINDERS) {
        const tM = toMin(r.time);
        if (reminderMountRef.current < tM && nowM >= tM && !reminderShownRef.current[r.id]) {
          reminderShownRef.current[r.id] = true;
          return r;
        }
      }
      return null;
    });
  };
  check();
  const iv = setInterval(check, 30000);
  return () => clearInterval(iv);
}, [session, userRole]);

const dismissDailyReminder = () => setDailyReminder(null);

// Thu tiền đơn hoàn: (shipping_fee + return_fee) − đã trả → payment (branch = chi nhánh thu, now).
const handleCollectReturnPayment = async () => {
  if (!selectedBill) return;
  if (session?.role === "boss") { showToast("Boss chỉ được xem.", "error"); return; }
  if (!(await requireSysAdminUnlock())) return;
  const { data: liveBill, error: liveErr } = await supabase
    .from("bills")
    .select("id, shipping_fee, return_fee, actual_amount_paid, payment_status, branch_id, bill_code")
    .eq("id", selectedBill.id)
    .single();
  if (liveErr || !liveBill) { showToast("Không tải được đơn — thử lại!", "error"); return; }
  const owed = (Number(liveBill.shipping_fee) || 0) + (Number(liveBill.return_fee) || 0) - (Number(liveBill.actual_amount_paid) || 0);
  if (owed <= 0) { showToast("Đơn đã thu đủ cước!", "info"); return; }
  const ok = await askConfirm({
    title: "Thu tiền đơn hoàn?",
    message: `Thu ${owed.toLocaleString("vi-VN")} đ cước còn lại cho đơn ${liveBill.bill_code || ""}?`,
    confirmText: "Thu tiền",
  });
  if (!ok) return;
  try {
    const { error: payErr } = await supabase.from("bill_payment_details").insert({
      bill_id: liveBill.id,
      amount_paid: owed,
      branch_id: session?.branch_id || liveBill.branch_id,
      collected_by: session?.id || null,
      note: "Thu cước đi + hoàn hàng",
    });
    if (payErr) throw payErr;
    const { error: billErr } = await supabase.from("bills").update({ payment_status: "paid" }).eq("id", liveBill.id);
    if (billErr) throw billErr;
    await refreshBillActualPaid(liveBill.id);
    logAudit({
      entityType: "bill", entityId: liveBill.id, entityLabel: liveBill.bill_code,
      action: "bill_payment_received",
      changes: { payment_status: [liveBill.payment_status, "paid"], amount_paid: [null, owed] },
      note: "Thu cước đơn hoàn hàng",
    });
    showToast(`Đã thu ${owed.toLocaleString("vi-VN")} đ đơn hoàn!`, "success");
    await fetchData();
    const fresh = await fetchBillById(selectedBill.id);
    if (fresh) setSelectedBill(fresh);
    setBillHistoryRefreshKey(k => k + 1);
  } catch (err) {
    showToast("Lỗi thu tiền: " + err.message, "error");
  }
};

// 6. Thêm khoản chi phát sinh
// expand-revenue-reporting: helper khóa sổ tháng (D8/D9)
// period "YYYY-MM"; monthly_closes.period_month lưu DATE đầu tháng "YYYY-MM-01".
const getMonthCloseRecord = (branchCode, ym) => {
  const bId = branchIdByCode[branchCode];
  if (!bId || !ym) return null;
  const first = `${ym}-01`;
  return monthlyCloses.find(
    m => m.branch_id === bId && String(m.period_month).slice(0, 10) === first
  ) || null;
};

// admin/boss còn sửa được phiếu chi tháng không: chưa 'closed' VÀ còn trong hạn (tới mùng 3 tháng sau).
const isMonthEditableByAdmin = (branchCode, ym) => {
  const rec = getMonthCloseRecord(branchCode, ym);
  if (rec && rec.status === "closed") return false;
  const [y, m] = (ym || "").split("-").map(Number);
  if (!y || !m) return false;
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const deadline = `${nextY}-${String(nextM).padStart(2, "0")}-03`;
  return getVNTodayDate() <= deadline;
};

// Tháng đã khóa với admin/boss (hiển thị badge / disable nút).
const isMonthLocked = (branchCode, ym) => !isMonthEditableByAdmin(branchCode, ym);

// Boss khóa sổ 1 tháng cho 1 chi nhánh (hoặc qua prompt).
const handleCloseMonth = async (branchCode, ym) => {
  const bId = branchIdByCode[branchCode];
  if (!bId || !ym) return;
  if (session?.role !== "boss" && session?.role !== "sys_admin") {
    showToast("Chỉ boss mới được khóa sổ!", "error");
    return;
  }
  try {
    const first = `${ym}-01`;
    const { error } = await supabase
      .from("monthly_closes")
      .upsert(
        { branch_id: bId, period_month: first, status: "closed", closed_by: session.id, closed_at: new Date().toISOString() },
        { onConflict: "branch_id,period_month" }
      );
    if (error) throw error;
    showToast(`Đã khóa sổ tháng ${ym} — chi nhánh ${branchCode}.`, "success");
    logAudit({
      entityType: "expense",
      entityId: null,
      entityLabel: `Khóa sổ ${ym} - ${branchCode}`,
      action: "month_close",
      changes: { status: ["open", "closed"], period: [null, `${ym} / ${branchCode}`] },
    });
    setMonthClosePrompt(null);
    fetchData();
  } catch (err) {
    showToast("Lỗi khóa sổ: " + err.message, "error");
  }
};

// expand-revenue-reporting: nhắc boss khóa sổ tháng trước khi mở app (trong 3 ngày đầu tháng).
useEffect(() => {
  if (monthClosePrompt) return;
  if (userRole !== "boss") return;
  if (!branchIdByCode.SG && !branchIdByCode.GL) return;
  const today = getVNTodayDate();
  const [y, m] = today.split("-").map(Number);
  if (!y || !m) return;
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const prevYm = `${prevY}-${String(prevM).padStart(2, "0")}`;
  const deadline = `${y}-${String(m).padStart(2, "0")}-03`; // mùng 3 tháng hiện tại
  if (today > deadline) return; // quá hạn → đã auto-khóa, không hỏi
  const daysLeft = Math.max(
    0,
    Math.round((new Date(deadline + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000)
  );
  for (const code of ["SG", "GL"]) {
    if (!branchIdByCode[code]) continue;
    if (monthCloseDismissed.has(`${code}:${prevYm}`)) continue;
    const rec = getMonthCloseRecord(code, prevYm);
    if (!rec || rec.status !== "closed") {
      setMonthClosePrompt({ branchCode: code, periodMonth: prevYm, daysLeft });
      return;
    }
  }
}, [userRole, branchIdByCode, monthlyCloses, monthCloseDismissed, monthClosePrompt]);

// expand-revenue-reporting: loại kỳ phiếu chi bám theo sub-tab thời gian (Ngày → day, Tháng/Năm → month)
// để user khỏi chọn nhầm. Ở tab Tháng, mặc định tháng áp dụng = tháng đang xem.
useEffect(() => {
  if (revenueFilterType === "day") {
    setExpPeriodType("day");
  } else {
    setExpPeriodType("month");
    if (revenueFilterType === "month") setExpPeriodMonth(revenueMonth);
  }
}, [revenueFilterType, revenueMonth]);

const handleAddExpense = async (e) => {
  e.preventDefault();
  if (!expAmount || !expNote) return;
  if (!expCategoryId) { showToast("Vui lòng chọn danh mục chi phí!", "error"); return; }
  if (!(await requireSysAdminUnlock())) return;

  // Revamp §19.6: chỉ admin/sys_admin (và của đúng chi nhánh mình) được tạo chi phí.
  if (session?.role !== "admin" && session?.role !== "sys_admin") {
    showToast("Chỉ admin mới được ghi phiếu chi!", "error");
    return;
  }
  if (session.branch_code !== revenueTab) {
    showToast(`Bạn chỉ được ghi chi phí cho chi nhánh ${session.branch_code}!`, "error");
    return;
  }

  const isMonth = expPeriodType === "month";
  // expand-revenue-reporting: phiếu chi tháng tuân khóa sổ; sys_admin bypass.
  if (isMonth && session.role !== "sys_admin" && !isMonthEditableByAdmin(revenueTab, expPeriodMonth)) {
    showToast("Tháng này đã khóa sổ — chỉ sys_admin mới nhập được.", "error");
    return;
  }

  // expand-revenue-reporting: phiếu chi NGÀY lưu đúng ngày đang xem.
  //  - admin/boss: chỉ hôm nay. sys_admin: backdate được (set created_at = trưa VN của ngày đó).
  const todayISO = getVNTodayDate();
  const targetDay = (!isMonth && session.role === "sys_admin") ? revenueDate : todayISO;
  if (!isMonth && session.role !== "sys_admin" && revenueDate !== todayISO) {
    showToast("Chỉ thêm phiếu chi cho hôm nay. Ngày quá khứ cần sys_admin.", "error");
    return;
  }
  // created_at override chỉ khi phiếu chi ngày & ngày khác hôm nay (giữ timestamp thật cho hôm nay)
  const dayCreatedAt = (!isMonth && targetDay !== todayISO)
    ? new Date(`${targetDay}T12:00:00+07:00`).toISOString()
    : null;

  try {
    // Revamp §6.3: dùng session.branch_id trực tiếp (đã có sẵn từ login), không cần query branches
    const { data: newExp, error } = await supabase.from("expenses").insert({
      amount: Number(expAmount),
      note: expNote,
      branch_id: session.branch_id,
      created_by: session.id,
      category_id: expCategoryId,
      period_type: expPeriodType,
      period_month: isMonth ? `${expPeriodMonth}-01` : null,
      ...(dayCreatedAt ? { created_at: dayCreatedAt } : {}),
    }).select("id").single();

    if (error) throw error;

    showToast("Đã ghi nhận phiếu chi thành công!");
    const catName = expenseCategories.find(c => c.id === expCategoryId)?.name || "";
    // §4.5: log expense_create
    logAudit({
      entityType: "expense",
      entityId: newExp?.id || null,
      entityLabel: `${auditFormatVnd(expAmount)} - ${expNote}`,
      action: "expense_create",
      changes: {
        amount: [null, Number(expAmount)],
        note: [null, expNote],
        category: [null, catName],
        period: [null, isMonth ? `tháng ${expPeriodMonth}` : `ngày ${targetDay.split("-").reverse().join("-")}`],
      },
      note: (dayCreatedAt ? "Backdate ngày quá khứ" : undefined),
    });
    setExpAmount("");
    setExpNote("");
    setExpCategoryId("");
    setExpPeriodType("day");
    setExpenseHistoryRefreshKey(k => k + 1);
    fetchData();
  } catch (err) {
    showToast("Lỗi ghi nhận chi phí: " + err.message, "error");
  }
};

// Revamp §18.2: mở modal edit expense
const handleOpenEditExpense = (exp) => {
  const canEditExpense = (session?.role === "admin" || session?.role === "sys_admin")
    && session.branch_code === (exp.branch?.branch_code || "");
  if (!canEditExpense) {
    showToast("Bạn không có quyền sửa phiếu chi này!", "error");
    return;
  }
  setEditingExpense(exp);
  setExpEditAmount(String(exp.amount || ""));
  setExpEditNote(exp.note || "");
  setExpEditCategoryId(exp.category_id || "");
};

// Revamp §18.3: lưu update expense
const handleUpdateExpense = async (e) => {
  e.preventDefault();
  if (!editingExpense) return;
  if (!(await requireSysAdminUnlock())) return;
  const amt = Number(expEditAmount);
  const noteTrim = (expEditNote || "").trim();
  if (!amt || amt <= 0) { showToast("Số tiền phải > 0!", "error"); return; }
  if (!noteTrim) { showToast("Lý do không được rỗng!", "error"); return; }
  // Double-check quyền (defense in depth)
  const canEdit = (session?.role === "admin" || session?.role === "sys_admin")
    && session.branch_code === (editingExpense.branch?.branch_code || "");
  if (!canEdit) {
    showToast("Không có quyền!", "error"); return;
  }
  try {
    const { error } = await supabase
      .from("expenses")
      .update({
        amount: amt,
        note: noteTrim,
        category_id: expEditCategoryId || editingExpense.category_id,
        updated_at: new Date().toISOString(),
        updated_by: session.id,
      })
      .eq("id", editingExpense.id);
    if (error) throw error;
    showToast("Đã cập nhật phiếu chi!");
    // §4.5b / §18.4: log expense_update
    logAudit({
      entityType: "expense",
      entityId: editingExpense.id,
      entityLabel: `${auditFormatVnd(amt)} - ${noteTrim}`,
      action: "expense_update",
      changes: diffObjects(
        { amount: editingExpense.amount, note: editingExpense.note },
        { amount: amt, note: noteTrim },
        ["amount", "note"]
      ),
    });
    setEditingExpense(null);
    setExpEditAmount("");
    setExpEditNote("");
    setExpEditCategoryId("");
    setExpenseHistoryRefreshKey(k => k + 1);
    fetchData();
  } catch (err) {
    showToast("Lỗi cập nhật: " + err.message, "error");
  }
};

// Revamp §18.4: soft-delete expense
const handleDeleteExpense = async () => {
  if (!confirmDeleteExpense) return;
  if (!(await requireSysAdminUnlock())) return;
  const exp = confirmDeleteExpense;
  const canDelete = (session?.role === "admin" || session?.role === "sys_admin")
    && session.branch_code === (exp.branch?.branch_code || "");
  if (!canDelete) {
    showToast("Không có quyền!", "error"); return;
  }
  try {
    const { error } = await supabase
      .from("expenses")
      .update({
        is_delete: true,
        deleted_at: new Date().toISOString(),
        deleted_by: session.id,
      })
      .eq("id", exp.id);
    if (error) throw error;
    showToast(`Đã xóa phiếu chi ${formatVND(exp.amount)}!`);
    // §4.5c / §18.5: log expense_delete
    logAudit({
      entityType: "expense",
      entityId: exp.id,
      entityLabel: `${auditFormatVnd(exp.amount)} - ${exp.note || ""}`,
      action: "expense_delete",
      changes: { is_delete: [false, true] },
      note: `Xoá phiếu chi ${auditFormatVnd(exp.amount)}`,
    });
    setConfirmDeleteExpense(null);
    setExpenseHistoryRefreshKey(k => k + 1);
    fetchData();
  } catch (err) {
    showToast("Lỗi xóa: " + err.message, "error");
  }
};

// Tính toán doanh thu thực tế từ DB (lọc theo tab chi nhánh + ngày/tháng/năm)
const { totalRevenue, totalExpense, netRevenue, paidPaymentsInRange, paidBillsInRange, expensesInRange, categoryBreakdown } = useMemo(() => {
  const inRange = (dayStr) => {
    if (!dayStr) return false;
    if (revenueFilterType === "day") {
      return dayStr === revenueDate;
    } else if (revenueFilterType === "month") {
      return dayStr.slice(0, 7) === revenueMonth;
    } else if (revenueFilterType === "year") {
      return dayStr.slice(0, 4) === revenueYear;
    }
    return false;
  };
  // Revamp §5.2 + §15: doanh thu = SUM(bill_payment_details.amount_paid), group by branch + day
  // Filter: KHÔNG tính payment thuộc bill cancelled/deleted (§15.1-15.2)
  // Revamp §17.2: dùng toVNDate() để convert UTC created_at → VN calendar day trước khi so sánh.
  // expand-revenue-reporting: revenueTab "ALL" (boss) = gộp SG + GL.
  const matchBranch = (code) => revenueTab === "ALL" ? (code === "SG" || code === "GL") : code === revenueTab;
  const paidPayments = payments.filter(p => {
    if (!matchBranch(p.branch?.branch_code || "")) return false;
    if (p.bill?.is_delete === true) return false;
    if (p.bill?.delivery_status === "cancelled") return false;
    const d = toVNDate(p.created_at);
    return inRange(d);
  });
  // expand-revenue-reporting: lọc chi phí theo period_type
  //  - day: chỉ phiếu chi theo ngày, đúng ngày
  //  - month/year: phiếu chi ngày (theo created_at) + phiếu chi tháng (theo period_month)
  const exps = expenses.filter(e => {
    if (!matchBranch(e.branch?.branch_code || "")) return false;
    if (e.period_type === "month") {
      if (revenueFilterType === "day") return false; // phiếu chi tháng KHÔNG hiện ở màn Ngày
      const pm = String(e.period_month || "").slice(0, 10);
      if (!pm) return false;
      if (revenueFilterType === "month") return pm.slice(0, 7) === revenueMonth;
      if (revenueFilterType === "year") return pm.slice(0, 4) === revenueYear;
      return false;
    }
    const d = toVNDate(e.created_at);
    return inRange(d);
  });
  const rev = paidPayments.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  const exp = exps.reduce((s, e) => s + Number(e.amount || 0), 0);
  // expand-revenue-reporting: gom chi theo category (bảng tháng/năm)
  const catMap = new Map();
  for (const e of exps) {
    const name = expenseCategories.find(c => c.id === e.category_id)?.name || "Chưa phân loại";
    catMap.set(name, (catMap.get(name) || 0) + Number(e.amount || 0));
  }
  const categoryBreakdown = Array.from(catMap.entries())
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total);
  // Backward-compat alias: `paidBillsInRange` = danh sách UNIQUE bills từ paidPayments (giữ shape cũ cho UI hiện tại)
  const billsById = new Map();
  for (const p of paidPayments) {
    const bid = p.bill_id;
    if (!billsById.has(bid)) {
      // Tìm bill trong `bills` state để giữ tất cả cột (nếu không có, fallback minimal shape từ payment)
      const b = bills.find(x => x.id === bid) || {
        id: bid,
        bill_code: p.bill?.bill_code,
        sender_name_text: p.bill?.sender_name_text,
        receiver_name_text: p.bill?.receiver_name_text,
        goods_type: p.bill?.goods_type,
        shipping_fee: p.bill?.shipping_fee,
        payment_status: "paid",
        delivery_status: p.bill?.delivery_status,
      };
      billsById.set(bid, b);
    }
  }
  return {
    totalRevenue: rev,
    totalExpense: exp,
    netRevenue: rev - exp,
    paidPaymentsInRange: paidPayments,
    paidBillsInRange: Array.from(billsById.values()),
    expensesInRange: exps,
    categoryBreakdown,
  };
}, [bills, payments, expenses, expenseCategories, revenueTab, revenueFilterType, revenueDate, revenueMonth, revenueYear]);

// Tổng hợp theo người thu — hiện trong modal "Chi Tiết Doanh Thu" để biết mỗi NV thu bao nhiêu trong kỳ.
const collectorSummary = useMemo(() => {
  const map = new Map();
  for (const p of paidPaymentsInRange) {
    const key = p.collected_by || "__unknown";
    const name = p.collector?.full_name || p.collector?.username || "Không rõ";
    if (!map.has(key)) map.set(key, { name, count: 0, total: 0 });
    const entry = map.get(key);
    entry.count += 1;
    entry.total += Number(p.amount_paid || 0);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}, [paidPaymentsInRange]);

// Revamp §20.1: breakdown table + so sánh kỳ trước
// - filterType="month" → array 28-31 rows (mỗi ngày trong tháng)
// - filterType="year"  → array 12 rows (mỗi tháng trong năm)
// - filterType="day"   → mảng rỗng (đã có tổng ở trên, không cần breakdown)
// - prevPeriodRevenue: doanh thu cùng chi nhánh, kỳ trước liền kề (ngày trước / tháng trước / năm trước)
const { breakdownRows, prevPeriodRevenue, prevPeriodLabel } = useMemo(() => {
  const matchBranch = (code) => revenueTab === "ALL" ? (code === "SG" || code === "GL") : code === revenueTab;
  const branchPayments = payments.filter(p => {
    if (!matchBranch(p.branch?.branch_code || "")) return false;
    if (p.bill?.is_delete === true) return false;
    if (p.bill?.delivery_status === "cancelled") return false;
    return true;
  });
  const branchExpenses = expenses.filter(e => matchBranch(e.branch?.branch_code || ""));

  const sumByKey = (rows, keyFn, valueFn) => {
    const map = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!k) continue;
      map.set(k, (map.get(k) || 0) + Number(valueFn(r) || 0));
    }
    return map;
  };

  let rows = [];
  let prevRev = 0;
  let prevLabel = "";

  if (revenueFilterType === "day") {
    // Kỳ trước = ngày trước đó
    const d = new Date(revenueDate + "T00:00:00");
    if (!isNaN(d.getTime())) {
      d.setDate(d.getDate() - 1);
      const prevDay = getLocalDateString(d);
      prevRev = branchPayments
        .filter(p => toVNDate(p.created_at) === prevDay)
        .reduce((s, p) => s + Number(p.amount_paid || 0), 0);
      prevLabel = `ngày ${prevDay.slice(8, 10)}/${prevDay.slice(5, 7)}`;
    }
  } else if (revenueFilterType === "month") {
    // rows: các ngày trong tháng
    const [yyyy, mm] = revenueMonth.split("-").map(Number);
    if (yyyy && mm) {
      const daysInMonth = new Date(yyyy, mm, 0).getDate();
      const revMap = sumByKey(branchPayments, p => toVNDate(p.created_at), p => p.amount_paid);
      // Màn Tháng per-day: chỉ phiếu chi theo ngày (month-expenses không thuộc ngày nào).
      const expMap = sumByKey(branchExpenses.filter(e => e.period_type !== "month"), e => toVNDate(e.created_at), e => e.amount);
      for (let day = 1; day <= daysInMonth; day++) {
        const key = `${yyyy}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const r = revMap.get(key) || 0;
        const x = expMap.get(key) || 0;
        rows.push({ label: `${String(day).padStart(2, "0")}/${String(mm).padStart(2, "0")}`, key, revenue: r, expense: x, net: r - x });
      }
      // Kỳ trước = tháng trước
      const prevMonth = mm === 1 ? `${yyyy - 1}-12` : `${yyyy}-${String(mm - 1).padStart(2, "0")}`;
      prevRev = branchPayments
        .filter(p => toVNDate(p.created_at).slice(0, 7) === prevMonth)
        .reduce((s, p) => s + Number(p.amount_paid || 0), 0);
      prevLabel = `tháng ${prevMonth}`;
    }
  } else if (revenueFilterType === "year") {
    const yyyy = Number(revenueYear);
    if (yyyy) {
      const revMap = sumByKey(branchPayments, p => toVNDate(p.created_at).slice(0, 7), p => p.amount_paid);
      // Màn Năm per-month: phiếu chi ngày theo created_at, phiếu chi tháng theo period_month.
      const expKey = (e) => e.period_type === "month"
        ? String(e.period_month || "").slice(0, 7)
        : toVNDate(e.created_at).slice(0, 7);
      const expMap = sumByKey(branchExpenses, expKey, e => e.amount);
      for (let m = 1; m <= 12; m++) {
        const key = `${yyyy}-${String(m).padStart(2, "0")}`;
        const r = revMap.get(key) || 0;
        const x = expMap.get(key) || 0;
        rows.push({ label: `Tháng ${m}`, key, revenue: r, expense: x, net: r - x });
      }
      // Kỳ trước = năm trước
      const prevYear = yyyy - 1;
      prevRev = branchPayments
        .filter(p => toVNDate(p.created_at).slice(0, 4) === String(prevYear))
        .reduce((s, p) => s + Number(p.amount_paid || 0), 0);
      prevLabel = `năm ${prevYear}`;
    }
  }
  return { breakdownRows: rows, prevPeriodRevenue: prevRev, prevPeriodLabel: prevLabel };
}, [payments, expenses, revenueTab, revenueFilterType, revenueDate, revenueMonth, revenueYear]);

// §14.19 fix: lịch sử audit thêm/sửa/xoá phiếu chi theo KỲ đang xem (không theo từng phiếu,
// vì phiếu bị xoá mềm biến mất khỏi `expenses` local state → mất luôn lối vào xem lịch sử).
// Query trực tiếp audit_log + join ngược sang bảng expenses (RLS cho phép đọc cả row đã xoá mềm)
// để lấy branch_code — nhờ vậy vẫn xác định được chi nhánh của phiếu đã bị xoá.
useEffect(() => {
  if (currentTab !== "revenue" || userRole === "boss") return;
  if (revenueFilterType === "year") { setExpensePeriodAudit([]); return; } // tab Năm: không hiện audit
  let cancelled = false;
  (async () => {
    setExpensePeriodAuditLoading(true);
    setExpensePeriodAuditError(null);
    try {
      if (revenueFilterType === "month") {
        // Tab Tháng: chỉ audit của phiếu chi THÁNG có period_month = tháng đang xem.
        const first = `${revenueMonth}-01`;
        const { data: expRows, error: expErr } = await supabase
          .from("expenses")
          .select("id, branch:branches!branch_id(branch_code)")
          .eq("period_type", "month")
          .eq("period_month", first);
        if (expErr) throw expErr;
        const ids = (expRows || [])
          .filter(e => (e.branch?.branch_code || "") === revenueTab)
          .map(e => e.id);
        if (ids.length === 0) { if (!cancelled) setExpensePeriodAudit([]); return; }
        const { data: rows, error } = await supabase
          .from("audit_log")
          .select("*")
          .eq("entity_type", "expense")
          .in("entity_id", ids)
          .order("created_at", { ascending: false });
        if (error) throw error;
        if (!cancelled) setExpensePeriodAudit(rows || []);
        return;
      }

      // Tab Ngày: audit của phiếu chi NGÀY có created_at thuộc ngày đang xem (khớp bảng danh sách).
      const startUTC = new Date(`${revenueDate}T00:00:00+07:00`).toISOString();
      const endDate = new Date(`${revenueDate}T00:00:00+07:00`);
      endDate.setDate(endDate.getDate() + 1);
      const { data: expRows, error: expErr } = await supabase
        .from("expenses")
        .select("id, branch:branches!branch_id(branch_code)")
        .eq("period_type", "day")
        .gte("created_at", startUTC)
        .lt("created_at", endDate.toISOString());
      if (expErr) throw expErr;
      const ids = (expRows || [])
        .filter(e => (e.branch?.branch_code || "") === revenueTab)
        .map(e => e.id);
      if (ids.length === 0) { if (!cancelled) setExpensePeriodAudit([]); return; }
      const { data: rows, error } = await supabase
        .from("audit_log")
        .select("*")
        .eq("entity_type", "expense")
        .in("entity_id", ids)
        .order("created_at", { ascending: false });
      if (error) throw error;
      if (!cancelled) setExpensePeriodAudit(rows || []);
    } catch (err) {
      if (!cancelled) {
        setExpensePeriodAuditError(err.message || "Lỗi tải lịch sử");
        setExpensePeriodAudit([]);
      }
    } finally {
      if (!cancelled) setExpensePeriodAuditLoading(false);
    }
  })();
  return () => { cancelled = true; };
}, [currentTab, userRole, revenueTab, revenueFilterType, revenueDate, revenueMonth, revenueYear, expenseHistoryRefreshKey]);

// --- Danh Sách Bốc Xếp: đơn của chi nhánh + ngày đang chọn (không tính draft/cancelled) ---
// add-return-and-destroy-flow: dùng chi nhánh HIỆU LỰC = current_branch_id (chuyến về) nếu có, else branch gốc.
const warehouseFilteredBills = useMemo(() => {
  return bills.filter(b =>
    (b.current_branch?.branch_code || b.branch?.branch_code) === warehouseBranch &&
    b.delivery_status !== 'draft' &&
    b.delivery_status !== 'cancelled' &&
    b.delivery_status !== 'destroyed' &&
    b.business_date === warehouseDate
  // Sắp theo mã đơn tăng dần (seq ở 2 ký tự đầu → string sort đúng thứ tự).
  ).sort((a, b) => (a.bill_code || "zzzz").localeCompare(b.bill_code || "zzzz"));
}, [bills, warehouseBranch, warehouseDate]);

// Summary đầu trang: tổng số kiện / tổng kiện Trong / tổng kiện Ngoài của toàn bộ đơn (không chỉ trang hiện tại).
const warehouseSummary = useMemo(() => {
  return warehouseFilteredBills.reduce((acc, b) => {
    acc.totalPackages += Number(b.package_count || 0);
    acc.totalInside += Number(b.inside_count || 0);
    acc.totalOutside += Number(b.outside_count || 0);
    return acc;
  }, { totalPackages: 0, totalInside: 0, totalOutside: 0 });
}, [warehouseFilteredBills]);

// --- L\u1eccC \u0110\u01a0N H\u00c0NG cho m\u00e0n T\u1ed5ng H\u1ee3p ---
const filteredBills = useMemo(() => {
  const f = allBillsFilter;
  const codeQ = f.billCode.trim().toLowerCase();
  const phoneQ = f.phone.trim().replace(/\s+/g, "");
  const list = bills.filter((b) => {
    if ((b.branch?.branch_code || "") !== allBillsTab) return false;
    // Ẩn đơn hủy ở mọi filter, trừ khi user chọn rõ "delivery = cancelled"
    if (f.delivery !== "cancelled" && b.delivery_status === "cancelled") return false;
    // Toggle giao tận nhà: chỉ hiện đơn chưa giao (pending) và có is_home_delivery
    if (f.homeDeliveryOnly && !(b.is_home_delivery === true && b.delivery_status === "pending")) return false;
    if (codeQ && !(b.bill_code || "").toLowerCase().includes(codeQ)) return false;
    // tr\u1ea1ng th\u00e1i giao
    if (f.delivery === "delivered" && b.delivery_status !== "delivered") return false;
    if (f.delivery === "pending" && b.delivery_status !== "pending") return false;
    if (f.delivery === "draft" && b.delivery_status !== "draft") return false;
    if (f.delivery === "returned" && b.delivery_status !== "returned") return false;
    if (f.delivery === "destroyed" && b.delivery_status !== "destroyed") return false;
    if (f.delivery === "cancelled" && b.delivery_status !== "cancelled") return false;
    // tr\u1ea1ng th\u00e1i thanh to\u00e1n
    if (f.payment === "paid" && b.payment_status !== "paid") return false;
    if (f.payment === "unpaid" && b.payment_status !== "unpaid") return false;
    if (f.payment === "free" && b.payment_status !== "free") return false;
    // ng\u00e0y t\u1ea1o
    const businessDay = b.business_date || ""; // add-server-session §8: filter theo business_date (Ngày Gửi)
    if (f.businessFrom && businessDay < f.businessFrom) return false;
    if (f.businessTo && businessDay > f.businessTo) return false;
    // ng\u00e0y giao
    const deliveryDay = b.delivery_date ? toVNDate(b.delivery_date) : "";
    if (f.deliveryFrom && (!deliveryDay || deliveryDay < f.deliveryFrom)) return false;
    if (f.deliveryTo && (!deliveryDay || deliveryDay > f.deliveryTo)) return false;
    // s\u0111t kh\u00e1ch (g\u1eedi ho\u1eb7c nh\u1eadn)
    if (phoneQ) {
      const sp = (b.sender_phone_text || "").replace(/\s+/g, "");
      const rp = (b.receiver_phone_text || "").replace(/\s+/g, "");
      if (!sp.includes(phoneQ) && !rp.includes(phoneQ)) return false;
    }
    return true;
  });
  // add-server-session §10: Sort chính theo business_date desc, phụ theo created_at desc.
  list.sort((a, b) => {
    const bd = (b.business_date || "").localeCompare(a.business_date || "");
    if (bd !== 0) return bd;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });
  return list;
}, [bills, allBillsFilter, allBillsTab]);

const billsCountByBranch = useMemo(() => {
  const c = { SG: 0, GL: 0 };
  bills.forEach(b => {
    const code = b.branch?.branch_code;
    if (code === "SG" || code === "GL") c[code]++;
  });
  return c;
}, [bills]);

// --- CÔNG NỢ: group + sort + search ---
const debtGroups = useMemo(() => {
  const groups = groupBillsByCustomer(bills, debtIncludePending);
  const q = debtQuery.trim().toLowerCase();
  const searched = q
    ? groups.filter((g) => {
        const nm = (g.name || "").toLowerCase();
        const ph = g.phone || "";
        return nm.includes(q) || ph.startsWith(debtQuery.trim());
      })
    : groups;
  const sorted = [...searched].sort((a, b) =>
    debtSortMode === "debt_asc"
      ? a.totalDebt - b.totalDebt
      : b.totalDebt - a.totalDebt
  );
  return sorted;
}, [bills, debtIncludePending, debtQuery, debtSortMode]);

const debtTotals = useMemo(() => {
  const totalDebt = debtGroups.reduce((s, g) => s + g.totalDebt, 0);
  const totalBills = debtGroups.reduce((s, g) => s + g.billCount, 0);
  const totalQuoteLater = debtGroups.reduce((s, g) => s + g.quoteLaterCount, 0);
  return { totalDebt, totalBills, totalQuoteLater, customerCount: debtGroups.length };
}, [debtGroups]);

const toggleDebtExpanded = (key) => {
  setDebtExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
};

useEffect(() => { setAllBillsPage(1); }, [allBillsFilter, allBillsTab]);
useEffect(() => { setWarehousePage(1); }, [warehouseBranch, warehouseDate]);

// Guard: member vào screen 'debt' qua state cũ → redirect + toast
useEffect(() => {
  if (currentTab === "debt" && userRole === "member") {
    setCurrentScreenRaw("bills");
    showToast("Bạn không có quyền truy cập màn Công Nợ", "error");
  }
}, [currentTab, userRole]);

// Guard: non-sys_admin vào screen 'sys-admin' → redirect + toast
useEffect(() => {
  if (currentTab === "sys-admin" && userRole !== "sys_admin") {
    setCurrentScreenRaw("bills");
    showToast("Bạn không có quyền truy cập trang Quản Trị Hệ Thống", "error");
  }
}, [currentTab, userRole]);

// Guard: non-sys_admin vào screen 'my-account' → redirect (chỉ sys_admin dùng)
useEffect(() => {
  if (currentTab === "my-account" && userRole !== "sys_admin") {
    setCurrentScreenRaw("bills");
  }
}, [currentTab, userRole]);

// Guard: sys_admin không có nav vào các screen vận hành → về sys-admin.
// Ngoại lệ: cho phép "bills" khi đang xem chi tiết (selectedBill) hoặc đang sửa 1 bill/draft (editingBillId).
useEffect(() => {
  if (userRole !== "sys_admin") return;
  if (["clients", "warehouse", "debt"].includes(currentTab)) {
    setCurrentScreenRaw("sys-admin");
    return;
  }
  if (currentTab === "bills" && !selectedBill && !editingBillId && !editingDraftId) {
    setCurrentScreenRaw("sys-admin");
  }
}, [currentTab, userRole, selectedBill, editingBillId, editingDraftId]);

const totalBillsPages = Math.max(1, Math.ceil(filteredBills.length / BILLS_PER_PAGE));
const pagedBills = filteredBills.slice((allBillsPage - 1) * BILLS_PER_PAGE, allBillsPage * BILLS_PER_PAGE);

const resetAllBillsFilter = () => setAllBillsFilter({
  billCode: "", delivery: "all", payment: "all",
  businessFrom: "", businessTo: "", deliveryFrom: "", deliveryTo: "", phone: "",
  homeDeliveryOnly: false,
});

// --- GATE: nếu chưa login, hiển thị màn hình Login ---
if (authLoading) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500 animate-pulse">⏳ Đang kiểm tra phiên đăng nhập...</p>
    </div>
  );
}
if (recoveryMode) {
  return <ResetPasswordScreen onDone={() => { setRecoveryMode(false); setSession(null); }} />;
}
if (!session) {
  return <LoginScreen onLogin={handleLoginSuccess} />;
}

return (
  <SysAdminPinProvider session={session} showToast={showToast}>
  <SessionMonitor session={session} onForceLogout={handleForceLogout} />
  <MfaFlow session={session} onComplete={handleMfaComplete} showToast={showToast} />
  <div className="flex h-screen bg-gray-100 text-gray-800 font-sans overflow-hidden w-full relative">
    
    {/* --- CỤM TOAST THÔNG BÁO XỊN SÒ (THAY THẾ ALERT) --- */}
    {toastMessage && (
      <div className={`fixed top-5 right-5 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg border text-sm font-bold animate-bounce ${
        toastType === "success" ? "bg-green-100 border-green-200 text-green-800" : "bg-red-100 border-red-200 text-red-800"
      }`}>
        <span>{toastType === "success" ? "✅" : "❌"}</span>
        <span>{toastMessage}</span>
      </div>
    )}

    {/* --- NHẮC NHỞ HẰNG NGÀY (16:00 kiểm bốc xếp / 16:40 xuất bến) — mọi màn hình, trừ boss & sys_admin --- */}
    {dailyReminder && (
      <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center">
          <div className="text-5xl mb-3">{dailyReminder.icon}</div>
          <h3 className="text-lg font-extrabold text-gray-800 mb-2">{dailyReminder.title}</h3>
          <p className="text-sm text-gray-600 mb-5 leading-relaxed">{dailyReminder.message}</p>
          <button
            type="button"
            onClick={dismissDailyReminder}
            className="w-full px-4 py-2.5 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-lg transition"
          >
            OK
          </button>
        </div>
      </div>
    )}

    {/* --- CỤM REACT MODAL CONFIRM (ĐÃ BỬA: khách chưa có trong DB tự động được tạo) --- */}
    {confirmDialog && (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-[fadeIn_0.15s_ease-out]">
          <div className={`px-5 py-4 border-b ${confirmDialog.danger ? "bg-red-50" : "bg-orange-50"}`}>
            <h3 className={`font-bold text-sm ${confirmDialog.danger ? "text-red-800" : "text-orange-800"}`}>
              {confirmDialog.danger ? "⚠️ " : "❓ "}{confirmDialog.title}
            </h3>
          </div>
          {confirmDialog.message && (
            <div className="px-5 py-4 text-sm text-gray-700 whitespace-pre-line">
              {confirmDialog.message}
            </div>
          )}
          <div className="px-5 py-3 bg-gray-50 border-t flex justify-end gap-2">
            <button
              type="button"
              onClick={confirmDialog.onCancel}
              className="px-4 py-2 text-xs font-bold text-gray-600 bg-white border rounded-lg hover:bg-gray-100"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={confirmDialog.onConfirm}
              className={`px-4 py-2 text-xs font-bold text-white rounded-lg ${confirmDialog.danger ? "bg-red-600 hover:bg-red-700" : "bg-orange-600 hover:bg-orange-700"}`}
            >
              {confirmDialog.confirmText || "Xác nhận"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* --- MODAL HỦY ĐƠN (có input lý do) --- */}
    {cancelDialog && (() => {
      const isDraft = cancelDialog.bill?.delivery_status === "draft";
      return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-[fadeIn_0.15s_ease-out]">
          <div className="px-5 py-4 border-b bg-red-50">
            <h3 className="font-bold text-sm text-red-800">
              ⚠️ {isDraft ? "Xóa đơn nháp" : `Hủy đơn ${cancelDialog.bill?.bill_code || ""}`}
            </h3>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-sm text-gray-700">
              {isDraft
                ? "Đơn nháp sẽ bị xóa vĩnh viễn khỏi hệ thống."
                : "Đơn sẽ chuyển sang trạng thái Đã hủy. Mã đơn hàng vẫn được giữ lại để truy vết."}
            </p>
            <div>
              <label className="block text-xs font-bold text-gray-700 mb-1">
                Lý do hủy <span className="text-red-600">*</span>
              </label>
              <textarea
                value={cancelDialog.reason}
                onChange={(e) => setCancelDialog(d => ({ ...d, reason: e.target.value }))}
                placeholder="VD: Khách đổi ý không gửi, sai thông tin..."
                rows={3}
                autoFocus
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500"
              />
            </div>
          </div>
          <div className="px-5 py-3 bg-gray-50 border-t flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setCancelDialog(null)}
              className="px-4 py-2 text-xs font-bold text-gray-600 bg-white border rounded-lg hover:bg-gray-100"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={() => runExclusive(handleConfirmCancelBill)}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-bold text-white rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "⏳ Đang xử lý..." : (isDraft ? "Xóa nháp" : "Xác nhận hủy đơn")}
            </button>
          </div>
        </div>
      </div>
      );
    })()}

    {/* --- MODAL HOÀN HÀNG / TIÊU HỦY (add-return-and-destroy-flow) --- */}
    {returnDialog && (() => {
      const dlg = returnDialog;
      const bill = dlg.bill;
      const hasDebt = bill?.payment_status !== "paid" && bill?.payment_status !== "free";
      return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-[fadeIn_0.15s_ease-out]">
            <div className="px-5 py-4 border-b bg-red-50 flex items-center justify-between">
              <h3 className="font-bold text-sm text-red-800">
                ↩️ Hoàn hàng — Đơn {bill?.bill_code || ""}
              </h3>
              <button type="button" onClick={() => setReturnDialog(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>

            {dlg.step === "choose" && (
              <div className="p-5 space-y-3">
                <p className="text-sm text-gray-600">Khách nhận từ chối. Chọn xử lý cho đơn này:</p>
                <button
                  type="button"
                  onClick={() => setReturnDialog({ ...dlg, step: "return" })}
                  className="w-full text-left px-4 py-3 border rounded-lg hover:bg-orange-50 border-orange-200"
                >
                  <div className="font-bold text-orange-700">↩️ Hoàn hàng — trả về người gửi</div>
                  <div className="text-xs text-gray-500">Thu cước đi + cước hoàn (chiều về).</div>
                </button>
                <button
                  type="button"
                  disabled={hasDebt}
                  onClick={() => setReturnDialog({ ...dlg, step: "destroy" })}
                  className={`w-full text-left px-4 py-3 border rounded-lg ${hasDebt ? "opacity-50 cursor-not-allowed border-gray-200" : "hover:bg-red-50 border-red-200"}`}
                  title={hasDebt ? "Đơn còn nợ cước — phải Quay đầu để thu tiền" : ""}
                >
                  <div className="font-bold text-red-700">🗑️ Tiêu hủy</div>
                  <div className="text-xs text-gray-500">{hasDebt ? "Khách đã xác nhận ko nhận lại hàng": "Hàng sẽ bị tiêu hủy."}</div>
                </button>
              </div>
            )}

            {dlg.step === "return" && (
              <div className="p-5 space-y-3">
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Cước hoàn hàng — chiều về (VND)</label>
                  <MoneyInput
                    value={dlg.returnFee}
                    onChange={(v) => setReturnDialog(d => ({ ...d, returnFee: v }))}
                    placeholder="0 nếu miễn phí cước về..."
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Tổng cước đơn = cước đi ({formatVND(bill?.shipping_fee)}) + cước hoàn.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Lý do hoàn hàng *</label>
                  <textarea
                    value={dlg.reason}
                    onChange={(e) => setReturnDialog(d => ({ ...d, reason: e.target.value }))}
                    rows={2}
                    placeholder="VD: khách SG từ chối nhận, sai địa chỉ..."
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={() => setReturnDialog({ ...dlg, step: "choose" })} className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border rounded hover:bg-gray-50">← Quay lại</button>
                  <button type="button" onClick={() => runExclusive(handleReturnBill)} disabled={isSubmitting} className="px-4 py-2 text-sm font-semibold text-white bg-orange-600 hover:bg-orange-700 rounded disabled:opacity-60 disabled:cursor-not-allowed">{isSubmitting ? "⏳ Đang xử lý..." : "↩️ Xác nhận hoàn hàng"}</button>
                </div>
              </div>
            )}

            {dlg.step === "destroy" && (
              <div className="p-5 space-y-3">
                <div className="bg-red-50 border border-red-200 rounded p-2 text-[11px] text-red-800">
                  ⚠️ Tiêu hủy: hàng bị bỏ, không chở về. Đơn đã thanh toán nên không thu thêm.
                </div>
                <div>
                  <label className="block text-xs font-bold text-gray-600 mb-1">Lý do tiêu hủy *</label>
                  <textarea
                    value={dlg.reason}
                    onChange={(e) => setReturnDialog(d => ({ ...d, reason: e.target.value }))}
                    rows={2}
                    placeholder="VD: khách gửi không nhận lại, hàng hư hỏng..."
                    className="w-full border rounded px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2 border-t">
                  <button type="button" onClick={() => setReturnDialog({ ...dlg, step: "choose" })} className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border rounded hover:bg-gray-50">← Quay lại</button>
                  <button type="button" onClick={() => runExclusive(handleDestroyBill)} disabled={isSubmitting} className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-60 disabled:cursor-not-allowed">{isSubmitting ? "⏳ Đang xử lý..." : "🗑️ Xác nhận tiêu hủy"}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    })()}

    {/* --- MODAL XÁC NHẬN XUẤT BẾN (sau 16:30) --- */}
    {departureConfirmDialog && (() => {
      const dlg = departureConfirmDialog;
      const timeLabel = `${String(DEPARTURE_CUTOFF_HOUR).padStart(2, "0")}:${String(DEPARTURE_CUTOFF_MIN).padStart(2, "0")}`;
      return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden animate-[fadeIn_0.15s_ease-out]">
            {dlg.stage === "confirm" ? (
              <>
                <div className="px-5 py-4 border-b bg-amber-50">
                  <h3 className="font-bold text-sm text-amber-800">
                    🚛 Xe kho {dlg.branch} đã xuất bến chưa?
                  </h3>
                </div>
                <div className="px-5 py-3 text-sm text-gray-600">
                  Xác nhận xe đã <b>xuất bến</b> chưa?
                </div>
                <div className="px-5 py-3 bg-gray-50 border-t flex flex-col sm:flex-row justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setDepartureConfirmDialog({ ...dlg, stage: "choice" })}
                    className="px-4 py-2 text-xs font-bold text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg"
                  >
                    ← Chưa, quay lại
                  </button>
                  <button
                    type="button"
                    onClick={() => runExclusive(handleDepartureCreateTomorrow)}
                    disabled={isSubmitting}
                    className="px-4 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? "⏳ Đang xử lý..." : "✅ Rồi, tạo đơn ngày mai"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="px-5 py-4 border-b bg-amber-50">
                  <h3 className="font-bold text-sm text-amber-800">
                    🚛 Đã sau {timeLabel} — Xe xuất bến chưa?
                  </h3>
                </div>
                <div className="px-5 py-3 text-sm text-gray-600">
                  Chọn ngày tạo cho đơn này.
                </div>
                <div className="px-5 py-3 bg-gray-50 border-t flex flex-col sm:flex-row justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => runExclusive(handleDepartureConfirmProceed)}
                    disabled={isSubmitting}
                    className="px-4 py-2 text-xs font-bold text-gray-700 bg-white border border-gray-300 hover:bg-gray-100 rounded-lg disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {isSubmitting ? "⏳ Đang xử lý..." : "📦 Tạo đơn hôm nay"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDepartureConfirmDialog({ ...dlg, stage: "confirm" })}
                    className="px-4 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 rounded-lg"
                  >
                    📅 Tạo đơn ngày mai
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      );
    })()}

    {/* --- MODAL DIFF KHI ADMIN SỬA ĐƠN (N-4) --- */}
    {showEditDiffModal && (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-[fadeIn_0.15s_ease-out]">
          <div className="px-5 py-4 border-b bg-amber-50">
            <h3 className="font-bold text-sm text-amber-800">
              ✏️ Xác nhận cập nhật đơn {editingBillCode}
            </h3>
          </div>
          <div className="px-5 py-4 space-y-3 max-h-[60vh] overflow-y-auto">
            <p className="text-sm text-gray-700">Bạn vừa thay đổi các thông tin sau:</p>
            <ul className="space-y-2">
              {editDiffList.map((d) => (
                <li key={d.field} className="text-sm border-l-4 border-amber-400 pl-3 py-1 bg-amber-50/50 rounded">
                  <div className="font-semibold text-gray-800">{d.label}</div>
                  <div className="text-xs text-gray-600 mt-0.5">
                    <span className="line-through text-red-600">{d.oldFormatted}</span>
                    <span className="mx-2">→</span>
                    <span className="font-semibold text-green-700">{d.newFormatted}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="px-5 py-3 bg-gray-50 border-t flex justify-end gap-2">
            <button
              type="button"
              onClick={handleCancelEditBill}
              className="px-4 py-2 text-xs font-bold text-gray-600 bg-white border rounded-lg hover:bg-gray-100"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={() => runExclusive(handleConfirmEditBill)}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-bold text-white rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {isSubmitting ? "⏳ Đang lưu..." : "OK — Cập nhật"}
            </button>
          </div>
        </div>
      </div>
    )}

    {/* --- MODAL XEM BIÊN NHẬN IN CHO KHÁCH --- */}
    {showBillPreview && (() => {
      // Branch contact info hiển thị ở footer "Thông tin nhà xe".
      // Sending branch: dùng snapshot lúc tạo bill (bill cũ giữ nguyên info cũ).
      // Other branch: dùng current DB info (không snapshot được nếu bill của branch khác).
      const buildBranchContact = (code) => {
        const bId = branchIdByCode[code];
        const live = branchInfoById[bId] || {};
        // Nếu bill này thuộc code hiện tại → dùng snapshot cho own branch
        if (selectedBill && selectedBill.branch?.branch_code === code) {
          return {
            address: selectedBill.branch_address_snapshot || live.address || "",
            hotline: selectedBill.branch_hotline_snapshot || live.hotline || "",
            note: selectedBill.branch_address_note_snapshot || live.address_note || "",
          };
        }
        return {
          address: live.address || "",
          hotline: live.hotline || "",
          note: live.address_note || "",
        };
      };
      const sgContact = buildBranchContact("SG");
      const glContact = buildBranchContact("GL");
      // pd = preview data — đọc từ selectedBill nếu đang xem bill, ngược lại đọc từ form state
      const pd = selectedBill ? {
        billCode: selectedBill.bill_code || "...",
        senderName: selectedBill.sender_name_text || "",
        senderPhone: selectedBill.sender_phone_text || "",
        receiverName: selectedBill.receiver_name_text || "",
        receiverPhone: selectedBill.receiver_phone_text || "",
        goodsType: selectedBill.goods_type || "",
        noDeclaredValue: !!selectedBill.no_declared_value,
        goodsValue: selectedBill.goods_value || 0,
        packageCount: selectedBill.package_count || 0,
        shippingFee: selectedBill.shipping_fee || 0,
        isPaidImmediately: selectedBill.payment_status === "paid",
        isFreeShipping: selectedBill.payment_status === "free",
        feeQuoteLater: selectedBill.payment_status === "quote_later",
        sendDate: selectedBill.created_at ? toVNDate(selectedBill.created_at) : "",
        expectedDeliveryDate: selectedBill.expected_delivery_date || "",
        isHomeDelivery: !!selectedBill.is_home_delivery,
        deliveryAddress: selectedBill.delivery_address || "",
        selfPacked: !!selectedBill.self_packed,
        riskWarning: !!selectedBill.risk_warning,
        exportVat: !!selectedBill.export_vat,
        orderNote: selectedBill.order_note || "",
        requireIdCheck: !!selectedBill.require_id_check,
      } : {
        billCode: reservedBillCode || "...",
        senderName, senderPhone, receiverName, receiverPhone,
        goodsType, noDeclaredValue, goodsValue, packageCount,
        shippingFee, isPaidImmediately, isFreeShipping, feeQuoteLater, sendDate, expectedDeliveryDate,
        isHomeDelivery, deliveryAddress, selfPacked, riskWarning, exportVat,
        orderNote, requireIdCheck,
      };
      // Nội dung 1 bản bill — 2 bản (khách giữ + chành xe giữ) giống hệt nhau.
      const renderBillCopy = () => (
        <div className="bill-copy space-y-3">
          {/* Company Header — đứng ngoài watermark để làm mốc canh vị trí logo cố định, giống nhau ở cả 2 bản */}
          <div className="text-center border-b-2 border-gray-800 pb-4">
            <h1 className="text-lg font-extrabold text-gray-900 uppercase whitespace-nowrap">DNTN Vận Tải Và Thương Mại Hoàn Cầu</h1>
            <h2 className="text-sm font-bold text-gray-900 mt-2 uppercase">Biên Nhận Hàng Hóa</h2>
          </div>

          {/* Watermark logo chống làm giả — bắt đầu ngay dưới header, rộng chạm lề trái/phải, xám nhạt vì máy in không màu */}
          <div className="relative">
            <img
              src={logoHC}
              alt=""
              aria-hidden="true"
              className="watermark-logo absolute top-0 left-1/2 pointer-events-none select-none"
              style={{ width: '100%', transform: 'translateX(-50%)', opacity: 0.15, filter: 'grayscale(100%)', zIndex: 0 }}
            />
            <div className="relative space-y-3" style={{ zIndex: 1 }}>
          {/* Bill Code */}
          <div className="text-center">
            <p className="text-base"><span className="font-bold">Mã đơn hàng:</span> <span className="font-mono font-bold text-lg">{pd.billCode}</span></p>
          </div>

          {/* Main Info */}
          <div className="space-y-2 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <p><span className="font-bold">Người gửi:</span> {pd.senderName}</p>
              <p><span className="font-bold">SĐT:</span> {pd.senderPhone}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <p><span className="font-bold">Người nhận:</span> {pd.receiverName}</p>
              <p><span className="font-bold">SĐT:</span> {pd.receiverPhone}</p>
            </div>
            <p><span className="font-bold">Mặt hàng gửi:</span> {pd.goodsType}</p>
            <div className="grid grid-cols-2 gap-3">
              <p><span className="font-bold">Trị giá hàng:</span> {pd.noDeclaredValue ? "Không kê khai" : formatVND(pd.goodsValue)}</p>
            <p><span className="font-bold">Số kiện:</span> {pd.packageCount}</p>
            </div>   
            <div className="grid grid-cols-2 gap-3">
              <p><span className="font-bold">Giá cước:</span> <span className="font-bold">{pd.isFreeShipping ? "Miễn phí" : (pd.feeQuoteLater ? "Báo cước sau" : formatVND(pd.shippingFee))}</span></p>
              {pd.isPaidImmediately && <p><span className="font-bold">Đã thanh toán</span></p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <p><span className="font-bold">Ngày gửi:</span> {pd.sendDate}</p>
              <p><span className="font-bold">Ngày giao dự kiến:</span> {pd.expectedDeliveryDate}</p>
            </div>
          </div>

          {/* Optional Notes */}
          {(pd.isHomeDelivery || pd.noDeclaredValue || pd.selfPacked || pd.riskWarning || pd.exportVat || (pd.orderNote || "").trim() || pd.requireIdCheck) && (
            <div className="border-t border-gray-300 pt-3 mt-3">
              <p className="font-bold text-sm mb-2">Lưu ý:</p>
              <ul className="text-xs space-y-1 list-disc list-inside">
                {pd.isHomeDelivery && pd.deliveryAddress && (
                  <li><span className="font-semibold">Giao hàng tận nơi:</span> {pd.deliveryAddress}</li>
                )}
                {pd.noDeclaredValue && (
                  <li>Khách không kê khai giá trị hàng hóa</li>
                )}
                {pd.selfPacked && (
                  <li>Khách hàng tự đóng gói / niêm phong</li>
                )}
                {pd.riskWarning && (
                  <li>Hàng hóa bể / gãy / ướt - Nhà xe không giải quyết khiếu nại</li>
                )}
                {pd.exportVat && (
                  <li>Yêu cầu xuất hóa đơn VAT</li>
                )}
                {pd.requireIdCheck && (
                  <li>Yêu cầu cung cấp CCCD khi nhận hàng</li>
                )}
                {(pd.orderNote || "").trim() && !pd.requireIdCheck && (
                  <li><span className="font-semibold">Ghi chú:</span> {pd.orderNote}</li>
                )}
              </ul>
            </div>
          )}

          {/* Company Contact Info */}
          <div className="border-t border-gray-300 pt-3 mt-3 text-xs">
            <p className="font-bold mb-2">Thông tin nhà xe:</p>
            <p>
              <span className="font-semibold">Gia Lai:</span>{" "}
              {glContact.address || "—"}
              {glContact.hotline ? ` - ĐT: ${glContact.hotline}` : ""}
            </p>
            <p>
              <span className="font-semibold">TP. HCM:</span>{" "}
              {sgContact.address || "—"}
              {sgContact.hotline ? ` - ĐT: ${sgContact.hotline}` : ""}
            </p>
            {sgContact.note && <p>({sgContact.note})</p>}
            {glContact.note && <p>({glContact.note})</p>}
          </div>

          {/* Footer Notes */}
          <div className="border-t-2 border-gray-800 pt-3 mt-4 text-[11px] space-y-1 text-gray-700">
            <p className="font-bold">Ghi chú:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Biên nhận có giá trị 10 ngày. <span className="font-bold">Khách hàng chịu trách nhiệm pháp lý về hàng gửi.</span></li>
              <li>Khi nhận hàng đem theo giấy tờ tùy thân. DNTN VT & TM Hoàn Cầu không giải quyết khiếu nại khi không có biên nhận.</li>
              <li>Hàng hóa phải kê khai trị giá. Nếu khách hàng không kê khai, khi mất mát xảy ra Công ty chỉ bồi thường gấp 05 lần giá cước vận chuyển.</li>
            </ul>
          </div>

          {/* Ký giao / ký nhận — hiện ở cả 2 bản (khách giữ + chành xe giữ) */}
          <div className="border-t-2 border-gray-800 pt-3 mt-4 text-xs">
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="pb-14">
                <p className="font-bold">Ký giao</p>
                <p className="text-[11px] text-gray-600">(Ghi rõ họ tên)</p>
              </div>
              <div className="pb-14">
                <p className="font-bold">Ký nhận</p>
                <p className="text-[11px] text-gray-600">(Ghi rõ họ tên)</p>
              </div>
            </div>
          </div>
            </div>
          </div>
        </div>
      );

      return (
      <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl w-full max-w-md my-8 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="px-6 py-4 border-b flex items-center justify-between bg-gray-50">
            <h3 className="font-bold text-lg text-gray-800">{billPreviewSingle ? "📄 Bill Giao (1 bản cho khách)" : "📋 Biên Nhận In (2 bản: khách giữ + chành xe giữ)"}</h3>
            <button
              type="button"
              onClick={() => { setShowBillPreview(false); setBillPreviewSingle(false); }}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Printable Content */}
          <div id="bill-print-content" className="p-5">
            <style>{`
              @media print {
                @page {
                  size: 80mm auto;
                  margin: 5mm;
                }
                body {
                  width: 80mm;
                  margin: 0;
                  padding: 0;
                }
                #bill-print-content {
                  padding: 8px !important;
                }
                .bill-copy + .bill-copy {
                  page-break-before: always;
                }
                .watermark-logo {
                  -webkit-print-color-adjust: exact;
                  print-color-adjust: exact;
                }
              }
            `}</style>

            {renderBillCopy()}

            {!billPreviewSingle && (
              <>
                <div className="border-t-4 border-dashed border-gray-300 my-6" />
                {renderBillCopy()}
              </>
            )}
          </div>

          {/* Footer Buttons */}
          <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => { setShowBillPreview(false); setBillPreviewSingle(false); }}
              className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition"
            >
              Đóng
            </button>
            <button
              type="button"
              onClick={() => {
                const printContent = document.getElementById('bill-print-content');
                const originalContent = document.body.innerHTML;
                document.body.innerHTML = printContent.outerHTML;
                window.print();
                document.body.innerHTML = originalContent;
                window.location.reload();
              }}
              className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-md transition"
            >
              🖨️ In Bill
            </button>
          </div>
        </div>
      </div>
      );
    })()}

    {/* --- MODAL CHI TIẾT DOANH THU --- */}
    {showRevenueDetail && (
      <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl my-8 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="px-6 py-4 border-b flex items-center justify-between bg-green-50">
            <div>
              <h3 className="font-bold text-lg text-green-800">💵 Chi Tiết Doanh Thu</h3>
              <p className="text-xs text-green-600 mt-1">
                Chi nhánh: <span className="font-bold">{revenueTab === "SG" ? "Sài Gòn" : "Gia Lai"}</span> · 
                {revenueFilterType === "day" && <> Ngày <span className="font-bold">{revenueDate.split("-").reverse().join("/")}</span></>}
                {revenueFilterType === "month" && <> Tháng <span className="font-bold">{revenueMonth.split("-").reverse().join("/")}</span></>}
                {revenueFilterType === "year" && <> Năm <span className="font-bold">{revenueYear}</span></>}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowRevenueDetail(false)}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Content */}
          <div className="p-6">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm font-bold text-gray-700">
                Tổng cộng: <span className="text-green-600 text-lg">{paidPaymentsInRange.length} đơn thu</span> ·
                <span className="text-green-600 text-lg ml-2">{formatVND(totalRevenue)}</span>
              </p>
            </div>

            {collectorSummary.length > 0 && (
              <div className="mb-4 bg-gray-50 border rounded-lg p-3">
                <p className="text-xs font-bold text-gray-500 uppercase mb-2">👤 Tổng thu theo nhân viên</p>
                <div className="flex flex-wrap gap-2">
                  {collectorSummary.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 bg-white border rounded-lg px-3 py-1.5">
                      <span className="text-xs font-semibold text-gray-700">{c.name}</span>
                      <span className="text-[11px] text-gray-400">({c.count} đơn)</span>
                      <span className="text-xs font-bold text-green-600">{formatVND(c.total)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                    <th className="py-3 px-4">Mã Đơn Hàng</th>
                    <th className="py-3 px-4">Người gửi</th>
                    <th className="py-3 px-4">Người nhận</th>
                    <th className="py-3 px-4">Mặt hàng</th>
                    <th className="py-3 px-4">Số tiền thu</th>
                    <th className="py-3 px-4">Người thu</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-sm">
                  {paidPaymentsInRange.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-xs text-gray-400 italic">
                        Không có lượt thu tiền nào
                      </td>
                    </tr>
                  ) : (() => {
                    const totalPages = Math.max(1, Math.ceil(paidPaymentsInRange.length / REVENUE_BILLS_PER_PAGE));
                    const page = Math.min(revenueDetailPage, totalPages);
                    const start = (page - 1) * REVENUE_BILLS_PER_PAGE;
                    const pagedPayments = paidPaymentsInRange.slice(start, start + REVENUE_BILLS_PER_PAGE);
                    return pagedPayments.map((pay) => {
                      const fullBill = bills.find(b => b.id === pay.bill_id) || null;
                      return (
                        <tr key={pay.id} className="hover:bg-gray-50">
                          <td className="py-3 px-4">
                            {fullBill ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedBill(fullBill);
                                  setPreviousTab("revenue");
                                  setCurrentScreenRaw("bills");
                                  setShowRevenueDetail(false);
                                }}
                                className="font-mono font-bold text-orange-600 hover:text-orange-800 hover:underline"
                              >
                                {pay.bill?.bill_code || fullBill.bill_code}
                              </button>
                            ) : (
                              <span className="font-mono font-bold text-gray-500">{pay.bill?.bill_code || "—"}</span>
                            )}
                          </td>
                          <td className="py-3 px-4">{pay.bill?.sender_name_text || "—"}</td>
                          <td className="py-3 px-4">{pay.bill?.receiver_name_text || "—"}</td>
                          <td className="py-3 px-4 text-xs text-gray-600">{pay.bill?.goods_type || "—"}</td>
                          <td className="py-3 px-4 font-bold text-green-600">{formatVND(pay.amount_paid)}</td>
                          <td className="py-3 px-4 text-xs text-gray-600">{pay.collector?.full_name || pay.collector?.username || "—"}</td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>

            {paidPaymentsInRange.length > REVENUE_BILLS_PER_PAGE && (() => {
              const totalPages = Math.ceil(paidPaymentsInRange.length / REVENUE_BILLS_PER_PAGE);
              const page = Math.min(revenueDetailPage, totalPages);
              return (
                <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t">
                  <span className="text-xs text-gray-500">
                    Trang <b>{page}</b> / {totalPages} — hiển thị {Math.min(REVENUE_BILLS_PER_PAGE, paidPaymentsInRange.length - (page-1)*REVENUE_BILLS_PER_PAGE)} / {paidPaymentsInRange.length} lượt thu
                  </span>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setRevenueDetailPage(1)} disabled={page === 1} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">«</button>
                    <button type="button" onClick={() => setRevenueDetailPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">‹ Trước</button>
                    <span className="px-3 py-1 text-xs font-bold text-orange-600">{page}</span>
                    <button type="button" onClick={() => setRevenueDetailPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">Sau ›</button>
                    <button type="button" onClick={() => setRevenueDetailPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">»</button>
                  </div>
                </div>
              );
            })()}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t bg-gray-50 flex justify-end">
            <button
              type="button"
              onClick={() => setShowRevenueDetail(false)}
              className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition"
            >
              Đóng
            </button>
          </div>
        </div>
      </div>
    )}

    {/* --- MODAL SỬA PHIẾU CHI (§18.3) --- */}
    {editingExpense && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
          <div className="flex items-center justify-between px-5 py-3 border-b bg-blue-50">
            <h3 className="font-bold text-blue-800">✎ Sửa Phiếu Chi</h3>
            <button
              type="button"
              onClick={() => { setEditingExpense(null); setExpEditAmount(""); setExpEditNote(""); setExpEditCategoryId(""); }}
              className="text-gray-500 hover:text-gray-700 text-xl leading-none"
            >×</button>
          </div>
          <form onSubmit={(e) => { e.preventDefault(); runExclusive(() => handleUpdateExpense(e)); }} className="p-5 space-y-4">
            <div className="text-xs text-gray-500 bg-gray-50 p-2 rounded">
              Chi nhánh: <b>{editingExpense.branch?.branch_code || "—"}</b> · Tạo lúc: <b>{toVNDate(editingExpense.created_at) || "—"}</b>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-600 mb-1">Số tiền chi (VND) *</label>
              <MoneyInput
                value={expEditAmount}
                onChange={setExpEditAmount}
                className="w-full border rounded px-3 py-2 text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-600 mb-1">Danh mục *</label>
              <select
                value={expEditCategoryId}
                onChange={(e) => setExpEditCategoryId(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm bg-white"
                required
              >
                <option value="">— Chọn danh mục —</option>
                {expenseCategories.filter(c => c.is_active !== false || c.id === editingExpense.category_id).map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-600 mb-1">Lý do chi tiết *</label>
              <input
                type="text"
                value={expEditNote}
                onChange={(e) => setExpEditNote(e.target.value)}
                className="w-full border rounded px-3 py-2 text-sm"
                required
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => { setEditingExpense(null); setExpEditAmount(""); setExpEditNote(""); setExpEditCategoryId(""); }}
                className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded"
              >Hủy</button>
              <button
                type="submit"
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-60 disabled:cursor-not-allowed"
              >{isSubmitting ? "⏳ Đang lưu..." : "Lưu thay đổi"}</button>
            </div>
          </form>
        </div>
      </div>
    )}

    {/* expand-revenue-reporting: prompt nhắc boss khóa sổ tháng trước */}
    {monthClosePrompt && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
          <div className="px-5 py-3 border-b bg-orange-50">
            <h3 className="font-bold text-orange-800">🔒 Khóa sổ tháng</h3>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-700">
              Bạn đã hoàn tất doanh thu <b>tháng {monthClosePrompt.periodMonth}</b> cho chi nhánh{" "}
              <b>{monthClosePrompt.branchCode === "SG" ? "Sài Gòn" : "Gia Lai"}</b> chưa?
            </p>
            <p className="text-xs text-gray-500">
              Nếu chọn "Rồi", sổ tháng này sẽ bị khóa — chỉ sys_admin mới chỉnh sửa được.
              Nếu "Chưa", bạn còn <b>{monthClosePrompt.daysLeft} ngày</b> để cập nhật trước khi hệ thống tự khóa.
            </p>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  setMonthCloseDismissed(prev => new Set(prev).add(`${monthClosePrompt.branchCode}:${monthClosePrompt.periodMonth}`));
                  setMonthClosePrompt(null);
                }}
                className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded"
              >Chưa — để sau</button>
              <button
                type="button"
                onClick={() => runExclusive(() => handleCloseMonth(monthClosePrompt.branchCode, monthClosePrompt.periodMonth))}
                disabled={isSubmitting}
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-60 disabled:cursor-not-allowed"
              >Rồi — khóa sổ</button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* --- MODAL XÁC NHẬN XÓA PHIẾU CHI (§18.4) --- */}
    {confirmDeleteExpense && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
        <div className="bg-white rounded-xl shadow-2xl max-w-md w-full">
          <div className="px-5 py-3 border-b bg-red-50">
            <h3 className="font-bold text-red-800">🗑 Xác nhận xóa phiếu chi</h3>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-sm text-gray-700">Bạn có chắc muốn xóa phiếu chi sau?</p>
            <div className="bg-gray-50 rounded p-3 text-sm space-y-1">
              <div>Số tiền: <b className="text-red-600">{formatVND(confirmDeleteExpense.amount)}</b></div>
              <div>Lý do: <b>{confirmDeleteExpense.note}</b></div>
              <div>Chi nhánh: <b>{confirmDeleteExpense.branch?.branch_code || "—"}</b></div>
              <div>Ngày: <b>{toVNDate(confirmDeleteExpense.created_at) || "—"}</b></div>
            </div>
            <p className="text-xs text-amber-700 bg-amber-50 p-2 rounded">
              ⚠️ Xóa mềm — dữ liệu vẫn giữ trong DB để audit, nhưng sẽ không còn hiển thị ở doanh thu.
            </p>
          </div>
          <div className="px-5 py-3 border-t bg-gray-50 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirmDeleteExpense(null)}
              className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded"
            >Hủy</button>
            <button
              type="button"
              onClick={() => runExclusive(handleDeleteExpense)}
              disabled={isSubmitting}
              className="px-4 py-2 text-sm font-semibold text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-60 disabled:cursor-not-allowed"
            >{isSubmitting ? "⏳..." : "Xóa"}</button>
          </div>
        </div>
      </div>
    )}

    {/* MOBILE BACKDROP */}
    {sidebarOpen && (
      <div
        className="fixed inset-0 bg-black/40 z-30 md:hidden"
        onClick={() => setSidebarOpen(false)}
      />
    )}

    {/* 1. SIDEBAR NAV */}
    <aside className={`w-64 bg-orange-800 text-white flex flex-col shadow-xl fixed md:static inset-y-0 left-0 z-40 transform transition-transform duration-200 md:transform-none ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}`}>
      <div className="p-5 border-b border-orange-700 bg-orange-900">
        <h2 className="text-base font-bold tracking-wider">🚚 VẬN TẢI HOÀN CẦU</h2>
        <p className="text-xs text-orange-100 mt-1 font-semibold">Chi nhánh: {currentBranch === "SG" ? "Sài Gòn" : "Gia Lai"}</p>
      </div>
      
      <nav className="flex-1 p-4 space-y-1.5">
        {(userRole === "admin" || userRole === "boss") && (
          <button
            type="button"
            onClick={() => setCurrentScreen("clients")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "clients" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            👥 Quản Lý Khách Hàng
          </button>
        )}

        {userRole !== "sys_admin" && userRole !== "boss" && (
          <button
            type="button"
            onClick={() => setCurrentScreen("bills")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "bills" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            📦 Phiếu Gửi Hàng
          </button>
        )}

        {userRole !== "sys_admin" && (
          <button
            type="button"
            onClick={() => setCurrentScreen("warehouse")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "warehouse" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            📋 Danh Sách Bốc Xếp
          </button>
        )}

        <button
          type="button"
          onClick={() => { setAllBillsTab(loggedBranch); setCurrentScreen("all-bills"); }}
          className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "all-bills" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
        >
          📋 Tổng Hợp Đơn Hàng
        </button>

        {(userRole === "admin" || userRole === "boss" || userRole === "sys_admin") && (
          <button
            type="button"
            onClick={() => setCurrentScreen("revenue")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "revenue" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            💰 Quản Lý Doanh Thu
          </button>
        )}

        {(userRole === "admin" || userRole === "boss") && (
          <button
            type="button"
            onClick={() => setCurrentScreen("debt")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "debt" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            🧾 Công Nợ
          </button>
        )}

        {userRole === "sys_admin" && (
          <button
            type="button"
            onClick={() => setCurrentScreen("sys-admin")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "sys-admin" ? "bg-purple-700 shadow-md" : "hover:bg-purple-800/50"}`}
          >
            ⚙️ Quản Trị Hệ Thống
          </button>
        )}
      </nav>

      <div className="p-4 border-t border-orange-700 bg-orange-950 text-[10px] space-y-2">
        <div className="bg-orange-900/60 rounded-lg p-2.5 space-y-0.5">
          <p className="text-orange-300 font-semibold uppercase text-[9px]">👤 Đang đăng nhập:</p>
          <p className="text-white font-bold text-xs truncate" title={userFullname}>{userFullname}</p>
        </div>

        {userRole === "sys_admin" && (
          <button
            type="button"
            onClick={() => setCurrentScreen("my-account")}
            className={`w-full font-bold py-2 rounded-lg text-xs transition ${currentTab === "my-account" ? "bg-orange-500 text-white shadow-md" : "bg-white/10 hover:bg-white/20 text-orange-100"}`}
          >
            👤 Tài khoản của tôi
          </button>
        )}

        <button
          type="button"
          onClick={handleLogout}
          className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-2 rounded-lg text-xs transition"
        >
          🚪 Đăng Xuất
        </button>
      </div>
    </aside>

    {/* 2. KHU VỰC HIỂN THỊ CHÍNH */}
    <main className="flex-1 flex flex-col overflow-hidden">
      
      <header className="bg-white h-16 shadow-sm border-b px-4 md:px-8 flex justify-between items-center gap-3">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          className="md:hidden p-2 -ml-2 rounded hover:bg-gray-100 text-gray-600"
          aria-label="Mở menu"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-xs md:text-sm font-bold text-gray-800 uppercase truncate">
            {currentTab === "clients" && "👥 QUẢN LÝ KHÁCH HÀNG"}
            {currentTab === "bills" && "📦 LẬP & PHÁT HOÁ ĐƠN GỬI HÀNG"}
            {currentTab === "warehouse" && "🚚 DANH SÁCH BỐC DỠ HÀNG HOÁ THEO NGÀY"}
            {currentTab === "all-bills" && "📋 TỔNG HỢP HỆ THỐNG ĐƠN HÀNG"}
            {currentTab === "revenue" && "💰 BÁO CÁO DOANH THU & CHI TIÊU"}
            {currentTab === "debt" && "🧾 CÔNG NỢ THEO KHÁCH HÀNG"}
            {currentTab === "my-account" && "👤 TÀI KHOẢN CỦA TÔI"}
            {currentTab === "sys-admin" && "⚙️ QUẢN TRỊ HỆ THỐNG"}
          </h1>
          <p className="text-[11px] md:text-[12px] text-gray-400 truncate">Hệ thống quản lý đơn hàng Sài Gòn - Gia Lai</p>
        </div>

      </header>

      {/* 3. HIỂN THỊ SCREEN TƯƠNG ỨNG */}
      <section className="flex-1 p-4 md:p-8 overflow-y-auto">
        {loading && <p className="text-xs text-orange-600 animate-pulse mb-4">🔄 Đang đồng bộ dữ liệu thực tế...</p>}
        
        {/* MÀN HÌNH KHÁCH HÀNG */}
        {currentTab === "clients" && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {userRole === "boss" ? (
              <div className="lg:col-span-1 bg-white p-6 rounded-xl border shadow-sm h-fit">
                <h3 className="font-bold text-sm text-gray-700 border-l-4 border-orange-500 pl-2 mb-3">👁️ QUẢN LÝ KHÁCH HÀNG</h3>
              </div>
            ) : (
            <div className="lg:col-span-1 bg-white p-6 rounded-xl border shadow-sm h-fit space-y-4">
              <h3 className="font-bold text-sm text-gray-700 border-l-4 border-orange-500 pl-2">
                {editingClientId ? "✏️ Sửa Khách Hàng" : "Thêm Khách Hàng Mới"}
              </h3>
              <form onSubmit={(e) => { e.preventDefault(); runExclusive(() => handleAddClient(e)); }} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Họ tên *</label>
                  <input
                    type="text"
                    data-client-form-fullname
                    value={newClientName}
                    onChange={(e) => setNewClientName(e.target.value)}
                    disabled={userRole === "boss"}
                    placeholder="Nguyễn Văn A..."
                    className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Số điện thoại chính *</label>
                  <input
                    type="text"
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                    disabled={userRole === "boss"}
                    placeholder="090..."
                    className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
                    required
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Số điện thoại phụ</label>
                  <input
                    type="text"
                    value={newClientPhoneSec}
                    onChange={(e) => setNewClientPhoneSec(e.target.value)}
                    disabled={userRole === "boss"}
                    placeholder="098..."
                    className="w-full border rounded px-3 py-2 text-sm outline-none"
                  />
                </div>
                {/* add-client-phone-history §4.1: list "Số điện thoại cũ" read-only.
                    Chỉ render khi có ≥1 số cũ. UI hiển thị lịch sử để admin đối chiếu; KHÔNG sửa được. */}
                {newClientOldPhones.length > 0 && (
                  <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1.5">
                    <div className="text-xs font-bold text-gray-500 uppercase">📜 Số điện thoại cũ</div>
                    <ul className="space-y-1 text-sm text-gray-700">
                      {newClientOldPhones.map((num, idx) => (
                        <li key={`${num}-${idx}`} className="flex items-center gap-2">
                          <span className="text-gray-400">•</span>
                          <span className="font-mono">{num}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[10px] text-gray-400 italic pt-1 border-t border-gray-200">
                      Không sửa được — đây là lịch sử, được dùng để bảo toàn bill cũ.
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Địa chỉ giao hàng</label>
                  <textarea
                    value={newClientAddress}
                    onChange={(e) => setNewClientAddress(e.target.value)}
                    disabled={userRole === "boss"}
                    placeholder="Nhập địa chỉ..."
                    className="w-full border rounded px-3 py-2 text-sm h-16 outline-none"
                  />
                </div>
                
                <div className="bg-red-50 p-3 rounded-lg border border-red-100 space-y-3">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isBlacklist}
                      onChange={(e) => setIsBlacklist(e.target.checked)}
                      disabled={userRole === "boss"}
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    <span className="text-xs font-bold text-red-800">⚠️ Đưa vào Blacklist</span>
                  </label>

                  {isBlacklist && (
                    <textarea
                      value={blacklistReason}
                      onChange={(e) => setBlacklistReason(e.target.value)}
                      disabled={userRole === "boss"}
                      placeholder="Nhập lý do..."
                      className="w-full border border-red-200 bg-white rounded p-2 text-xs h-16 outline-none text-red-900"
                      required
                    />
                  )}
                </div>

                <button
                  type="submit"
                  disabled={userRole === "boss" || isSubmitting}
                  className="w-full bg-orange-600 text-white font-bold py-2 rounded-lg text-sm hover:bg-orange-700 transition disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? "⏳ Đang lưu..." : (editingClientId ? "💾 Cập Nhật Khách Hàng" : "💾 Lưu Khách Hàng")}
                </button>
                {editingClientId && (
                  <button
                    type="button"
                    onClick={resetClientForm}
                    className="w-full bg-gray-100 text-gray-600 font-bold py-2 rounded-lg text-sm hover:bg-gray-200 transition"
                  >
                    ❌ Hủy
                  </button>
                )}
              </form>
              {/* add-audit-log §5.3 + add-client-phone-history §6: Lịch sử thay đổi khách hàng */}
              {editingClientId && userRole !== "member" && (
                <ClientHistorySection
                  clientId={editingClientId}
                  refreshKey={clientHistoryRefreshKey}
                  userRole={userRole}
                />
              )}
            </div>
            )}

            <div className="lg:col-span-2 bg-white p-6 rounded-xl border shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
                <h3 className="font-bold text-sm text-gray-700 border-l-4 border-orange-500 pl-2">
                  Danh Sách Khách Hàng
                  <span className="ml-2 text-xs font-normal text-gray-400">({clients.length} khách)</span>
                </h3>
                <input
                  type="text"
                  value={clientSearch}
                  onChange={(e) => { setClientSearch(e.target.value); setClientPage(1); }}
                  placeholder="🔍 Tìm theo tên hoặc SDT..."
                  className="border rounded px-3 py-1.5 text-xs w-full sm:w-64 outline-none focus:border-orange-500"
                />
              </div>
              {(() => {
                const kw = clientSearch.trim().toLowerCase();
                const filtered = kw
                  ? clients.filter(c =>
                      (c.fullname || "").toLowerCase().includes(kw) ||
                      (c.client_phones || []).some(p => (p.phone_number || "").includes(kw))
                    )
                  : clients;
                const totalPages = Math.max(1, Math.ceil(filtered.length / CLIENTS_PER_PAGE));
                const page = Math.min(clientPage, totalPages);
                const start = (page - 1) * CLIENTS_PER_PAGE;
                const pageRows = filtered.slice(start, start + CLIENTS_PER_PAGE);
                return (
                  <>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                      <th className="py-3 px-4">Khách hàng</th>
                      <th className="py-3 px-4">Số Điện Thoại</th>
                      <th className="py-3 px-4">Địa chỉ mặc định</th>
                      <th className="py-3 px-4">Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y text-sm">
                    {pageRows.length === 0 && (
                      <tr><td colSpan={4} className="py-6 text-center text-xs text-gray-400 italic">Không có khách hàng nào phù hợp</td></tr>
                    )}
                    {pageRows.map((c) => (
                      <tr key={c.id} className={`hover:bg-gray-50/50 ${c.is_blacklist ? "bg-red-50/30" : ""} ${editingClientId === c.id ? "ring-2 ring-orange-400" : ""}`}>
                        <td className="py-3 px-4">
                          {userRole === "boss" ? (
                            <span className="font-semibold text-gray-800">{c.fullname}</span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleStartEditClient(c)}
                              className="font-semibold text-gray-800 hover:text-orange-600 hover:underline text-left"
                              title="Nhấn để chỉnh sửa"
                            >
                              {c.fullname}
                            </button>
                          )}
                        </td>
                        <td className="py-3 px-4 space-y-1">
                          {c.client_phones && [...c.client_phones]
                            .sort((a, b) => {
                              const order = { primary: 0, secondary: 1, old: 2 };
                              return (order[a.type] ?? 99) - (order[b.type] ?? 99);
                            })
                            .map(p => {
                              const label = p.type === 'primary' ? 'Chính' : p.type === 'old' ? 'Cũ' : 'Phụ';
                              const badgeClass = p.type === 'primary'
                                ? 'bg-orange-100 text-orange-700 border border-orange-200'
                                : p.type === 'old'
                                ? 'bg-white text-gray-400 border border-gray-200 italic'
                                : 'bg-gray-100 text-gray-700';
                              return (
                                <span key={p.id} className={`block font-mono font-bold text-xs px-2 py-0.5 rounded w-fit ${badgeClass}`}>
                                  {label}: {p.phone_number}
                                </span>
                              );
                            })}
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-500">{c.address || ""}</td>
                        <td className="py-3 px-4">
                          {c.is_blacklist ? (
                            <span className="bg-red-100 text-red-800 text-xs font-bold px-2 py-0.5 rounded" title={c.blacklist_reason || ""}>⚠️ BLACKLIST</span>
                          ) : (
                            <span className="bg-green-100 text-green-800 text-xs font-bold px-2 py-0.5 rounded">✅ Hoạt động</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t">
                  <span className="text-xs text-gray-500">
                    Trang <b>{page}</b> / {totalPages} — hiển thị {pageRows.length} / {filtered.length} khách
                  </span>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => setClientPage(1)} disabled={page === 1} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">«</button>
                    <button type="button" onClick={() => setClientPage(p => Math.max(1, p - 1))} disabled={page === 1} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">‹ Trước</button>
                    <span className="px-3 py-1 text-xs font-bold text-orange-600">{page}</span>
                    <button type="button" onClick={() => setClientPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">Sau ›</button>
                    <button type="button" onClick={() => setClientPage(totalPages)} disabled={page === totalPages} className="px-2 py-1 text-xs border rounded hover:bg-gray-50 disabled:opacity-40">»</button>
                  </div>
                </div>
              )}
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* SCREEN 7: PHIẾU GỬI HÀNG */}
        {currentTab === "bills" && (
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">

            {selectedBill ? (
                <div className="p-4 md:p-8 space-y-5">
                  {/* ===== HEADER ===== */}
                  <div className="space-y-4">
                    {/* Hàng 1: Title bên trái — Mã bill canh giữa (đã bỏ buttons ra dưới) */}
                    <div className="relative flex items-center justify-between gap-3">
                      <h3 className="text-xl font-extrabold text-orange-600 border-l-4 border-orange-500 pl-3 py-1 shrink-0">
                        Chi tiết đơn hàng
                      </h3>
                      <p className="text-3xl md:text-4xl font-extrabold text-orange-600 font-mono tracking-wider whitespace-nowrap">
                        {selectedBill.bill_code}
                      </p>
                      <div className="shrink-0" />
                    </div>

                    {/* Hàng 2: Thông tin NV tạo/giao — format giống Mặt hàng & cước phí */}
                    <div className={ui.card}>
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                          <p className={ui.label}>Nhân viên tạo đơn</p>
                          <p className={`${ui.value} mt-1`}>{selectedBill.creator_name_snapshot || selectedBill.creator?.full_name || selectedBill.creator?.username || "—"}</p>
                        </div>
                        <div>
                          <p className={ui.label}>Thời gian tạo</p>
                          <p className={`${ui.value} mt-1`}>{formatDateTime(selectedBill.created_at) || "—"}</p>
                          {/* add-server-session §9: hiển thị Ngày gửi (business_date) tách biệt với timestamp created_at */}
                          {selectedBill.business_date && (
                            <p className="text-xs text-gray-500 mt-1">
                              <span className="font-semibold">Ngày gửi:</span>{" "}
                              {selectedBill.business_date.slice(8,10)}/{selectedBill.business_date.slice(5,7)}/{selectedBill.business_date.slice(0,4)}
                            </p>
                          )}
                        </div>
                        <div>
                          <p className={ui.label}>Nhân viên giao đơn</p>
                          <p className={`${ui.value} mt-1`}>
                            {selectedBill.deliverer_name_snapshot
                              || selectedBill.deliverer?.full_name
                              || selectedBill.deliverer?.username
                              || <span className="italic text-gray-400 font-normal"></span>}
                          </p>
                        </div>
                        <div>
                          <p className={ui.label}>Thời gian giao</p>
                          <p className={`${ui.value} mt-1`}>{formatDateTime(selectedBill.delivery_date)}</p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* ===== NGƯỜI GỬI / NHẬN ===== */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className={ui.card}>
                      <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>Người gửi</h4>
                      <p className={ui.valueStrong}>{selectedBill.sender_name_text || "—"}</p>
                      <p className={`${ui.mono} text-gray-600 mt-1`}>{selectedBill.sender_phone_text || "—"}</p>
                    </div>
                    <div className={ui.card}>
                      <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>Người nhận</h4>
                      <p className={ui.valueStrong}>{selectedBill.receiver_name_text || "—"}</p>
                      <p className={`${ui.mono} text-gray-600 mt-1`}>{selectedBill.receiver_phone_text || "—"}</p>
                    </div>
                  </div>

                  {/* ===== HÀNG & CƯỚC ===== */}
                  <div className={ui.card}>
                    <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>Mặt hàng & cước phí</h4>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className={ui.label}>Mặt hàng</p>
                        <p className={`${ui.value} mt-1`}>{selectedBill.goods_type || "—"}</p>
                      </div>
                      <div>
                        <p className={ui.label}>Giá trị hàng</p>
                        <p className={`${ui.value} mt-1`}>{formatVND(selectedBill.goods_value)}</p>
                      </div>
                      <div>
                        <p className={ui.label}>Số kiện</p>
                        <p className={`${ui.value} mt-1`}>{selectedBill.package_count}</p>
                      </div>
                      <div>
                        <p className={ui.label}>Bảo quản</p>
                        <p className={`${ui.value} mt-1`}>
                          {selectedBill.special_stars === 2 ? "★★ Rất cao" : selectedBill.special_stars === 1 ? "★ Cao" : "Thường"}
                        </p>
                      </div>
                      <div>
                        <p className={ui.label}>Cước phí</p>
                        {selectedBill.payment_status === "free" ? (
                          <p className={`${ui.valueStrong} text-purple-700 mt-1`}>Miễn phí</p>
                        ) : selectedBill.payment_status === "quote_later" ? (
                          <p className={`${ui.valueStrong} text-amber-600 mt-1`}>Chưa có cước</p>
                        ) : (
                          <p className={`${ui.valueStrong} text-orange-600 mt-1`}>{formatVND(selectedBill.shipping_fee)}</p>
                        )}
                      </div>
                      {Number(selectedBill.return_fee) > 0 && (
                        <div>
                          <p className={ui.label}>Cước hoàn (về)</p>
                          <p className={`${ui.valueStrong} text-orange-600 mt-1`}>{formatVND(selectedBill.return_fee)}</p>
                        </div>
                      )}
                      <div>
                        <p className={ui.label}>Thanh toán</p>
                        {selectedBill.payment_status === "free" ? (
                          <p className={`mt-1 ${ui.statusFree}`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-500"></span>
                            Đơn miễn phí
                          </p>
                        ) : (
                          <p className={`mt-1 ${selectedBill.payment_status === "paid" ? ui.statusPaid : ui.statusUnpaid}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${selectedBill.payment_status === "paid" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                            {selectedBill.payment_status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}
                          </p>
                        )}
                      </div>
                      <div>
                        <p className={ui.label}>Giao hàng</p>
                        {(() => {
                          const ds = selectedBill.delivery_status;
                          const map = {
                            cancelled: ["Đã hủy", ui.statusCancelled, "bg-red-500"],
                            delivered: ["Đã giao", ui.statusDelivered, "bg-emerald-500"],
                            returned: ["Hoàn hàng", ui.statusUnpaid, "bg-orange-500"],
                            destroyed: ["Tiêu hủy", ui.statusCancelled, "bg-red-500"],
                          };
                          const [label, cls, dot] = map[ds] || ["Chờ giao", ui.statusPending, "bg-amber-500"];
                          return (
                            <p className={`mt-1 ${cls}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
                              {label}
                            </p>
                          );
                        })()}
                      </div>
                      <div>
                        <p className={ui.label}>Giao tận nơi</p>
                        <p className={`${ui.value} mt-1`}>{selectedBill.is_home_delivery ? "Có" : "Không"}</p>
                      </div>
                    </div>
                    {selectedBill.is_home_delivery && selectedBill.delivery_address && (
                      <div className={`${ui.alertInfo} mt-3`}>
                        <span className="font-semibold">Địa chỉ giao: </span>
                        <span>{selectedBill.delivery_address}</span>
                      </div>
                    )}
                  </div>

                  {/* ===== CỜ ĐẶC BIỆT & GHI CHÚ ===== */}
                  {(() => {
                    const flags = [
                      { on: selectedBill.no_declared_value, label: "Khách không kê khai giá trị hàng hóa" },
                      { on: selectedBill.risk_warning, label: "Hàng hóa bể / gãy / ướt - Nhà xe không giải quyết khiếu nại" },
                      { on: selectedBill.self_packed, label: "Khách hàng tự đóng gói / niêm phong" },
                      { on: selectedBill.export_vat, label: "Xuất hóa đơn VAT", bold: true },
                    ];
                    const activeFlags = flags.filter(f => f.on);
                    const hasNote = selectedBill.order_note && selectedBill.order_note.trim();
                    if (activeFlags.length === 0 && !hasNote) return null;
                    return (
                      <div className={ui.card}>
                        <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>LƯU Ý:</h4>
                        {activeFlags.length > 0 && (
                          <ul className="space-y-1.5 mb-3">
                            {activeFlags.map((f, i) => (
                              <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                                <span className="text-emerald-600 mt-0.5">✓</span>
                                <span className={f.bold ? "font-bold text-gray-900" : ""}>{f.label}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                        {hasNote && (
                          <div>
                            <p className={`${ui.label} mb-1`}>Ghi chú đơn hàng</p>
                            <pre className={`${ui.body} whitespace-pre-wrap font-sans bg-gray-50 border border-gray-200 rounded p-2`}>{selectedBill.order_note}</pre>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* ===== WARNING CCCD ===== */}
                  {selectedBill.require_id_check && (
                    <div className={`${ui.alertWarning} flex items-start gap-3`}>
                      <span className="text-lg leading-none mt-0.5">⚠️</span>
                      <div className="min-w-0 flex-1 space-y-1">
                        <h4 className="text-sm font-bold">Đơn hàng đặc biệt — Yêu cầu xuất trình CCCD</h4>
                      </div>
                    </div>
                  )}

                  {/* ====== SECTION: THANH TOÁN & GIAO NHẬN ====== */}
                  <div className={`${ui.divider} space-y-5`}>
                    <h3 className="text-xl font-extrabold text-orange-600 border-l-4 border-orange-500 pl-3 py-1">Thanh toán & Giao nhận</h3>

                    {(() => {
                      const isFullyDone = selectedBill.delivery_status === "delivered" && (selectedBill.payment_status === "paid" || selectedBill.payment_status === "free");
                      return isFullyDone ? (
                        <div className={`${ui.alertSuccess} flex items-center gap-3`}>
                          <span className="text-xl">✅</span>
                          <div>
                            <h4 className="text-sm font-bold">Đơn hàng đã hoàn tất</h4>
                            <p className="text-xs">{selectedBill.payment_status === "free" ? "Đơn miễn phí đã giao thành công." : "Đơn này đã giao và thanh toán đầy đủ."}</p>
                          </div>
                        </div>
                      ) : null;
                    })()}

                    {selectedBill.delivery_status === "destroyed" && (() => {
                      const code = selectedBill.current_branch?.branch_code || selectedBill.branch?.branch_code;
                      const label = code === "SG" ? "Sài Gòn" : code === "GL" ? "Gia Lai" : (code || "—");
                      return (
                      <div className={`${ui.alertWarning} flex items-center gap-3`}>
                        <span className="text-xl">🗑️</span>
                        <div>
                          <h4 className="text-sm font-bold">Đơn đã tiêu hủy</h4>
                          <p className="text-xs">Hàng đã tiêu hủy tại chi nhánh {label}.</p>
                        </div>
                      </div>
                      );
                    })()}

                    {/* Hoàn hàng: panel thu cước (đi + về), thay cho form giao nhận thường */}
                    {selectedBill.delivery_status === "returned" && (() => {
                      const shipFee = Number(selectedBill.shipping_fee) || 0;
                      const retFee = Number(selectedBill.return_fee) || 0;
                      const total = shipFee + retFee;
                      const paid = Number(selectedBill.actual_amount_paid) || 0;
                      const remain = Math.max(0, total - paid);
                      const confirmed = !!selectedBill.return_confirmed_at;
                      return (
                        <div className={ui.card}>
                          <div className={`${ui.alertWarning} flex items-center gap-3 mb-4`}>
                            <span className="text-xl">↩️</span>
                            <div>
                              <h4 className="text-sm font-bold">Đơn đang hoàn hàng</h4>
                              <p className="text-xs">{!confirmed ? "Chờ hàng về tới chi nhánh gốc." : remain > 0 ? "Hàng đã về — giao cho người gửi và thu cước." : "Đã hoàn tất."}</p>
                            </div>
                          </div>
                          <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>Thu cước hoàn hàng (đi + về)</h4>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between"><span className={ui.label}>Cước đi</span><span className={ui.value}>{formatVND(shipFee)}</span></div>
                            <div className="flex justify-between items-center">
                              <span className={ui.label}>Cước hoàn (về)</span>
                              {editReturnFee !== null ? (
                                <span className="flex items-center gap-1">
                                  <MoneyInput value={editReturnFee} onChange={setEditReturnFee} className="w-28 border rounded px-2 py-1 text-sm text-right" />
                                  <button type="button" onClick={() => runExclusive(handleSaveReturnFee)} disabled={isSubmitting} className="text-xs font-bold text-emerald-700 hover:underline px-1 disabled:opacity-50">{isSubmitting ? "..." : "Lưu"}</button>
                                  <button type="button" onClick={() => setEditReturnFee(null)} className="text-xs text-gray-500 hover:underline px-1">Hủy</button>
                                </span>
                              ) : (
                                <span className="flex items-center gap-2">
                                  <span className={ui.value}>{formatVND(retFee)}</span>
                                  {userRole === "sys_admin" && (
                                    <button type="button" onClick={() => setEditReturnFee("")} className="text-xs text-blue-600 hover:underline" title="sys_admin sửa cước hoàn">✏️ Sửa</button>
                                  )}
                                </span>
                              )}
                            </div>
                            <div className="flex justify-between border-t border-gray-200 pt-2"><span className="font-bold">Tổng cần thu</span><span className="font-bold text-orange-600">{formatVND(total)}</span></div>
                            <div className="flex justify-between"><span className={ui.label}>Đã thu</span><span className={ui.value}>{formatVND(paid)}</span></div>
                            <div className="flex justify-between"><span className="font-bold">Còn lại</span><span className={`font-bold ${remain > 0 ? "text-red-600" : "text-emerald-600"}`}>{formatVND(remain)}</span></div>
                          </div>
                          <p className="text-xs text-gray-500 mt-3">
                            {!confirmed
                              ? "Khi hàng về, bấm \"✅ Xác nhận đã hoàn hàng\" bên dưới."
                              : remain > 0
                                ? "Bấm \"💰 Thu tiền hoàn\" bên dưới để thu đủ cước còn lại."
                                : "Đã thu đủ cước — không cần thao tác thêm."}
                          </p>
                        </div>
                      );
                    })()}

                    {selectedBill.delivery_status !== "returned" && (
                    <fieldset disabled={(() => {
                      // Fully done → disable (existing behavior).
                      if (selectedBill.delivery_status === "delivered"
                          && (selectedBill.payment_status === "paid" || selectedBill.payment_status === "free")) {
                        return true;
                      }
                      // Tiêu hủy → kết thúc, disable mọi nơi.
                      if (selectedBill.delivery_status === "destroyed") return true;
                      // Boss = xem thôi, không thao tác thanh toán/giao nhận.
                      if (userRole === "boss") return true;
                      // Rule 3: chi nhánh GỬI (same branch với bill) không thao tác section này — chờ chi nhánh nhận. Sys_admin bypass.
                      const sameBranch = selectedBill.branch?.branch_code === session?.branch_code;
                      if (sameBranch && userRole !== "sys_admin") return true;
                      return false;
                    })()} className="space-y-5 disabled:opacity-70 disabled:pointer-events-none">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* === 1. Thanh toán === */}
                        <div className={ui.card}>
                          <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>1. Trạng thái thanh toán</h4>
                          <div className="space-y-3">
                            <div>
                              <label className={`${ui.label} block mb-1`}>Trạng thái thanh toán</label>
                              <div className="flex flex-col gap-2">
                                {selectedBill.payment_status === "free" ? (
                                  <label className="flex items-center gap-1.5 opacity-70 cursor-not-allowed">
                                    <input type="radio" name="payOption" checked disabled className="text-purple-600 focus:ring-purple-500" />
                                    <span className={`${ui.value} text-purple-700 font-semibold`}>Đơn miễn phí — không thu cước</span>
                                  </label>
                                ) : selectedBill.payment_status === "paid" ? (() => {
                                  const isFullPaid = Number(selectedBill.actual_amount_paid || 0) === Number(selectedBill.shipping_fee || 0);
                                  const lastPayment = payments.find(p => p.bill_id === selectedBill.id);
                                  return (
                                  <label className="flex items-center gap-1.5 opacity-60 cursor-not-allowed">
                                    <input type="radio" name="payOption" checked disabled className="text-orange-600 focus:ring-orange-500" />
                                    <span className={ui.value}>
                                      {isFullPaid
                                        ? `Đã thanh toán đủ (${formatVND(selectedBill.shipping_fee)})`
                                        : `Đã thu ${formatVND(selectedBill.actual_amount_paid)} / Cước ${formatVND(selectedBill.shipping_fee)}`}
                                    </span>
                                  </label>
                                  );
                                })() : selectedBill.delivery_status === "delivered" ? (
                                  // Revamp §3.3: delivered + unpaid/quote_later → CHỈ 2 lựa chọn full/actual (buộc chốt)
                                  <>
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="radio" name="payOption" checked={payOption === "full"} onChange={() => setPayOption("full")} className="text-orange-600 focus:ring-orange-500" />
                                      <span className={ui.value}>Thanh toán đủ cước ({formatVND(selectedBill.shipping_fee)})</span>
                                    </label>
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="radio" name="payOption" checked={payOption === "actual"} onChange={() => setPayOption("actual")} className="text-orange-600 focus:ring-orange-500" />
                                      <span className={ui.value}>Số tiền trả thực tế</span>
                                    </label>
                                  </>
                                ) : (
                                  // pending: 3 lựa chọn
                                  <>
                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="radio" name="payOption" checked={payOption === "full"} onChange={() => setPayOption("full")} className="text-orange-600 focus:ring-orange-500" />
                                      <span className={ui.value}>Thanh toán đủ cước ({formatVND(selectedBill.shipping_fee)})</span>
                                    </label>

                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="radio" name="payOption" checked={payOption === "unpaid"} onChange={() => setPayOption("unpaid")} className="text-orange-600 focus:ring-orange-500" />
                                      <span className={ui.value}>Chưa thanh toán</span>
                                    </label>

                                    <label className="flex items-center gap-1.5 cursor-pointer">
                                      <input type="radio" name="payOption" checked={payOption === "actual"} onChange={() => setPayOption("actual")} className="text-orange-600 focus:ring-orange-500" />
                                      <span className={ui.value}>Số tiền trả thực tế</span>
                                    </label>
                                  </>
                                )}
                              </div>
                            </div>

                            {payOption === "actual" && selectedBill.payment_status !== "paid" && (
                              <>
                                <div>
                                  <label className={`${ui.label} block mb-1`}>Số tiền thực thu *</label>
                                  <MoneyInput
                                    value={actualAmountPaid}
                                    onChange={setActualAmountPaid}
                                    placeholder="Số tiền thực thu..."
                                    className="w-full border rounded px-3 py-1.5 text-sm"
                                  />
                                </div>
                                <div>
                                  <label className={`${ui.label} block mb-1`}>Lý do thu thiếu / thu khác *</label>
                                  <input
                                    type="text"
                                    value={paymentNote}
                                    onChange={(e) => setPaymentNote(e.target.value)}
                                    placeholder="VD: khách khiếu nại đền bù thiếu, khách trả thêm phụ phí..."
                                    className="w-full border rounded px-3 py-1.5 text-sm"
                                  />
                                </div>
                              </>
                            )}

                            {/* Sau khi đã chốt (paid) + số tiền thực thu khác cước (thiếu hoặc thừa) — hiện lại lý do gốc dưới dạng field disabled, thay vì caption nhỏ. */}
                            {selectedBill.payment_status === "paid"
                              && Number(selectedBill.actual_amount_paid || 0) !== Number(selectedBill.shipping_fee || 0)
                              && (() => {
                                const lastPayment = payments.find(p => p.bill_id === selectedBill.id);
                                if (!lastPayment?.note) return null;
                                return (
                                  <div>
                                    <label className={`${ui.label} block mb-1`}>Lý do thu thiếu / thu khác</label>
                                    <input
                                      type="text"
                                      value={lastPayment.note}
                                      disabled
                                      readOnly
                                      className="w-full border rounded px-3 py-1.5 text-sm bg-gray-100 text-gray-500 cursor-not-allowed"
                                    />
                                  </div>
                                );
                              })()}

                            {/* Revamp §3.4: ghi chú thanh toán — chỉ hiện khi thu nợ (delivered + unpaid|quote_later), và KHÔNG hiện khi đã có field "Lý do thu thiếu" ở trên (payOption=actual) để tránh 2 field trùng nhau. */}
                            {selectedBill.delivery_status === "delivered"
                              && selectedBill.payment_status !== "paid"
                              && selectedBill.payment_status !== "free"
                              && payOption !== "actual" && (
                              <div>
                                <label className={`${ui.label} block mb-1`}>Ghi chú thanh toán (tuỳ chọn)</label>
                                <input
                                  type="text"
                                  value={paymentNote}
                                  onChange={(e) => setPaymentNote(e.target.value)}
                                  placeholder="VD: khách gom 3 đơn, chuyển khoản MB..."
                                  className="w-full border rounded px-3 py-1.5 text-sm"
                                />
                              </div>
                            )}
                          </div>
                        </div>

                        {/* === 2. Phát hàng === */}
                        <div className={ui.card}>
                          <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>2. Thông tin phát hàng</h4>
                          {selectedBill.delivery_status === "delivered" ? (
                            // Revamp §3.2 + §D6: đã giao → read-only display, KHÔNG cho chỉnh sửa
                            <div className="space-y-2 text-sm">
                              <div>
                                <span className="text-xs text-gray-500 block">Người ký nhận</span>
                                <span className="font-semibold text-gray-800">
                                  {selectedBill.recipient_type === "helper"
                                    ? (selectedBill.actual_recipient_name || "—")
                                    : selectedBill.recipient_type === "home"
                                      ? `Giao tận nhà${selectedBill.delivery_address ? ` — ${selectedBill.delivery_address}` : ""}`
                                      : `Chính chủ (${selectedBill.receiver_name_text || "—"})`}
                                </span>
                              </div>
                              <div>
                                <span className="text-xs text-gray-500 block">Ngày giao</span>
                                <span className="font-semibold text-gray-800">
                                  {selectedBill.delivery_date
                                    ? formatDateTime(selectedBill.delivery_date)
                                    : "—"}
                                </span>
                              </div>
                              <div>
                                <span className="text-xs text-gray-500 block">Nhân viên giao</span>
                                <span className="font-semibold text-gray-800">
                                  {selectedBill.deliverer_name_snapshot || selectedBill.deliverer?.full_name || selectedBill.deliverer?.username || "—"}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-3">
                              <div>
                                <label className={`${ui.label} block mb-1`}>Người nhận hàng trực tiếp</label>
                                <div className="flex flex-col gap-2">
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input type="radio" name="recipientType" checked={recipientType === "self"} onChange={() => { setRecipientType("self"); setRepRole(""); }} className="text-orange-600 focus:ring-orange-500" />
                                    <span className={ui.value}>Chính chủ ({selectedBill.receiver_name_text || "—"})</span>
                                  </label>
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input type="radio" name="recipientType" checked={recipientType === "helper"} onChange={() => setRecipientType("helper")} className="text-orange-600 focus:ring-orange-500" />
                                    <span className={ui.value}>Nhận giùm</span>
                                  </label>
                                  <label className="flex items-center gap-1.5 cursor-pointer">
                                    <input type="radio" name="recipientType" checked={recipientType === "home"} onChange={() => { setRecipientType("home"); setRepRole(""); }} className="text-orange-600 focus:ring-orange-500" />
                                    <span className={ui.value}>Giao tận nhà</span>
                                  </label>
                                </div>
                              </div>

                              {recipientType === "helper" && (
                                <div className={`${ui.cardMuted} space-y-2`}>
                                  <div>
                                    <label className={`${ui.label} block mb-1`}>Thông tin người nhận *</label>
                                    <input
                                      type="text"
                                      value={repName}
                                      onChange={(e) => setRepName(e.target.value)}
                                      placeholder="Người nhà, shipper..."
                                      className={ui.input}
                                      required
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </fieldset>
                    )}

                    {/* Action bar — tất cả buttons gộp xuống đây */}
                    <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 pt-4">
                      <button
                        type="button"
                        onClick={() => {
                          const back = previousTab || "all-bills";
                          setSelectedBill(null);
                          setPreviousTab(null);
                          setCurrentScreenRaw(back);
                        }}
                        className={ui.btnSecondary}
                      >
                        ← Quay lại
                      </button>
                      {(() => {
                        // Rule 1 + 4: ch\u1ec9 same-branch v\u00e0 trong ng\u00e0y m\u1edbi s\u1eeda/h\u1ee7y \u0111\u01a1n; sys_admin bypass.
                        const sameBranch = selectedBill.branch?.branch_code === session?.branch_code;
                        const sess = branchSessions[selectedBill.branch?.branch_code];
                        const tripDeparted = sess ? String(sess.business_date) > String(selectedBill.business_date) : false;
                        const canModify = userRole === "sys_admin" || (sameBranch && !tripDeparted);
                        return canModify;
                      })()
                        && (userRole === "admin" || userRole === "sys_admin")
                        && selectedBill.delivery_status === "pending"
                        && (selectedBill.payment_status === "unpaid" || selectedBill.payment_status === "free") && (
                        <>
                          <button
                            type="button"
                            onClick={() => {
                              const bill = selectedBill;
                              // Load toàn bộ dữ liệu bill vào form (giống draft load)
                              setPreviousTab(previousTab || "all-bills");
                              setEditingBillId(bill.id);
                              setEditingBillCode(bill.bill_code || "");
                              setEditingDraftId(null);
                              setFeeOnlyEditMode(false);
                              setCurrentBranch(bill.branch?.branch_code || currentBranch);
                              setSenderName(bill.sender_name_text || "");
                              setSenderPhone(bill.sender_phone_text || "");
                              setReceiverName(bill.receiver_name_text || "");
                              setReceiverPhone(bill.receiver_phone_text || "");
                              setGoodsType(bill.goods_type || "");
                              setGoodsValue(bill.goods_value?.toString() || "");
                              setPackageCount(bill.package_count || 1);
                              setShippingFee(
                                bill.payment_status === "free" || bill.payment_status === "quote_later"
                                  ? ""
                                  : (bill.shipping_fee && bill.shipping_fee > 0 ? bill.shipping_fee.toString() : "")
                              );
                              setIsFreeShipping(bill.payment_status === "free");
                              setFeeQuoteLater(bill.payment_status === "quote_later");
                              setSpecialStars(bill.special_stars || 0);
                              setStarsManual(false);
                              setNoDeclaredValue(!!bill.no_declared_value);
                              setIsHomeDelivery(bill.is_home_delivery || false);
                              setDeliveryAddress(bill.delivery_address || "");
                              setIsPaidImmediately(false);
                              setRequireIdCheck(bill.require_id_check || false);
                              setSelfPacked(bill.self_packed || false);
                              setRiskWarning(bill.risk_warning || false);
                              setExportVat(bill.export_vat || false);
                              setOrderNote(bill.order_note || "");
                              setSendDate(getTodayFormatted());
                              setExpectedDeliveryDate(bill.expected_delivery_date || getTomorrowFormatted());
                              // N-4: snapshot state gốc để tính diff khi submit
                              editBillSnapshotRef.current = buildEditSnapshot(bill);
                              setSelectedBill(null);
                              setCurrentScreen("bills");
                              setActiveSubTab("create");
                              if (bill.delivery_address) {
                                setTimeout(() => setDeliveryAddress(bill.delivery_address), 0);
                              }
                            }}
                            className="px-4 py-2 text-sm font-semibold text-amber-700 bg-white border border-amber-300 hover:bg-amber-50 rounded-md transition"
                          >
                            ✏️ Sửa Đơn
                          </button>
                          <button
                            type="button"
                            onClick={() => setCancelDialog({ bill: selectedBill, reason: "" })}
                            className="px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md transition"
                          >
                            🚫 Hủy Đơn
                          </button>
                        </>
                      )}
                      {/* §14.37: đơn "chưa có cước" (quote_later) — chỉ cho sửa ĐÚNG ô cước phí, theo rule ngày/chi nhánh riêng (không dùng canModify chung ở trên) */}
                      {(() => {
                        const todayVN = getVNTodayDate();
                        const isToday = selectedBill.business_date === todayVN;
                        const creatingBranch = selectedBill.branch?.branch_code;
                        const otherBranch = creatingBranch === "SG" ? "GL" : creatingBranch === "GL" ? "SG" : null;
                        const allowedFeeBranch = isToday ? creatingBranch : otherBranch;
                        const canEditQuoteLaterFee = userRole === "sys_admin"
                          || (userRole !== "boss" && !!allowedFeeBranch && session?.branch_code === allowedFeeBranch);
                        if (!canEditQuoteLaterFee || selectedBill.delivery_status !== "pending" || selectedBill.payment_status !== "quote_later") return null;
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              const bill = selectedBill;
                              setPreviousTab(previousTab || "all-bills");
                              setEditingBillId(bill.id);
                              setEditingBillCode(bill.bill_code || "");
                              setEditingDraftId(null);
                              setFeeOnlyEditMode(true);
                              setCurrentBranch(bill.branch?.branch_code || currentBranch);
                              setSenderName(bill.sender_name_text || "");
                              setSenderPhone(bill.sender_phone_text || "");
                              setReceiverName(bill.receiver_name_text || "");
                              setReceiverPhone(bill.receiver_phone_text || "");
                              setGoodsType(bill.goods_type || "");
                              setGoodsValue(bill.goods_value?.toString() || "");
                              setPackageCount(bill.package_count || 1);
                              setShippingFee("");
                              setIsFreeShipping(false);
                              setFeeQuoteLater(false); // điền cước xong → chốt thành unpaid, không giữ quote_later nữa
                              setSpecialStars(bill.special_stars || 0);
                              setStarsManual(false);
                              setNoDeclaredValue(!!bill.no_declared_value);
                              setIsHomeDelivery(bill.is_home_delivery || false);
                              setDeliveryAddress(bill.delivery_address || "");
                              setIsPaidImmediately(false);
                              setRequireIdCheck(bill.require_id_check || false);
                              setSelfPacked(bill.self_packed || false);
                              setRiskWarning(bill.risk_warning || false);
                              setExportVat(bill.export_vat || false);
                              setOrderNote(bill.order_note || "");
                              setSendDate(getTodayFormatted());
                              setExpectedDeliveryDate(bill.expected_delivery_date || getTomorrowFormatted());
                              editBillSnapshotRef.current = buildEditSnapshot(bill);
                              setSelectedBill(null);
                              setCurrentScreen("bills");
                              setActiveSubTab("create");
                              if (bill.delivery_address) {
                                setTimeout(() => setDeliveryAddress(bill.delivery_address), 0);
                              }
                            }}
                            className="px-4 py-2 text-sm font-semibold text-amber-700 bg-white border border-amber-300 hover:bg-amber-50 rounded-md transition"
                          >
                            ✏️ Cập Nhật Cước Phí
                          </button>
                        );
                      })()}
                      {/* Hủy Đơn cho đơn quote_later — giữ nguyên rule cũ (admin/sys_admin + canModify), tách riêng vì Sửa Đơn không còn áp dụng cho quote_later nữa */}
                      {(() => {
                        const sameBranch = selectedBill.branch?.branch_code === session?.branch_code;
                        const sess = branchSessions[selectedBill.branch?.branch_code];
                        const tripDeparted = sess ? String(sess.business_date) > String(selectedBill.business_date) : false;
                        const canModify = userRole === "sys_admin" || (sameBranch && !tripDeparted);
                        if (!canModify || !(userRole === "admin" || userRole === "sys_admin")) return null;
                        if (selectedBill.delivery_status !== "pending" || selectedBill.payment_status !== "quote_later") return null;
                        return (
                          <button
                            type="button"
                            onClick={() => setCancelDialog({ bill: selectedBill, reason: "" })}
                            className="px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md transition"
                          >
                            🚫 Hủy Đơn
                          </button>
                        );
                      })()}
                      {/* Revamp §3.1 + §11: state machine 2 nút — Hoàn tất giao / Xác nhận thanh toán / ẩn khi terminal */}
                      {/* Cross-branch delivery: chi nhánh gửi (branch tạo bill) KHÔNG được xác nhận giao — chờ chi nhánh nhận. Áp dụng cho mọi role. */}
                      {userRole === "boss" ? null : selectedBill.delivery_status === "pending"
                        && session?.branch_id !== selectedBill.branch_id ? (() => {
                        // Rule 5: cross-branch → chỉ enable khi bill.business_date < today (đơn xuất bến từ hôm trước → hàng đã tới).
                        const todayVN = getVNTodayDate();
                        const hasArrived = selectedBill.business_date && selectedBill.business_date < todayVN;
                        const bypass = userRole === "sys_admin";
                        // §14.37: đơn quote_later phải cập nhật cước trước khi cho hoàn tất giao hàng.
                        const feeMissing = selectedBill.payment_status === "quote_later";
                        const disabled = (!hasArrived || feeMissing) && !bypass;
                        const disabledTitle = feeMissing
                          ? "Đơn chưa có cước phí — vui lòng cập nhật cước trước khi xác nhận giao hàng"
                          : "Hàng chưa tới — chờ qua ngày mới xác nhận giao được";
                        return (
                          <button
                            type="button"
                            onClick={() => runExclusive(handleConfirmDelivery)}
                            disabled={disabled || isSubmitting}
                            title={disabled ? disabledTitle : ""}
                            className={(disabled || isSubmitting) ? `${ui.btnPrimary} opacity-50 cursor-not-allowed` : ui.btnPrimary}
                          >
                            {isSubmitting ? "⏳ Đang xử lý..." : "✅ Hoàn tất giao hàng"}
                          </button>
                        );
                      })() : (selectedBill.delivery_status === "delivered"
                            && selectedBill.payment_status !== "paid"
                            && selectedBill.payment_status !== "free") ? (
                        <button
                          type="button"
                          onClick={() => runExclusive(handleConfirmPayment)}
                          disabled={isSubmitting}
                          className={`${ui.btnPrimary} disabled:opacity-50 disabled:cursor-not-allowed`}
                        >
                          {isSubmitting ? "⏳ Đang xử lý..." : "💰 Xác nhận thanh toán"}
                        </button>
                      ) : null /* delivered + (paid|free) hoặc cancelled → ẩn nút */}
                      {/* add-return-and-destroy-flow: nút Hoàn hàng (đơn pending, chi nhánh nhận, hàng đã tới) */}
                      {userRole !== "boss" && selectedBill.delivery_status === "pending"
                        && (userRole === "sys_admin" || session?.branch_id !== selectedBill.branch_id) && (() => {
                        const todayVN = getVNTodayDate();
                        const hasArrived = selectedBill.business_date && selectedBill.business_date < todayVN;
                        const disabled = !hasArrived && userRole !== "sys_admin";
                        return (
                          <button
                            type="button"
                            onClick={() => setReturnDialog({ bill: selectedBill, step: "choose", returnFee: "", reason: "" })}
                            disabled={disabled}
                            title={disabled ? "Hàng chưa tới — chờ qua ngày mới xử lý hoàn hàng" : ""}
                            className={`px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-300 rounded-md transition ${disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-red-50"}`}
                          >
                            ↩️ Hoàn hàng
                          </button>
                        );
                      })()}
                      {/* add-return-and-destroy-flow: nút bước 2/3 của Quay đầu (chi nhánh gốc) */}
                      {userRole !== "boss" && selectedBill.delivery_status === "returned"
                        && (userRole === "sys_admin" || session?.branch_id === selectedBill.branch_id) && (
                        !selectedBill.return_confirmed_at ? (
                          <button type="button" onClick={() => runExclusive(handleConfirmReturnArrived)} disabled={isSubmitting} className={`${ui.btnPrimary} disabled:opacity-50 disabled:cursor-not-allowed`}>
                            {isSubmitting ? "⏳ Đang xử lý..." : "✅ Xác nhận đã hoàn hàng"}
                          </button>
                        ) : ((Number(selectedBill.shipping_fee) || 0) + (Number(selectedBill.return_fee) || 0) - (Number(selectedBill.actual_amount_paid) || 0) > 0) ? (
                          <button type="button" onClick={() => runExclusive(handleCollectReturnPayment)} disabled={isSubmitting} className={`${ui.btnPrimary} disabled:opacity-50 disabled:cursor-not-allowed`}>
                            {isSubmitting ? "⏳ Đang xử lý..." : "💰 Thu tiền hoàn"}
                          </button>
                        ) : null
                      )}
                      {userRole !== "sys_admin" && userRole !== "boss" && (
                        <button
                          type="button"
                          onClick={() => setSelectedBill(null)}
                          className={ui.btnPrimary}
                        >
                          + Tạo đơn mới
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => { setBillPreviewSingle(true); setShowBillPreview(true); }}
                        className="px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md transition"
                      >
                        🖨️ In bill giao
                      </button>
                    </div>
                  </div>
                  {/* add-audit-log §5.3: Lịch sử thay đổi bill (ẩn với member) */}
                  <BillHistorySection
                    billId={selectedBill.id}
                    refreshKey={billHistoryRefreshKey}
                    userRole={userRole}
                  />
                </div>
              ) : userRole === "boss" ? (
              <div className="p-8 text-center text-sm text-gray-500 italic">
                Boss không tạo đơn. Vui lòng xem chi tiết qua các tab khác.
              </div>
              ) : feeOnlyEditMode ? (
              // §14.37: đơn "chưa có cước" — chỉ cho sửa cước phí, tái dùng handleStartCreateBill có sẵn
              // (các field khác đã populate sẵn từ bill gốc, không hiển thị để user không đụng vào).
              <form onSubmit={(e) => { e.preventDefault(); runExclusive(() => handleStartCreateBill(e)); }} className="p-4 md:p-8 space-y-4">
                <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                  Đơn <b className="font-mono">{editingBillCode}</b> đang ở trạng thái "Chưa có cước" — chỉ cập nhật được cước phí, các thông tin khác giữ nguyên.
                </div>
                <div className={`${ui.card} grid grid-cols-2 gap-3 text-sm`}>
                  <div><span className="text-gray-500">Người gửi:</span> <span className="font-semibold">{senderName}</span></div>
                  <div><span className="text-gray-500">Người nhận:</span> <span className="font-semibold">{receiverName}</span></div>
                  <div className="col-span-2"><span className="text-gray-500">Mặt hàng:</span> <span className="font-semibold">{goodsType}</span></div>
                  <div><span className="text-gray-500">Số kiện:</span> <span className="font-semibold">{packageCount}</span></div>
                </div>
                <div>
                  <label className={`${ui.label} block mb-1`}>Cước phí vận chuyển (VND) *</label>
                  <MoneyInput
                    autoFocus
                    value={shippingFee}
                    onChange={setShippingFee}
                    placeholder="Nhập cước phí..."
                    className="w-full border rounded px-3 py-2 text-base"
                  />
                </div>
                <div className="flex justify-end gap-3 border-t pt-4">
                  <button
                    type="button"
                    onClick={() => {
                      resetCreateBillForm();
                      setCurrentScreen('all-bills');
                    }}
                    className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition"
                  >
                    ❌ Hủy
                  </button>
                  <button type="submit" disabled={isSubmitting} className={`${ui.btnPrimary} disabled:opacity-60 disabled:cursor-not-allowed`}>
                    {isSubmitting ? "⏳ Đang lưu..." : "💾 Lưu Cước Phí"}
                  </button>
                </div>
              </form>
              ) : (
              <form onSubmit={(e) => { e.preventDefault(); runExclusive(() => handleStartCreateBill(e)); }} className="p-4 md:p-8 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-orange-50/50 p-4 rounded-xl border border-orange-100">
                  <div>
                    <label className={`${ui.label} block mb-1`}>Chi Nhánh Gửi *</label>
                    <div className="w-full bg-gray-100 border rounded px-2 py-1.5 text-sm font-semibold text-gray-700 cursor-not-allowed select-none">
                      {currentBranch === "SG" ? "Sài Gòn (SG)" : "Gia Lai (GL)"}
                    </div>
                  </div>
                  <div>
                    <label className={`${ui.label} block mb-1`}>Ngày gửi</label>
                    <input
                      type="text"
                      value={sendDate}
                      onChange={(e) => setSendDate(e.target.value)}
                      placeholder="dd/mm/yyyy"
                      className="w-full bg-white border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className={`${ui.label} block mb-1`}>Ngày có hàng dự kiến</label>
                    <input
                      type="text"
                      value={expectedDeliveryDate}
                      onChange={(e) => setExpectedDeliveryDate(e.target.value)}
                      placeholder="dd/mm/yyyy"
                      className="w-full bg-white border rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div>
                    <label className={`${ui.label} block mb-1`}>Mã Đơn Hàng</label>
                    <span className={`${ui.brandValue} block ${editingBillId ? 'bg-amber-100 border-amber-300' : editingDraftId ? 'bg-blue-100 border-blue-300' : 'bg-orange-100 border-orange-200'} border px-2 py-1 rounded text-center font-mono font-bold`}>
                      {editingBillId ? editingBillCode : (reservedBillCode || "Đang tải...")}
                    </span>
                    {editingDraftId && !editingBillId && (
                      <span className="block text-[10px] text-blue-600 font-semibold text-center mt-1">
                        Mã khi hoàn tất nháp
                      </span>
                    )}
                    {editingBillId && (
                      <span className="block text-[10px] text-amber-700 font-semibold text-center mt-1">
                        Đang sửa đơn chính thức
                      </span>
                    )}
                  </div>
                </div>

                {/* === NGUOI XU LY DON (READ-ONLY) === */}
                <div className="-mt-2">
                  <div className={`${ui.cardMuted} flex items-center gap-2 w-full md:w-1/2`}>
                    <span className="text-base">�</span>
                    <div className="min-w-0">
                      <span className={`${ui.label} block`}>Nhân viên tạo đơn</span>
                      <span className={`${ui.valueStrong} block truncate`}>{userFullname}</span>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-3">
                    <h3 className={`${ui.sectionTitle} ${ui.cardHeader}`}>Thông Tin Người Gửi</h3>
                    <ClientAutocomplete
                      clients={clients}
                      nameValue={senderName}
                      onNameChange={setSenderName}
                      phoneValue={senderPhone}
                      onPhoneChange={setSenderPhone}
                      namePlaceholder="Tên người gửi..."
                    />
                  </div>

                  <div className="space-y-3">
                    <h3 className={`${ui.sectionTitle} ${ui.cardHeader}`}>Thông Tin Người Nhận</h3>
                    <ClientAutocomplete
                      clients={clients}
                      nameValue={receiverName}
                      onNameChange={setReceiverName}
                      phoneValue={receiverPhone}
                      onPhoneChange={setReceiverPhone}
                      namePlaceholder="Tên người nhận..."
                    />
                  </div>
                </div>

                <div className={`${ui.divider} space-y-4`}>
                  <h3 className={`${ui.sectionTitle} ${ui.cardHeader}`}>Mặt Hàng & Cước Phí</h3>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className={noDeclaredValue ? "md:col-span-3" : "md:col-span-2"}>
                      <label className={`${ui.label} block mb-1`}>Mặt hàng gửi *</label>
                      <textarea
                        value={goodsType}
                        onChange={(e) => setGoodsType(e.target.value)}
                        placeholder={"Mặt hàng..."}
                        rows={3}
                        className="w-full border rounded px-3 py-1.5 text-sm resize-y leading-relaxed whitespace-pre-wrap"
                      />
                    </div>
                    {!noDeclaredValue && (
                      <div>
                        <label className={`${ui.label} block mb-1`}>Giá trị hàng (VND) *</label>
                        <MoneyInput
                          value={goodsValue}
                          onChange={setGoodsValue}
                          placeholder="Giá trị..."
                          className="w-full border rounded px-3 py-1.5 text-sm"
                        />
                        <div className="flex items-center gap-2 mt-1.5">
                          <span className="text-[12px] text-gray-500 font-bold">Bảo quản:</span>
                          <div className="flex items-center gap-1">
                            {[1, 2].map((n) => {
                              const active = specialStars >= n;
                              return (
                                <button
                                  key={n}
                                  type="button"
                                  onClick={() => {
                                    setStarsManual(true);
                                    setSpecialStars(specialStars === n ? n - 1 : n);
                                  }}
                                  title={`Chọn ${n} sao`}
                                  className={`text-4xl leading-none transition-transform hover:scale-110 ${active ? "text-yellow-400 drop-shadow" : "text-gray-300 hover:text-yellow-400"}`}
                                >
                                  {active ? "★" : "☆"}
                                </button>
                              );
                            })}
                          </div>
                          <span className="text-[10px] text-orange-600 font-bold">
                            {specialStars === 2 ? "RẤT CAO" : specialStars === 1 ? "CAO" : "Thường"}
                          </span>
                        </div>
                      </div>
                    )}
                    <div>
                      <label className={`${ui.label} block mb-1`}>Số kiện hàng *</label>
                      <input
                        type="number"
                        min="1"
                        value={packageCount}
                        onChange={(e) => setPackageCount(e.target.value)}
                        placeholder="Số kiện..."
                        className="w-full border rounded px-3 py-1.5 text-sm"
                      />
                    </div>
                  </div>

                  {/* ===== CÁC CỜ CHỌN ĐẶC BIỆT ===== */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                    <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-amber-50/50 hover:bg-amber-50 border-amber-200">
                      <input
                        type="checkbox"
                        checked={noDeclaredValue}
                        onChange={(e) => setNoDeclaredValue(e.target.checked)}
                        className="mt-0.5 rounded text-amber-600 focus:ring-amber-500"
                      />
                      <span className="font-bold text-amber-800">Khách không kê khai giá trị hàng hóa</span>
                    </label>

                    <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-rose-50/50 hover:bg-rose-50 border-rose-200">
                      <input
                        type="checkbox"
                        checked={riskWarning}
                        onChange={(e) => setRiskWarning(e.target.checked)}
                        className="mt-0.5 rounded text-rose-600 focus:ring-rose-500"
                      />
                      <span className="font-bold text-rose-800">Hàng hóa bể / gãy / ướt - Nhà xe không giải quyết khiếu nại</span>
                    </label>

                    <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-indigo-50/50 hover:bg-indigo-50 border-indigo-200">
                      <input
                        type="checkbox"
                        checked={selfPacked}
                        onChange={(e) => setSelfPacked(e.target.checked)}
                        className="mt-0.5 rounded text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="font-bold text-indigo-800">Khách hàng tự đóng gói / niêm phong</span>
                    </label>

                    <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-emerald-50/50 hover:bg-emerald-50 border-emerald-200">
                      <input
                        type="checkbox"
                        checked={exportVat}
                        onChange={(e) => setExportVat(e.target.checked)}
                        className="mt-0.5 rounded text-emerald-600 focus:ring-emerald-500"
                      />
                      <span className="font-bold text-emerald-800">Xuất hóa đơn VAT</span>
                    </label>
                                        <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-purple-50/50 hover:bg-purple-50 border-purple-200">
                      <input
                        type="checkbox"
                        checked={isFreeShipping}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setIsFreeShipping(checked);
                          if (checked) {
                            setFeeQuoteLater(false);
                            setIsPaidImmediately(false);
                            setShippingFee("");
                          }
                        }}
                        className="mt-0.5 rounded text-purple-600 focus:ring-purple-500"
                      />
                      <span className="font-bold text-purple-800">Đơn miễn phí (không thu cước)</span>
                    </label>

                    <label className="flex items-start gap-2 cursor-pointer text-xs p-2.5 border rounded-lg bg-amber-50/50 hover:bg-amber-50 border-amber-200">
                      <input
                        type="checkbox"
                        checked={feeQuoteLater}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setFeeQuoteLater(checked);
                          if (checked) {
                            setIsFreeShipping(false);
                            setIsPaidImmediately(false);
                            setShippingFee("");
                          }
                        }}
                        className="mt-0.5 rounded text-amber-600 focus:ring-amber-500"
                      />
                      <span className="font-bold text-amber-800">Báo giá cước sau</span>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start pt-2">
                    <div>
                      <label className={`${ui.label} block mb-1`}>
                        Cước phí vận chuyển (VND) {!isFreeShipping && !feeQuoteLater && "*"}
                      </label>
                      {isFreeShipping ? (
                        <div className="w-full border rounded px-3 py-1.5 text-sm bg-purple-100 text-purple-800 font-bold h-[34px] flex items-center">
                          MIỄN PHÍ
                        </div>
                      ) : (
                        <MoneyInput
                          value={shippingFee}
                          onChange={setShippingFee}
                          placeholder={feeQuoteLater ? "Báo giá sau" : "Tiền cước..."}
                          className={`w-full border rounded px-3 py-1.5 text-sm ${feeQuoteLater ? "bg-amber-50 border-amber-300" : ""}`}
                        />
                      )}
                    </div>

                    <div>
                      <label className="block text-xs mb-1 invisible select-none">.</label>
                      <div className={`${ui.cardMuted} flex items-center h-[38px]`}>
                      <label className={`flex items-center gap-2 cursor-pointer ${ui.value}`}>
                        <input
                          type="checkbox"
                          checked={isHomeDelivery}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setIsHomeDelivery(checked);
                            // Auto-populate địa chỉ giao hàng từ DB — CHỈ xét theo người nhận
                            if (checked && receiverName.trim()) {
                              const nameLower = receiverName.trim().toLowerCase();
                              const phoneTrim = receiverPhone.trim();
                              const match = clients.find((c) => {
                                if (c.fullname?.toLowerCase() !== nameLower) return false;
                                if (phoneTrim) {
                                  return c.client_phones?.some((p) => p.phone_number === phoneTrim);
                                }
                                return true;
                              });
                              if (match?.address && !deliveryAddress.trim()) {
                                setDeliveryAddress(match.address);
                              }
                            }
                          }}
                          className="rounded text-orange-600 focus:ring-orange-500"
                        />
                        <span>Có giao tận nơi</span>
                      </label>
                      </div>
                    </div>

                    <div>
                      <label className="block text-xs mb-1 invisible select-none">.</label>
                      <div className={`${ui.cardMuted} flex items-center h-[38px]`}>
                      <label className={`flex items-center gap-2 text-sm font-bold ${(isFreeShipping || feeQuoteLater) ? "text-gray-400 cursor-not-allowed" : "text-emerald-700 cursor-pointer"}`}>
                        <input
                          type="checkbox"
                          checked={isPaidImmediately}
                          disabled={isFreeShipping || feeQuoteLater}
                          onChange={(e) => setIsPaidImmediately(e.target.checked)}
                          className="rounded text-green-600 focus:ring-green-500"
                        />
                        <span>Đã thanh toán{isHomeDelivery && !isFreeShipping && !feeQuoteLater ? " *" : ""}</span>
                      </label>
                      </div>
                    </div>
                  </div>
                </div>

                {isHomeDelivery && (
                  <div className={`${ui.cardMuted} space-y-2`}>
                    <label className={`${ui.label} block`}>Địa Chỉ Giao Tận Nơi *</label>
                    <input
                      type="text"
                      value={deliveryAddress}
                      onChange={(e) => setDeliveryAddress(e.target.value)}
                      placeholder="Nhập địa chỉ nhà..."
                      className={ui.input}
                    />
                  </div>
                )}

                <div className={ui.alertDanger}>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={requireIdCheck}
                      onChange={(e) => setRequireIdCheck(e.target.checked)}
                      className="rounded text-red-600 focus:ring-red-500"
                    />
                    <span className="text-xs font-bold">⚠️ YÊU CẦU ĐỐI CHIẾU CCCD KHI NHẬN HÀNG</span>
                  </label>
                </div>

                {/* GHI CHÚ ĐƠN HÀNG — required nếu CCCD (VAT thông tin qua Zalo, không bắt nhập) */}
                {(() => {
                  const noteRequired = requireIdCheck;
                  const notePlaceholder = requireIdCheck
                    ? "Nhập số CCCD và Họ tên người đối chiếu."
                    : "Nhập ghi chú tuỳ ý cho đơn hàng...";
                  return (
                    <div className={`${ui.cardMuted} space-y-2`}>
                      <label className={`${ui.label} block`}>
                        📝 Ghi chú cho đơn hàng {noteRequired && <span className="text-red-600">*</span>}
                      </label>
                      <textarea
                        value={orderNote}
                        onChange={(e) => setOrderNote(e.target.value)}
                        placeholder={notePlaceholder}
                        rows={3}
                        className={ui.input}
                        required={noteRequired}
                      />
                    </div>
                  );
                })()}

                <div className="flex flex-wrap justify-end gap-3 border-t pt-5">
                  {editingDraftId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const bill = bills.find(b => b.id === editingDraftId);
                          if (!bill) {
                            showToast("Không tìm thấy đơn để hủy!", "error");
                            return;
                          }
                          setCancelDialog({ bill, reason: "" });
                        }}
                        title="Đơn nháp này sẽ bị xóa vĩnh viễn khỏi hệ thống"
                        className="px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md transition"
                      >
                        🚫 Hủy Đơn Nháp
                      </button>
                      {/* Ẩn trên UI theo yêu cầu (giữ code để bật lại sau): Lưu Thay Đổi + Hủy Thay Đổi khi mở lại nháp */}
                      {false && (
                      <>
                      <button
                        type="button"
                        onClick={handleSaveDraft}
                        className={ui.btnSecondary}
                      >
                        💾 Lưu Thay Đổi
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          resetCreateBillForm();
                          setCurrentScreen('all-bills');
                        }}
                        className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition"
                      >
                        ❌ Hủy Thay Đổi
                      </button>
                      </>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowBillPreview(true)}
                        className="px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md transition"
                      >
                        📝 Xem Bill In
                      </button>
                      <button
                        type="submit"
                        className={ui.btnPrimary}
                      >
                        🚀 Hoàn Tất Và Tạo Đơn
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          resetCreateBillForm();
                          reserveBillCode();
                        }}
                        className={ui.btnPrimary}
                      >
                        + Tạo Đơn Mới
                      </button>
                    </>
                  ) : editingBillId ? (
                    <>
                      {/* Ẩn "Hủy Đơn" trong flow sửa đơn (tránh nhầm với Hủy Thay Đổi); giữ code để bật lại sau */}
                      {false && (
                      <button
                        type="button"
                        onClick={() => {
                          const bill = bills.find(b => b.id === editingBillId);
                          if (!bill) {
                            showToast("Không tìm thấy đơn để hủy!", "error");
                            return;
                          }
                          setCancelDialog({ bill, reason: "" });
                        }}
                        className="px-4 py-2 text-sm font-semibold text-red-700 bg-white border border-red-300 hover:bg-red-50 rounded-md transition"
                      >
                        🚫 Hủy Đơn
                      </button>
                      )}
                      <button
                        type="button"
                        onClick={() => {
                          resetCreateBillForm();
                          setCurrentScreen('all-bills');
                        }}
                        className="px-4 py-2 text-sm font-semibold text-gray-700 bg-white border border-gray-300 hover:bg-gray-50 rounded-md transition"
                      >
                        ❌ Hủy Thay Đổi
                      </button>
                      <button
                        type="submit"
                        className={ui.btnPrimary}
                      >
                        🚀 Cập Nhật Đơn
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowBillPreview(true)}
                        className="px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md transition"
                      >
                        📝 Xem Bill In
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          resetCreateBillForm();
                          reserveBillCode();
                        }}
                        className={ui.btnPrimary}
                      >
                        + Tạo Đơn Mới
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => runExclusive(handleSaveDraft)}
                        disabled={isSubmitting}
                        className={`${ui.btnSecondary} disabled:opacity-60 disabled:cursor-not-allowed`}
                      >
                        💾 Lưu Nháp
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowBillPreview(true)}
                        className="px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md transition"
                      >
                        📝 Xem Bill In
                      </button>
                      <button
                        type="submit"
                        disabled={isSubmitting}
                        className={`${ui.btnPrimary} disabled:opacity-60 disabled:cursor-not-allowed`}
                      >
                        {isSubmitting ? "⏳ Đang tạo..." : "🚀 Tạo Hoá Đơn"}
                      </button>
                    </>
                  )}
                </div>
              </form>
              )}
          </div>
        )}

        {/* SCREEN 8 */}
        {currentTab === "warehouse" && (
          <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6 space-y-4">
            <div className="flex flex-col md:flex-row md:justify-between md:items-center border-b pb-4 gap-3">
              <div>
                <h3 className="font-bold text-sm text-gray-800">🚚 Báo Cáo Kiểm Kho & Bốc Xếp Hàng Ngày</h3>
                <p className="text-xs text-gray-400">Danh sách bốc xếp hàng hóa.</p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {(() => {
                  const branchOk = session?.role !== 'boss' && warehouseBranch === session?.branch_code;
                  // Chuyến hiện tại phải có ít nhất 1 bill thật (bill_seq > 1) mới cho xuất bến — tránh chuyến rỗng đốt mã.
                  const currentSeq = branchSessions[warehouseBranch]?.bill_seq ?? 1;
                  const hasBillsInTrip = currentSeq > 1;
                  // Chuyến hiện tại phải kiểm đủ + khớp số kiện Trong/Ngoài mọi đơn mới cho xuất bến.
                  const tripBusinessDate = branchSessions[warehouseBranch]?.business_date;
                  const tripBills = bills.filter(b =>
                    b.branch?.branch_code === warehouseBranch &&
                    b.delivery_status !== 'draft' &&
                    b.delivery_status !== 'cancelled' &&
                    b.business_date === tripBusinessDate
                  );
                  const incompleteCount = tripBills.filter(b => {
                    const inside = b.inside_count;
                    const outside = b.outside_count;
                    if (inside === null || inside === undefined || outside === null || outside === undefined) return true;
                    return (Number(inside) + Number(outside)) !== Number(b.package_count || 0);
                  }).length;
                  const hasIncomplete = incompleteCount > 0;
                  const canDeparture = branchOk && hasBillsInTrip && !hasIncomplete;
                  const disabledReason = !branchOk
                    ? `Chỉ nhân viên chi nhánh ${warehouseBranch} mới được xuất bến kho ${warehouseBranch}`
                    : !hasBillsInTrip
                      ? `Chuyến hiện tại của kho ${warehouseBranch} chưa có đơn hàng nào — không thể xuất bến`
                      : hasIncomplete
                        ? `Còn ${incompleteCount} đơn chưa khớp số kiện Trong/Ngoài. Vui lòng kiểm tra lại!`
                        : "";
                  return (
                    <button
                      type="button"
                      onClick={() => runExclusive(handleDeparture)}
                      disabled={!canDeparture || isSubmitting}
                      className="px-3 py-1.5 text-xs font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed rounded-lg shadow-sm transition flex items-center gap-1.5"
                      title={canDeparture
                        ? `Kết thúc chuyến hiện tại của kho ${warehouseBranch} — mã đơn hàng kế tiếp sẽ bắt đầu cho chuyến mới (chỉ kho ${warehouseBranch})`
                        : disabledReason}
                    >
                      🚛 Xuất Bến {warehouseBranch}
                    </button>
                  );
                })()}
                <button
                  type="button"
                  onClick={handlePrintWarehouseList}
                  className="px-3 py-1.5 text-xs font-bold text-orange-700 bg-white border border-orange-500 hover:bg-orange-50 rounded-lg shadow-sm transition flex items-center gap-1.5"
                  title={`In danh sách bốc xếp ${warehouseBranch === "SG" ? "Sài Gòn" : "Gia Lai"} ngày ${warehouseDate}`}
                >
                  🖨️ In Danh Sách
                </button>
                <span className="w-px h-5 bg-gray-300 mx-1 hidden md:block" />
                <label className="text-xs font-bold text-gray-600">📅 Ngày:</label>
                <button
                  type="button"
                  onClick={() => setWarehouseDate(addDaysISO(warehouseDate, -1))}
                  className="px-3.5 py-2 text-lg font-extrabold border rounded-lg bg-white hover:bg-orange-50 text-orange-700 leading-none"
                  title="Ngày trước"
                >
                  «
                </button>
                <VNDateInput
                  value={warehouseDate}
                  onChange={(e) => setWarehouseDate(e.target.value)}
                  className="border rounded px-2 py-1.5 text-xs outline-none focus:border-orange-500 w-28"
                />
                <button
                  type="button"
                  onClick={() => setWarehouseDate(addDaysISO(warehouseDate, 1))}
                  className="px-3.5 py-2 text-lg font-extrabold border rounded-lg bg-white hover:bg-orange-50 text-orange-700 leading-none"
                  title="Ngày sau"
                >
                  »
                </button>
                <button
                  type="button"
                  onClick={() => setWarehouseDate(getVNTodayDate())}
                  className="text-[10px] text-blue-600 underline hover:text-blue-700"
                  title="Hôm nay"
                >
                  hôm nay
                </button>
              </div>
            </div>

            {/* TAB chi nhánh */}
            <div className="flex border-b text-sm font-semibold">
              {[
                { code: "SG", label: "Sài Gòn" },
                { code: "GL", label: "Gia Lai" }
              ].map(b => {
                // add-server-session §7: filter theo business_date (ngày kinh doanh) thay vì created_at (real timestamp).
                const count = bills.filter(x => (x.current_branch?.branch_code || x.branch?.branch_code) === b.code && x.delivery_status !== 'draft' && x.delivery_status !== 'cancelled' && x.delivery_status !== 'destroyed' && x.business_date === warehouseDate).length;
                const active = warehouseBranch === b.code;
                return (
                  <button
                    key={b.code}
                    type="button"
                    onClick={() => setWarehouseBranch(b.code)}
                    className={`px-4 py-2 border-b-2 transition ${active ? "border-orange-500 text-orange-600" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                  >
                    {b.label} <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded-full ${active ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-500"}`}>{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Summary đầu trang: tổng số kiện / trong / ngoài của toàn bộ đơn đang lọc */}
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 border rounded-lg p-3 text-center">
                <p className="text-[11px] font-semibold text-gray-500 uppercase">Tổng số kiện</p>
                <p className="text-lg font-extrabold text-gray-800">{warehouseSummary.totalPackages}</p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-center">
                <p className="text-[11px] font-semibold text-blue-700 uppercase">Kiện Trong</p>
                <p className="text-lg font-extrabold text-blue-800">{warehouseSummary.totalInside}</p>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-center">
                <p className="text-[11px] font-semibold text-amber-700 uppercase">Kiện Ngoài</p>
                <p className="text-lg font-extrabold text-amber-800">{warehouseSummary.totalOutside}</p>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                    <th className="py-3 px-4">Mã Đơn Hàng</th>
                    <th className="py-3 px-4">Bảo Quản</th>
                    <th className="py-3 px-4">Người Gửi</th>
                    <th className="py-3 px-4">Người Nhận</th>
                    <th className="py-3 px-4">Mặt hàng</th>
                    <th className="py-3 px-4">Số kiện</th>
                    <th className="py-3 px-4">Giá cước</th>
                    <th className="py-3 px-4 text-center">Giao tận nơi</th>
                    <th className="py-3 px-4 text-center">Trong</th>
                    <th className="py-3 px-4 text-center">Ngoài</th>
                    <th className="py-3 px-4 text-center">Hàng Ghép</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-sm">
                  {(() => {
                    const filtered = warehouseFilteredBills;
                    if (filtered.length === 0) {
                      return (
                        <tr><td colSpan={11} className="py-8 text-center text-xs text-gray-400 italic">Không có đơn hàng nào ở chi nhánh {warehouseBranch === "SG" ? "Sài Gòn" : "Gia Lai"} ngày này</td></tr>
                      );
                    }
                    const totalPages = Math.max(1, Math.ceil(filtered.length / WAREHOUSE_PER_PAGE));
                    const safePage = Math.min(warehousePage, totalPages);
                    const pageStart = (safePage - 1) * WAREHOUSE_PER_PAGE;
                    const pageItems = filtered.slice(pageStart, pageStart + WAREHOUSE_PER_PAGE);
                    return pageItems.map((bill) => {
                      const insideCount = bill.inside_count ?? null;
                      const outsideCount = bill.outside_count ?? null;
                      const total = (insideCount ?? 0) + (outsideCount ?? 0);
                      // Rule: danh sách bốc xếp của ngày nào chỉ sửa được đúng ngày lịch đó; qua ngày (business_date < hôm nay) → khóa. sys_admin bypass.
                      const warehouseDayOpen = userRole === 'sys_admin' || (bill.business_date || '') >= getVNTodayDate();
                      // Chi nhánh đang giữ hàng (current_branch cho đơn hoàn hàng, else gốc) mới được xếp Trong/Ngoài/Hàng ghép.
                      const effBranchCode = bill.current_branch?.branch_code || bill.branch?.branch_code;
                      const canEditWarehouse = session?.role !== 'boss' && effBranchCode === session?.branch_code && warehouseDayOpen;
                      // Chỉ validate nếu đã nhập ít nhất 1 trong 2 giá trị
                      const hasValue = insideCount !== null || outsideCount !== null;
                      const isValid = !hasValue || total === bill.package_count;
                      
                      return (
                    <tr key={bill.id} className="transition-colors hover:bg-gray-50">
                      <td className="py-4 px-4">
                        <button
                          type="button"
                          onClick={() => { setPreviousTab("warehouse"); setSelectedBill(bill); setCurrentScreen("bills"); setActiveSubTab("create"); }}
                          className="font-mono font-bold text-orange-600 hover:underline"
                          title="Xem chi tiết đơn hàng"
                        >
                          {bill.bill_code || <span className="text-gray-400 italic">(Nháp)</span>}
                        </button>
                      </td>
                      <td className="py-4 px-4">
                        {bill.special_stars === 2 && <span className="text-red-600 font-bold text-base">⭐⭐</span>}
                        {bill.special_stars === 1 && <span className="text-red-600 font-bold text-base">⭐</span>}
                      </td>
                      <td className="py-4 px-4 text-gray-700 font-medium">{bill.sender_name_text || "—"}</td>
                      <td className="py-4 px-4 text-gray-700 font-medium">
                        {bill.receiver_name_text || "—"}
                      </td>
                      <td className="py-4 px-4 font-medium">{bill.goods_type}</td>
                      <td className="py-4 px-4 text-center">
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-bold">{bill.package_count}</span>
                      </td>
                      <td className="py-4 px-4 font-bold text-gray-700">{
                        bill.payment_status === "free" ? <span className="text-emerald-600">Miễn phí</span>
                        : bill.payment_status === "quote_later" ? <span className="text-amber-600">Chưa có cước</span>
                        : formatVND(bill.shipping_fee)
                      }</td>
                      <td className="py-4 px-4 text-center">
                        {bill.is_home_delivery ? (
                          <HoverTooltip label={bill.delivery_address ? `Địa chỉ giao: ${bill.delivery_address}` : "Chưa có địa chỉ giao"}>
                            <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded font-bold">Có</span>
                          </HoverTooltip>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="py-4 px-4 text-center">
                        <input
                          type="number"
                          min="0"
                          max={bill.package_count}
                          value={insideCount ?? ''}
                          onChange={(e) => handleUpdateLocationCounts(bill.id, 'inside_count', e.target.value)}
                          placeholder="0"
                          disabled={!canEditWarehouse}
                          className={`w-16 px-2 py-1 text-center text-sm border-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed ${
                            isValid 
                              ? 'border-gray-300 bg-white' 
                              : 'border-red-500 bg-red-50'
                          }`}
                          title={!canEditWarehouse ? `Chỉ nhân viên ${bill.branch?.branch_code} mới cập nhật được kho này` : (isValid ? '' : `Tổng phải = ${bill.package_count} kiện`)}
                        />
                      </td>
                      <td className="py-4 px-4 text-center">
                        <input
                          type="number"
                          min="0"
                          max={bill.package_count}
                          value={outsideCount ?? ''}
                          onChange={(e) => handleUpdateLocationCounts(bill.id, 'outside_count', e.target.value)}
                          placeholder="0"
                          disabled={!canEditWarehouse}
                          className={`w-16 px-2 py-1 text-center text-sm border-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100 disabled:cursor-not-allowed ${
                            isValid 
                              ? 'border-gray-300 bg-white' 
                              : 'border-red-500 bg-red-50'
                          }`}
                          title={!canEditWarehouse ? `Chỉ nhân viên ${bill.branch?.branch_code} mới cập nhật được kho này` : (isValid ? '' : `Tổng phải = ${bill.package_count} kiện`)}
                        />
                      </td>
                      <td className="py-4 px-2 text-center">
                        <CombinedGoodsInput
                          value={bill.combined_goods ?? ''}
                          disabled={!canEditWarehouse}
                          onSave={(val) => handleCombinedGoodsSave(bill.id, val)}
                          title={!canEditWarehouse ? `Chỉ nhân viên ${bill.branch?.branch_code} mới cập nhật được kho này` : ''}
                        />
                      </td>
                    </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>

            {/* ===== PAGINATION ===== */}
            {(() => {
              const filteredCount = warehouseFilteredBills.length;
              if (filteredCount === 0) return null;
              const totalPages = Math.max(1, Math.ceil(filteredCount / WAREHOUSE_PER_PAGE));
              const safePage = Math.min(warehousePage, totalPages);
              return (
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 pt-2 border-t">
                  <div className="text-[11px] text-gray-500">
                    Trang <b>{safePage}</b> / {totalPages} · {WAREHOUSE_PER_PAGE} đơn/trang · Tổng <b>{filteredCount}</b> đơn
                  </div>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setWarehousePage(1)} disabled={safePage === 1}
                      className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">« Đầu</button>
                    <button type="button" onClick={() => setWarehousePage(p => Math.max(1, p - 1))} disabled={safePage === 1}
                      className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">‹ Trước</button>
                    <span className="text-xs font-bold text-orange-600 px-2">{safePage} / {totalPages}</span>
                    <button type="button" onClick={() => setWarehousePage(p => Math.min(totalPages, p + 1))} disabled={safePage === totalPages}
                      className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Sau ›</button>
                    <button type="button" onClick={() => setWarehousePage(totalPages)} disabled={safePage === totalPages}
                      className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed">Cuối »</button>
                  </div>
                </div>
              );
            })()}
          </div>
        )}

        {/* SCREEN 9 */}
        {currentTab === "all-bills" && (
          <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6 space-y-4">
            {/* ===== TABS CHI NHANH ===== */}
            <div className="flex border-b text-sm font-semibold -mt-2 -mx-2 md:-mx-4">
              {["SG", "GL"].map((br) => (
                <button
                  key={br}
                  type="button"
                  onClick={() => setAllBillsTab(br)}
                  className={`flex-1 py-3 text-center transition border-b-2 ${allBillsTab === br ? "border-orange-500 text-orange-600 bg-orange-50/40" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                >
                  {br === "SG" ? "🏙️ Sài Gòn (SG)" : "⛰️ Gia Lai (GL)"}
                  <span className="ml-2 bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full text-[10px] font-bold">{billsCountByBranch[br] || 0}</span>
                </button>
              ))}
            </div>

            {/* ===== FILTER BAR ===== */}
            <div className="bg-gray-50 border rounded-xl p-3 md:p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-bold text-gray-700 uppercase">🔎 Bộ Lọc Đơn Hàng</h4>
                <button
                  type="button"
                  onClick={resetAllBillsFilter}
                  className="text-[11px] font-bold text-gray-500 hover:text-orange-600 underline"
                >
                  ↺ Xóa tất cả filter
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Mã đơn hàng</label>
                  <input
                    type="text"
                    placeholder="VD: SG-001..."
                    value={allBillsFilter.billCode}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, billCode: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">SĐT khách</label>
                  <input
                    type="text"
                    placeholder="Gửi hoặc nhận..."
                    value={allBillsFilter.phone}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, phone: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Trạng thái giao</label>
                  <select
                    value={allBillsFilter.delivery}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, delivery: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none bg-white"
                  >
                    <option value="all">Tất cả</option>
                    <option value="delivered">Đã giao</option>
                    <option value="pending">Chờ giao</option>
                    <option value="returned">Hoàn hàng</option>
                    <option value="destroyed">Tiêu hủy</option>
                    <option value="cancelled">Đã hủy</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Trạng thái thanh toán</label>
                  <select
                    value={allBillsFilter.payment}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, payment: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none bg-white"
                  >
                    <option value="all">Tất cả</option>
                    <option value="paid">Đã thanh toán</option>
                    <option value="unpaid">Chưa thanh toán</option>
                    <option value="free">Miễn phí</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày gửi từ</label>
                  <VNDateInput
                    value={allBillsFilter.businessFrom}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, businessFrom: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày gửi đến</label>
                  <VNDateInput
                    value={allBillsFilter.businessTo}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, businessTo: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày giao từ</label>
                  <VNDateInput
                    value={allBillsFilter.deliveryFrom}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, deliveryFrom: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày giao đến</label>
                  <VNDateInput
                    value={allBillsFilter.deliveryTo}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, deliveryTo: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div className="flex items-end">
                  <label className="flex items-center gap-2 cursor-pointer select-none w-full border rounded px-2 py-1.5 bg-white hover:bg-orange-50 transition">
                    <input
                      type="checkbox"
                      checked={allBillsFilter.homeDeliveryOnly}
                      onChange={(e) => setAllBillsFilter(f => ({ ...f, homeDeliveryOnly: e.target.checked }))}
                      className="accent-orange-600 w-4 h-4"
                    />
                    <span className="text-xs font-semibold text-gray-700">🏠 Chỉ đơn giao tận nhà chưa giao</span>
                  </label>
                </div>
              </div>
              <div className="text-[11px] text-gray-500 font-semibold">
                Hiển thị <span className="text-orange-600 font-bold">{filteredBills.length}</span> đơn tại chi nhánh <span className="font-bold">{allBillsTab}</span> (tổng {billsCountByBranch[allBillsTab] || 0})
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                    <th className="py-3 px-4">Mã Đơn Hàng</th>
                    <th className="py-3 px-4">Người Gửi</th>
                    <th className="py-3 px-4">Người Nhận</th>
                    <th className="py-3 px-4">Giá Cước</th>
                    <th className="py-3 px-4">Số Tiền Thu</th>
                    <th className="py-3 px-4">Ngày Gửi</th>
                    <th className="py-3 px-4">Ngày Giao</th>
                    <th className="py-3 px-4">Giao Hàng</th>
                    <th className="py-3 px-4">Thanh Toán</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-sm">
                  {filteredBills.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-xs text-gray-400 italic">
                        Không có đơn nào khớp với bộ lọc.
                      </td>
                    </tr>
                  ) : pagedBills.map((bill) => (
                    <tr
                      key={bill.id}
                      onClick={() => {
                        if (bill.delivery_status === 'draft') {
                          // Nháp chỉ được sửa/hủy/hoàn tất bởi đúng chi nhánh đã tạo — sys_admin bypass.
                          if (userRole !== 'sys_admin' && bill.branch?.branch_code !== session?.branch_code) {
                            showToast(`Chỉ nhân viên chi nhánh ${bill.branch?.branch_code || '?'} mới được thao tác nháp này!`, 'error');
                            return;
                          }
                          // Load draft bill vào form để chỉnh sửa
                          setPreviousTab("all-bills");
                          setSelectedBill(null);
                          setEditingDraftId(bill.id);
                          setCurrentBranch(bill.branch?.branch_code || 'SG');
                          setSenderName(bill.sender_name_text || '');
                          setSenderPhone(bill.sender_phone_text || '');
                          setReceiverName(bill.receiver_name_text || '');
                          setReceiverPhone(bill.receiver_phone_text || '');
                          setGoodsType(bill.goods_type || '');
                          setGoodsValue(bill.goods_value?.toString() || '');
                          setPackageCount(bill.package_count || 1);
                          setShippingFee(
                            bill.payment_status === 'free' || bill.payment_status === 'quote_later'
                              ? ''
                              : (bill.shipping_fee && bill.shipping_fee > 0 ? bill.shipping_fee.toString() : '')
                          );
                          setIsFreeShipping(bill.payment_status === 'free');
                          // "Báo giá sau" không lưu DB: suy ra từ cước = 0 để user save lại được mà không bị required
                          setFeeQuoteLater(bill.payment_status === 'quote_later');
                          setSpecialStars(bill.special_stars || 0);
                          setStarsManual(false); // N-10: cho phép useEffect auto re-derive theo goods_value
                          setNoDeclaredValue(!!bill.no_declared_value);
                          setIsHomeDelivery(bill.is_home_delivery || false);
                          setDeliveryAddress(bill.delivery_address || '');
                          setIsPaidImmediately(bill.payment_status === 'paid');
                          setRequireIdCheck(bill.require_id_check || false);
                          setSelfPacked(bill.self_packed || false);
                          setRiskWarning(bill.risk_warning || false);
                          setExportVat(bill.export_vat || false);
                          setOrderNote(bill.order_note || '');
                          setSendDate(getTodayFormatted());
                          setExpectedDeliveryDate(bill.expected_delivery_date || getTomorrowFormatted());
                          setCurrentScreen('bills');
                          setActiveSubTab('create');
                          // Reserve bill code cho draft để sẵn sàng tạo đơn chính thức
                          setTimeout(() => reserveBillCode(), 100);
                          // Set lại deliveryAddress SAU khi useEffect (clear khi đổi receiverName) đã chạy
                          if (bill.delivery_address) {
                            setTimeout(() => setDeliveryAddress(bill.delivery_address), 0);
                          }
                        } else {
                          setPreviousTab("all-bills");
                          setSelectedBill(bill);
                          setCurrentScreen("bills");
                          setActiveSubTab("create");
                        }
                      }}
                      className="hover:bg-gray-50/40 transition cursor-pointer"
                      title={
                        bill.delivery_status === 'draft'
                          ? (userRole !== 'sys_admin' && bill.branch?.branch_code !== session?.branch_code
                              ? `Chỉ nhân viên chi nhánh ${bill.branch?.branch_code || '?'} mới được thao tác nháp này`
                              : 'Click để chỉnh sửa nháp')
                          : 'Xem chi tiết đơn hàng'
                      }
                    >
                      <td className="py-3.5 px-4 font-mono font-bold text-orange-600 hover:underline">
                        {bill.bill_code || <span className="text-gray-400 italic">(Nháp)</span>}
                      </td>
                      <td className="py-3.5 px-4 font-medium">{bill.sender_name_text || "—"}</td>
                      <td className="py-3.5 px-4 font-medium">
                        {bill.receiver_name_text || "—"}
                      </td>
                      <td className="py-3.5 px-4 font-bold text-gray-700">{
                        bill.payment_status === "free" ? <span className="text-emerald-600">Miễn phí</span>
                        : bill.payment_status === "quote_later" ? <span className="text-amber-600">Chưa có cước</span>
                        : formatVND(bill.shipping_fee)
                      }</td>
                      <td className="py-3.5 px-4 font-bold text-emerald-700">{
                        bill.payment_status === "free" || bill.payment_status === "quote_later" || !Number(bill.actual_amount_paid)
                          ? <span className="text-gray-400 font-normal">—</span>
                          : formatVND(bill.actual_amount_paid)
                      }</td>
                      <td className="py-3.5 px-4 text-xs font-medium text-gray-700">{bill.business_date ? bill.business_date : "Chưa có"}</td>
                      <td className="py-3.5 px-4 text-xs font-medium text-gray-700">{bill.delivery_date ? toVNDate(bill.delivery_date) : "—"}</td>
                      <td className="py-3.5 px-4">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${
                          bill.delivery_status === 'delivered' ? 'bg-blue-100 text-blue-800' : 
                          bill.delivery_status === 'draft' ? 'bg-gray-100 text-gray-700' : 
                          bill.delivery_status === 'cancelled' ? 'bg-red-100 text-red-700' :
                          bill.delivery_status === 'returned' ? 'bg-orange-100 text-orange-800' :
                          bill.delivery_status === 'destroyed' ? 'bg-red-100 text-red-700' :
                          'bg-yellow-100 text-yellow-800'
                        }`}>
                          {bill.delivery_status === 'delivered' ? 'Đã giao' : bill.delivery_status === 'draft' ? 'Nháp' : bill.delivery_status === 'cancelled' ? 'Đã hủy' : bill.delivery_status === 'returned' ? 'Hoàn hàng' : bill.delivery_status === 'destroyed' ? 'Tiêu hủy' : 'Chờ giao'}
                        </span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${(bill.payment_status === 'paid' || bill.payment_status === 'free') ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{(bill.payment_status === 'paid' || bill.payment_status === 'free') ? 'Đã thanh toán' : 'Chưa thanh toán'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ===== PAGINATION ===== */}
            {filteredBills.length > 0 && (
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 pt-2 border-t">
                <div className="text-[11px] text-gray-500">
                  Trang <b>{allBillsPage}</b> / {totalBillsPages}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setAllBillsPage(1)}
                    disabled={allBillsPage === 1}
                    className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >« Đầu</button>
                  <button
                    type="button"
                    onClick={() => setAllBillsPage(p => Math.max(1, p - 1))}
                    disabled={allBillsPage === 1}
                    className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >‹ Trước</button>
                  <span className="text-xs font-bold text-orange-600 px-2">{allBillsPage} / {totalBillsPages}</span>
                  <button
                    type="button"
                    onClick={() => setAllBillsPage(p => Math.min(totalBillsPages, p + 1))}
                    disabled={allBillsPage === totalBillsPages}
                    className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >Sau ›</button>
                  <button
                    type="button"
                    onClick={() => setAllBillsPage(totalBillsPages)}
                    disabled={allBillsPage === totalBillsPages}
                    className="px-2.5 py-1 text-xs font-bold border rounded bg-white hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
                  >Cuối »</button>
                </div>
              </div>
            )}
          </div>
        )}
        {currentTab === "revenue" && (
          <div className="space-y-6">
            {/* TABS CHI NHANH */}
            <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
              <div className="flex border-b text-sm font-semibold">
                {["SG", "GL", ...(userRole === "boss" ? ["ALL"] : [])].map((br) => (
                  <button
                    key={br}
                    type="button"
                    onClick={() => setRevenueTab(br)}
                    className={`flex-1 py-3 text-center transition border-b-2 ${revenueTab === br ? "border-orange-500 text-orange-600 bg-orange-50/40" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                  >
                    {br === "SG" ? "🏙️ Sài Gòn (SG)" : br === "GL" ? "⛰️ Gia Lai (GL)" : "🔀 Tổng 2 chi nhánh"}
                  </button>
                ))}
              </div>
              <div className="p-3 md:p-4 flex flex-col md:flex-row md:items-end gap-3 bg-gray-50">
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Xem theo</label>
                  <div className="inline-flex rounded-lg border overflow-hidden">
                    {[["day", "Ngày"], ["month", "Tháng"], ["year", "Năm"]].map(([val, lbl]) => (
                      <button
                        key={val}
                        type="button"
                        onClick={() => setRevenueFilterType(val)}
                        className={`px-3 py-1.5 text-xs font-bold transition ${revenueFilterType === val ? "bg-orange-500 text-white" : "bg-white text-gray-600 hover:bg-orange-50"}`}
                      >
                        {lbl}
                      </button>
                    ))}
                  </div>
                </div>
                {revenueFilterType === "day" && (
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chọn ngày</label>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          const d = new Date(revenueDate + "T00:00:00");
                          d.setDate(d.getDate() - 1);
                          setRevenueDate(getLocalDateString(d));
                        }}
                        className="px-3.5 py-2 text-lg font-extrabold border rounded-lg bg-white hover:bg-orange-50 text-orange-700 leading-none"
                        title="Ngày trước"
                      >
                        «
                      </button>
                      <VNDateInput
                        value={revenueDate}
                        onChange={(e) => setRevenueDate(e.target.value)}
                        className="border rounded px-2 py-1.5 text-xs outline-none bg-white w-28"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const d = new Date(revenueDate + "T00:00:00");
                          d.setDate(d.getDate() + 1);
                          setRevenueDate(getLocalDateString(d));
                        }}
                        className="px-3.5 py-2 text-lg font-extrabold border rounded-lg bg-white hover:bg-orange-50 text-orange-700 leading-none"
                        title="Ngày sau"
                      >
                        »
                      </button>
                    </div>
                  </div>
                )}
                {revenueFilterType === "month" && (
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chọn tháng</label>
                    <VNMonthInput
                      value={revenueMonth}
                      onChange={(e) => setRevenueMonth(e.target.value)}
                      className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
                    />
                  </div>
                )}
                {revenueFilterType === "year" && (
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chọn năm</label>
                    <input
                      type="number"
                      min="2020"
                      max="2099"
                      value={revenueYear}
                      onChange={(e) => setRevenueYear(e.target.value)}
                      className="border rounded px-2 py-1.5 text-xs outline-none bg-white w-24"
                    />
                  </div>
                )}
                <div className="flex items-end gap-1.5">
                  <button type="button" onClick={() => { setRevenueFilterType("day"); setRevenueDate(getVNTodayDate()); }} className="px-2.5 py-1.5 text-[11px] font-bold border rounded bg-white hover:bg-orange-50">Hôm nay</button>
                  {/* Revamp §21: nút refresh doanh thu thủ công (fetchData lại toàn bộ payments + expenses) */}
                  <button
                    type="button"
                    onClick={fetchData}
                    disabled={loading}
                    title="Tải lại doanh thu"
                    className="px-2.5 py-1.5 text-[11px] font-bold border rounded bg-white hover:bg-orange-50 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? "⏳ Đang tải..." : "🔄 Cập nhật"}
                  </button>
                </div>
                <div className="md:ml-auto text-[11px] text-gray-500 font-semibold">
                  Chi nhánh: <span className="text-orange-600 font-bold">{branchFullName(revenueTab)}</span> · {paidBillsInRange.length} đơn thu · {expensesInRange.length} phiếu chi
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white p-5 rounded-xl border border-green-100 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-4">
                    <div className="p-3.5 bg-green-50 text-2xl rounded-lg">💵</div>
                    <div>
                      <span className="text-[10px] text-gray-400 uppercase font-semibold">TỔNG THU</span>
                      <p className="text-2xl font-bold text-green-600">{formatVND(totalRevenue)}</p>
                    </div>
                  </div>
                </div>
                {/* Chỉ cho xem chi tiết đơn ở màn Ngày — tháng/năm quá nhiều đơn */}
                {revenueFilterType === "day" && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowRevenueDetail(true);
                      setRevenueDetailPage(1);
                    }}
                    className="w-full mt-2 px-3 py-1.5 text-xs font-semibold text-green-700 bg-green-50 hover:bg-green-100 border border-green-200 rounded transition"
                  >
                    📋 Xem chi tiết
                  </button>
                )}
              </div>
              <div className="bg-white p-5 rounded-xl border border-red-100 shadow-sm flex items-center gap-4">
                <div className="p-3.5 bg-red-50 text-2xl rounded-lg">💸</div>
                <div>
                  <span className="text-[10px] text-gray-400 uppercase font-semibold">TỔNG CHI</span>
                  <p className="text-2xl font-bold text-red-600">{formatVND(totalExpense)}</p>
                </div>
              </div>
              <div className="bg-white p-5 rounded-xl border border-blue-100 shadow-sm flex items-center gap-4">
                <div className="p-3.5 bg-blue-50 text-2xl rounded-lg">📈</div>
                <div>
                  <span className="text-[10px] text-gray-400 uppercase font-semibold">DOANH THU THUẦN</span>
                  <p className={`text-2xl font-bold ${netRevenue >= 0 ? "text-blue-600" : "text-red-600"}`}>{formatVND(netRevenue)}</p>
                </div>
              </div>
            </div>

            {/* Revamp §20.1: breakdown table theo ngày (month) hoặc tháng (year) */}
            {breakdownRows.length > 0 && (
              <div className="bg-white p-4 rounded-xl border shadow-sm">
                <h3 className="font-bold text-sm text-gray-700 mb-3">
                  📊 Chi tiết theo {revenueFilterType === "month" ? "ngày" : "tháng"} — Chi nhánh {branchFullName(revenueTab)}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                        <th className="py-2 px-3 text-left">{revenueFilterType === "month" ? "Ngày" : "Tháng"}</th>
                        <th className="py-2 px-3 text-right">Thu</th>
                        <th className="py-2 px-3 text-right">Chi</th>
                        <th className="py-2 px-3 text-right">Thuần</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {breakdownRows.map(row => {
                        const hasData = row.revenue > 0 || row.expense > 0;
                        return (
                          <tr key={row.key} className={hasData ? "hover:bg-gray-50" : "text-gray-300"}>
                            <td className="py-1.5 px-3">{row.label}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-green-600">{row.revenue ? formatVND(row.revenue) : "—"}</td>
                            <td className="py-1.5 px-3 text-right font-mono text-red-600">{row.expense ? formatVND(row.expense) : "—"}</td>
                            <td className={`py-1.5 px-3 text-right font-mono font-bold ${row.net >= 0 ? "text-blue-600" : "text-red-600"}`}>{hasData ? formatVND(row.net) : "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 bg-gray-50 font-bold">
                        <td className="py-2 px-3">TỔNG</td>
                        <td className="py-2 px-3 text-right font-mono text-green-700">{formatVND(totalRevenue)}</td>
                        <td className="py-2 px-3 text-right font-mono text-red-700">{formatVND(totalExpense)}</td>
                        <td className={`py-2 px-3 text-right font-mono ${netRevenue >= 0 ? "text-blue-700" : "text-red-700"}`}>{formatVND(netRevenue)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* expand-revenue-reporting: bảng chi theo danh mục (tháng + năm) */}
            {(revenueFilterType === "month" || revenueFilterType === "year") && categoryBreakdown.length > 0 && (
              <div className="bg-white p-4 rounded-xl border shadow-sm">
                <h3 className="font-bold text-sm text-gray-700 mb-3">
                  🧾 Chi theo danh mục — {revenueFilterType === "month" ? `Tháng ${formatMonthDisplay(revenueMonth)}` : `Năm ${revenueYear}`} · {branchFullName(revenueTab)}
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                        <th className="py-2 px-3 text-left">Danh mục</th>
                        <th className="py-2 px-3 text-right">Số tiền</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {categoryBreakdown.map(c => (
                        <tr key={c.name} className="hover:bg-gray-50">
                          <td className="py-1.5 px-3">{c.name}</td>
                          <td className="py-1.5 px-3 text-right font-mono text-red-600">{formatVND(c.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 bg-gray-50 font-bold">
                        <td className="py-2 px-3">TỔNG CHI</td>
                        <td className="py-2 px-3 text-right font-mono text-red-700">{formatVND(totalExpense)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            {/* expand-revenue-reporting: khóa sổ tháng (boss, màn Tháng, 1 chi nhánh cụ thể) */}
            {revenueFilterType === "month" && userRole === "boss" && revenueTab !== "ALL" && (
              <div className="bg-white p-4 rounded-xl border shadow-sm flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-gray-600">
                  Sổ tháng <span className="font-bold">{revenueMonth}</span> — {branchFullName(revenueTab)}:{" "}
                  {getMonthCloseRecord(revenueTab, revenueMonth)?.status === "closed"
                    ? <span className="font-bold text-red-600">Đã khóa 🔒</span>
                    : isMonthLocked(revenueTab, revenueMonth)
                      ? <span className="font-bold text-red-600">Đã khóa (quá hạn) 🔒</span>
                      : <span className="font-bold text-green-600">Đang mở</span>}
                </div>
                {!isMonthLocked(revenueTab, revenueMonth) && (
                  <button
                    type="button"
                    onClick={() => runExclusive(() => handleCloseMonth(revenueTab, revenueMonth))}
                    disabled={isSubmitting}
                    className="px-3 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    🔒 Khóa sổ tháng này
                  </button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 gap-8">
              {revenueFilterType !== "year" && (
              <div className="bg-white p-6 rounded-xl border shadow-sm space-y-4">
                {/* Revamp §19.3-19.4: form thêm phiếu chi chỉ hiển thị cho admin/sys_admin của đúng chi nhánh đang xem.
                    Boss (chỉ đọc) + admin xem chi nhánh khác + member → ẩn hoàn toàn. */}
                {(session?.role === "admin" || session?.role === "sys_admin") && session.branch_code === revenueTab && revenueFilterType !== "year" ? (
                  (revenueFilterType === "month" && session?.role !== "sys_admin" && isMonthLocked(revenueTab, revenueMonth)) ? (
                    <p className="text-sm font-semibold text-red-600 border-l-4 border-red-400 pl-2">
                      🔒 Tháng {formatMonthDisplay(revenueMonth, "-")} đã khóa sổ.
                    </p>
                  ) : (
                  <>
                <h3 className="font-bold text-sm text-red-700 border-l-4 border-red-500 pl-2">💸 Thêm Phiếu Chi Tiêu — Chi nhánh {branchFullName(revenueTab)}</h3>
                <form onSubmit={(e) => { e.preventDefault(); runExclusive(() => handleAddExpense(e)); }} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">Số tiền chi (VND)</label>
                    <MoneyInput
                      placeholder="Số tiền..."
                      value={expAmount}
                      onChange={setExpAmount}
                      className="w-full border rounded px-3 py-1.5 text-sm"
                      required
                    />
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">Danh mục</label>
                    <select
                      value={expCategoryId}
                      onChange={(e) => setExpCategoryId(e.target.value)}
                      className="w-full border rounded px-3 py-1.5 text-sm bg-white"
                      required
                    >
                      <option value="">— Chọn danh mục —</option>
                      {expenseCategories.filter(c => c.is_active !== false).map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="md:col-span-3">
                    <label className="block text-xs text-gray-500 mb-1">Loại kỳ</label>
                    <select
                      value={expPeriodType}
                      disabled
                      title="Loại kỳ bám theo tab đang xem (Ngày/Tháng)"
                      className="w-full border rounded px-3 py-1.5 text-sm bg-gray-100 text-gray-600 cursor-not-allowed"
                    >
                      <option value="day">Theo ngày</option>
                      <option value="month">Theo tháng</option>
                    </select>
                  </div>
                  {expPeriodType === "month" && (
                    <div className="md:col-span-3">
                      <label className="block text-xs text-gray-500 mb-1">Tháng áp dụng</label>
                      <VNMonthInput
                        value={expPeriodMonth}
                        onChange={(e) => setExpPeriodMonth(e.target.value)}
                        className="w-full border rounded px-3 py-1.5 text-sm bg-white"
                      />
                    </div>
                  )}
                  <div className={expPeriodType === "month" ? "md:col-span-9" : "md:col-span-10"}>
                    <label className="block text-xs text-gray-500 mb-1">Lý do chi chi tiết</label>
                    <input
                      type="text"
                      placeholder="Lý do..."
                      value={expNote}
                      onChange={(e) => setExpNote(e.target.value)}
                      className="w-full border rounded px-3 py-1.5 text-sm"
                      required
                    />
                  </div>
                  <div className="md:col-span-2">
                    <button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-1.5 px-3 rounded text-sm transition disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {isSubmitting ? "⏳..." : "Thêm"}
                    </button>
                  </div>
                  {expPeriodType === "month" && session?.role !== "sys_admin" && isMonthLocked(revenueTab, expPeriodMonth) && (
                    <p className="md:col-span-12 text-[11px] font-semibold text-red-600">
                      ⚠️ Tháng {expPeriodMonth} đã khóa sổ — chỉ sys_admin mới nhập được.
                    </p>
                  )}
                </form>
                  </>
                  )
                ) : revenueFilterType === "day" ? (
                  <h3 className="font-bold text-sm text-gray-500 border-l-4 border-gray-300 pl-2">
                    📋 Danh sách phiếu chi — Chi nhánh {branchFullName(revenueTab)}
                  </h3>
                ) : null}

                {/* Danh sách phiếu chi chỉ hiện ở màn Ngày; tháng/năm chỉ xem chi theo danh mục */}
                {revenueFilterType === "day" && expensesInRange.length > 0 && (
                  <div className="border-t pt-4 mt-4">
                    <h4 className="font-bold text-sm text-gray-700 mb-3">📋 Danh sách phiếu chi ({expensesInRange.length})</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                            <th className="py-2 px-3">Ngày</th>
                            <th className="py-2 px-3">Danh mục</th>
                            <th className="py-2 px-3">Số tiền</th>
                            <th className="py-2 px-3">Lý do</th>
                            {(session?.role === "admin" || session?.role === "sys_admin") && session.branch_code === revenueTab && (
                              <th className="py-2 px-3 text-right">Thao tác</th>
                            )}
                          </tr>
                        </thead>
                        <tbody className="divide-y text-sm">
                          {expensesInRange.map((exp) => (
                            <tr key={exp.id} className="hover:bg-gray-50">
                              <td className="py-2 px-3 text-xs text-gray-600">
                                {exp.period_type === "month"
                                  ? <span className="font-semibold text-purple-700">Tháng {formatMonthDisplay(String(exp.period_month || "").slice(0, 7))}</span>
                                  : ((toVNDate(exp.created_at) || "").split("-").reverse().join("-") || "—")}
                              </td>
                              <td className="py-2 px-3 text-xs text-gray-700">{expenseCategories.find(c => c.id === exp.category_id)?.name || "Chưa phân loại"}</td>
                              <td className="py-2 px-3 font-bold text-red-600">{formatVND(exp.amount)}</td>
                              <td className="py-2 px-3 text-xs text-gray-700">{exp.note}</td>
                              {(session?.role === "admin" || session?.role === "sys_admin") && session.branch_code === revenueTab && (
                                <td className="py-2 px-3 text-right whitespace-nowrap">
                                  <button
                                    type="button"
                                    onClick={() => handleOpenEditExpense(exp)}
                                    className="px-2 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 rounded"
                                    title="Sửa"
                                  >✎ Sửa</button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteExpense(exp)}
                                    className="ml-1 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 rounded"
                                    title="Xóa"
                                  >🗑 Xóa</button>
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {/* §14.19: lịch sử phiếu chi theo kỳ. Ẩn với boss; ẩn luôn ở tab Năm. */}
                {userRole !== "boss" && revenueFilterType !== "year" && (
                  <div className="border-t pt-4 mt-4">
                    <ExpenseHistorySection
                      entries={expensePeriodAudit}
                      loading={expensePeriodAuditLoading}
                      error={expensePeriodAuditError}
                      title={revenueFilterType === "month" ? "Lịch sử phiếu chi theo tháng" : "Lịch sử phiếu chi theo ngày"}
                    />
                  </div>
                )}
              </div>
              )}
            </div>
          </div>
        )}

        {/* SCREEN: CÔNG NỢ (add-debt-collection-screen) */}
        {currentTab === "debt" && userRole !== "member" && (
          <div className="space-y-4">
            {/* Header: search + toggle + sort + refresh */}
            <div className="bg-white rounded-xl border shadow-sm p-4 space-y-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[220px]">
                  <input
                    type="text"
                    value={debtQuery}
                    onChange={(e) => setDebtQuery(e.target.value)}
                    placeholder="🔍 Tìm theo tên khách / SĐT"
                    className={ui.input}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs font-semibold text-gray-700 cursor-pointer select-none px-3 py-2 border rounded-lg hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={debtIncludePending}
                    onChange={(e) => setDebtIncludePending(e.target.checked)}
                    className="h-4 w-4 accent-orange-600"
                  />
                  Bao gồm đơn chưa giao
                </label>
                <button
                  type="button"
                  onClick={() => setDebtSortMode((m) => (m === "debt_desc" ? "debt_asc" : "debt_desc"))}
                  className={ui.btnSecondary}
                  title="Đổi cách sắp xếp danh sách theo tổng nợ"
                >
                  {debtSortMode === "debt_desc" ? "↓ Nợ nhiều nhất" : "↑ Nợ thấp nhất"}
                </button>
                <button
                  type="button"
                  disabled={debtRefreshing || loading}
                  onClick={async () => {
                    setDebtRefreshing(true);
                    try {
                      await fetchData();
                      showToast("Đã cập nhật", "success");
                    } catch (err) {
                      showToast("Cập nhật thất bại: " + (err?.message || err), "error");
                    } finally {
                      setDebtRefreshing(false);
                    }
                  }}
                  className={ui.btnPrimary}
                >
                  {debtRefreshing ? "⏳ Đang tải..." : "🔄 Cập nhật"}
                </button>
              </div>

              {/* Tổng quan */}
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-3">
                  <p className="text-[11px] font-semibold text-orange-700 uppercase">Khách nợ</p>
                  <p className="text-lg font-extrabold text-orange-800">{debtTotals.customerCount}</p>
                </div>
                <div className="bg-gray-50 border rounded-lg p-3">
                  <p className="text-[11px] font-semibold text-gray-500 uppercase">Tổng bill</p>
                  <p className="text-lg font-extrabold text-gray-800">{debtTotals.totalBills}</p>
                </div>
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-[11px] font-semibold text-red-700 uppercase">Tổng nợ</p>
                  <p className="text-lg font-extrabold text-red-700">{formatVND(debtTotals.totalDebt)}đ</p>
                </div>
              </div>
            </div>

            {/* List khách */}
            {debtGroups.length === 0 ? (
              <div className="bg-white rounded-xl border shadow-sm p-10 text-center text-gray-500 text-sm">
                {debtQuery
                  ? "Không tìm thấy khách nào khớp tìm kiếm."
                  : debtIncludePending
                  ? "Không có công nợ nào."
                  : "Không có công nợ đơn đã giao. Bật \"Bao gồm đơn chưa giao\" để xem thêm."}
              </div>
            ) : (
              <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
                <div className="divide-y">
                  {debtGroups.map((g) => {
                    const isOpen = debtExpanded.has(g.key);
                    return (
                      <div key={g.key}>
                        <button
                          type="button"
                          onClick={() => toggleDebtExpanded(g.key)}
                          className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-orange-50/50 transition ${isOpen ? "bg-orange-50/40" : ""}`}
                        >
                          <span className="text-gray-400 text-sm w-4">{isOpen ? "▾" : "▸"}</span>
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                              <span className="font-bold text-sm text-gray-900 truncate">{g.name}</span>
                              {g.phone && <span className="text-xs text-gray-500 font-mono">{g.phone}</span>}
                              <span className="text-[11px] text-gray-500">— {g.billCount} bill</span>
                              {g.hasQuoteLater && (
                                <span className="text-[10px] font-semibold text-amber-700 bg-amber-100 px-2 py-0.5 rounded">
                                  Chưa báo cước × {g.quoteLaterCount}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-[10px] text-gray-500 uppercase font-semibold">Tổng nợ</p>
                            <p className={`text-sm font-extrabold ${g.totalDebt > 0 ? "text-red-600" : "text-gray-400"}`}>
                              {formatVND(g.totalDebt)}đ
                            </p>
                          </div>
                        </button>

                        {isOpen && (
                          <div className="bg-gray-50/60 px-4 pb-3 pt-1">
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-gray-500 text-[11px] uppercase">
                                    <th className="text-left py-1.5 pr-3 font-semibold">Mã bill</th>
                                    <th className="text-left py-1.5 pr-3 font-semibold">Ngày gửi</th>
                                    <th className="text-left py-1.5 pr-3 font-semibold">Trạng thái giao</th>
                                    <th className="text-right py-1.5 pr-3 font-semibold">Cước</th>
                                    <th className="text-right py-1.5 pr-3 font-semibold">Đã trả</th>
                                    <th className="text-right py-1.5 font-semibold">Nợ</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-200">
                                  {g.bills.map((b) => {
                                    const fee = Number(b.shipping_fee || 0);
                                    const paid = Number(b.actual_amount_paid || 0);
                                    const debt = Math.max(0, fee - paid);
                                    const isQL = b.payment_status === "quote_later";
                                    return (
                                      <tr key={b.id} className="hover:bg-white">
                                        <td className="py-1.5 pr-3">
                                          <button
                                            type="button"
                                            onClick={() => {
                                              setSelectedBill(b);
                                              setPreviousTab("debt");
                                              setCurrentScreenRaw("bills");
                                            }}
                                            className="font-mono font-bold text-orange-600 hover:text-orange-800 hover:underline"
                                          >
                                            {b.bill_code}
                                          </button>
                                        </td>
                                        <td className="py-1.5 pr-3 text-gray-600">
                                          {b.business_date
                                            ? b.business_date.split("-").reverse().join("/")
                                            : "—"}
                                        </td>
                                        <td className="py-1.5 pr-3">
                                          {b.delivery_status === "delivered" ? (
                                            <span className="text-green-700 font-semibold">Đã giao</span>
                                          ) : b.delivery_status === "pending" ? (
                                            <span className="text-amber-700 font-semibold">Chờ giao</span>
                                          ) : (
                                            <span className="text-gray-500">{b.delivery_status}</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-right">
                                          {isQL ? (
                                            <span className="text-amber-700 italic">Chưa báo cước</span>
                                          ) : (
                                            <span className="text-gray-700">{formatVND(fee)}đ</span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-3 text-right text-gray-700">
                                          {isQL ? "—" : `${formatVND(paid)}đ`}
                                        </td>
                                        <td className="py-1.5 text-right">
                                          {isQL ? (
                                            <span className="text-amber-700 italic">—</span>
                                          ) : (
                                            <span className={`font-bold ${debt > 0 ? "text-red-600" : "text-gray-400"}`}>
                                              {formatVND(debt)}đ
                                            </span>
                                          )}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* MÀN HÌNH TÀI KHOẢN CỦA TÔI */}
        {currentTab === "my-account" && (
          <MyAccountScreen session={session} showToast={showToast} />
        )}

        {/* MÀN HÌNH QUẢN TRỊ HỆ THỐNG (sys_admin only) */}
        {currentTab === "sys-admin" && (
          <SysAdminPanel
            session={session}
            showToast={showToast}
            askConfirm={askConfirm}
            onDataChanged={fetchData}
          />
        )}

      </section>

      <footer className="h-10 border-t bg-gray-50 flex items-center justify-center text-xs text-gray-400">
        <p>© 2026 Hệ thống quản trị vận tải Sài Gòn - Gia Lai.</p>
      </footer>

    </main>

  </div>
  </SysAdminPinProvider>
);
}