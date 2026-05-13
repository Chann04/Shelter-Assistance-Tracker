/* ==========================================================================
   Shelter Assistance Tracker — app.js
   Expanded app logic: Auth + Clients + Supplies + Requests + Reporting
   ========================================================================== */

/* -------------------------------------------------------------------------- */
/*  1. CONFIG                                                                  */
/* -------------------------------------------------------------------------- */
const SUPABASE_URL = "https://ruicqbkrqgvhdkcsmsej.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_yaxaLWQSy4sE8oj-5fBVnQ_CumPEVhE";

const TABLES = {
  users: "shelter_users",
  clients: "clients",
  supplies: "supplies",
  requests: "assistance_requests",
  distributions: "distributions",
};

const RPC = {
  dashboardSummary: "rpc_dashboard_summary",
  masterReport: "rpc_master_report",
  monthlyTrend: "rpc_monthly_assistance_trend",
  clientsAboveAverage: "rpc_clients_above_avg_requests",
};

/* -------------------------------------------------------------------------- */
/*  2. STATE                                                                   */
/* -------------------------------------------------------------------------- */
const state = {
  supabase: null,
  isConfigured: false,
  user: null,
  profile: null,
  requests: [],
  clients: [],
  supplies: [],
  reportRows: [],
  rpcWarnings: {},
  filters: {
    search: "",
    category: "",
    status: "",
  },
};

/* -------------------------------------------------------------------------- */
/*  3. DOM                                                                      */
/* -------------------------------------------------------------------------- */
const els = {
  // Existing UI
  form: document.getElementById("intake-form"),
  formMessage: document.getElementById("form-message"),
  submitBtn: document.getElementById("submit-btn"),
  inputName: document.getElementById("client-name"),
  inputIdPhone: document.getElementById("client-id"),
  inputCategory: document.getElementById("category"),
  search: document.getElementById("search"),
  tbody: document.getElementById("requests-tbody"),
  emptyState: document.getElementById("empty-state"),
  loadingState: document.getElementById("loading-state"),
  statTotal: document.getElementById("stat-total"),
  statApproved: document.getElementById("stat-approved"),
  statPending: document.getElementById("stat-pending"),
  statCancelled: document.getElementById("stat-cancelled"),
  statCards: Array.from(document.querySelectorAll("[data-stat-filter]")),
  connectionDot: document.getElementById("connection-dot"),
  connectionText: document.getElementById("connection-text"),
  toastContainer: document.getElementById("toast-container"),
  welcomeUser: document.getElementById("welcome-user"),
  welcomeDate: document.getElementById("welcome-date"),

  // Optional extended UI hooks
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginPassword: document.getElementById("login-password"),
  logoutBtn: document.getElementById("logout-btn"),
  authStatus: document.getElementById("auth-status"),

  requestCategoryFilter: document.getElementById("filter-category"),
  requestStatusFilter: document.getElementById("filter-status"),

  clientForm: document.getElementById("client-form"),
  supplyForm: document.getElementById("supply-form"),

  reportTableBody: document.getElementById("report-tbody"),
  reportRefreshBtn: document.getElementById("report-refresh-btn"),
  trendContainer: document.getElementById("trend-container"),
  clientsTableBody: document.getElementById("clients-tbody"),
  suppliesTableBody: document.getElementById("supplies-tbody"),
};

/* -------------------------------------------------------------------------- */
/*  4. UTILITIES                                                               */
/* -------------------------------------------------------------------------- */
function escapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

function splitFullName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "Unknown" };
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1],
  };
}

function showToast(message, kind = "info", durationMs = 3000) {
  if (!els.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <span class="inline-flex items-center justify-center w-5 h-5 rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
      ${kind === "success" ? "✓" : kind === "error" ? "!" : "i"}
    </span>
    <span>${escapeHtml(message)}</span>
  `;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 220);
  }, durationMs);
}

function setConnectionStatus(kind, text) {
  if (!els.connectionDot || !els.connectionText) return;
  const cls = {
    connected: "bg-emerald-500 animate-pulse",
    connecting: "bg-amber-400 animate-pulse",
    error: "bg-red-500",
    offline: "bg-slate-300",
  };
  els.connectionDot.className =
    "w-2.5 h-2.5 rounded-full " + (cls[kind] || "bg-slate-300");
  els.connectionText.textContent = text;
}

function setFormMessage(msg, kind = "info") {
  if (!els.formMessage) return;
  if (!msg) {
    els.formMessage.classList.add("hidden");
    els.formMessage.textContent = "";
    return;
  }
  const color =
    kind === "error"
      ? "text-red-600"
      : kind === "success"
      ? "text-emerald-600"
      : "text-slate-600";
  els.formMessage.className = `text-sm ${color}`;
  els.formMessage.textContent = msg;
  els.formMessage.classList.remove("hidden");
}

function requireSupabase() {
  if (!state.supabase) throw new Error("Supabase client is not ready.");
  return state.supabase;
}

function isMissingRpcError(error) {
  const msg = String(error?.message || "");
  return error?.code === "PGRST202" || msg.toLowerCase().includes("could not find the function");
}

function warnMissingRpcOnce(name) {
  if (state.rpcWarnings[name]) return;
  state.rpcWarnings[name] = true;
  showToast(`RPC missing: ${name}. Run SQL setup script.`, "info", 4500);
}

/* -------------------------------------------------------------------------- */
/*  5. SUPABASE + AUTH                                                         */
/* -------------------------------------------------------------------------- */
function clearStaleSupabaseSession() {
  try {
    const host = new URL(SUPABASE_URL).hostname;
    const projectRef = host.split(".")[0];
    if (!projectRef) return;
    localStorage.removeItem(`sb-${projectRef}-auth-token`);
    localStorage.removeItem(`sb-${projectRef}-auth-token-code-verifier`);
  } catch {
    // No-op
  }
}

function initSupabase() {
  const placeholder =
    !SUPABASE_URL ||
    !SUPABASE_ANON_KEY ||
    SUPABASE_URL === "YOUR_SUPABASE_URL" ||
    SUPABASE_ANON_KEY === "YOUR_SUPABASE_ANON_KEY";
  if (placeholder) {
    state.isConfigured = false;
    setConnectionStatus("offline", "Supabase config missing");
    return null;
  }
  if (typeof window.supabaseCreateClient !== "function") {
    setConnectionStatus("error", "Supabase library not loaded");
    return null;
  }

  const client = window.supabaseCreateClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  state.supabase = client;
  state.isConfigured = true;
  return client;
}

async function ensureSession() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  state.user = data.session?.user || null;
  return state.user;
}

async function loginWithPassword(email, password) {
  const supabase = requireSupabase();
  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw error;
  state.user = data.user || null;
  return data;
}

async function logout() {
  const supabase = requireSupabase();
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  state.user = null;
}

async function loadCurrentUserProfile() {
  if (!state.user) {
    state.profile = null;
    return null;
  }
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.users)
    .select("*")
    .eq("id", state.user.id)
    .maybeSingle();
  if (error) throw error;
  state.profile = data || null;
  return state.profile;
}

/* -------------------------------------------------------------------------- */
/*  6. DATA ACCESS                                                             */
/* -------------------------------------------------------------------------- */
async function listClients() {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.clients)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;
  state.clients = data || [];
  return state.clients;
}

async function createClient(payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.clients)
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateClient(id, payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.clients)
    .update(payload)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteClient(id) {
  const supabase = requireSupabase();
  const { error } = await supabase.from(TABLES.clients).delete().eq("id", id);
  if (error) throw error;
}

async function findOrCreateClientFromIntake(name, idOrPhone) {
  const supabase = requireSupabase();
  const { data: existing, error: existingErr } = await supabase
    .from(TABLES.clients)
    .select("*")
    .eq("contact_number", idOrPhone)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) return existing;

  const split = splitFullName(name);
  const payload = {
    first_name: split.firstName,
    last_name: split.lastName,
    contact_number: idOrPhone,
  };
  return createClient(payload);
}

async function listSupplies() {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.supplies)
    .select("*")
    .order("name", { ascending: true });
  if (error) throw error;
  state.supplies = data || [];
  return state.supplies;
}

async function createSupply(payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.supplies)
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateSupply(id, payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.supplies)
    .update(payload)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteSupply(id) {
  const supabase = requireSupabase();
  const { error } = await supabase.from(TABLES.supplies).delete().eq("id", id);
  if (error) throw error;
}

function buildRequestsQuery() {
  const supabase = requireSupabase();
  let q = supabase.from(TABLES.requests).select(
    `
      id,
      client_id,
      category,
      status,
      priority,
      request_notes,
      created_at,
      updated_at
    `
  );
  if (state.filters.category) q = q.eq("category", state.filters.category);
  return q.order("created_at", { ascending: false });
}

async function listRequests() {
  const { data, error } = await buildRequestsQuery();
  if (error) throw error;
  state.requests = data || [];
  return state.requests;
}

async function createRequest(payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.requests)
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function updateRequestStatus(requestId, status) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.requests)
    .update({ status })
    .eq("id", requestId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteRequest(requestId) {
  const supabase = requireSupabase();
  const { error } = await supabase
    .from(TABLES.requests)
    .delete()
    .eq("id", requestId);
  if (error) throw error;
}

async function createDistribution(payload) {
  const supabase = requireSupabase();
  const { data, error } = await supabase
    .from(TABLES.distributions)
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

/* -------------------------------------------------------------------------- */
/*  7. RPC REPORTING                                                           */
/* -------------------------------------------------------------------------- */
async function loadDashboardSummary() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc(RPC.dashboardSummary);
  if (error) {
    if (isMissingRpcError(error)) {
      warnMissingRpcOnce(RPC.dashboardSummary);
      return {
        total_clients: state.clients.length,
        active_requests: state.requests.filter((r) => ["Pending", "Approved"].includes(r.status)).length,
        supplies_units_distributed: 0,
        current_inventory_units: state.supplies.reduce(
          (sum, s) => sum + Number(s.quantity_in_stock || 0),
          0
        ),
      };
    }
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : null;
  return (
    row || {
      total_clients: 0,
      active_requests: 0,
      supplies_units_distributed: 0,
      current_inventory_units: 0,
    }
  );
}

async function loadMasterReport() {
  const supabase = requireSupabase();
  const params = {
    p_category: state.filters.category || null,
    p_status: state.filters.status || null,
  };
  const { data, error } = await supabase.rpc(RPC.masterReport, params);
  if (error) {
    if (isMissingRpcError(error)) {
      warnMissingRpcOnce(RPC.masterReport);
      state.reportRows = [];
      return state.reportRows;
    }
    throw error;
  }
  state.reportRows = data || [];
  return state.reportRows;
}

async function loadMonthlyTrend(months = 6) {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc(RPC.monthlyTrend, {
    p_months: months,
  });
  if (error) {
    if (isMissingRpcError(error)) {
      warnMissingRpcOnce(RPC.monthlyTrend);
      return [];
    }
    throw error;
  }
  return data || [];
}

async function loadClientsAboveAverage() {
  const supabase = requireSupabase();
  const { data, error } = await supabase.rpc(RPC.clientsAboveAverage);
  if (error) {
    if (isMissingRpcError(error)) {
      warnMissingRpcOnce(RPC.clientsAboveAverage);
      return [];
    }
    throw error;
  }
  return data || [];
}

/* -------------------------------------------------------------------------- */
/*  8. RENDER                                                                   */
/* -------------------------------------------------------------------------- */
function requestClientName(req) {
  const clientId = req?.client_id;
  if (!clientId) return "Unknown Client";
  const c = state.clients.find((client) => client.id === clientId);
  if (!c) return "Unknown Client";
  return `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown Client";
}

function requestClientContact(req) {
  const clientId = req?.client_id;
  if (!clientId) return "—";
  const c = state.clients.find((client) => client.id === clientId);
  return c?.contact_number || "—";
}

function statusPill(status) {
  const cls =
    status === "Fulfilled"
      ? "status-fulfilled"
      : status === "Approved"
      ? "status-approved"
      : status === "Cancelled"
      ? "status-cancelled"
      : "status-pending";
  return `<span class="status-pill ${cls}">${escapeHtml(status || "Pending")}</span>`;
}

function statusSelect(id, current) {
  const options = ["Pending", "Approved", "Fulfilled", "Cancelled"]
    .map(
      (s) =>
        `<option value="${s}" ${s === current ? "selected" : ""}>${s}</option>`
    )
    .join("");
  return `
    <label class="sr-only" for="status-${id}">Update status</label>
    <select
      id="status-${id}"
      data-action="update-status"
      data-id="${escapeHtml(id)}"
      class="status-select rounded-md border border-slate-300 bg-white py-1 pl-2 text-xs text-slate-700 shadow-sm focus:border-brand-500 focus:ring-2 focus:ring-brand-200 focus:outline-none"
    >
      ${options}
    </select>
  `;
}

function deleteButton(id) {
  return `
    <button
      type="button"
      data-action="delete"
      data-id="${escapeHtml(id)}"
      class="inline-flex items-center justify-center rounded-md p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-200"
      title="Delete request"
      aria-label="Delete request"
    >
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4">
        <path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
      </svg>
    </button>
  `;
}

function quickStatusButtons(id, current) {
  const mk = (status, label, color) => `
    <button
      type="button"
      data-action="quick-status"
      data-id="${escapeHtml(id)}"
      data-status="${status}"
      class="rounded-md px-2 py-1 text-xs font-medium ${color} ${current === status ? "ring-2 ring-offset-1 ring-brand-300" : ""}"
    >${label}</button>
  `;
  return `
    <div class="inline-flex items-center gap-1">
      ${mk("Approved", "Approve", "bg-emerald-50 text-emerald-700 hover:bg-emerald-100")}
      ${mk("Fulfilled", "Fulfill", "bg-brand-50 text-brand-700 hover:bg-brand-100")}
    </div>
  `;
}

function categoryDisplay(category) {
  const icon =
    category === "Housing"
      ? "🏠"
      : category === "Food"
      ? "🍎"
      : category === "Medical"
      ? "💊"
      : "📦";
  return `${icon} ${category || "Uncategorized"}`;
}

function getFilteredRequests() {
  const q = state.filters.search.trim().toLowerCase();
  return state.requests.filter((r) => {
    if (state.filters.status && r.status !== state.filters.status) return false;
    const name = requestClientName(r).toLowerCase();
    const phone = requestClientContact(r).toLowerCase();
    if (!q) return true;
    return (
      name.includes(q) ||
      phone.includes(q) ||
      String(r.category || "")
        .toLowerCase()
        .includes(q) ||
      String(r.status || "")
        .toLowerCase()
        .includes(q)
    );
  });
}

function renderTable() {
  if (!els.tbody || !els.emptyState || !els.loadingState) return;
  const rows = getFilteredRequests();
  els.loadingState.classList.add("hidden");

  if (rows.length === 0) {
    els.tbody.innerHTML = "";
    els.emptyState.textContent = "No matching requests found.";
    els.emptyState.classList.remove("hidden");
    return;
  }

  els.emptyState.classList.add("hidden");
  els.tbody.innerHTML = rows
    .map((req) => {
      return `
      <tr data-id="${escapeHtml(req.id)}">
        <td class="px-3 py-3 font-medium text-slate-900">${escapeHtml(requestClientName(req))}</td>
        <td class="px-3 py-3 text-slate-600">${escapeHtml(requestClientContact(req))}</td>
        <td class="px-3 py-3"><span class="category-badge">${escapeHtml(categoryDisplay(req.category))}</span></td>
        <td class="px-3 py-3"><div class="flex items-center gap-2">${statusPill(req.status)}</div></td>
        <td class="px-3 py-3 text-slate-500 hidden md:table-cell">${escapeHtml(formatDate(req.created_at))}</td>
        <td class="px-3 py-3">
          <div class="flex items-center justify-end gap-2">
            ${quickStatusButtons(req.id, req.status)}
            ${statusSelect(req.id, req.status)}
            ${deleteButton(req.id)}
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderSummaryCards(summary) {
  const total = state.requests.length || Number(summary.total_clients || 0);
  const approved = state.requests.filter((r) => r.status === "Approved").length;
  const pending = state.requests.filter((r) => r.status === "Pending").length;
  if (els.statTotal) els.statTotal.textContent = String(total);
  if (els.statApproved) els.statApproved.textContent = String(approved);
  if (els.statPending) els.statPending.textContent = String(pending);
  if (els.statCancelled) {
    const cancelled = state.requests.filter((r) => r.status === "Cancelled").length;
    els.statCancelled.textContent = String(cancelled);
  }
  renderStatCardActiveState();
}

function renderStatCardActiveState() {
  if (!els.statCards?.length) return;
  for (const card of els.statCards) {
    const cardStatus = card.dataset.statFilter || "all";
    const isAll = !state.filters.status && cardStatus === "all";
    const isActive = isAll || state.filters.status === cardStatus;
    card.classList.toggle("ring-2", isActive);
    card.classList.toggle("ring-brand-300", isActive);
    card.classList.toggle("bg-brand-50", isActive);
  }
}

function renderReportTable(rows) {
  if (!els.reportTableBody) return;
  if (!rows.length) {
    els.reportTableBody.innerHTML =
      '<tr><td colspan="7" class="px-3 py-3 text-slate-500">No report rows.</td></tr>';
    return;
  }
  els.reportTableBody.innerHTML = rows
    .map((r) => {
      return `
      <tr>
        <td class="px-3 py-2">${escapeHtml(formatDate(r.request_created_at))}</td>
        <td class="px-3 py-2">${escapeHtml(r.client_name || "—")}</td>
        <td class="px-3 py-2">${escapeHtml(r.request_category || "—")}</td>
        <td class="px-3 py-2">${escapeHtml(r.request_status || "—")}</td>
        <td class="px-3 py-2">${escapeHtml(r.supply_name || "—")}</td>
        <td class="px-3 py-2 text-right">${escapeHtml(r.quantity_distributed ?? "—")}</td>
      </tr>
    `;
    })
    .join("");
}

function renderTrend(trendRows) {
  if (!els.trendContainer) return;
  if (!trendRows.length) {
    els.trendContainer.textContent = "No monthly trend data yet.";
    return;
  }
  els.trendContainer.innerHTML = trendRows
    .map((r) => {
      return `<div class="text-xs text-slate-600">${escapeHtml(
        r.month_start
      )}: requests=${escapeHtml(r.requests_count)}, fulfilled=${escapeHtml(
        r.fulfilled_count
      )}, units=${escapeHtml(r.distributed_units)}</div>`;
    })
    .join("");
}

function clientActions(id) {
  return `
    <div class="inline-flex items-center gap-1">
      <button type="button" data-action="edit-client" data-id="${escapeHtml(id)}" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">Edit</button>
      <button type="button" data-action="delete-client" data-id="${escapeHtml(id)}" class="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">Delete</button>
    </div>
  `;
}

function supplyActions(id) {
  return `
    <div class="inline-flex items-center gap-1">
      <button type="button" data-action="edit-supply" data-id="${escapeHtml(id)}" class="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50">Edit</button>
      <button type="button" data-action="delete-supply" data-id="${escapeHtml(id)}" class="rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-xs text-rose-700 hover:bg-rose-100">Delete</button>
    </div>
  `;
}

function renderClientsTable() {
  if (!els.clientsTableBody) return;
  if (!state.clients.length) {
    els.clientsTableBody.innerHTML =
      '<tr><td colspan="4" class="px-3 py-3 text-slate-500">No clients yet.</td></tr>';
    return;
  }
  els.clientsTableBody.innerHTML = state.clients
    .map((c) => {
      const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Unknown";
      return `
      <tr>
        <td class="px-3 py-2">${escapeHtml(name)}</td>
        <td class="px-3 py-2">${escapeHtml(c.contact_number || "—")}</td>
        <td class="px-3 py-2">${escapeHtml(c.id_number || "—")}</td>
        <td class="px-3 py-2 text-right">${clientActions(c.id)}</td>
      </tr>
    `;
    })
    .join("");
}

function renderSuppliesTable() {
  if (!els.suppliesTableBody) return;
  if (!state.supplies.length) {
    els.suppliesTableBody.innerHTML =
      '<tr><td colspan="4" class="px-3 py-3 text-slate-500">No supplies yet.</td></tr>';
    return;
  }
  els.suppliesTableBody.innerHTML = state.supplies
    .map((s) => {
      return `
      <tr>
        <td class="px-3 py-2">${escapeHtml(s.name || "Unknown")}</td>
        <td class="px-3 py-2">${escapeHtml(s.category || "Other")}</td>
        <td class="px-3 py-2">${escapeHtml(String(s.quantity_in_stock ?? 0))} ${escapeHtml(s.unit || "pcs")}</td>
        <td class="px-3 py-2 text-right">${supplyActions(s.id)}</td>
      </tr>
    `;
    })
    .join("");
}

function renderAuthState() {
  if (!els.authStatus) return;
  if (!state.user) {
    els.authStatus.textContent = "Not signed in";
    if (els.welcomeUser) els.welcomeUser.textContent = "Welcome back";
    if (els.welcomeDate) {
      els.welcomeDate.textContent = new Date().toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
    }
    return;
  }
  const label =
    state.profile?.full_name ||
    state.user.email ||
    "Signed in user";
  els.authStatus.textContent = `Signed in: ${label}`;
  if (els.welcomeUser) {
    const name = state.profile?.full_name || state.user.email?.split("@")[0] || "Responder";
    els.welcomeUser.textContent = `Welcome back, ${name}`;
  }
  if (els.welcomeDate) {
    els.welcomeDate.textContent = new Date().toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  9. EVENT HANDLERS                                                          */
/* -------------------------------------------------------------------------- */
async function handleLoginSubmit(e) {
  e.preventDefault();
  if (!els.loginEmail || !els.loginPassword) return;
  const submitBtn = e.target?.querySelector("button[type='submit']");
  try {
    if (els.authStatus) {
      els.authStatus.textContent = "Signing in...";
    }
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add("opacity-70");
    }
    await loginWithPassword(els.loginEmail.value.trim(), els.loginPassword.value);
    await afterAuthReady();
    showToast("Logged in successfully.", "success");
    if (window.location.pathname.toLowerCase().endsWith("/login.html")) {
      window.location.href = "index.html";
    }
  } catch (err) {
    console.error(err);
    if (els.authStatus) {
      els.authStatus.textContent = `Login failed: ${err.message || "Please check credentials."}`;
    }
    showToast(err.message || "Login failed.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove("opacity-70");
    }
  }
}

async function handleLogoutClick(e) {
  if (e?.preventDefault) e.preventDefault();
  try {
    // Fire the network request but don't await it to prevent hanging
    logout().catch(err => console.error("Background logout error:", err));
    
    // Explicitly clear local storage for supabase to force client-side logout
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('sb-') && key.endsWith('-auth-token')) {
        localStorage.removeItem(key);
      }
    });

    state.requests = [];
    state.user = null;
    state.profile = null;
    
  } catch (err) {
    console.error("Logout error:", err);
  } finally {
    // Immediately redirect to login
    window.location.href = "login.html";
  }
}

async function handleIntakeSubmit(e) {
  e.preventDefault();
  setFormMessage("");
  if (!state.user) {
    try {
      await ensureSession();
    } catch (sessionErr) {
      console.error(sessionErr);
    }
  }
  if (!state.user) {
    setFormMessage("Please login first.", "error");
    showToast("Session not found. Please log in again.", "error");
    return;
  }

  const fullName = els.inputName?.value?.trim() || "";
  const idOrPhone = els.inputIdPhone?.value?.trim() || "";
  const category = els.inputCategory?.value || "";
  const status = "Pending";

  if (!fullName || !idOrPhone || !category) {
    setFormMessage("Please fill in all required fields.", "error");
    return;
  }

  if (els.submitBtn) {
    els.submitBtn.disabled = true;
    els.submitBtn.classList.add("opacity-70");
  }

  try {
    const client = await findOrCreateClientFromIntake(fullName, idOrPhone);
    await createRequest({
      // Keep compatibility with legacy table shape (name/id_or_phone required).
      name: fullName,
      id_or_phone: idOrPhone,
      client_id: client.id,
      requested_by: state.user.id,
      category,
      status,
      priority: "Normal",
      request_notes: null,
    });
    await refreshMainData();

    if (els.form) els.form.reset();
    setFormMessage("Request added successfully.", "success");
    showToast("Request added.", "success");
  } catch (err) {
    console.error(err);
    setFormMessage(err.message || "Failed to create request.", "error");
    showToast("Failed to save request.", "error");
  } finally {
    if (els.submitBtn) {
      els.submitBtn.disabled = false;
      els.submitBtn.classList.remove("opacity-70");
    }
  }
}

async function handleTableChange(e) {
  const target = e.target;
  if (!target?.dataset) return;
  if (target.dataset.action !== "update-status") return;
  const requestId = target.dataset.id;
  if (!requestId) return;
  try {
    await updateRequestStatus(requestId, target.value);
    await refreshMainData();
    showToast("Request status updated.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Status update failed.", "error");
  }
}

async function handleTableClick(e) {
  const quick = e.target.closest("[data-action='quick-status']");
  if (quick) {
    const requestId = quick.dataset.id;
    const status = quick.dataset.status;
    if (!requestId || !status) return;
    try {
      await updateRequestStatus(requestId, status);
      await refreshMainData();
      showToast(`Request marked ${status}.`, "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Quick update failed.", "error");
    }
    return;
  }

  const btn = e.target.closest("[data-action='delete']");
  if (!btn) return;
  const requestId = btn.dataset.id;
  if (!requestId) return;
  if (!window.confirm("Delete this request? This cannot be undone.")) return;
  try {
    await deleteRequest(requestId);
    await refreshMainData();
    showToast("Request deleted.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Delete failed.", "error");
  }
}

function handleSearchInput(e) {
  state.filters.search = e.target.value || "";
  renderTable();
}

function handleStatCardClick(e) {
  const card = e.currentTarget;
  const raw = card.dataset.statFilter || "all";
  const nextStatus = raw === "all" ? "" : raw;
  state.filters.status = state.filters.status === nextStatus ? "" : nextStatus;
  if (els.requestStatusFilter) els.requestStatusFilter.value = state.filters.status;
  renderStatCardActiveState();
  renderTable();
}

async function handleFilterChange() {
  state.filters.category = els.requestCategoryFilter?.value || "";
  state.filters.status = els.requestStatusFilter?.value || "";
  try {
    await refreshMainData();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Filter refresh failed.", "error");
  }
}

async function handleClientFormSubmit(e) {
  e.preventDefault();
  if (!els.clientForm) return;
  const fd = new FormData(els.clientForm);
  try {
    await createClient({
      first_name: String(fd.get("first_name") || "").trim(),
      last_name: String(fd.get("last_name") || "").trim(),
      gender: String(fd.get("gender") || "").trim() || null,
      birth_date: String(fd.get("birth_date") || "").trim() || null,
      contact_number: String(fd.get("contact_number") || "").trim() || null,
      id_number: String(fd.get("id_number") || "").trim() || null,
      address: String(fd.get("address") || "").trim() || null,
    });
    await listClients();
    showToast("Client created.", "success");
    els.clientForm.reset();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Create client failed.", "error");
  }
}

async function handleSupplyFormSubmit(e) {
  e.preventDefault();
  if (!els.supplyForm) return;
  const fd = new FormData(els.supplyForm);
  try {
    await createSupply({
      name: String(fd.get("name") || "").trim(),
      category: String(fd.get("category") || "").trim() || "Other",
      unit: String(fd.get("unit") || "").trim() || "pcs",
      quantity_in_stock: Number(fd.get("quantity_in_stock") || 0),
      reorder_level: Number(fd.get("reorder_level") || 0),
      expires_at: String(fd.get("expires_at") || "").trim() || null,
    });
    await listSupplies();
    await refreshDashboardOnly();
    showToast("Supply created.", "success");
    els.supplyForm.reset();
  } catch (err) {
    console.error(err);
    showToast(err.message || "Create supply failed.", "error");
  }
}

async function handleClientTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;

  if (btn.dataset.action === "delete-client") {
    if (!window.confirm("Delete this client record?")) return;
    try {
      await deleteClient(id);
      await refreshMainData();
      showToast("Client deleted.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Delete client failed.", "error");
    }
    return;
  }

  if (btn.dataset.action === "edit-client") {
    const current = state.clients.find((c) => c.id === id);
    if (!current) return;
    const first = window.prompt("First name:", current.first_name || "");
    if (first == null) return;
    const last = window.prompt("Last name:", current.last_name || "");
    if (last == null) return;
    const contact = window.prompt("Contact number:", current.contact_number || "");
    if (contact == null) return;
    try {
      await updateClient(id, {
        first_name: first.trim(),
        last_name: last.trim(),
        contact_number: contact.trim() || null,
      });
      await refreshMainData();
      showToast("Client updated.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Update client failed.", "error");
    }
  }
}

async function handleSupplyTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;

  if (btn.dataset.action === "delete-supply") {
    if (!window.confirm("Delete this supply record?")) return;
    try {
      await deleteSupply(id);
      await refreshMainData();
      showToast("Supply deleted.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Delete supply failed.", "error");
    }
    return;
  }

  if (btn.dataset.action === "edit-supply") {
    const current = state.supplies.find((s) => s.id === id);
    if (!current) return;
    const name = window.prompt("Supply name:", current.name || "");
    if (name == null) return;
    const qtyRaw = window.prompt(
      "Quantity in stock:",
      String(current.quantity_in_stock ?? 0)
    );
    if (qtyRaw == null) return;
    const qty = Number(qtyRaw);
    if (!Number.isFinite(qty) || qty < 0) {
      showToast("Quantity must be a non-negative number.", "error");
      return;
    }
    try {
      await updateSupply(id, {
        name: name.trim(),
        quantity_in_stock: qty,
      });
      await refreshMainData();
      showToast("Supply updated.", "success");
    } catch (err) {
      console.error(err);
      showToast(err.message || "Update supply failed.", "error");
    }
  }
}

async function handleReportRefresh() {
  try {
    const rows = await loadMasterReport();
    const trend = await loadMonthlyTrend(6);
    renderReportTable(rows);
    renderTrend(trend);
    showToast("Report refreshed.", "success");
  } catch (err) {
    console.error(err);
    showToast(err.message || "Report refresh failed.", "error");
  }
}

/* -------------------------------------------------------------------------- */
/* 10. APP FLOW                                                                */
/* -------------------------------------------------------------------------- */
async function refreshDashboardOnly() {
  const summary = await loadDashboardSummary();
  renderSummaryCards(summary);
}

async function refreshMainData() {
  await Promise.all([listRequests(), listClients(), listSupplies()]);
  renderTable();
  renderClientsTable();
  renderSuppliesTable();
  await refreshDashboardOnly();
}

async function afterAuthReady() {
  await ensureSession();
  await loadCurrentUserProfile();
  renderAuthState();
  const path = window.location.pathname.toLowerCase();
  const isLoginPage = path.endsWith("/login.html");
  const isHomePage = path.endsWith("/index.html") || path.endsWith("/");

  if (state.user && isLoginPage) {
    window.location.href = "index.html";
    return;
  }

  if (!state.user) {
    if (isHomePage) {
      window.location.href = "login.html";
      return;
    }
    setConnectionStatus("offline", "Login required");
    if (els.loadingState) els.loadingState.classList.add("hidden");
    return;
  }
  setConnectionStatus("connecting", "Loading data...");
  await refreshMainData();
  const reportRows = await loadMasterReport();
  renderReportTable(reportRows);
  const trend = await loadMonthlyTrend(6);
  renderTrend(trend);
  setConnectionStatus("connected", "Live");
}

function attachListeners() {
  if (els.form) els.form.addEventListener("submit", handleIntakeSubmit);
  if (els.search) els.search.addEventListener("input", handleSearchInput);
  if (els.tbody) els.tbody.addEventListener("change", handleTableChange);
  if (els.tbody) els.tbody.addEventListener("click", handleTableClick);

  if (els.loginForm) els.loginForm.addEventListener("submit", handleLoginSubmit);
  if (els.logoutBtn) els.logoutBtn.addEventListener("click", handleLogoutClick);
  if (els.requestCategoryFilter)
    els.requestCategoryFilter.addEventListener("change", handleFilterChange);
  if (els.requestStatusFilter)
    els.requestStatusFilter.addEventListener("change", handleFilterChange);

  if (els.clientForm) els.clientForm.addEventListener("submit", handleClientFormSubmit);
  if (els.supplyForm) els.supplyForm.addEventListener("submit", handleSupplyFormSubmit);
  if (els.clientsTableBody) els.clientsTableBody.addEventListener("click", handleClientTableClick);
  if (els.suppliesTableBody) els.suppliesTableBody.addEventListener("click", handleSupplyTableClick);
  if (els.reportRefreshBtn) els.reportRefreshBtn.addEventListener("click", handleReportRefresh);
  if (els.statCards?.length) {
    for (const card of els.statCards) {
      card.addEventListener("click", handleStatCardClick);
    }
  }
}

function subscribeToAuthChanges() {
  const supabase = requireSupabase();
  supabase.auth.onAuthStateChange(async (_event, session) => {
    state.user = session?.user || null;
    try {
      await afterAuthReady();
    } catch (err) {
      console.error(err);
      showToast(err.message || "Session refresh failed.", "error");
      setConnectionStatus("error", "Session error");
    }
  });
}

function waitForSupabaseLib() {
  return new Promise((resolve) => {
    if (typeof window.supabaseCreateClient === "function") return resolve();
    let tries = 0;
    const iv = setInterval(() => {
      tries += 1;
      if (typeof window.supabaseCreateClient === "function" || tries > 60) {
        clearInterval(iv);
        resolve();
      }
    }, 100);
  });
}

async function start() {
  attachListeners();
  await waitForSupabaseLib();
  initSupabase();

  if (!state.isConfigured) {
    setConnectionStatus("offline", "Supabase config missing");
    if (els.loadingState) els.loadingState.classList.add("hidden");
    showToast("Configure SUPABASE_URL and SUPABASE_ANON_KEY in app.js", "error", 5000);
    return;
  }

  try {
    await afterAuthReady();
    subscribeToAuthChanges();
  } catch (err) {
    console.error(err);
    setConnectionStatus("error", "Failed to initialize");
    if (els.loadingState) els.loadingState.classList.add("hidden");
    showToast(err.message || "Startup failed.", "error");
  }
}

// Expose module functions for manual admin/testing actions in console.
window.shelterApp = {
  listClients,
  createClient,
  updateClient,
  deleteClient,
  listSupplies,
  createSupply,
  updateSupply,
  deleteSupply,
  listRequests,
  createRequest,
  updateRequestStatus,
  deleteRequest,
  createDistribution,
  loadDashboardSummary,
  loadMasterReport,
  loadMonthlyTrend,
  loadClientsAboveAverage,
};

document.addEventListener("DOMContentLoaded", start);
