import React, { useEffect, useState, useMemo } from "react";
import { supabase, callAdminUsers } from "./supabaseClient";
import { logAudit } from "./auditLog";

/**
 * Trang Quản Trị Hệ Thống — chỉ sys_admin thấy.
 * Guard được enforce ở App.jsx qua render condition; component vẫn có check
 * fallback để hiển thị lỗi nếu bị bypass.
 */
export default function SysAdminPanel({ session, showToast, askConfirm, onDataChanged }) {
  const [activeTab, setActiveTab] = useState("branches"); // 'branches' | 'users' | 'categories'

  if (session?.role !== "sys_admin") {
    return (
      <div className="bg-white rounded-xl border shadow-sm p-8 text-center text-red-600 font-semibold">
        ⛔ Bạn không có quyền truy cập trang này.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="bg-white rounded-xl border shadow-sm p-4 md:p-6">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚙️</span>
          <div>
            <h2 className="text-lg font-bold text-gray-900">Quản Trị Hệ Thống</h2>
            <p className="text-xs text-gray-500">
              Cấu hình chi nhánh và quản lý tài khoản người dùng. Chỉ sys_admin có quyền.
            </p>
          </div>
        </div>
      </div>

      {/* Sub-tabs */}
      <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
        <div className="flex border-b text-sm font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab("branches")}
            className={`flex-1 py-3 text-center transition border-b-2 ${
              activeTab === "branches"
                ? "border-orange-500 text-orange-600 bg-orange-50/40"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            🏢 Chi nhánh
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("users")}
            className={`flex-1 py-3 text-center transition border-b-2 ${
              activeTab === "users"
                ? "border-orange-500 text-orange-600 bg-orange-50/40"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            👥 Người dùng
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("categories")}
            className={`flex-1 py-3 text-center transition border-b-2 ${
              activeTab === "categories"
                ? "border-orange-500 text-orange-600 bg-orange-50/40"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            🏷️ Danh mục chi
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("login-log")}
            className={`flex-1 py-3 text-center transition border-b-2 ${
              activeTab === "login-log"
                ? "border-orange-500 text-orange-600 bg-orange-50/40"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            🔒 Nhật ký đăng nhập
          </button>
        </div>

        <div className="p-4 md:p-6">
          {activeTab === "branches" && (
            <BranchesTab session={session} showToast={showToast} onDataChanged={onDataChanged} />
          )}
          {activeTab === "users" && (
            <UsersTab session={session} showToast={showToast} askConfirm={askConfirm} onDataChanged={onDataChanged} />
          )}
          {activeTab === "categories" && (
            <CategoriesTab session={session} showToast={showToast} askConfirm={askConfirm} onDataChanged={onDataChanged} />
          )}
          {activeTab === "login-log" && (
            <LoginLogTab showToast={showToast} />
          )}
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Tab: Danh mục chi phí (expand-revenue-reporting)
// =============================================================================
function CategoriesTab({ session, showToast, askConfirm, onDataChanged }) {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newDay, setNewDay] = useState("");
  const [newMonth, setNewMonth] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("expense_categories")
      .select("id, name, is_active, period_type, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      showToast("Lỗi tải danh mục: " + error.message, "error");
    } else {
      setCategories(data || []);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const handleAdd = async (periodType, rawName, clear) => {
    const name = (rawName || "").trim();
    if (!name) return;
    setBusy(true);
    try {
      const { data, error } = await supabase
        .from("expense_categories")
        .insert({ name, period_type: periodType })
        .select("id, name")
        .single();
      if (error) {
        if (error.code === "23505") { showToast("Danh mục này đã tồn tại!", "error"); return; }
        throw error;
      }
      showToast("Đã thêm danh mục!");
      logAudit({
        entityType: "expense",
        entityId: data?.id || null,
        entityLabel: name,
        action: "category_create",
        changes: { name: [null, name], period_type: [null, periodType] },
      });
      clear?.();
      await load();
      onDataChanged?.();
    } catch (err) {
      showToast("Lỗi thêm danh mục: " + err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (cat) => {
    const name = editName.trim();
    if (!name || name === cat.name) { setEditingId(null); return; }
    setBusy(true);
    try {
      const { error } = await supabase
        .from("expense_categories")
        .update({ name })
        .eq("id", cat.id);
      if (error) {
        if (error.code === "23505") { showToast("Tên danh mục đã tồn tại!", "error"); return; }
        throw error;
      }
      showToast("Đã đổi tên danh mục!");
      logAudit({
        entityType: "expense",
        entityId: cat.id,
        entityLabel: name,
        action: "category_update",
        changes: { name: [cat.name, name] },
      });
      setEditingId(null);
      await load();
      onDataChanged?.();
    } catch (err) {
      showToast("Lỗi đổi tên: " + err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (cat) => {
    const ok = await askConfirm({
      title: "Xoá danh mục",
      message: `Xoá danh mục "${cat.name}"? Chỉ xoá được nếu không có phiếu chi nào dùng danh mục này.`,
      confirmText: "Xoá",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("expense_categories")
        .delete()
        .eq("id", cat.id);
      if (error) {
        // 23503 = foreign_key_violation → đang có phiếu chi tham chiếu
        if (error.code === "23503") {
          showToast("Không xoá được — đang có phiếu chi liên quan đến danh mục này.", "error");
          return;
        }
        throw error;
      }
      showToast("Đã xoá danh mục!");
      logAudit({
        entityType: "expense",
        entityId: cat.id,
        entityLabel: cat.name,
        action: "category_delete",
        changes: { name: [cat.name, null] },
      });
      await load();
      onDataChanged?.();
    } catch (err) {
      showToast("Lỗi xoá: " + err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  // Chuyển 1 danh mục giữa nhóm Ngày ⇄ Tháng.
  const handleChangePeriod = async (cat) => {
    const to = (cat.period_type || "day") === "day" ? "month" : "day";
    const ok = await askConfirm({
      title: "Chuyển nhóm danh mục?",
      message: `Chuyển "${cat.name}" sang nhóm ${to === "month" ? "THÁNG" : "NGÀY"}?`,
      confirmText: "Chuyển",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await supabase
        .from("expense_categories")
        .update({ period_type: to })
        .eq("id", cat.id);
      if (error) throw error;
      showToast("Đã chuyển nhóm danh mục!");
      logAudit({
        entityType: "expense",
        entityId: cat.id,
        entityLabel: cat.name,
        action: "category_update",
        changes: { period_type: [cat.period_type || "day", to] },
      });
      await load();
      onDataChanged?.();
    } catch (err) {
      showToast("Lỗi chuyển nhóm: " + err.message, "error");
    } finally {
      setBusy(false);
    }
  };

  const renderSection = (periodType, title, hint, newVal, setNewVal) => {
    const list = categories.filter((c) => (c.period_type || "day") === periodType);
    const otherLabel = periodType === "day" ? "Tháng" : "Ngày";
    return (
      <div className="space-y-3">
        <div>
          <h3 className="font-bold text-sm text-gray-800">{title}</h3>
          <p className="text-xs text-gray-500">{hint}</p>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); handleAdd(periodType, newVal, () => setNewVal("")); }} className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs text-gray-500 mb-1">Tên danh mục mới</label>
            <input
              type="text"
              value={newVal}
              onChange={(e) => setNewVal(e.target.value)}
              placeholder={periodType === "day" ? "Ví dụ: tiền bốc xếp" : "Ví dụ: tiền lương"}
              className="w-full border rounded px-3 py-1.5 text-sm"
            />
          </div>
          <button type="submit" disabled={busy || !newVal.trim()} className="bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-bold py-1.5 px-4 rounded text-sm">+ Thêm</button>
        </form>
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-xs text-gray-500 uppercase border-b font-bold">
                <th className="py-2 px-3 text-left">Tên danh mục</th>
                <th className="py-2 px-3 text-right">Thao tác</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {list.map((cat) => (
                <tr key={cat.id} className="hover:bg-gray-50">
                  <td className="py-2 px-3">
                    {editingId === cat.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="border rounded px-2 py-1 text-sm w-full max-w-xs"
                        autoFocus
                      />
                    ) : (
                      <span className="text-gray-800">{cat.name}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    {editingId === cat.id ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => handleRename(cat)} className="px-2 py-1 text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded">Lưu</button>
                        <button type="button" onClick={() => setEditingId(null)} className="ml-1 px-2 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-100 rounded">Hủy</button>
                      </>
                    ) : (
                      <>
                        <button type="button" onClick={() => { setEditingId(cat.id); setEditName(cat.name); }} className="px-2 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-50 rounded">✎ Sửa</button>
                        <button type="button" disabled={busy} onClick={() => handleChangePeriod(cat)} title={`Chuyển sang nhóm ${otherLabel}`} className="ml-1 px-2 py-1 text-[11px] font-semibold text-amber-600 hover:bg-amber-50 rounded">⇄ {otherLabel}</button>
                        <button type="button" disabled={busy} onClick={() => handleDelete(cat)} className="ml-1 px-2 py-1 text-[11px] font-semibold text-red-600 hover:bg-red-50 rounded">🗑 Xoá</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {list.length === 0 && (
                <tr><td colSpan={2} className="py-6 text-center text-gray-400 text-sm">Chưa có danh mục nào.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <p className="text-xs text-gray-500">Danh mục dùng chung cho cả 2 chi nhánh. Không xoá được danh mục đang có phiếu chi. Dùng nút ⇄ để chuyển danh mục giữa nhóm Ngày và Tháng.</p>
      {loading ? (
        <p className="text-sm text-gray-400">Đang tải...</p>
      ) : (
        <>
          <section className="border rounded-xl p-4 bg-white">
            {renderSection("day", "📅 Danh mục chi theo NGÀY", "Hiện ở form nhập phiếu chi khi đang xem tab Ngày.", newDay, setNewDay)}
          </section>
          <section className="border rounded-xl p-4 bg-white">
            {renderSection("month", "🗓️ Danh mục chi theo THÁNG", "Hiện ở form nhập phiếu chi khi đang xem tab Tháng.", newMonth, setNewMonth)}
          </section>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Tab: Chi nhánh
// =============================================================================
function BranchesTab({ session, showToast, onDataChanged }) {
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState({}); // { [branchId]: bool }
  const [draft, setDraft] = useState({}); // { [branchId]: { address, hotline, address_note } }

  const load = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("branches")
      .select("id, branch_code, address, hotline, address_note")
      .order("branch_code");
    if (error) {
      showToast("Lỗi tải danh sách chi nhánh: " + error.message, "error");
    } else {
      setBranches(data || []);
      const d = {};
      (data || []).forEach((b) => {
        d[b.id] = {
          address: b.address || "",
          hotline: b.hotline || "",
          address_note: b.address_note || "",
        };
      });
      setDraft(d);
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async (branch) => {
    const cur = draft[branch.id] || {};
    const address = (cur.address || "").trim();
    const hotline = (cur.hotline || "").trim();
    const address_note = (cur.address_note || "").trim();
    if (
      address === (branch.address || "")
      && hotline === (branch.hotline || "")
      && address_note === (branch.address_note || "")
    ) {
      showToast("Không có thay đổi", "info");
      return;
    }
    setSaving({ ...saving, [branch.id]: true });
    const { error } = await supabase
      .from("branches")
      .update({ address, hotline, address_note })
      .eq("id", branch.id);
    setSaving({ ...saving, [branch.id]: false });
    if (error) {
      showToast("Lỗi cập nhật: " + error.message, "error");
    } else {
      showToast(`Đã cập nhật chi nhánh ${branch.branch_code}`, "success");
      load();
      onDataChanged?.();
    }
  };

  if (loading) {
    return <p className="text-sm text-gray-500 animate-pulse">⏳ Đang tải...</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">
        Cấu hình thông tin liên lạc của chi nhánh. <b>Mã chi nhánh</b> không sửa được (ảnh hưởng
        đến bill code).
      </p>
      <div className="space-y-3">
        {branches.map((b) => {
          const d = draft[b.id] || { address: "", hotline: "", address_note: "" };
          const changed =
            d.address !== (b.address || "")
            || d.hotline !== (b.hotline || "")
            || d.address_note !== (b.address_note || "");
          return (
            <div key={b.id} className="border rounded-lg p-4 bg-gray-50/50 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-lg font-mono font-bold text-orange-700">{b.branch_code}</span>
                <span className="text-xs text-gray-500">
                  {b.branch_code === "SG" ? "Sài Gòn" : b.branch_code === "GL" ? "Gia Lai" : ""}
                </span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                    Địa chỉ
                  </label>
                  <input
                    type="text"
                    value={d.address}
                    onChange={(e) =>
                      setDraft({ ...draft, [b.id]: { ...d, address: e.target.value } })
                    }
                    placeholder="Số nhà, đường, phường/xã..."
                    className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                    Hotline
                  </label>
                  <input
                    type="text"
                    value={d.hotline}
                    onChange={(e) =>
                      setDraft({ ...draft, [b.id]: { ...d, hotline: e.target.value } })
                    }
                    placeholder="0xxx xxx xxx"
                    className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500 font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
                  Ghi chú địa chỉ (tùy chọn — hiển thị dưới địa chỉ trong bill)
                </label>
                <input
                  type="text"
                  value={d.address_note}
                  onChange={(e) =>
                    setDraft({ ...draft, [b.id]: { ...d, address_note: e.target.value } })
                  }
                  placeholder='VD: Bên trong chung cư Trần Quang Diệu, Phường Nhiêu Lộc'
                  className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
                />
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => handleSave(b)}
                  disabled={!changed || saving[b.id]}
                  className="px-4 py-1.5 text-xs font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 rounded-md transition"
                >
                  {saving[b.id] ? "⏳ Đang lưu..." : "💾 Lưu"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// Tab: Người dùng
// =============================================================================
function UsersTab({ session, showToast, askConfirm, onDataChanged }) {
  const [profiles, setProfiles] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({
    role: "all",
    branch: "all",
    status: "active", // 'all' | 'active' | 'disabled' | 'deleted'
    search: "",
  });

  // Modals
  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState(null); // profile
  const [resettingUser, setResettingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);

  const load = async () => {
    setLoading(true);
    const [profRes, branchRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, username, full_name, role, branch_id, is_disabled, is_deleted, is_locked, locked_at, failed_login_count, disabled_at, created_at, branches(branch_code)")
        .order("created_at", { ascending: false }),
      supabase.from("branches").select("id, branch_code").order("branch_code"),
    ]);
    if (profRes.error) showToast("Lỗi tải users: " + profRes.error.message, "error");
    if (branchRes.error) showToast("Lỗi tải branches: " + branchRes.error.message, "error");
    setProfiles(profRes.data || []);
    setBranches(branchRes.data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = filter.search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (filter.role !== "all" && p.role !== filter.role) return false;
      if (filter.branch !== "all" && p.branches?.branch_code !== filter.branch) return false;
      if (filter.status === "active" && (p.is_disabled || p.is_deleted)) return false;
      if (filter.status === "disabled" && !(p.is_disabled && !p.is_deleted)) return false;
      if (filter.status === "deleted" && !p.is_deleted) return false;
      if (q) {
        const hit =
          (p.username || "").toLowerCase().includes(q) ||
          (p.full_name || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [profiles, filter]);

  const handleDisableToggle = async (p) => {
    const action = p.is_disabled ? "enable" : "disable";
    const label = p.is_disabled ? "mở khóa" : "khóa";
    const ok = await askConfirm({
      title: `Xác nhận ${label} user?`,
      message: `Bạn có chắc muốn ${label} user "${p.username}" (${p.full_name})?${
        action === "disable" ? "\n\nUser sẽ bị đăng xuất khỏi hệ thống ngay lập tức." : ""
      }`,
      confirmText: action === "disable" ? "🚫 Khóa" : "✅ Mở khóa",
    });
    if (!ok) return;
    const res = await callAdminUsers({ action, target_id: p.id });
    if (res.ok) {
      showToast(`Đã ${label} user ${p.username}`, "success");
      load();
      onDataChanged?.();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  // Mở khóa tài khoản bị khóa do đăng nhập sai nhiều lần.
  const handleUnlock = async (p) => {
    const ok = await askConfirm({
      title: "Mở khóa tài khoản?",
      message: `Mở khóa "${p.username}" (${p.full_name}) — tài khoản bị khóa do nhập sai mật khẩu ${p.failed_login_count || 0} lần. Sau khi mở, user có thể đăng nhập lại.`,
      confirmText: "🔓 Mở khóa",
    });
    if (!ok) return;
    const res = await callAdminUsers({ action: "unlock", target_id: p.id });
    if (res.ok) {
      showToast(`Đã mở khóa ${p.username}`, "success");
      load();
      onDataChanged?.();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="bg-gray-50 border rounded-lg p-3 flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Tìm kiếm
          </label>
          <input
            type="text"
            value={filter.search}
            onChange={(e) => setFilter({ ...filter, search: e.target.value })}
            placeholder="Username / họ tên..."
            className="w-full border rounded px-2 py-1.5 text-xs outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Role</label>
          <select
            value={filter.role}
            onChange={(e) => setFilter({ ...filter, role: e.target.value })}
            className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
          >
            <option value="all">Tất cả</option>
            <option value="sys_admin">Sys_admin</option>
            <option value="admin">Admin</option>
            <option value="member">Member</option>
            <option value="boss">Boss</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Chi nhánh
          </label>
          <select
            value={filter.branch}
            onChange={(e) => setFilter({ ...filter, branch: e.target.value })}
            className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
          >
            <option value="all">Tất cả</option>
            <option value="SG">SG</option>
            <option value="GL">GL</option>
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Trạng thái
          </label>
          <select
            value={filter.status}
            onChange={(e) => setFilter({ ...filter, status: e.target.value })}
            className="border rounded px-2 py-1.5 text-xs outline-none bg-white"
          >
            <option value="active">Đang hoạt động</option>
            <option value="disabled">Đã khóa</option>
            <option value="deleted">Đã xóa</option>
            <option value="all">Tất cả</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="px-3 py-1.5 text-xs font-bold text-white bg-orange-600 hover:bg-orange-700 rounded-md"
        >
          ➕ Thêm user
        </button>
        <button
          type="button"
          onClick={load}
          className="px-3 py-1.5 text-xs font-bold text-gray-700 border rounded-md hover:bg-gray-100"
        >
          🔄 Refresh
        </button>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-100">
            <tr className="text-xs text-gray-500 uppercase font-bold">
              <th className="py-2 px-3 w-10 text-center">#</th>
              <th className="py-2 px-3">Username</th>
              <th className="py-2 px-3">Họ tên</th>
              <th className="py-2 px-3">Role</th>
              <th className="py-2 px-3">Branch</th>
              <th className="py-2 px-3">Trạng thái</th>
              <th className="py-2 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-xs text-gray-400 italic">
                  ⏳ Đang tải...
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-xs text-gray-400 italic">
                  Không có user nào khớp filter
                </td>
              </tr>
            ) : (
              filtered.map((p, i) => {
                const isSelf = p.id === session.id;
                return (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="py-2 px-3 text-center text-gray-400 text-xs">{i + 1}</td>
                    <td className="py-2 px-3 font-mono text-xs font-semibold">
                      {p.username}
                      {isSelf && (
                        <span className="ml-1 text-[10px] bg-blue-100 text-blue-700 px-1 rounded">
                          BẠN
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">{p.full_name}</td>
                    <td className="py-2 px-3">
                      <span
                        className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                          p.role === "sys_admin"
                            ? "bg-purple-100 text-purple-800"
                            : p.role === "admin"
                            ? "bg-blue-100 text-blue-800"
                            : p.role === "boss"
                            ? "bg-amber-100 text-amber-800"
                            : "bg-gray-100 text-gray-800"
                        }`}
                      >
                        {p.role}
                      </span>
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">{p.branches?.branch_code || "—"}</td>
                    <td className="py-2 px-3">
                      {p.is_deleted ? (
                        <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                          🗑️ Đã xóa
                        </span>
                      ) : p.is_disabled ? (
                        <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">
                          🚫 Đã khóa
                        </span>
                      ) : p.is_locked ? (
                        <span className="text-[10px] font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded" title={`Khóa do nhập sai ${p.failed_login_count || 0} lần${p.locked_at ? " — " + new Date(p.locked_at).toLocaleString("vi-VN") : ""}`}>
                          🔒 Khóa (sai MK)
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">
                          ✅ Active
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => setEditingUser(p)}
                          disabled={p.is_deleted}
                          title="Sửa profile"
                          className="px-2 py-1 text-xs border rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          onClick={() => setResettingUser(p)}
                          disabled={p.is_deleted}
                          title="Đổi mật khẩu"
                          className="px-2 py-1 text-xs border rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          🔑
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDisableToggle(p)}
                          disabled={isSelf || p.is_deleted}
                          title={
                            isSelf
                              ? "Không thể thao tác trên chính mình"
                              : p.is_disabled
                              ? "Mở khóa"
                              : "Khóa tạm"
                          }
                          className="px-2 py-1 text-xs border rounded hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {p.is_disabled ? "✅" : "🚫"}
                        </button>
                        {p.is_locked && !p.is_deleted && (
                          <button
                            type="button"
                            onClick={() => handleUnlock(p)}
                            title="Mở khóa (bị khóa do đăng nhập sai)"
                            className="px-2 py-1 text-xs border rounded border-orange-300 text-orange-600 hover:bg-orange-50"
                          >
                            🔓
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setDeletingUser(p)}
                          disabled={isSelf || p.is_deleted}
                          title={isSelf ? "Không thể thao tác trên chính mình" : "Xóa vĩnh viễn"}
                          className="px-2 py-1 text-xs border rounded hover:bg-red-50 hover:border-red-300 text-red-600 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          🗑️
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-gray-500">
        Hiển thị <b className="text-orange-600">{filtered.length}</b> user / tổng {profiles.length}
      </p>

      {/* Modals */}
      {createOpen && (
        <CreateUserModal
          branches={branches}
          onClose={() => setCreateOpen(false)}
          onSuccess={() => {
            setCreateOpen(false);
            load();
            onDataChanged?.();
          }}
          showToast={showToast}
        />
      )}
      {editingUser && (
        <EditProfileModal
          user={editingUser}
          branches={branches}
          onClose={() => setEditingUser(null)}
          onSuccess={() => {
            setEditingUser(null);
            load();
            onDataChanged?.();
          }}
          showToast={showToast}
        />
      )}
      {resettingUser && (
        <ResetPasswordModal
          user={resettingUser}
          onClose={() => setResettingUser(null)}
          onSuccess={() => {
            setResettingUser(null);
            showToast(`Đã reset password cho ${resettingUser.username}`, "success");
          }}
          showToast={showToast}
        />
      )}
      {deletingUser && (
        <DeleteUserModal
          user={deletingUser}
          onClose={() => setDeletingUser(null)}
          onSuccess={() => {
            setDeletingUser(null);
            load();
            onDataChanged?.();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}

// =============================================================================
// Modals
// =============================================================================
function ModalShell({ title, onClose, children, size = "md" }) {
  const width = size === "sm" ? "max-w-sm" : size === "lg" ? "max-w-2xl" : "max-w-md";
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-xl shadow-2xl w-full ${width} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between px-5 py-3 border-b bg-gray-50 rounded-t-xl">
          <h3 className="font-bold text-sm text-gray-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function CreateUserModal({ branches, onClose, onSuccess, showToast }) {
  const [form, setForm] = useState({
    username: "",
    full_name: "",
    role: "member",
    branch_code: "SG",
    password: "",
    password_confirm: "",
  });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username)) {
      showToast("Username chỉ được có chữ thường, số, _.-", "error");
      return;
    }
    if (!form.full_name.trim()) {
      showToast("Họ tên không được rỗng", "error");
      return;
    }
    if (form.password.length < 8) {
      showToast("Password phải >= 8 ký tự", "error");
      return;
    }
    if (form.password !== form.password_confirm) {
      showToast("Password confirm không khớp", "error");
      return;
    }
    setSubmitting(true);
    const res = await callAdminUsers({
      action: "create",
      username,
      full_name: form.full_name.trim(),
      role: form.role,
      branch_code: form.branch_code,
      password: form.password,
    });
    setSubmitting(false);
    if (res.ok) {
      showToast(`Đã tạo user ${username}`, "success");
      onSuccess();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <ModalShell title="➕ Thêm user mới" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Username *
          </label>
          <input
            type="text"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            placeholder="VD: linh, hoa.nguyen"
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500 font-mono lowercase"
          />
          <p className="text-[10px] text-gray-500 mt-1">
            Chỉ chữ thường, số, và ký tự _.-. Sẽ dùng làm email <b>{form.username || "..."}@hoancau.internal</b>.
          </p>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Họ tên đầy đủ *
          </label>
          <input
            type="text"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Role *</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm outline-none bg-white"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="boss">Boss</option>
              <option value="sys_admin">Sys_admin</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
              Chi nhánh *
            </label>
            <select
              value={form.branch_code}
              onChange={(e) => setForm({ ...form, branch_code: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm outline-none bg-white"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.branch_code}>
                  {b.branch_code}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Mật khẩu ban đầu * (≥ 8 ký tự)
          </label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
            minLength={8}
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập lại mật khẩu *
          </label>
          <input
            type="password"
            value={form.password_confirm}
            onChange={(e) => setForm({ ...form, password_confirm: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        {form.role === "sys_admin" && (
          <div className="bg-purple-50 border border-purple-200 rounded p-2 text-[11px] text-purple-800">
            ⚠️ Sys_admin cần thêm bước setup PIN sau khi tạo. Vào "Tài khoản của tôi → Đổi PIN" hoặc dùng CLI script cho bootstrap.
          </div>
        )}
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border rounded hover:bg-gray-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 rounded"
          >
            {submitting ? "⏳ Đang tạo..." : "➕ Tạo user"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditProfileModal({ user, branches, onClose, onSuccess, showToast }) {
  const [form, setForm] = useState({
    username: user.username || "",
    full_name: user.full_name || "",
    role: user.role,
    branch_code: user.branches?.branch_code || "SG",
  });
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(username)) {
      showToast("Username chỉ được có chữ thường, số, _.-", "error");
      return;
    }
    setSubmitting(true);
    const res = await callAdminUsers({
      action: "update_profile",
      target_id: user.id,
      username,
      full_name: form.full_name.trim(),
      role: form.role,
      branch_code: form.branch_code,
    });
    setSubmitting(false);
    if (res.ok) {
      showToast(`Đã cập nhật user ${user.username}`, "success");
      onSuccess();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <ModalShell title={`✏️ Sửa: ${user.username}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Username *</label>
          <input
            type="text"
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500 font-mono lowercase"
          />
          <p className="text-[10px] text-gray-500 mt-1">
            Đổi username sẽ đổi luôn email đăng nhập <b>{(form.username || "...").trim().toLowerCase()}@hoancau.internal</b>. Mật khẩu giữ nguyên.
          </p>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Họ tên *</label>
          <input
            type="text"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Role</label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm outline-none bg-white"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="boss">Boss</option>
              <option value="sys_admin">Sys_admin</option>
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Chi nhánh</label>
            <select
              value={form.branch_code}
              onChange={(e) => setForm({ ...form, branch_code: e.target.value })}
              className="w-full border rounded px-3 py-2 text-sm outline-none bg-white"
            >
              {branches.map((b) => (
                <option key={b.id} value={b.branch_code}>
                  {b.branch_code}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border rounded hover:bg-gray-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 rounded"
          >
            {submitting ? "⏳ Đang lưu..." : "💾 Lưu"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ResetPasswordModal({ user, onClose, onSuccess, showToast }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (password.length < 8) {
      showToast("Password >= 8 ký tự", "error");
      return;
    }
    if (password !== confirm) {
      showToast("Password confirm không khớp", "error");
      return;
    }
    setSubmitting(true);
    const res = await callAdminUsers({
      action: "reset_password",
      target_id: user.id,
      new_password: password,
    });
    setSubmitting(false);
    if (res.ok) {
      onSuccess();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <ModalShell title={`🔑 Đổi mật khẩu: ${user.username}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-amber-800">
          ⚠️ Password mới sẽ ghi đè password cũ. User có thể login ngay bằng password mới.
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Mật khẩu mới * (≥ 8 ký tự)
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập lại *
          </label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-orange-500"
          />
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border rounded hover:bg-gray-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 text-sm font-bold text-white bg-orange-600 hover:bg-orange-700 disabled:bg-gray-300 rounded"
          >
            {submitting ? "⏳ Đang lưu..." : "🔑 Đổi mật khẩu"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function DeleteUserModal({ user, onClose, onSuccess, showToast }) {
  const [typedName, setTypedName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = typedName === user.username;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    const res = await callAdminUsers({ action: "delete", target_id: user.id });
    setSubmitting(false);
    if (res.ok) {
      showToast(`Đã xóa user ${user.username}`, "success");
      onSuccess();
    } else {
      showToast("Lỗi: " + (res.error || "unknown"), "error");
    }
  };

  return (
    <ModalShell title={`🗑️ Xóa user: ${user.username}`} onClose={onClose} size="md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="bg-red-50 border border-red-200 rounded p-3 text-xs text-red-800 space-y-1">
          <p>
            <b>⚠️ Cảnh báo:</b> User sẽ bị xóa vĩnh viễn khỏi hệ thống.
          </p>
          <ul className="list-disc pl-5">
            <li>Không đăng nhập được nữa.</li>
            <li>Không hiện trong list quản lý.</li>
            <li>Không thể enable lại từ UI (phải mở DB thủ công).</li>
            <li>Bill/expense do user này tạo vẫn giữ trong hệ thống.</li>
          </ul>
        </div>
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">
            Nhập chính xác <b className="font-mono text-red-700">{user.username}</b> để xác nhận
          </label>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-red-500 font-mono"
          />
        </div>
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-gray-700 border rounded hover:bg-gray-50"
          >
            Hủy
          </button>
          <button
            type="submit"
            disabled={!canSubmit || submitting}
            className="px-4 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 disabled:bg-gray-300 rounded"
          >
            {submitting ? "⏳ Đang xóa..." : "🗑️ Xóa vĩnh viễn"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// =============================================================================
// LoginLogTab — Nhật ký đăng nhập/đăng xuất (chỉ sys_admin đọc được qua RLS)
// =============================================================================
const LOGIN_REASON_LABEL = {
  password: "🔑 Đăng nhập",
  logout_button: "🚪 Đăng xuất",
  idle_timeout: "⏱️ Hết phiên (2h không hoạt động)",
  forced: "⛔ Bị buộc đăng xuất",
  tab_close: "✖️ Đóng tab",
};

function vnTodayISODate() {
  const now = new Date();
  const vn = new Date(now.getTime() + (now.getTimezoneOffset() + 420) * 60000);
  return vn.toISOString().slice(0, 10);
}

function fmtTimeVN(ts) {
  try {
    return new Date(ts).toLocaleTimeString("vi-VN", {
      hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
    });
  } catch { return ""; }
}

function LoginLogTab({ showToast }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [date, setDate] = useState(vnTodayISODate());
  const [userQ, setUserQ] = useState("");

  const load = async () => {
    setLoading(true);
    // Khoảng 1 ngày theo giờ VN: [date 00:00 +07, date hôm sau 00:00 +07)
    const start = new Date(`${date}T00:00:00+07:00`).toISOString();
    const end = new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from("login_events")
      .select("id, user_id, username, full_name, user_role, branch_code, event_type, reason, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });
    if (error) showToast("Lỗi tải nhật ký: " + error.message, "error");
    setEvents(data || []);
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const groups = useMemo(() => {
    const q = userQ.trim().toLowerCase();
    const byUser = new Map();
    for (const e of events) {
      if (q && !((e.username || "").toLowerCase().includes(q) || (e.full_name || "").toLowerCase().includes(q))) continue;
      const key = e.user_id || e.username || "?";
      if (!byUser.has(key)) {
        byUser.set(key, { username: e.username, full_name: e.full_name, role: e.user_role, branch: e.branch_code, events: [], logins: 0, logouts: 0 });
      }
      const g = byUser.get(key);
      g.events.push(e);
      if (e.event_type === "login") g.logins++;
      else g.logouts++;
    }
    return [...byUser.values()].sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
  }, [events, userQ]);

  const shiftDay = (delta) => {
    const d = new Date(`${date}T00:00:00+07:00`);
    d.setDate(d.getDate() + delta);
    setDate(d.toISOString().slice(0, 10));
  };

  return (
    <div className="space-y-4">
      {/* Bộ lọc */}
      <div className="bg-gray-50 border rounded-lg p-3 flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Ngày</label>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => shiftDay(-1)} className="px-2 py-1.5 text-sm border rounded hover:bg-gray-100">‹</button>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded px-2 py-1.5 text-sm" />
            <button type="button" onClick={() => shiftDay(1)} className="px-2 py-1.5 text-sm border rounded hover:bg-gray-100">›</button>
            <button type="button" onClick={() => setDate(vnTodayISODate())} className="px-2.5 py-1.5 text-xs font-bold border rounded bg-white hover:bg-orange-50">Hôm nay</button>
          </div>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="block text-[10px] font-bold text-gray-500 uppercase mb-1">Tìm nhân viên</label>
          <input type="text" value={userQ} onChange={(e) => setUserQ(e.target.value)} placeholder="Username / họ tên..." className="w-full border rounded px-3 py-1.5 text-sm outline-none focus:border-orange-500" />
        </div>
        <button type="button" onClick={load} className="px-3 py-1.5 text-xs font-bold border rounded bg-white hover:bg-gray-100">🔄 Tải lại</button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 italic py-6 text-center">⏳ Đang tải...</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-gray-400 italic py-6 text-center">Không có hoạt động đăng nhập nào trong ngày này.</p>
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <div key={(g.username || "?") + g.full_name} className="border rounded-lg overflow-hidden">
              <div className="bg-gray-50 px-4 py-2 flex flex-wrap items-center gap-2 border-b">
                <span className="font-bold text-gray-800">{g.full_name || g.username}</span>
                <span className="font-mono text-xs text-gray-500">@{g.username}</span>
                {g.role && <span className="text-[10px] font-bold bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">{g.role}</span>}
                {g.branch && <span className="text-[10px] font-bold bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded">{g.branch}</span>}
                <span className="ml-auto text-xs font-semibold text-emerald-700">Đăng nhập: {g.logins} lần</span>
                <span className="text-xs font-semibold text-gray-500">· Đăng xuất: {g.logouts}</span>
              </div>
              <ul className="divide-y">
                {g.events.map((e) => (
                  <li key={e.id} className="px-4 py-2 flex items-center gap-3 text-sm">
                    <span className="font-mono text-gray-800 w-20">{fmtTimeVN(e.created_at)}</span>
                    <span className={e.event_type === "login" ? "text-emerald-700 font-semibold" : "text-gray-600"}>
                      {LOGIN_REASON_LABEL[e.reason] || (e.event_type === "login" ? "🔑 Đăng nhập" : "🚪 Đăng xuất")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-[11px] text-gray-400 italic">
        Ghi chú: đăng xuất chỉ ghi khi bấm nút Đăng xuất hoặc hết phiên 2h. Đóng tab trực tiếp không ghi được (giới hạn chung của trình duyệt).
      </p>
    </div>
  );
}
