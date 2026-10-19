// src/auditLabels.js
// Change: add-audit-log
// Ref: openspec/changes/add-audit-log/design.md §4 (labels), §5 (diffObjects)
//
// Mục đích: map technical field/enum/action name → tiếng Việt để render
// section "Lịch sử đơn" / "Lịch sử khách" trên UI.

export const FIELD_LABELS = {
  // bills
  shipping_fee: "Cước phí",
  payment_status: "Trạng thái TT",
  delivery_status: "Trạng thái giao",
  delivery_address: "Địa chỉ giao",
  is_home_delivery: "Giao tận nơi",
  goods_type: "Loại hàng",
  goods_value: "Giá trị hàng",
  package_count: "Số kiện",
  special_stars: "Sao đặc biệt",
  no_declared_value: "Không khai giá trị",
  self_packed: "Tự đóng gói",
  risk_warning: "Cảnh báo rủi ro",
  require_id_check: "Kiểm tra CMND",
  order_note: "Ghi chú đơn",
  export_vat: "Xuất VAT",
  business_date: "Ngày gửi",
  sender_name_text: "Tên người gửi",
  sender_phone_text: "SĐT người gửi",
  receiver_name_text: "Tên người nhận",
  receiver_phone_text: "SĐT người nhận",
  branch_id: "Chi nhánh",
  bill_code: "Mã đơn",
  amount_paid: "Số tiền thu",
  recipient_type: "Người nhận",
  // clients
  fullname: "Họ tên",
  address: "Địa chỉ",
  is_blacklist: "Blacklist",
  blacklist_reason: "Lý do blacklist",
  phone_primary: "SĐT chính",
  phone_secondary: "SĐT phụ",
  phone_demoted_to_old: "Số chuyển thành cũ",
  // expenses
  amount: "Số tiền",
  note: "Ghi chú",
  is_delete: "Đã xoá",
  source_bill: "Bill nguồn",
  // session
  day_counter: "Ký tự phiên",
};

export const ENUM_LABELS = {
  payment_status: {
    paid: "Đã thanh toán",
    unpaid: "Chưa TT",
    free: "Miễn phí",
    quote_later: "Báo giá sau",
  },
  delivery_status: {
    pending: "Chờ giao",
    delivered: "Đã giao",
    cancelled: "Đã huỷ",
    draft: "Nháp",
  },
  recipient_type: {
    self: "Chính chủ",
    helper: "Nhận giùm",
    home: "Giao tận nhà",
  },
};

export const ACTION_LABELS = {
  bill_create:           { text: "tạo đơn",                 icon: "🆕",  color: "emerald" },
  bill_update:           { text: "sửa đơn",                 icon: "✏️",  color: "amber"   },
  bill_cancel:           { text: "huỷ đơn",                 icon: "❌",  color: "red"     },
  bill_delivered:        { text: "giao hàng",               icon: "🚚",  color: "blue"    },
  bill_payment_received: { text: "thu cước",                icon: "💰",  color: "emerald" },
  client_create:         { text: "tạo khách",               icon: "👤",  color: "emerald" },
  client_update:         { text: "sửa khách",               icon: "✏️",  color: "amber"   },
  client_delete:         { text: "xoá khách",               icon: "🗑️",  color: "red"     },
  client_blacklist:      { text: "đổi blacklist",           icon: "⚠️",  color: "red"     },
  expense_create:        { text: "thêm chi phí",            icon: "💸",  color: "orange"  },
  expense_update:        { text: "sửa chi phí",             icon: "✏️",  color: "amber"   },
  expense_delete:        { text: "xoá chi phí",             icon: "🗑️",  color: "red"     },
  refund_created:        { text: "hoàn tiền cho bill huỷ",  icon: "↩️",  color: "orange"  },
  session_departure:     { text: "xuất bến",                icon: "🚛",  color: "blue"    },
  month_close:           { text: "khóa sổ tháng",           icon: "🔒",  color: "red"     },
  category_create:       { text: "thêm danh mục chi",       icon: "🏷️",  color: "emerald" },
  category_update:       { text: "sửa danh mục chi",        icon: "✏️",  color: "amber"   },
  category_delete:       { text: "xoá danh mục chi",        icon: "🗑️",  color: "red"     },
};

const MONEY_FIELDS = new Set(["shipping_fee", "goods_value", "amount", "amount_paid"]);
const BOOL_FIELDS = new Set([
  "is_home_delivery", "no_declared_value", "self_packed",
  "risk_warning", "require_id_check", "export_vat",
  "is_blacklist", "is_delete",
]);
const DATE_FIELDS = new Set(["business_date"]);

export function formatVnd(v) {
  if (v == null || v === "") return "—";
  return Number(v).toLocaleString("vi-VN") + " đ";
}

export function formatValue(field, value) {
  if (value == null || value === "") return "—";
  if (ENUM_LABELS[field]) return ENUM_LABELS[field][value] || String(value);
  if (MONEY_FIELDS.has(field)) return formatVnd(value);
  if (BOOL_FIELDS.has(field)) return value ? "có" : "không";
  if (DATE_FIELDS.has(field)) {
    const [y, m, d] = String(value).split("-");
    return d && m && y ? `${d}/${m}/${y}` : String(value);
  }
  if (field === "special_stars") return `${value} sao`;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Convert `changes` JSONB object → array cho UI render.
 * Input: { field: [oldVal, newVal], ... }
 * Output: [{ label, oldText, newText, isCreate }]
 * Nếu oldVal === null → isCreate=true (snapshot lúc tạo, không có mũi tên).
 */
export function renderChanges(changes) {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([field, val]) => {
    const [oldVal, newVal] = Array.isArray(val) ? val : [null, val];
    return {
      label: FIELD_LABELS[field] || field,
      oldText: formatValue(field, oldVal),
      newText: formatValue(field, newVal),
      isCreate: oldVal === null || oldVal === undefined,
    };
  });
}
