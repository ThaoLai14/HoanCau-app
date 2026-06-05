import React, { useState, useEffect, useMemo } from "react";
import { supabase } from "./supabaseClient";
import LoginScreen from "./LoginScreen";
import ClientAutocomplete from "./ClientAutocomplete";

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

// Lấy ngày hiện tại định dạng dd/mm/yyyy (Fix bug hardcode date)
const getTodayFormatted = () => {
const today = new Date();
const dd = String(today.getDate()).padStart(2, '0');
const mm = String(today.getMonth() + 1).padStart(2, '0');
const yyyy = today.getFullYear();
return `${dd}/${mm}/${yyyy}`;
};

// Lấy ngày mai định dạng dd/mm/yyyy
const getTomorrowFormatted = () => {
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const dd = String(tomorrow.getDate()).padStart(2, '0');
const mm = String(tomorrow.getMonth() + 1).padStart(2, '0');
const yyyy = tomorrow.getFullYear();
return `${dd}/${mm}/${yyyy}`;
};

// Lấy ngày local (theo timezone của máy) dạng YYYY-MM-DD (Fix bug timezone)
const getLocalDateString = (date = new Date()) => {
const yyyy = date.getFullYear();
const mm = String(date.getMonth() + 1).padStart(2, '0');
const dd = String(date.getDate()).padStart(2, '0');
return `${yyyy}-${mm}-${dd}`;
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

// Định dạng datetime kiểu "dd/MM/yyyy HH:mm" (ngày trước, giờ sau)
const formatDateTime = (val) => {
  if (!val) return "";
  const d = new Date(val);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  statusDelivered: "inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700",
  statusPending: "inline-flex items-center gap-1.5 text-sm font-semibold text-amber-700",
};

export default function App() {
// --- AUTH STATE (Custom: query bảng public.users) ---
const [session, setSession] = useState(null); // { id, username, full_name, role, branch_code }
const [authLoading, setAuthLoading] = useState(true);

const userRole = session?.role || "member"; // admin | member | boss
const userFullname = session?.full_name || session?.username || "User";
const loggedBranch = session?.branch_code || "SG"; // SG | GL

const [currentTab, setCurrentScreenRaw] = useState("bills"); // 'clients' | 'bills' | 'warehouse' | 'all-bills' | 'revenue'
const [sidebarOpen, setSidebarOpen] = useState(false);
const setCurrentScreen = (s) => { setCurrentScreenRaw(s); setSidebarOpen(false); };
const [currentBranch, setCurrentBranch] = useState(loggedBranch);
const [loading, setLoading] = useState(false);

// --- TRẠNG THÁI TOAST & MODAL (FIX BUG ALERT / CONFIRM) ---
const [toastMessage, setToastMessage] = useState("");
const [toastType, setToastType] = useState("success"); // success | error
const [confirmDialog, setConfirmDialog] = useState(null); // { title, message, onConfirm, confirmText, danger }

// --- TRẠNG THÁI HỆ THỐNG (FIX BUG STATE THIẾU) ---
const [dayCounter, setDayCounter] = useState(1);
const [billSeq, setBillSeq] = useState(1);

// --- TRẠNG THÁI DỮ LIỆU THỰC TẾ ---
const [clients, setClients] = useState([]);
const [bills, setBills] = useState([]);
const [expenses, setExpenses] = useState([]);

// --- FILTERS cho TỔNG HỢP ĐƠN HÀNG ---
const [allBillsTab, setAllBillsTab] = useState(loggedBranch || "SG"); // "SG" | "GL"
const [allBillsPage, setAllBillsPage] = useState(1);
const BILLS_PER_PAGE = 100;
const [allBillsFilter, setAllBillsFilter] = useState({
  billCode: "",
  delivery: "all",      // "all" | "delivered" | "pending"
  payment: "all",       // "all" | "paid" | "unpaid"
  createdFrom: "",
  createdTo: "",
  deliveryFrom: "",
  deliveryTo: "",
  phone: "",
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
const [specialStars, setSpecialStars] = useState(0);
const [starsManual, setStarsManual] = useState(false);
const [requireIdCheck, setRequireIdCheck] = useState(false);
const [expectedIdInfo, setExpectedIdInfo] = useState("");
const [riskWarning, setRiskWarning] = useState(false);          // rủi ro bể vỡ
const [selfPacked, setSelfPacked] = useState(false);            // khách tự đóng gói
const [noDeclaredValue, setNoDeclaredValue] = useState(false);  // không kê khai giá trị
const [exportVat, setExportVat] = useState(false);              // xuất VAT
const [orderNote, setOrderNote] = useState("");                 // ghi chú đơn
const [showBillPreview, setShowBillPreview] = useState(false);  // hiển thị biên nhận in
const [showRevenueDetail, setShowRevenueDetail] = useState(false); // modal chi tiết doanh thu

// --- FORM THÀNH VIÊN KHÁCH HÀNG (SCREEN 6) ---
const [newClientName, setNewClientName] = useState("");
const [newClientPhone, setNewClientPhone] = useState("");
const [newClientPhoneSec, setNewClientPhoneSec] = useState("");
const [newClientAddress, setNewClientAddress] = useState("");
const [isBlacklist, setIsBlacklist] = useState(false);
const [blacklistReason, setBlacklistReason] = useState("");
const [editingClientId, setEditingClientId] = useState(null);
const [clientSearch, setClientSearch] = useState("");
const [clientPage, setClientPage] = useState(1);
const CLIENTS_PER_PAGE = 50;
const [warehouseBranch, setWarehouseBranch] = useState(loggedBranch); // SG | GL
const [warehouseDate, setWarehouseDate] = useState(getLocalDateString());

// --- FORM CHI TIẾT THANH TOÁN / GIAO NHẬN (TAB 7.2) ---
const [selectedBill, setSelectedBill] = useState(null);
const [previousTab, setPreviousTab] = useState(null); // nhớ tab trước đó để "Quay lại" đúng chỗ
const [payOption, setPayOption] = useState(""); // "" | full | unpaid | actual  — KHÔNG default, bắt user chọn
const [actualAmountPaid, setActualAmountPaid] = useState("");
const [recipientType, setRecipientType] = useState(""); // "" | self | helper — KHÔNG default, bắt user chọn
const [repName, setRepName] = useState("");
const [repPhone, setRepPhone] = useState("");
const [repRole, setRepRole] = useState("Shipper");
const [deliveryDate, setDeliveryDate] = useState(getTodayFormatted());

// --- FORM CHI TIÊU ---
const [expAmount, setExpAmount] = useState("");
const [expNote, setExpNote] = useState("");

// --- MÀN DOANH THU: tab + lọc ngày/tháng/năm ---
const [revenueTab, setRevenueTab] = useState(loggedBranch === "GL" ? "GL" : "SG");
const [revenueFilterType, setRevenueFilterType] = useState("day"); // "day" | "month" | "year"
const [revenueDate, setRevenueDate] = useState(getLocalDateString());
const [revenueMonth, setRevenueMonth] = useState(() => {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,"0")}`;
});
const [revenueYear, setRevenueYear] = useState(new Date().getFullYear().toString());
const [revenueDetailPage, setRevenueDetailPage] = useState(1);
const REVENUE_BILLS_PER_PAGE = 100;

// Khôi phục session từ localStorage khi mở app
useEffect(() => {
  try {
    const raw = localStorage.getItem("hc_session");
    if (raw) setSession(JSON.parse(raw));
  } catch (_) { /* ignore */ }
  setAuthLoading(false);
}, []);

// Khi user login, đồng bộ currentBranch theo chi nhánh của user
useEffect(() => {
  if (session) setCurrentBranch(loggedBranch);
}, [session, loggedBranch]);

// Tải dữ liệu thực tế từ Supabase khi đã có session
useEffect(() => {
  if (session) fetchData();
}, [session]);

// Sync form Thanh toán/Phát hàng với data của bill đang chọn
// → tránh hiện default "full"/"self" đè lên giá trị đã lưu trong DB
useEffect(() => {
  if (!selectedBill) {
    setPayOption("");
    setActualAmountPaid("");
    setRecipientType("");
    setRepName("");
    setRepPhone("");
    setDeliveryDate(getTodayFormatted());
    return;
  }
  // Map payment_status → payOption (paid → "full", unpaid → "unpaid", else "")
  if (selectedBill.payment_status === "paid") setPayOption("full");
  else if (selectedBill.payment_status === "unpaid") setPayOption("unpaid");
  else setPayOption("");
  setActualAmountPaid("");
  // Load recipient từ DB; chưa lưu → để rỗng (bắt user chọn)
  setRecipientType(selectedBill.recipient_type || "");
  setRepName(selectedBill.actual_recipient_name || "");
  setRepPhone(selectedBill.actual_recipient_phone || "");
  // Ngày giao: nếu đã có thì hiển thị dd/MM/yyyy, chưa có thì hôm nay
  if (selectedBill.delivery_date) {
    const d = new Date(selectedBill.delivery_date);
    if (!isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      setDeliveryDate(`${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`);
    } else {
      setDeliveryDate(getTodayFormatted());
    }
  } else {
    setDeliveryDate(getTodayFormatted());
  }
// eslint-disable-next-line react-hooks/exhaustive-deps
}, [selectedBill?.id]);

// Callback truyền cho LoginScreen để gán session sau khi login OK
const handleLoginSuccess = (sess) => {
  localStorage.setItem("hc_session", JSON.stringify(sess));
  setSession(sess);
  // Redirect th\u1eb3ng v\u00e0o m\u00e0n t\u1ea1o \u0111\u01a1n h\u00e0ng sau khi login
  setCurrentScreen("bills");
  setActiveSubTab("create");
  setSelectedBill(null);
};

// Hàm logout
const handleLogout = () => {
  localStorage.removeItem("hc_session");
  setSession(null);
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

const fetchData = async () => {
  setLoading(true);
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
        branch:branches!branch_id(branch_code),
        creator:users!created_by(id, username, full_name),
        deliverer:users!delivered_by(id, username, full_name)
      `)
      .eq("is_delete", false)
      .order("created_at", { ascending: false });
    
    if (errB) throw errB;
    setBills(billsData || []);

    // Đếm số đơn trong ngày để gán số thứ tự tiếp theo (Fix bug timezone)
    if (billsData) {
      const todayStr = getLocalDateString();
      const todayBills = billsData.filter(b => {
        if (!b.created_at) return false;
        return getLocalDateString(new Date(b.created_at)) === todayStr;
      });
      setBillSeq(todayBills.length + 1);
    }

    // 3. Lấy danh sách chi tiêu
    const { data: expensesData, error: errE } = await supabase
      .from("expenses")
      .select(`*, branch:branches!branch_id(branch_code)`)
      .eq("is_delete", false);
    if (errE) throw errE;
    setExpenses(expensesData || []);
  } catch (err) {
    console.error("Lỗi lấy dữ liệu:", err.message);
  } finally {
    setLoading(false);
  }
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
  setNewClientAddress("");
  setIsBlacklist(false);
  setBlacklistReason("");
  setEditingClientId(null);
};

const handleStartEditClient = (c) => {
  const primary = c.client_phones?.find(p => p.type === "primary") || c.client_phones?.[0];
  const secondary = c.client_phones?.find(p => p.type === "secondary");
  setEditingClientId(c.id);
  setNewClientName(c.fullname || "");
  setNewClientPhone(primary?.phone_number || "");
  setNewClientPhoneSec(secondary?.phone_number || "");
  setNewClientAddress(c.address || "");
  setIsBlacklist(!!c.is_blacklist);
  setBlacklistReason(c.blacklist_reason || "");
  window.scrollTo({ top: 0, behavior: "smooth" });
};

const handleAddClient = async (e) => {
  e.preventDefault();
  if (!newClientName || !newClientPhone) return;

  if (editingClientId) {
    const ok = await askConfirm({
      title: "Cập nhật khách hàng?",
      message: `Bạn có chắc muốn lưu thay đổi cho khách hàng "${newClientName}"?`,
      confirmText: "Cập nhật"
    });
    if (!ok) return;
  }

  try {
    let clientId = editingClientId;

    if (editingClientId) {
      const { error: updErr } = await supabase
        .from("clients")
        .update({
          fullname: newClientName,
          address: newClientAddress,
          is_blacklist: isBlacklist,
          blacklist_reason: isBlacklist ? blacklistReason : ""
        })
        .eq("id", editingClientId);
      if (updErr) throw updErr;

      // Xóa SDT cũ rồi thêm lại (đơn giản & đúng)
      await supabase.from("client_phones").delete().eq("client_id", editingClientId);
    } else {
      const { data: client, error: clientErr } = await supabase
        .from("clients")
        .insert({
          fullname: newClientName,
          address: newClientAddress,
          is_blacklist: isBlacklist,
          blacklist_reason: isBlacklist ? blacklistReason : ""
        })
        .select()
        .single();
      if (clientErr) throw clientErr;
      clientId = client.id;
    }

    await supabase.from("client_phones").insert({
      client_id: clientId,
      phone_number: newClientPhone,
      type: "primary"
    });

    if (newClientPhoneSec) {
      await supabase.from("client_phones").insert({
        client_id: clientId,
        phone_number: newClientPhoneSec,
        type: "secondary"
      });
    }

    showToast(editingClientId ? "Đã cập nhật khách hàng!" : "Đã lưu Khách Hàng mới thành công!");
    fetchData();
    resetClientForm();
  } catch (err) {
    showToast("Lỗi lưu khách hàng: " + err.message, "error");
  }
};

// 2. Tạo đơn hàng mới (Tab 7.1) - submit đi thẳng, khách chưa có trong DB sẽ được tự động tạo
const handleStartCreateBill = async (e) => {
  e.preventDefault();

  // Validate tối thiểu
  if (!senderName.trim() || !receiverName.trim()) {
    showToast("Vui lòng nhập tên người gửi và người nhận!", "error");
    return;
  }
  if (!goodsType.trim() || !shippingFee) {
    showToast("Vui lòng nhập mặt hàng và cước phí!", "error");
    return;
  }
  if (!packageCount || Number(packageCount) < 1) {
    showToast("Vui lòng nhập số kiện hàng (tối thiểu 1)!", "error");
    return;
  }

  await executeCreateBill({
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
    specialStars: noDeclaredValue ? 0 : specialStars,
    requireIdCheck,
    expectedIdInfo,
    riskWarning,
    selfPacked,
    noDeclaredValue,
    exportVat,
    orderNote: orderNote.trim(),
  });
};

// 3. Thực thi tạo đơn hàng (Fix bug .single() trùng tên, thiếu liên kết SĐT)
const executeCreateBill = async (data) => {
  if (!data) return;
  setLoading(true);

  try {
    const { data: branchData } = await supabase
      .from("branches")
      .select("id")
      .eq("branch_code", currentBranch)
      .single();
    
    const branchUUID = branchData ? branchData.id : null;

    const seqStr = billSeq.toString().padStart(2, "0");
    const dayCode = getDayCode(dayCounter);
    const generatedCode = `${seqStr}${currentBranch}${dayCode}`;

    // BƯỚC A: Xử lý Đăng ký Khách Gửi (Fix bug trùng tên .single())
    let senderUUID = null;
    let senderPhoneUUID = null;

    const { data: existingSenders } = await supabase
      .from("clients")
      .select("id, client_phones(id, phone_number)")
      .ilike("fullname", data.senderName)
      .eq("is_delete", false);

    // Tìm xem có ông nào trùng cả tên lẫn số không
    const matchedSender = existingSenders?.find(s =>
      s.client_phones?.some(p => p.phone_number === data.senderPhone)
    );

    if (matchedSender) {
      senderUUID = matchedSender.id;
      senderPhoneUUID = matchedSender.client_phones.find(p => p.phone_number === data.senderPhone)?.id;
    } else {
      // Tạo khách hàng mới tinh dưới DB
      const { data: newS, error: newSErr } = await supabase
        .from("clients")
        .insert({ fullname: data.senderName })
        .select().single();
      if (newSErr) throw newSErr;
      senderUUID = newS.id;

      if (data.senderPhone) {
        const { data: newPhone, error: phErr } = await supabase
          .from("client_phones")
          .insert({ client_id: newS.id, phone_number: data.senderPhone, type: "primary" })
          .select().single();
        if (phErr) throw phErr;
        senderPhoneUUID = newPhone.id;
      }
    }

    // BƯỚC B: Xử lý Đăng ký Khách Nhận
    let receiverUUID = null;
    let receiverPhoneUUID = null;

    const { data: existingReceivers } = await supabase
      .from("clients")
      .select("id, client_phones(id, phone_number)")
      .ilike("fullname", data.receiverName)
      .eq("is_delete", false);

    const matchedReceiver = existingReceivers?.find(r =>
      r.client_phones?.some(p => p.phone_number === data.receiverPhone)
    );

    if (matchedReceiver) {
      receiverUUID = matchedReceiver.id;
      receiverPhoneUUID = matchedReceiver.client_phones.find(p => p.phone_number === data.receiverPhone)?.id;
    } else {
      const { data: newR, error: newRErr } = await supabase
        .from("clients")
        .insert({ fullname: data.receiverName, address: data.isHomeDelivery ? data.deliveryAddress : "" })
        .select().single();
      if (newRErr) throw newRErr;
      receiverUUID = newR.id;

      if (data.receiverPhone) {
        const { data: newPhone, error: phErr } = await supabase
          .from("client_phones")
          .insert({ client_id: newR.id, phone_number: data.receiverPhone, type: "primary" })
          .select().single();
        if (phErr) throw phErr;
        receiverPhoneUUID = newPhone.id;
      }
    }

    // BƯỚC C: Tạo Bill dưới Supabase
    const { data: newBill, error: billErr } = await supabase
      .from("bills")
      .insert({
        bill_code: generatedCode,
        branch_id: branchUUID,
        sender_id: senderUUID,
        sender_phone_id: senderPhoneUUID,
        receiver_id: receiverUUID,
        receiver_phone_id: receiverPhoneUUID,
        goods_type: data.goodsType,
        goods_value: data.noDeclaredValue ? 0 : (Number(data.goodsValue) || 0),
        shipping_fee: Number(data.shippingFee) || 0,
        package_count: Number(data.packageCount) || 1,
        is_home_delivery: data.isHomeDelivery,
        delivery_address: data.isHomeDelivery ? data.deliveryAddress : null,
        payment_status: data.isPaidImmediately ? "paid" : "unpaid",
        delivery_status: "pending",
        special_stars: data.noDeclaredValue ? 0 : data.specialStars,
        require_id_check: data.requireIdCheck,
        expected_id_info: data.requireIdCheck ? data.expectedIdInfo : null,
        risk_warning: data.riskWarning,
        self_packed: data.selfPacked,
        no_declared_value: data.noDeclaredValue,
        export_vat: data.exportVat,
        order_note: data.orderNote || null,
        goods_location: "out",
        created_by: session?.id || null,
      })
      .select().single();

    if (billErr) throw billErr;

    // BƯỚC D: Tạo dòng tiền
    if (data.isPaidImmediately) {
      const { error: payErr } = await supabase.from("bill_payment_details").insert({
        bill_id: newBill.id,
        amount_paid: Number(data.shippingFee) || 0,
        branch_id: branchUUID
      });
      if (payErr) throw payErr;
    }

    showToast(`Đã lưu thành công Đơn Hàng mã: ${newBill.bill_code}!`);
    // Tăng billSeq ngay để tránh trùng bill_code khi tạo liên tiếp (Fix bug race)
    setBillSeq(prev => prev + 1);
    fetchData();

    // Reset Form
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
    setRequireIdCheck(false);
    setExpectedIdInfo("");
    setStarsManual(false);
    setSpecialStars(0);
    setRiskWarning(false);
    setSelfPacked(false);
    setNoDeclaredValue(false);
    setExportVat(false);
    setOrderNote("");
  } catch (err) {
    showToast("Lỗi tạo đơn hàng: " + err.message, "error");
  } finally {
    setLoading(false);
  }
};

// 4. Lưu thông tin thanh toán & phát hàng muộn (Tab 7.2)
const handleSavePaymentAndDelivery = async () => {
  if (!selectedBill) return;

  // Validate người nhận hàng
  if (!recipientType) {
    showToast("Vui lòng chọn người nhận hàng (Chính chủ / Nhận giùm / Giao tận nhà)!", "error");
    return;
  }
  if (recipientType === "helper" && (!repName.trim() || !repPhone.trim())) {
    showToast("Vui lòng nhập Họ tên và SĐT người nhận giùm!", "error");
    return;
  }

  // Validate trạng thái thanh toán
  if (!payOption) {
    showToast("Vui lòng chọn trạng thái thanh toán!", "error");
    return;
  }

  // Validate số tiền thực tế
  if (payOption === "actual") {
    const n = Number(actualAmountPaid);
    if (!actualAmountPaid || isNaN(n) || n <= 0) {
      showToast("Vui lòng nhập số tiền trả thực tế hợp lệ!", "error");
      return;
    }
  }

  // Thời gian giao = ngay lúc bấm lưu (không cho user nhập tay)
  const deliveryISO = new Date().toISOString();

  const ok = await askConfirm({
    title: "Xác nhận giao hàng & thanh toán?",
    message: `Bạn có chắc muốn cập nhật đơn ${selectedBill.bill_code || ""}?\nThao tác này sẽ đổi trạng thái giao/thanh toán.`,
    confirmText: "Xác nhận"
  });
  if (!ok) return;

  try {
    const { error: billErr } = await supabase
      .from("bills")
      .update({
        delivery_status: "delivered",
        payment_status: payOption === "unpaid" ? "unpaid" : "paid",
        delivery_date: deliveryISO,
        recipient_type: recipientType,
        actual_recipient_name: recipientType === "helper" ? repName.trim() : null,
        actual_recipient_phone: recipientType === "helper" ? repPhone.trim() : null,
        delivered_by: session?.id || null,
      })
      .eq("id", selectedBill.id);

    if (billErr) throw billErr;

    if (payOption === "full" || payOption === "actual") {
      const finalAmount = payOption === "full" ? selectedBill.shipping_fee : Number(actualAmountPaid);
      const { error: payErr } = await supabase.from("bill_payment_details").insert({
        bill_id: selectedBill.id,
        amount_paid: finalAmount,
        branch_id: selectedBill.branch_id
      });
      if (payErr) throw payErr;
    }

    showToast("Đã cập nhật trạng thái phát hàng thành công!");
    // Reset state Tab 7.2 (tránh leak qua bill khác)
    setSelectedBill(null);
    setActiveSubTab("create");
    setPayOption("");
    setActualAmountPaid("");
    setRecipientType("");
    setRepName("");
    setRepPhone("");
    setDeliveryDate(getTodayFormatted());
    fetchData();
  } catch (err) {
    showToast("Lỗi cập nhật đơn hàng: " + err.message, "error");
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

// 6. Thêm khoản chi phát sinh
const handleAddExpense = async (e) => {
  e.preventDefault();
  if (!expAmount || !expNote) return;

  try {
    // Lấy branch_id theo tab đang chọn
    const { data: branchData } = await supabase
      .from("branches")
      .select("id")
      .eq("branch_code", revenueTab)
      .single();
    const branchUUID = branchData ? branchData.id : null;

    const { error } = await supabase.from("expenses").insert({
      amount: Number(expAmount),
      note: expNote,
      branch_id: branchUUID,
    });

    if (error) throw error;

    showToast("Đã ghi nhận phiếu chi thành công!");
    setExpAmount("");
    setExpNote("");
    fetchData();
  } catch (err) {
    showToast("Lỗi ghi nhận chi phí: " + err.message, "error");
  }
};

// Tính toán doanh thu thực tế từ DB (lọc theo tab chi nhánh + ngày/tháng/năm)
const { totalRevenue, totalExpense, netRevenue, paidBillsInRange, expensesInRange } = useMemo(() => {
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
  const paid = bills.filter(b => {
    if (b.payment_status !== "paid") return false;
    if ((b.branch?.branch_code || "") !== revenueTab) return false;
    // ưu tiên delivery_date nếu có, fallback created_at
    const d = (b.delivery_date || b.created_at || "").slice(0, 10);
    return inRange(d);
  });
  const exps = expenses.filter(e => {
    if ((e.branch?.branch_code || "") !== revenueTab) return false;
    const d = (e.created_at || "").slice(0, 10);
    return inRange(d);
  });
  const rev = paid.reduce((s, b) => s + Number(b.shipping_fee || 0), 0);
  const exp = exps.reduce((s, e) => s + Number(e.amount || 0), 0);
  return { totalRevenue: rev, totalExpense: exp, netRevenue: rev - exp, paidBillsInRange: paid, expensesInRange: exps };
}, [bills, expenses, revenueTab, revenueFilterType, revenueDate, revenueMonth, revenueYear]);

// --- L\u1eccC \u0110\u01a0N H\u00c0NG cho m\u00e0n T\u1ed5ng H\u1ee3p ---
const filteredBills = useMemo(() => {
  const f = allBillsFilter;
  const codeQ = f.billCode.trim().toLowerCase();
  const phoneQ = f.phone.trim().replace(/\s+/g, "");
  const list = bills.filter((b) => {
    if ((b.branch?.branch_code || "") !== allBillsTab) return false;
    if (codeQ && !(b.bill_code || "").toLowerCase().includes(codeQ)) return false;
    // tr\u1ea1ng th\u00e1i giao
    if (f.delivery === "delivered" && b.delivery_status !== "delivered") return false;
    if (f.delivery === "pending" && b.delivery_status === "delivered") return false;
    // tr\u1ea1ng th\u00e1i thanh to\u00e1n
    if (f.payment === "paid" && b.payment_status !== "paid") return false;
    if (f.payment === "unpaid" && b.payment_status === "paid") return false;
    // ng\u00e0y t\u1ea1o
    const createdDay = b.created_at ? b.created_at.slice(0, 10) : "";
    if (f.createdFrom && createdDay < f.createdFrom) return false;
    if (f.createdTo && createdDay > f.createdTo) return false;
    // ng\u00e0y giao
    const deliveryDay = b.delivery_date ? b.delivery_date.slice(0, 10) : "";
    if (f.deliveryFrom && (!deliveryDay || deliveryDay < f.deliveryFrom)) return false;
    if (f.deliveryTo && (!deliveryDay || deliveryDay > f.deliveryTo)) return false;
    // s\u0111t kh\u00e1ch (g\u1eedi ho\u1eb7c nh\u1eadn)
    if (phoneQ) {
      const sp = (b.sender_phone?.phone_number || "").replace(/\s+/g, "");
      const rp = (b.receiver_phone?.phone_number || "").replace(/\s+/g, "");
      if (!sp.includes(phoneQ) && !rp.includes(phoneQ)) return false;
    }
    return true;
  });
  // Sort: chua giao truoc -> chua thanh toan truoc -> ngay tao moi nhat
  list.sort((a, b) => {
    const aPending = a.delivery_status !== "delivered" ? 0 : 1;
    const bPending = b.delivery_status !== "delivered" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const aUnpaid = a.payment_status !== "paid" ? 0 : 1;
    const bUnpaid = b.payment_status !== "paid" ? 0 : 1;
    if (aUnpaid !== bUnpaid) return aUnpaid - bUnpaid;
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

useEffect(() => { setAllBillsPage(1); }, [allBillsFilter, allBillsTab]);
const totalBillsPages = Math.max(1, Math.ceil(filteredBills.length / BILLS_PER_PAGE));
const pagedBills = filteredBills.slice((allBillsPage - 1) * BILLS_PER_PAGE, allBillsPage * BILLS_PER_PAGE);

const resetAllBillsFilter = () => setAllBillsFilter({
  billCode: "", delivery: "all", payment: "all",
  createdFrom: "", createdTo: "", deliveryFrom: "", deliveryTo: "", phone: "",
});

// --- GATE: nếu chưa login, hiển thị màn hình Login ---
if (authLoading) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-sm text-gray-500 animate-pulse">⏳ Đang kiểm tra phiên đăng nhập...</p>
    </div>
  );
}
if (!session) {
  return <LoginScreen onLogin={handleLoginSuccess} />;
}

return (
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

    {/* --- CỤM REACT MODAL CONFIRM (ĐÃ BỬA: khách chưa có trong DB tự động được tạo) --- */}
    {confirmDialog && (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden animate-[fadeIn_0.15s_ease-out]">
          <div className={`px-5 py-4 border-b ${confirmDialog.danger ? "bg-red-50" : "bg-orange-50"}`}>
            <h3 className={`font-bold text-sm ${confirmDialog.danger ? "text-red-800" : "text-orange-800"}`}>
              {confirmDialog.danger ? "⚠️ " : "❓ "}{confirmDialog.title}
            </h3>
          </div>
          <div className="px-5 py-4 text-sm text-gray-700 whitespace-pre-line">
            {confirmDialog.message}
          </div>
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

    {/* --- MODAL XEM BIÊN NHẬN IN CHO KHÁCH --- */}
    {showBillPreview && (
      <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl w-full max-w-md my-8 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="px-6 py-4 border-b flex items-center justify-between bg-gray-50">
            <h3 className="font-bold text-lg text-gray-800">📋 Biên Nhận In Cho Khách</h3>
            <button
              type="button"
              onClick={() => setShowBillPreview(false)}
              className="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            >
              ×
            </button>
          </div>

          {/* Printable Content */}
          <div id="bill-print-content" className="p-5 space-y-3">
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
              }
            `}</style>
            
            {/* Company Header */}
            <div className="text-center border-b-2 border-gray-800 pb-4">
              <h1 className="text-lg font-extrabold text-gray-900 uppercase whitespace-nowrap">DNTN Vận Tải Và Thương Mại Hoàn Cầu</h1>
              <h2 className="text-sm font-bold text-gray-900 mt-2 uppercase">Biên Nhận Hàng Hóa</h2>
            </div>

            {/* Bill Code */}
            <div className="text-center">
              <p className="text-base"><span className="font-bold">Mã đơn hàng:</span> <span className="font-mono font-bold text-lg">{billSeq.toString().padStart(2, "0") + currentBranch + getDayCode(dayCounter)}</span></p>
            </div>

            {/* Main Info */}
            <div className="space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <p><span className="font-bold">Người gửi:</span> {senderName}</p>
                <p><span className="font-bold">SĐT:</span> {senderPhone || "—"}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <p><span className="font-bold">Người nhận:</span> {receiverName}</p>
                <p><span className="font-bold">SĐT:</span> {receiverPhone || "—"}</p>
              </div>
              <p><span className="font-bold">Mặt hàng gửi:</span> {goodsType}</p>
              <div className="grid grid-cols-2 gap-3">
                <p><span className="font-bold">Trị giá hàng:</span> {noDeclaredValue ? "Không kê khai" : formatVND(goodsValue)}</p>
              <p><span className="font-bold">Số kiện:</span> {packageCount}</p>
              </div>   
              <p><span className="font-bold">Giá cước:</span> <span className="font-bold">{formatVND(shippingFee)}</span></p>
              <div className="grid grid-cols-2 gap-3">
                <p><span className="font-bold">Ngày gửi:</span> {sendDate}</p>
                <p><span className="font-bold">Ngày giao:</span> {expectedDeliveryDate}</p>
              </div>
            </div>

            {/* Optional Notes */}
            {(isHomeDelivery || noDeclaredValue || selfPacked || riskWarning || exportVat || orderNote.trim() || requireIdCheck) && (
              <div className="border-t border-gray-300 pt-3 mt-3">
                <p className="font-bold text-sm mb-2">Lưu ý:</p>
                <ul className="text-xs space-y-1 list-disc list-inside">
                  {isHomeDelivery && deliveryAddress && (
                    <li><span className="font-semibold">Giao hàng tận nơi:</span> {deliveryAddress}</li>
                  )}
                  {noDeclaredValue && (
                    <li>Khách không kê khai giá trị hàng hóa</li>
                  )}
                  {selfPacked && (
                    <li>Khách hàng tự đóng gói / niêm phong</li>
                  )}
                  {riskWarning && (
                    <li>Hàng có nguy cơ rủi ro bể vỡ cao — Nhà xe không giải quyết khiếu nại</li>
                  )}
                  {exportVat && (
                    <li>Yêu cầu xuất hóa đơn VAT</li>
                  )}
                  {requireIdCheck && (
                    <li>Yêu cầu cung cấp CCCD khi nhận hàng</li>
                  )}
                  {orderNote.trim() && (
                    <li><span className="font-semibold">Ghi chú:</span> {orderNote}</li>
                  )}
                </ul>
              </div>
            )}

            {/* Company Contact Info */}
            <div className="border-t border-gray-300 pt-3 mt-3 text-xs">
              <p className="font-bold mb-2">Thông tin nhà xe:</p>
              <p><span className="font-semibold">TP.HCM:</span> 123 Đường ABC, Quận 1, TP.HCM · ĐT: 028.1234.5678</p>
              <p><span className="font-semibold">Gia Lai:</span> 456 Đường XYZ, TP. Pleiku, Gia Lai · ĐT: 026.9876.5432</p>
            </div>

            {/* Footer Notes */}
            <div className="border-t-2 border-gray-800 pt-3 mt-4 text-[11px] space-y-1 text-gray-700">
              <p className="font-bold">Ghi chú:</p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>Biên nhận có giá trị 10 ngày. Khách hàng chịu trách nhiệm pháp lý về hàng gửi.</li>
                <li>Khi nhận hàng đem theo giấy tờ tùy thân. DNTN VT & TM Hoàn Cầu không giải quyết khiếu nại khi không có biên nhận.</li>
                <li>Hàng hóa phải kê khai trị giá. Nếu khách hàng không kê khai, khi mất mát xảy ra Công ty chỉ bồi thường gấp 05 lần giá cước vận chuyển.</li>
              </ul>
            </div>
          </div>

          {/* Footer Buttons */}
          <div className="px-6 py-4 border-t bg-gray-50 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowBillPreview(false)}
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
    )}

    {/* --- MODAL CHI TIẾT DOANH THU --- */}
    {showRevenueDetail && (
      <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-lg shadow-2xl w-full max-w-5xl my-8 max-h-[90vh] overflow-y-auto">
          {/* Header */}
          <div className="px-6 py-4 border-b flex items-center justify-between bg-green-50">
            <div>
              <h3 className="font-bold text-lg text-green-800">💵 Chi Tiết Doanh Thu</h3>
              <p className="text-xs text-green-600 mt-1">
                Chi nhánh: <span className="font-bold">{revenueTab}</span> · 
                {revenueFilterType === "day" && ` Ngày ${revenueDate}`}
                {revenueFilterType === "month" && ` Tháng ${revenueMonth}`}
                {revenueFilterType === "year" && ` Năm ${revenueYear}`}
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
                Tổng cộng: <span className="text-green-600 text-lg">{paidBillsInRange.length} đơn</span> · 
                <span className="text-green-600 text-lg ml-2">{formatVND(totalRevenue)}</span>
              </p>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                    <th className="py-3 px-4">Mã Bill</th>
                    <th className="py-3 px-4">Ngày tạo</th>
                    <th className="py-3 px-4">Người gửi</th>
                    <th className="py-3 px-4">Người nhận</th>
                    <th className="py-3 px-4">Mặt hàng</th>
                    <th className="py-3 px-4">Giá cước</th>
                    <th className="py-3 px-4">Số tiền thu</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-sm">
                  {paidBillsInRange.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-xs text-gray-400 italic">
                        Không có đơn hàng nào
                      </td>
                    </tr>
                  ) : (() => {
                    const totalPages = Math.max(1, Math.ceil(paidBillsInRange.length / REVENUE_BILLS_PER_PAGE));
                    const page = Math.min(revenueDetailPage, totalPages);
                    const start = (page - 1) * REVENUE_BILLS_PER_PAGE;
                    const pagedBills = paidBillsInRange.slice(start, start + REVENUE_BILLS_PER_PAGE);
                    return pagedBills.map((bill) => (
                      <tr key={bill.id} className="hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedBill(bill);
                              setPreviousTab("revenue");
                              setCurrentScreenRaw("bills");
                              setShowRevenueDetail(false);
                            }}
                            className="font-mono font-bold text-orange-600 hover:text-orange-800 hover:underline"
                          >
                            {bill.bill_code}
                          </button>
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-600">{bill.created_at?.slice(0,10) || "—"}</td>
                        <td className="py-3 px-4">{displayName(bill.sender)}</td>
                        <td className="py-3 px-4">{displayName(bill.receiver)}</td>
                        <td className="py-3 px-4 text-xs text-gray-600">{bill.goods_type || "—"}</td>
                        <td className="py-3 px-4 font-bold text-gray-700">{formatVND(bill.shipping_fee)}</td>
                        <td className="py-3 px-4 font-bold text-green-600">{formatVND(bill.actual_amount_paid || bill.shipping_fee)}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </div>

            {paidBillsInRange.length > REVENUE_BILLS_PER_PAGE && (() => {
              const totalPages = Math.ceil(paidBillsInRange.length / REVENUE_BILLS_PER_PAGE);
              const page = Math.min(revenueDetailPage, totalPages);
              return (
                <div className="flex items-center justify-between gap-2 mt-4 pt-3 border-t">
                  <span className="text-xs text-gray-500">
                    Trang <b>{page}</b> / {totalPages} — hiển thị {Math.min(REVENUE_BILLS_PER_PAGE, paidBillsInRange.length - (page-1)*REVENUE_BILLS_PER_PAGE)} / {paidBillsInRange.length} đơn
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

        <button
          type="button"
          onClick={() => setCurrentScreen("bills")}
          className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "bills" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
        >
          📦 Phiếu Gửi Hàng
        </button>

        <button
          type="button"
          onClick={() => setCurrentScreen("warehouse")}
          className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "warehouse" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
        >
          📋 Danh Sách Bốc Xếp
        </button>

        <button
          type="button"
          onClick={() => setCurrentScreen("all-bills")}
          className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "all-bills" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
        >
          📋 Tổng Hợp Đơn Hàng
        </button>

        {(userRole === "admin" || userRole === "boss") && (
          <button
            type="button"
            onClick={() => setCurrentScreen("revenue")}
            className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg text-xs font-bold transition ${currentTab === "revenue" ? "bg-orange-600 shadow-md" : "hover:bg-orange-700/50"}`}
          >
            💰 Quản Lý Doanh Thu
          </button>
        )}
      </nav>

      <div className="p-4 border-t border-orange-700 bg-orange-950 text-[10px] space-y-2">
        <div className="bg-orange-900/60 rounded-lg p-2.5 space-y-0.5">
          <p className="text-orange-300 font-semibold uppercase text-[9px]">👤 Đang đăng nhập:</p>
          <p className="text-white font-bold text-xs truncate" title={userFullname}>{userFullname}</p>
          <div className="flex gap-1.5 mt-1.5">
            <span className="bg-orange-600 text-white px-1.5 py-0.5 rounded text-[9px] font-bold uppercase">{userRole}</span>
          </div>
        </div>

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
            {currentTab === "warehouse" && "🚚 DANH SÁCH BỐC DỠ HÀNG HOÁ THEO NGÀY (THỦ KHO)"}
            {currentTab === "all-bills" && "📋 TỔNG HỢP HỆ THỐNG ĐƠN HÀNG"}
            {currentTab === "revenue" && "💰 BÁO CÁO DOANH THU & CHI TIÊU"}
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
            <div className="lg:col-span-1 bg-white p-6 rounded-xl border shadow-sm h-fit space-y-4">
              <h3 className="font-bold text-sm text-gray-700 border-l-4 border-orange-500 pl-2">
                {editingClientId ? "✏️ Sửa Khách Hàng" : "Thêm Khách Hàng Mới"}
              </h3>
              <form onSubmit={handleAddClient} className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Họ tên *</label>
                  <input
                    type="text"
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
                  disabled={userRole === "boss"}
                  className="w-full bg-orange-600 text-white font-bold py-2 rounded-lg text-sm hover:bg-orange-700 transition"
                >
                  {editingClientId ? "💾 Cập Nhật Khách Hàng" : "💾 Lưu Khách Hàng"}
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
            </div>

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
                          <button
                            type="button"
                            onClick={() => handleStartEditClient(c)}
                            disabled={userRole === "boss"}
                            className="font-semibold text-gray-800 hover:text-orange-600 hover:underline text-left disabled:cursor-not-allowed disabled:hover:text-gray-800 disabled:hover:no-underline"
                            title="Nhấn để chỉnh sửa"
                          >
                            {c.fullname}
                          </button>
                        </td>
                        <td className="py-3 px-4 space-y-1">
                          {c.client_phones && c.client_phones.map(p => (
                            <span key={p.id} className="block font-mono font-bold text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded w-fit">
                              {p.type === 'primary' ? 'Chính' : 'Phụ'}: {p.phone_number}
                            </span>
                          ))}
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-500">{c.address || "Chưa có"}</td>
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
                    {/* Hàng 1: Title bên trái — Mã bill canh giữa — Buttons bên phải */}
                    <div className="relative flex items-center justify-between gap-3">
                      <h3 className="text-xl font-extrabold text-orange-600 border-l-4 border-orange-500 pl-3 py-1 shrink-0">
                        Chi tiết đơn hàng
                      </h3>
                      <p className="absolute left-1/2 -translate-x-1/2 text-3xl md:text-4xl font-extrabold text-orange-600 font-mono tracking-wider whitespace-nowrap">
                        {selectedBill.bill_code}
                      </p>
                      <div className="flex gap-2 shrink-0 z-10">
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
                        <button
                          type="button"
                          onClick={() => setSelectedBill(null)}
                          className={ui.btnPrimary}
                        >
                          + Tạo đơn mới
                        </button>
                      </div>
                    </div>

                    {/* Hàng 2: Thông tin NV tạo/giao — format giống Mặt hàng & cước phí */}
                    <div className={ui.card}>
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                        <div>
                          <p className={ui.label}>Nhân viên tạo đơn</p>
                          <p className={`${ui.value} mt-1`}>{selectedBill.creator?.full_name || selectedBill.creator?.username || "—"}</p>
                        </div>
                        <div>
                          <p className={ui.label}>Thời gian tạo</p>
                          <p className={`${ui.value} mt-1`}>{formatDateTime(selectedBill.created_at) || "—"}</p>
                        </div>
                        <div>
                          <p className={ui.label}>Nhân viên giao đơn</p>
                          <p className={`${ui.value} mt-1`}>
                            {selectedBill.deliverer
                              ? (selectedBill.deliverer.full_name || selectedBill.deliverer.username)
                              : <span className="italic text-gray-400 font-normal"></span>}
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
                      <p className={ui.valueStrong}>{displayName(selectedBill.sender) || "—"}</p>
                      <p className={`${ui.mono} text-gray-600 mt-1`}>{selectedBill.sender_phone?.phone_number || selectedBill.sender_alt_contact || "—"}</p>
                    </div>
                    <div className={ui.card}>
                      <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>Người nhận</h4>
                      <p className={ui.valueStrong}>{displayName(selectedBill.receiver) || "—"}</p>
                      <p className={`${ui.mono} text-gray-600 mt-1`}>{selectedBill.receiver_phone?.phone_number || selectedBill.receiver_alt_contact || "—"}</p>
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
                        <p className={`${ui.valueStrong} text-orange-600 mt-1`}>{formatVND(selectedBill.shipping_fee)}</p>
                      </div>
                      <div>
                        <p className={ui.label}>Thanh toán</p>
                        <p className={`mt-1 ${selectedBill.payment_status === "paid" ? ui.statusPaid : ui.statusUnpaid}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${selectedBill.payment_status === "paid" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                          {selectedBill.payment_status === "paid" ? "Đã thanh toán" : "Chưa thanh toán"}
                        </p>
                      </div>
                      <div>
                        <p className={ui.label}>Giao hàng</p>
                        <p className={`mt-1 ${selectedBill.delivery_status === "delivered" ? ui.statusDelivered : ui.statusPending}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${selectedBill.delivery_status === "delivered" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                          {selectedBill.delivery_status === "delivered" ? "Đã giao" : "Chờ giao"}
                        </p>
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
                      { on: selectedBill.risk_warning, label: "Hàng có nguy cơ rủi ro bể vỡ cao — Nhà xe không giải quyết khiếu nại" },
                      { on: selectedBill.self_packed, label: "Khách hàng tự đóng gói / niêm phong" },
                      { on: selectedBill.export_vat, label: "Xuất hóa đơn VAT" },
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
                                <span>{f.label}</span>
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
                        <p className="text-xs">Thông tin đối chiếu:</p>
                        <pre className="text-xs whitespace-pre-wrap font-mono bg-white/60 border border-amber-200 rounded p-2 text-amber-900">{selectedBill.expected_id_info || "(không có thông tin)"}</pre>
                      </div>
                    </div>
                  )}

                  {/* ====== SECTION: THANH TOÁN & GIAO NHẬN ====== */}
                  <div className={`${ui.divider} space-y-5`}>
                    <h3 className="text-xl font-extrabold text-orange-600 border-l-4 border-orange-500 pl-3 py-1">Thanh toán & Giao nhận</h3>

                    {(() => {
                      const isFullyDone = selectedBill.delivery_status === "delivered" && selectedBill.payment_status === "paid";
                      return isFullyDone ? (
                        <div className={`${ui.alertSuccess} flex items-center gap-3`}>
                          <span className="text-xl">✅</span>
                          <div>
                            <h4 className="text-sm font-bold">Đơn hàng đã hoàn tất</h4>
                            <p className="text-xs">Đơn này đã giao và thanh toán đầy đủ.</p>
                          </div>
                        </div>
                      ) : null;
                    })()}

                    <fieldset disabled={selectedBill.delivery_status === "delivered" && selectedBill.payment_status === "paid"} className="space-y-5 disabled:opacity-70 disabled:pointer-events-none">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* === 1. Thanh toán === */}
                        <div className={ui.card}>
                          <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>1. Trạng thái thanh toán</h4>
                          <div className="space-y-3">
                            <div>
                              <label className={`${ui.label} block mb-1`}>Trạng thái thanh toán</label>
                              <div className="flex flex-col gap-2">
                                {selectedBill.payment_status === "paid" ? (
                                  <label className="flex items-center gap-1.5 opacity-60 cursor-not-allowed">
                                    <input type="radio" name="payOption" checked disabled className="text-orange-600 focus:ring-orange-500" />
                                    <span className={ui.value}>Đã thanh toán đủ ({formatVND(selectedBill.shipping_fee)})</span>
                                  </label>
                                ) : (
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

                            {payOption === "actual" && (
                              <div>
                                <label className={`${ui.label} block mb-1`}>Số tiền thực thu *</label>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={formatNumber(actualAmountPaid)}
                                  onChange={(e) => setActualAmountPaid(e.target.value.replace(/\D/g, ""))}
                                  placeholder="Số tiền thực thu..."
                                  className="w-full border rounded px-3 py-1.5 text-sm"
                                />
                              </div>
                            )}
                          </div>
                        </div>

                        {/* === 2. Phát hàng === */}
                        <div className={ui.card}>
                          <h4 className={`${ui.sectionTitle} ${ui.cardHeader} mb-3`}>2. Thông tin phát hàng</h4>
                          <div className="space-y-3">
                            <div>
                              <label className={`${ui.label} block mb-1`}>Người nhận hàng trực tiếp</label>
                              <div className="flex flex-col gap-2">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input type="radio" name="recipientType" checked={recipientType === "self"} onChange={() => setRecipientType("self")} className="text-orange-600 focus:ring-orange-500" />
                                  <span className={ui.value}>Chính chủ ({displayName(selectedBill.receiver)})</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input type="radio" name="recipientType" checked={recipientType === "helper"} onChange={() => setRecipientType("helper")} className="text-orange-600 focus:ring-orange-500" />
                                  <span className={ui.value}>Nhận giùm</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input type="radio" name="recipientType" checked={recipientType === "home"} onChange={() => setRecipientType("home")} className="text-orange-600 focus:ring-orange-500" />
                                  <span className={ui.value}>Giao tận nhà</span>
                                </label>
                              </div>
                            </div>

                            {recipientType === "helper" && (
                              <div className={`${ui.cardMuted} space-y-2`}>
                                <div>
                                  <label className={`${ui.label} block mb-1`}>Họ tên người nhận giùm *</label>
                                  <input
                                    type="text"
                                    value={repName}
                                    onChange={(e) => setRepName(e.target.value)}
                                    className={ui.input}
                                    required
                                  />
                                </div>
                                <div>
                                  <label className={`${ui.label} block mb-1`}>SĐT người nhận giùm *</label>
                                  <input
                                    type="text"
                                    value={repPhone}
                                    onChange={(e) => setRepPhone(e.target.value)}
                                    className={ui.input}
                                    required
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    </fieldset>

                    {!(selectedBill.delivery_status === "delivered" && selectedBill.payment_status === "paid") && (
                      <div className="flex justify-end gap-3 border-t border-gray-200 pt-4">
                        <button
                          type="button"
                          onClick={handleSavePaymentAndDelivery}
                          className={ui.btnPrimary}
                        >
                          Hoàn tất giao hàng
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
              <form onSubmit={handleStartCreateBill} className="p-4 md:p-8 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 bg-orange-50/50 p-4 rounded-xl border border-orange-100">
                  <div>
                    <label className={`${ui.label} block mb-1`}>Chi Nhánh Gửi *</label>
                    <select
                      value={currentBranch}
                      onChange={(e) => setCurrentBranch(e.target.value)}
                      disabled={userRole === "member"}
                      className="w-full bg-white border rounded px-2 py-1.5 text-sm disabled:bg-gray-100 disabled:text-gray-500 disabled:cursor-not-allowed"
                    >
                      <option value="SG">Sài Gòn (SG)</option>
                      <option value="GL">Gia Lai (GL)</option>
                    </select>
                    {userRole === "member" && (
                      <span className="text-[10px] text-gray-400 italic mt-0.5 block">🔒 Theo chi nhánh đăng nhập</span>
                    )}
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
                    <label className={`${ui.label} block mb-1`}>Mã Bill Dự Kiến</label>
                    <span className={`${ui.brandValue} block bg-orange-100 border border-orange-200 px-2 py-1 rounded text-center`}>
                      {(billSeq.toString().padStart(2, "0")) + currentBranch + (getDayCode(dayCounter))}
                    </span>
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
                        <input
                          type="text"
                          inputMode="numeric"
                          value={formatNumber(goodsValue)}
                          onChange={(e) => setGoodsValue(e.target.value.replace(/\D/g, ""))}
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
                      <span className="font-bold text-rose-800">Hàng có nguy cơ rủi ro bể vỡ cao — Nhà xe không giải quyết khiếu nại</span>
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
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start pt-2">
                    <div>
                      <label className={`${ui.label} block mb-1`}>Cước phí vận chuyển (VND) *</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formatNumber(shippingFee)}
                        onChange={(e) => setShippingFee(e.target.value.replace(/\D/g, ""))}
                        placeholder="Tiền cước..."
                        className="w-full border rounded px-3 py-1.5 text-sm"
                      />
          
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
                      <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-emerald-700">
                        <input
                          type="checkbox"
                          checked={isPaidImmediately}
                          onChange={(e) => setIsPaidImmediately(e.target.checked)}
                          className="rounded text-green-600 focus:ring-green-500"
                        />
                        <span>Cước thanh toán ngay</span>
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

                  {requireIdCheck && (
                    <textarea
                      value={expectedIdInfo}
                      onChange={(e) => setExpectedIdInfo(e.target.value)}
                      placeholder={"Nhập số CCCD và Họ tên người đối chiếu...\nCó thể xuống dòng để ghi nhiều thông tin"}
                      rows={3}
                      className="w-full bg-white border border-red-200 rounded px-3 py-2 text-xs text-red-900 resize-y leading-relaxed whitespace-pre-wrap mt-2"
                      required
                    />
                  )}
                </div>

                {/* GHI CHÚ ĐƠN HÀNG */}
                <div className={`${ui.cardMuted} space-y-2`}>
                  <label className={`${ui.label} block`}>📝 Ghi chú cho đơn hàng</label>
                  <textarea
                    value={orderNote}
                    onChange={(e) => setOrderNote(e.target.value)}
                    placeholder={""}
                    rows={3}
                    className={ui.input}
                  />
                </div>

                <div className="flex justify-end gap-3 border-t pt-5">
                  <button
                    type="button"
                    onClick={() => showToast("Đã lưu nháp!")}
                    className={ui.btnSecondary}
                  >
                    💾 Lưu Nháp
                  </button>
                  {senderName.trim() && receiverName.trim() && goodsType.trim() && shippingFee && packageCount && (
                    <button
                      type="button"
                      onClick={() => setShowBillPreview(true)}
                      className="px-4 py-2 text-sm font-semibold text-blue-700 bg-white border border-blue-300 hover:bg-blue-50 rounded-md transition"
                    >
                      📝 Xem Bill In
                    </button>
                  )}
                  <button
                    type="submit"
                    className={ui.btnPrimary}
                  >
                    🚀 Tạo Hoá Đơn
                  </button>
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
                <p className="text-xs text-gray-400">Danh sách bốc xếp dỡ hàng hóa.</p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-bold text-gray-600">📅 Ngày:</label>
                <input
                  type="date"
                  value={warehouseDate}
                  onChange={(e) => setWarehouseDate(e.target.value)}
                  className="border rounded px-2 py-1.5 text-xs outline-none focus:border-orange-500"
                />
                <button
                  type="button"
                  onClick={() => setWarehouseDate(getLocalDateString())}
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
                const count = bills.filter(x => x.branch?.branch_code === b.code && getLocalDateString(new Date(x.created_at)) === warehouseDate).length;
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

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                    <th className="py-3 px-4">Mã Bill</th>
                    <th className="py-3 px-4">Số Sao</th>
                    <th className="py-3 px-4">Người Gửi</th>
                    <th className="py-3 px-4">Người Nhận</th>
                    <th className="py-3 px-4">Mặt hàng</th>
                    <th className="py-3 px-4">Số kiện</th>
                    <th className="py-3 px-4">Giá cước</th>
                    <th className="py-3 px-4 text-center">Vị trí hàng</th>
                  </tr>
                </thead>
                <tbody className="divide-y text-sm">
                  {(() => {
                    const filtered = bills.filter(b =>
                      b.branch?.branch_code === warehouseBranch &&
                      getLocalDateString(new Date(b.created_at)) === warehouseDate
                    );
                    if (filtered.length === 0) {
                      return (
                        <tr><td colSpan={8} className="py-8 text-center text-xs text-gray-400 italic">Không có đơn hàng nào ở chi nhánh {warehouseBranch === "SG" ? "Sài Gòn" : "Gia Lai"} ngày này</td></tr>
                      );
                    }
                    return filtered.map((bill) => {
                      const loc = bill.goods_location === "in" ? "in" : "out"; // default = out
                      return (
                    <tr key={bill.id} className={`transition-colors ${loc === "in" ? "bg-blue-50/30" : "bg-orange-50/30"}`}>
                      <td className="py-4 px-4">
                        <button
                          type="button"
                          onClick={() => { setPreviousTab("warehouse"); setSelectedBill(bill); setCurrentScreen("bills"); setActiveSubTab("create"); }}
                          className="font-mono font-bold text-orange-600 hover:underline"
                          title="Xem chi tiết đơn hàng"
                        >
                          {bill.bill_code}
                        </button>
                      </td>
                      <td className="py-4 px-4">
                        {bill.special_stars === 2 && <span className="text-red-600 font-bold text-base">⭐⭐</span>}
                        {bill.special_stars === 1 && <span className="text-red-600 font-bold text-base">⭐</span>}
                      </td>
                      <td className="py-4 px-4 text-gray-700 font-medium">{displayName(bill.sender)}</td>
                      <td className="py-4 px-4 text-gray-700 font-medium">
                        {displayName(bill.receiver)}
                        {!bill.receiver_phone_id && bill.receiver_alt_contact && (
                          <span className="block text-[11px] text-gray-400 italic font-normal mt-0.5">{bill.receiver_alt_contact}</span>
                        )}
                      </td>
                      <td className="py-4 px-4 font-medium">{bill.goods_type}</td>
                      <td className="py-4 px-4 text-center">
                        <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded font-bold">{bill.package_count}</span>
                      </td>
                      <td className="py-4 px-4 font-bold text-gray-700">{formatVND(bill.shipping_fee)}</td>
                      <td className="py-4 px-4">
                        <div className="flex justify-center">
                          <div className="inline-flex bg-gray-100 p-0.5 rounded-lg border text-xs font-bold">
                            <button
                              type="button"
                              onClick={() => handleToggleLocation(bill.id, "in")}
                              className={`px-4 py-1 rounded-md ${loc === 'in' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}
                            >
                              Trong
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleLocation(bill.id, "out")}
                              className={`px-4 py-1 rounded-md ${loc === 'out' ? 'bg-orange-600 text-white' : 'text-gray-400'}`}
                            >
                              Ngoài
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
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
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày tạo từ</label>
                  <input
                    type="date"
                    value={allBillsFilter.createdFrom}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, createdFrom: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày tạo đến</label>
                  <input
                    type="date"
                    value={allBillsFilter.createdTo}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, createdTo: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày giao từ</label>
                  <input
                    type="date"
                    value={allBillsFilter.deliveryFrom}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, deliveryFrom: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày giao đến</label>
                  <input
                    type="date"
                    value={allBillsFilter.deliveryTo}
                    onChange={(e) => setAllBillsFilter(f => ({ ...f, deliveryTo: e.target.value }))}
                    className="w-full border rounded px-2 py-1.5 text-xs outline-none"
                  />
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
                    <th className="py-3 px-4">Mã Bill</th>
                    <th className="py-3 px-4">Chi Nhánh</th>
                    <th className="py-3 px-4">Người Gửi</th>
                    <th className="py-3 px-4">Người Nhận</th>
                    <th className="py-3 px-4">Giá Cước</th>
                    <th className="py-3 px-4">Ngày Tạo</th>
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
                      onClick={() => { setPreviousTab("all-bills"); setSelectedBill(bill); setCurrentScreen("bills"); setActiveSubTab("create"); }}
                      className="hover:bg-gray-50/40 transition cursor-pointer"
                      title="Xem chi tiết đơn hàng"
                    >
                      <td className="py-3.5 px-4 font-mono font-bold text-orange-600 hover:underline">{bill.bill_code}</td>
                      <td className="py-3.5 px-4 text-xs font-bold text-gray-600">{bill.branch?.branch_code || "—"}</td>
                      <td className="py-3.5 px-4 font-medium">{displayName(bill.sender)}</td>
                      <td className="py-3.5 px-4 font-medium">
                        {displayName(bill.receiver)}
                      </td>
                      <td className="py-3.5 px-4 font-bold text-gray-700">{formatVND(bill.shipping_fee)}</td>
                      <td className="py-3.5 px-4 text-xs font-medium text-gray-700">{bill.created_at ? bill.created_at.slice(0,10) : "Chưa có"}</td>
                      <td className="py-3.5 px-4 text-xs font-medium text-gray-700">{bill.delivery_date ? bill.delivery_date.slice(0,10) : "—"}</td>
                      <td className="py-3.5 px-4">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${bill.delivery_status === 'delivered' ? 'bg-blue-100 text-blue-800' : 'bg-yellow-100 text-yellow-800'}`}>{bill.delivery_status === 'delivered' ? 'Đã giao' : 'Chờ giao'}</span>
                      </td>
                      <td className="py-3.5 px-4">
                        <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${bill.payment_status === 'paid' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>{bill.payment_status === 'paid' ? 'Đã thanh toán' : 'Chưa thanh toán'}</span>
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
                  Trang <b>{allBillsPage}</b> / {totalBillsPages} · {BILLS_PER_PAGE} đơn/trang · Tổng <b>{filteredBills.length}</b> đơn
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
                {["SG", "GL"].map((br) => (
                  <button
                    key={br}
                    type="button"
                    onClick={() => setRevenueTab(br)}
                    className={`flex-1 py-3 text-center transition border-b-2 ${revenueTab === br ? "border-orange-500 text-orange-600 bg-orange-50/40" : "border-transparent text-gray-500 hover:text-gray-700"}`}
                  >
                    {br === "SG" ? "🏙️ Sài Gòn (SG)" : "⛰️ Gia Lai (GL)"}
                  </button>
                ))}
              </div>
              <div className="p-3 md:p-4 flex flex-col md:flex-row md:items-end gap-3 bg-gray-50">
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Lọc theo</label>
                  <select
                    value={revenueFilterType}
                    onChange={(e) => setRevenueFilterType(e.target.value)}
                    className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
                  >
                    <option value="day">Ngày</option>
                    <option value="month">Tháng</option>
                    <option value="year">Năm</option>
                  </select>
                </div>
                {revenueFilterType === "day" && (
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chọn ngày</label>
                    <input
                      type="date"
                      value={revenueDate}
                      onChange={(e) => setRevenueDate(e.target.value)}
                      className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
                    />
                  </div>
                )}
                {revenueFilterType === "month" && (
                  <div>
                    <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chọn tháng</label>
                    <input
                      type="month"
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
                  <button type="button" onClick={() => { setRevenueFilterType("day"); setRevenueDate(getLocalDateString()); }} className="px-2.5 py-1.5 text-[11px] font-bold border rounded bg-white hover:bg-orange-50">Hôm nay</button>
                </div>
                <div className="md:ml-auto text-[11px] text-gray-500 font-semibold">
                  Chi nhánh: <span className="text-orange-600 font-bold">{revenueTab}</span> · {paidBillsInRange.length} đơn thu · {expensesInRange.length} phiếu chi
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

            <div className="grid grid-cols-1 gap-8">
              <div className="bg-white p-6 rounded-xl border shadow-sm space-y-4">
                <h3 className="font-bold text-sm text-red-700 border-l-4 border-red-500 pl-2">💸 Thêm Phiếu Chi Tiêu — Chi nhánh {revenueTab}</h3>
                <form onSubmit={handleAddExpense} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                  <div className="md:col-span-4">
                    <label className="block text-xs text-gray-500 mb-1">Số tiền chi (VND)</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="Số tiền..."
                      value={formatNumber(expAmount)}
                      onChange={(e) => setExpAmount(e.target.value.replace(/\D/g, ""))}
                      className="w-full border rounded px-3 py-1.5 text-sm"
                      required
                    />
                  </div>
                  <div className="md:col-span-6">
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
                      className="w-full bg-red-600 hover:bg-red-700 text-white font-bold py-1.5 px-3 rounded text-sm transition"
                    >
                      Thêm
                    </button>
                  </div>
                </form>

                {expensesInRange.length > 0 && (
                  <div className="border-t pt-4 mt-4">
                    <h4 className="font-bold text-sm text-gray-700 mb-3">📋 Danh sách phiếu chi ({expensesInRange.length})</h4>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                            <th className="py-2 px-3">Ngày chi</th>
                            <th className="py-2 px-3">Số tiền</th>
                            <th className="py-2 px-3">Lý do</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y text-sm">
                          {expensesInRange.map((exp) => (
                            <tr key={exp.id} className="hover:bg-gray-50">
                              <td className="py-2 px-3 text-xs text-gray-600">{exp.created_at?.slice(0, 10) || "—"}</td>
                              <td className="py-2 px-3 font-bold text-red-600">{formatVND(exp.amount)}</td>
                              <td className="py-2 px-3 text-xs text-gray-700">{exp.note}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

      </section>

      <footer className="h-10 border-t bg-gray-50 flex items-center justify-center text-xs text-gray-400">
        <p>© 2026 Hệ thống quản trị vận tải Sài Gòn - Gia Lai.</p>
      </footer>

    </main>

  </div>
);
}