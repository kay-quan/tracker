/* ============================================================
   Income Tracker — all app logic.
   Plain JavaScript, no build step, no libraries.
   Records live in Firestore, reached from the browser (see cloud.js).
   ============================================================ */

let DB = null;
let state = { view: "today", showDone: false, calMonth: null, period: "year", year: new Date().getFullYear() };

const EXPENSE_CATEGORIES = [
  "Equipment", "Software & subscriptions", "Supplies & materials", "Travel",
  "Meals & entertainment", "Home office", "Rent & utilities", "Marketing & advertising",
  "Professional fees", "Insurance", "Education & training", "Contractors & assistants",
  "Bank & payment fees", "Phone & internet", "Taxes", "Other",
];
const PAYMENT_METHODS = ["Bank transfer", "Zelle", "Venmo", "PayPal", "Check", "Cash", "Credit card", "Stripe", "Other"];

/* ---------- small helpers ---------- */

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function num(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function money0(n) {
  const sym = (DB && DB.settings.currencySymbol) || "$";
  return (n < 0 ? "-" : "") + sym + Math.round(Math.abs(num(n))).toLocaleString();
}

function money(n) {
  const sym = (DB && DB.settings.currencySymbol) || "$";
  const v = Math.abs(num(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-" : "") + sym + v;
}

function todayISO() {
  const d = new Date();
  return isoOf(d);
}

function isoOf(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Parse a YYYY-MM-DD string as a LOCAL date. `new Date("2026-03-05")` parses as
// UTC and can land on the previous day west of Greenwich, which would shift
// every gig on the calendar by one day.
function parseISO(s) {
  if (!s) return null;
  const p = String(s).split("-").map(Number);
  if (p.length < 3 || isNaN(p[0])) return null;
  return new Date(p[0], p[1] - 1, p[2]);
}

function fmtDate(iso, opts) {
  const d = parseISO(iso);
  if (!d) return "";
  return d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
}

function fmtDateLong(iso) {
  return fmtDate(iso, { weekday: "short", month: "long", day: "numeric", year: "numeric" });
}

function addDays(iso, days) {
  const d = parseISO(iso) || new Date();
  d.setDate(d.getDate() + days);
  return isoOf(d);
}

function fmtTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return hh + (m ? ":" + String(m).padStart(2, "0") : "") + " " + ap;
}

function daysBetween(a, b) {
  const da = parseISO(a), dbb = parseISO(b);
  if (!da || !dbb) return 0;
  return Math.round((dbb - da) / 86400000);
}

/* ---------- starting shape for a brand-new account ---------- */

function defaultData() {
  return {
    settings: {
      businessName: "", yourName: "", email: "", phone: "", website: "", address: "",
      taxId: "", currency: "USD", currencySymbol: "$", defaultTaxRate: 0,
      defaultHourlyRate: 0, paymentTerms: 14, paymentInstructions: "",
      invoicePrefix: "INV-", nextInvoiceNumber: 1,
      invoiceFooter: "Thank you for your business!",
      incomeGoal: 0, edmtrainKey: "", eventCity: "Los Angeles",
      eventState: "California", eventLookaheadDays: 120,
    },
    clients: [], gigs: [], invoices: [], income: [], expenses: [],
    outreach: [], todos: [], localEvents: [], localEventsFetchedAt: null,
  };
}

// Older saves won't have keys added in later versions; fill them in so the app
// never reads undefined.
function withDefaults(data) {
  const base = defaultData();
  const out = Object.assign({}, base, data || {});
  out.settings = Object.assign({}, base.settings, (data && data.settings) || {});
  Object.keys(base).forEach((k) => {
    if (Array.isArray(base[k]) && !Array.isArray(out[k])) out[k] = [];
  });
  return out;
}

/* ---------- load & save ---------- */

let saveTimer = null;
let saveInFlight = false;
let savePending = false;
let dirty = false;   // true whenever edits exist that disk hasn't got yet

function setSaveState(text, cls) {
  // Purely cosmetic. It must never be able to throw: this runs at the top of
  // save(), so an exception here would stop the write from ever happening.
  const el = $("#save-state");
  if (!el) return;
  el.textContent = text;
  el.className = "save-state " + (cls || "");
}

async function load() {
  const remote = await Cloud.load();
  DB = withDefaults(remote);
  // Drop past events on read - Edmtrain's terms ask that their data for
  // finished events isn't kept. Events you typed in yourself stay.
  const today = todayISO();
  DB.localEvents = (DB.localEvents || []).filter((e) => e.manual || (e.date && e.date >= today));
}

function save() {
  dirty = true;
  clearTimeout(saveTimer);
  setSaveState("Saving…", "saving");
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 400);
}

async function flush() {
  if (saveInFlight) { savePending = true; return; }
  saveInFlight = true;
  const snapshot = JSON.stringify(DB);
  try {
    await Cloud.save(JSON.parse(snapshot));
    // Only call it clean if nothing changed while the request was in the air.
    if (!savePending && JSON.stringify(DB) === snapshot) dirty = false;
    setSaveState("Saved", "");
    setTimeout(() => { if ($("#save-state").textContent === "Saved") setSaveState("", ""); }, 1600);
  } catch (err) {
    setSaveState("Not saved!", "error");
    console.error(err);
  } finally {
    saveInFlight = false;
    if (savePending) { savePending = false; flush(); }
  }
}

// Never lose an edit that hasn't reached disk when the tab closes.
//
// A normal fetch() is cancelled on unload, so use sendBeacon, which the browser
// delivers even as the page goes away. Guarded by `dirty` so a stale tab can
// never re-post its old copy over newer edits made somewhere else.
window.addEventListener("beforeunload", () => {
  if (!dirty && !saveInFlight && !savePending) return;
  clearTimeout(saveTimer);
  // sendBeacon can't set an Authorization header, so use keepalive fetch, which
  // the browser finishes even as the page goes away.
  flush();
});

/* ---------- lookups ---------- */

const clientById = (id) => DB.clients.find((c) => c.id === id) || null;
const clientName = (id) => { const c = clientById(id); return c ? c.name : "—"; };
const gigById = (id) => DB.gigs.find((g) => g.id === id) || null;
const invoiceById = (id) => DB.invoices.find((i) => i.id === id) || null;

function gigValue(g) {
  if (!g) return 0;
  return g.rateType === "hourly" ? num(g.rate) * num(g.hours) : num(g.rate);
}

function invoiceSubtotal(inv) {
  return (inv.items || []).reduce((s, it) => s + num(it.qty) * num(it.rate), 0);
}

function invoiceTotals(inv) {
  const subtotal = invoiceSubtotal(inv);
  const discount = num(inv.discount);
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * (num(inv.taxRate) / 100);
  return { subtotal, discount, tax, total: taxable + tax };
}

function invoicePaid(inv) {
  return DB.income.filter((i) => i.invoiceId === inv.id).reduce((s, i) => s + num(i.amount), 0);
}

function invoiceStatus(inv) {
  if (inv.status === "paid") return "paid";
  if (inv.status === "draft") return "draft";
  const paid = invoicePaid(inv);
  const total = invoiceTotals(inv).total;
  if (total > 0 && paid >= total - 0.005) return "paid";
  if (paid > 0) return "partial";
  if (inv.dueDate && inv.dueDate < todayISO()) return "overdue";
  return "sent";
}

const STATUS_PILL = {
  draft: "pill-gray", sent: "pill-blue", partial: "pill-amber",
  overdue: "pill-red", paid: "pill-green",
};

/* ---------- period filtering ---------- */

function periodRange() {
  const y = state.year;
  const now = new Date();
  if (state.period === "all") return { from: "0000-01-01", to: "9999-12-31", label: "All time" };
  if (state.period === "month") {
    const m = now.getMonth();
    const from = isoOf(new Date(y, m, 1));
    const to = isoOf(new Date(y, m + 1, 0));
    return { from, to, label: new Date(y, m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
  }
  if (state.period === "quarter") {
    const q = Math.floor(now.getMonth() / 3);
    const from = isoOf(new Date(y, q * 3, 1));
    const to = isoOf(new Date(y, q * 3 + 3, 0));
    return { from, to, label: "Q" + (q + 1) + " " + y };
  }
  return { from: y + "-01-01", to: y + "-12-31", label: String(y) };
}

const inRange = (iso, r) => !!iso && iso >= r.from && iso <= r.to;

/* ---------- modal ---------- */

let modalOnClose = null;

function openModal(title, bodyHTML, footHTML, opts = {}) {
  closeModal();
  const root = $("#modal-root");
  root.innerHTML =
    '<div class="modal-backdrop" data-act="backdrop">' +
    '<div class="modal' + (opts.wide ? " wide" : "") + '" role="dialog" aria-modal="true">' +
    '<div class="modal-head"><h2>' + esc(title) + "</h2>" +
    '<button class="btn btn-ghost btn-sm" data-act="close-modal">Close</button></div>' +
    '<div class="modal-body">' + bodyHTML + "</div>" +
    (footHTML ? '<div class="modal-foot">' + footHTML + "</div>" : "") +
    "</div></div>";
  modalOnClose = opts.onClose || null;
  const first = root.querySelector("input:not([type=hidden]), select, textarea");
  if (first && !opts.noFocus) first.focus();
}

function closeModal() {
  $("#modal-root").innerHTML = "";
  if (modalOnClose) { const f = modalOnClose; modalOnClose = null; f(); }
}

function confirmDelete(what, onYes) {
  openModal("Delete " + what + "?",
    "<p>This can't be undone. Your daily backup in the <code>backups</code> folder would still have it.</p>",
    '<button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-danger" data-act="confirm-delete">Delete</button>');
  window.__confirmYes = onYes;
}

/* ---------- form value collection ---------- */

function formValues(root) {
  const out = {};
  $$("[name]", root).forEach((el) => {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else out[el.name] = el.value;
  });
  return out;
}

function selectOptions(list, selected, placeholder) {
  let html = placeholder ? '<option value="">' + esc(placeholder) + "</option>" : "";
  list.forEach((o) => {
    const val = typeof o === "string" ? o : o.value;
    const lbl = typeof o === "string" ? o : o.label;
    html += '<option value="' + esc(val) + '"' + (val === selected ? " selected" : "") + ">" + esc(lbl) + "</option>";
  });
  return html;
}

const clientOptions = (sel) => selectOptions(DB.clients.map((c) => ({ value: c.id, label: c.name })), sel, "— No client —");

/* ---------- router ---------- */

const VIEWS = {};

/* ---------- headline figures shown on every screen ---------- */

function ytdFigures() {
  const y = new Date().getFullYear();
  const r = { from: y + "-01-01", to: y + "-12-31" };
  const earned = DB.income.filter((i) => inRange(i.date, r)).reduce((s, i) => s + num(i.amount), 0);
  const spent = DB.expenses.filter((e) => inRange(e.date, r)).reduce((s, e) => s + num(e.amount), 0);
  const net = earned - spent;
  const goal = num(DB.settings.incomeGoal);

  // Weeks left in the year, floored so the pace never divides by zero.
  const weeksLeft = Math.max(0.1, (new Date(y, 11, 31) - new Date()) / (7 * 86400000));
  const remaining = Math.max(0, goal - net);
  return { year: y, earned, spent, net, goal, weeksLeft, remaining,
           pace: goal ? remaining / weeksLeft : 0 };
}

function renderHeader() {
  const name = DB.settings.businessName || DB.settings.yourName;
  $("#app-title").textContent = name || "Income Tracker";
  document.title = name ? name + " \u00b7 Tracker" : "Income Tracker";

  const f = ytdFigures();
  const today = new Date().toLocaleDateString(undefined,
    { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  $("#app-meta").innerHTML =
    '<span class="meta-line"><span class="muted">' + esc(today) + "</span>" +
    '<span class="meta-stat">YTD net <strong>' + money(f.net) + "</strong></span></span>" +
    '<span class="meta-line">' +
    (f.goal
      ? '<span class="meta-stat">Goal pace <strong>' + money(f.pace) + "</strong>/wk</span>"
      : '<a href="#" class="meta-stat" data-act="set-goal">Set an income goal</a>') +
    '<span class="live"><i></i>live</span></span>';
}

/* ---------- bottom tab bar ---------- */

const TABS = [
  { view: "today", label: "Today", icon: "\u2713" },
  { view: "calendar", label: "Calendar", icon: "\u25a6" },
  { view: "money", label: "Money", icon: "$" },
  { view: "outreach", label: "Outreach", icon: "\u2709" },
  { view: "invoices", label: "Invoices", icon: "\u25a4" },
];

// Badges flag only what needs a decision from you.
function tabBadge(view) {
  const today = todayISO();
  if (view === "today") return (DB.todos || []).filter((t) => !t.done).length;
  if (view === "outreach") {
    return (DB.outreach || []).filter((o) =>
      o.status === "to-contact" ||
      (o.nextFollowUp && o.nextFollowUp <= today && !["booked", "passed"].includes(o.status))).length;
  }
  if (view === "invoices") {
    return DB.invoices.filter((inv) => ["draft", "overdue"].includes(invoiceStatus(inv))).length;
  }
  return 0;
}

// Sub-screens light up their parent tab rather than leaving none active.
const TAB_OF = { income: "money", expenses: "money", gigs: "calendar", clients: "outreach" };

function renderTabbar() {
  const current = TAB_OF[state.view] || state.view;
  $("#tabbar").innerHTML = TABS.map((t) => {
    const n = tabBadge(t.view);
    return '<button class="tab' + (current === t.view ? " active" : "") +
      '" data-act="goto" data-view="' + t.view + '">' +
      '<span class="tab-icon">' + t.icon +
      (n ? '<span class="badge">' + (n > 99 ? "99+" : n) + "</span>" : "") + "</span>" +
      '<span class="tab-label">' + t.label + "</span></button>";
  }).join("");
}

function render() {
  document.body.dataset.view = state.view;   // lets CSS widen only where needed
  renderHeader();
  renderTabbar();
  $("#view").innerHTML = VIEWS[state.view]();
  window.scrollTo({ top: 0 });
  if (VIEWS[state.view].after) VIEWS[state.view].after();
}

function go(view) { state.view = view; render(); }

function setupComplete() {
  const s = DB.settings;
  return !!(s.yourName || s.businessName) && !!s.email;
}

/* ============================================================
   DASHBOARD
   ============================================================ */

VIEWS.dashboard = function () {
  const r = periodRange();
  const income = DB.income.filter((i) => inRange(i.date, r));
  const expenses = DB.expenses.filter((e) => inRange(e.date, r));
  const totalIn = income.reduce((s, i) => s + num(i.amount), 0);
  const totalOut = expenses.reduce((s, e) => s + num(e.amount), 0);
  const net = totalIn - totalOut;

  const open = DB.invoices.filter((inv) => ["sent", "overdue", "partial"].includes(invoiceStatus(inv)));
  const outstanding = open.reduce((s, inv) => s + (invoiceTotals(inv).total - invoicePaid(inv)), 0);
  const overdueCount = DB.invoices.filter((inv) => invoiceStatus(inv) === "overdue").length;

  const upcoming = DB.gigs
    .filter((g) => g.date >= todayISO() && g.status !== "cancelled")
    .sort((a, b) => a.date.localeCompare(b.date));
  const booked = upcoming.filter((g) => g.status === "confirmed").reduce((s, g) => s + gigValue(g), 0);

  const unbilled = DB.gigs.filter(
    (g) => g.status === "completed" && !g.invoiceId && gigValue(g) > 0);

  let html = "";

  if (!setupComplete()) {
    html +=
      '<div class="notice"><div><strong>One thing first:</strong> add your name and email in Settings so your ' +
      "invoices have your details on them.</div>" +
      '<button class="btn btn-sm" data-act="goto" data-view="settings">Open Settings</button></div>';
  }

  html +=
    '<div class="page-head"><div><h1>Dashboard</h1><p>' + esc(r.label) + "</p></div>" +
    '<div class="page-actions">' +
    '<select id="period-select">' +
    selectOptions([
      { value: "month", label: "This month" }, { value: "quarter", label: "This quarter" },
      { value: "year", label: "This year" }, { value: "all", label: "All time" },
    ], state.period) + "</select>" +
    '<select id="year-select">' +
    selectOptions(yearChoices().map((y) => ({ value: String(y), label: String(y) })), String(state.year)) + "</select>" +
    '<button class="btn" data-act="new-expense">Log expense</button>' +
    '<button class="btn btn-primary" data-act="new-invoice">New invoice</button>' +
    "</div></div>";

  html +=
    '<div class="stat-grid">' +
    stat("Money in", money(totalIn), income.length + " payment" + (income.length === 1 ? "" : "s"), "in") +
    stat("Money out", money(totalOut), expenses.length + " expense" + (expenses.length === 1 ? "" : "s"), "out") +
    stat("Net", money(net), net >= 0 ? "You're up" : "You're down", net >= 0 ? "in" : "neg") +
    stat("Awaiting payment", money(outstanding),
      open.length + " open invoice" + (open.length === 1 ? "" : "s") +
      (overdueCount ? " · " + overdueCount + " overdue" : ""), overdueCount ? "neg" : "") +
    stat("Booked ahead", money(booked), bookedSub(upcoming), "") +
    "</div>";

  html += '<div class="two-col">';

  /* left column */
  html += "<div>";
  html += '<div class="card card-pad stack">' +
    '<p class="card-title">In vs. out — ' + state.year + "</p>" + monthlyChart() + "</div>";

  html += '<div class="card card-pad stack">' +
    '<p class="card-title">Upcoming gigs</p>';
  if (!upcoming.length) {
    html += '<p class="muted" style="font-size:13.5px;margin:0">Nothing on the books yet. ' +
      '<a href="#" data-act="goto" data-view="calendar">Add a gig →</a></p>';
  } else {
    html += '<div class="table-wrap"><table><tbody>';
    upcoming.slice(0, 6).forEach((g) => {
      const away = daysBetween(todayISO(), g.date);
      html += "<tr>" +
        '<td style="width:1%;white-space:nowrap"><div class="strong">' + esc(fmtDate(g.date, { month: "short", day: "numeric" })) + "</div>" +
        '<div class="muted" style="font-size:12px">' + (away === 0 ? "today" : away === 1 ? "tomorrow" : "in " + away + " days") + "</div></td>" +
        "<td><div class=\"strong\">" + esc(g.title || "Untitled gig") + "</div>" +
        '<div class="muted" style="font-size:12.5px">' + esc(clientName(g.clientId)) +
        (g.location ? " · " + esc(g.location) : "") + "</div></td>" +
        '<td class="num">' + money(gigValue(g)) + "</td>" +
        '<td class="num">' + statusPill(g.status) + "</td>" +
        '<td class="actions"><button class="btn btn-sm" data-act="edit-gig" data-id="' + g.id + '">Open</button></td>' +
        "</tr>";
    });
    html += "</tbody></table></div>";
  }
  html += "</div>";

  if (unbilled.length) {
    html += '<div class="card card-pad"><p class="card-title">Completed but not invoiced</p>' +
      '<div class="table-wrap"><table><tbody>';
    unbilled.forEach((g) => {
      html += "<tr><td><div class=\"strong\">" + esc(g.title || "Untitled gig") + "</div>" +
        '<div class="muted" style="font-size:12.5px">' + esc(fmtDate(g.date)) + " · " + esc(clientName(g.clientId)) + "</div></td>" +
        '<td class="num strong">' + money(gigValue(g)) + "</td>" +
        '<td class="actions"><button class="btn btn-sm btn-primary" data-act="invoice-gig" data-id="' + g.id + '">Invoice it</button></td></tr>';
    });
    html += "</tbody></table></div></div>";
  }
  html += "</div>";

  /* right column */
  html += "<div>";
  html += '<div class="card card-pad todo-card stack">' + todoCard() + "</div>";
  html += '<div class="card card-pad" style="margin-bottom:16px"><p class="card-title">Open invoices</p>';
  if (!open.length) {
    html += '<p class="muted" style="font-size:13.5px;margin:0">Nothing outstanding. Nice.</p>';
  } else {
    html += '<div class="table-wrap"><table><tbody>';
    open.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || "")).forEach((inv) => {
      const st = invoiceStatus(inv);
      const owed = invoiceTotals(inv).total - invoicePaid(inv);
      html += "<tr><td><div class=\"strong\">" + esc(inv.number) + "</div>" +
        '<div class="muted" style="font-size:12.5px">' + esc(clientName(inv.clientId)) +
        (inv.dueDate ? " · due " + esc(fmtDate(inv.dueDate, { month: "short", day: "numeric" })) : "") + "</div></td>" +
        '<td class="num"><div class="strong">' + money(owed) + "</div>" +
        '<div style="margin-top:2px">' + '<span class="pill ' + STATUS_PILL[st] + '">' + st + "</span></div></td>" +
        '<td class="actions"><button class="btn btn-sm" data-act="open-invoice" data-id="' + inv.id + '">Open</button></td></tr>';
    });
    html += "</tbody></table></div>";
  }
  html += "</div>";

  html += '<div class="card card-pad" style="margin-bottom:16px"><p class="card-title">Where the money came from</p>' +
    breakdown(groupSum(income, (i) => (i.clientId ? clientName(i.clientId) : i.source || "Other"))
      , "var(--money-in)", "No income logged in this period.") + "</div>";

  html += '<div class="card card-pad"><p class="card-title">Where it went</p>' +
    breakdown(groupSum(expenses, (e) => e.category || "Uncategorised"), "var(--money-out)",
      "No expenses logged in this period.") + "</div>";
  html += "</div>";

  html += "</div>";
  return html;
};

VIEWS.dashboard.after = function () {
  const p = $("#period-select");
  if (p) p.onchange = (e) => { state.period = e.target.value; render(); };
  const y = $("#year-select");
  if (y) y.onchange = (e) => { state.year = Number(e.target.value); render(); };
};

function yearChoices() {
  const years = new Set([new Date().getFullYear(), state.year]);
  DB.income.concat(DB.expenses).forEach((x) => { if (x.date) years.add(Number(x.date.slice(0, 4))); });
  DB.gigs.forEach((g) => { if (g.date) years.add(Number(g.date.slice(0, 4))); });
  return Array.from(years).filter((y) => y > 1990 && y < 2200).sort((a, b) => b - a);
}

function bookedSub(upcoming) {
  const confirmed = upcoming.filter((g) => g.status === "confirmed").length;
  const tentative = upcoming.length - confirmed;
  if (!upcoming.length) return "Nothing booked yet";
  const parts = [];
  if (confirmed) parts.push(confirmed + " confirmed");
  if (tentative) parts.push(tentative + " tentative");
  return "from " + parts.join(" \u00b7 ");
}

function todoCard() {
  const todos = DB.todos || [];
  const openCount = todos.filter((t) => !t.done).length;
  return '<p class="card-title">To do' +
    (openCount ? ' <span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">\u00b7 ' +
      openCount + " left</span>" : "") + "</p>" +
    '<div class="todo-add">' +
    '<input id="todo-input" type="text" placeholder="Add a task\u2026" maxlength="200">' +
    '<button class="btn btn-sm" data-act="add-todo">Add</button></div>' +
    '<div id="todo-list">' + todoListHTML() + "</div>";
}

function todoListHTML() {
  const open = (DB.todos || []).filter((t) => !t.done && !t.top);
  if (!open.length) {
    const slotted = (DB.todos || []).some((t) => t.top && !t.done);
    return '<p class="muted" style="font-size:13.5px;margin:12px 0 0">' +
      (slotted
        ? "Everything left is up in your Top 3."
        : "Nothing on the list. Chase an invoice, email a venue, book a shoot \u2014 " +
          "whatever's next.") + "</p>";
  }
  return open.map((t) =>
    '<label class="todo" draggable="true" data-todo-id="' + t.id + '">' +
    '<span class="grip" aria-hidden="true">\u22ee\u22ee</span>' +
    '<input type="checkbox" data-act="toggle-todo" data-id="' + t.id + '">' +
    '<span class="todo-text">' + esc(t.text) + "</span>" +
    '<button class="todo-del" data-act="delete-todo" data-id="' + t.id + '" title="Remove">\u00d7</button>' +
    "</label>").join("");
}



// Repaint just the list, so adding or ticking something never steals focus
// from the input or jumps the page back to the top.
function refreshTodoList() {
  // Ticking or starring changes the Top 3 slots and the tab badge too, so on
  // the Today screen repaint the lot; elsewhere just the list is enough.
  if (state.view === "today") { render(); return; }
  const list = $("#todo-list");
  if (!list) return;
  list.innerHTML = todoListHTML();
  const heading = list.closest(".card").querySelector(".card-title");
  const open = (DB.todos || []).filter((t) => !t.done).length;
  heading.innerHTML = "To do" + (open
    ? ' <span class="muted" style="font-weight:500;text-transform:none;letter-spacing:0">\u00b7 ' +
      open + " left</span>"
    : "");
}

function setGoalDialog() {
  openModal("Income goal",
    '<form id="goal-form"><div class="field"><label>What do you want to earn this year? ' +
    '<span class="hint">net, after expenses</span></label>' +
    '<input type="number" name="incomeGoal" step="100" min="0" value="' +
    esc(num(DB.settings.incomeGoal) || "") + '" placeholder="100000"></div>' +
    '<p class="muted" style="font-size:13px;margin:0">Leave it blank to hide the goal tracking.</p></form>',
    '<button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-goal">Save</button>');
}

// Put a task into a Top 3 slot. Whatever was in that slot gets bumped back to
// the list, so a slot always holds exactly one thing.
function assignTop(taskId, rank) {
  const t = (DB.todos || []).find((x) => x.id === taskId);
  if (!t) return;
  (DB.todos || []).forEach((x) => {
    if (x !== t && x.top && !x.done && x.topRank === rank) { x.top = false; x.topRank = null; }
  });
  // Dragging a slotted task to another slot moves it rather than duplicating.
  t.top = true;
  t.topRank = rank;
  save();
  render();
}

// Touch devices don't fire HTML5 drag events, so tapping an empty slot offers
// the same thing as a list.
function pickTopDialog(rank) {
  const open = (DB.todos || []).filter((t) => !t.done && !(t.top && t.topRank === rank));
  if (!open.length) {
    openModal("Nothing to add", "<p>Add a task first, then it can go in a slot.</p>",
      '<button class="btn btn-primary" data-act="close-modal">OK</button>');
    return;
  }
  openModal("Put in slot " + (rank + 1),
    '<div class="picklist">' + open.map((t) =>
      '<button class="pick" data-act="pick-task" data-id="' + t.id + '" data-rank="' + rank + '">' +
      esc(t.text) + "</button>").join("") + "</div>",
    '<button class="btn" data-act="close-modal">Cancel</button>', { noFocus: true });
}

let dragId = null;

document.addEventListener("dragstart", (e) => {
  const row = e.target.closest("[data-todo-id][draggable]");
  if (!row) return;
  dragId = row.dataset.todoId;
  row.classList.add("dragging");
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    // Firefox needs data set or the drag never starts.
    e.dataTransfer.setData("text/plain", dragId);
  }
});

document.addEventListener("dragend", (e) => {
  const row = e.target.closest("[data-todo-id]");
  if (row) row.classList.remove("dragging");
  $$(".slot.dragover").forEach((el) => el.classList.remove("dragover"));
  dragId = null;
});

document.addEventListener("dragover", (e) => {
  const slot = e.target.closest(".slot");
  if (!slot || !dragId) return;
  e.preventDefault();                       // required to allow a drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  slot.classList.add("dragover");
});

document.addEventListener("dragleave", (e) => {
  const slot = e.target.closest(".slot");
  if (slot && !slot.contains(e.relatedTarget)) slot.classList.remove("dragover");
});

document.addEventListener("drop", (e) => {
  const slot = e.target.closest(".slot");
  if (!slot) return;
  e.preventDefault();
  slot.classList.remove("dragover");
  const id = dragId || (e.dataTransfer && e.dataTransfer.getData("text/plain"));
  if (id) assignTop(id, Number(slot.dataset.slot));
  dragId = null;
});

function addTodo() {
  const input = $("#todo-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  DB.todos = DB.todos || [];
  DB.todos.push({ id: uid(), text: text, done: false, created: todayISO(), doneAt: null,
                  top: false, topRank: null });
  save();
  refreshTodoList();
  // On Today the whole screen re-renders (the Top 3 slots depend on this list),
  // which throws away the input element. Grab the new one and put the cursor
  // back, so several tasks can be typed one after another.
  const fresh = $("#todo-input");
  if (fresh) { fresh.value = ""; fresh.focus(); }
}


function toggleTodo(id) {
  const t = (DB.todos || []).find((x) => x.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? todayISO() : null;
  if (t.done) { t.top = false; t.topRank = null; }   // finishing frees its slot
  save();
  refreshTodoList();
}

function stat(label, value, sub, cls) {
  return '<div class="stat"><div class="label">' + esc(label) + "</div>" +
    '<div class="value ' + (cls || "") + '">' + value + "</div>" +
    '<div class="sub">' + esc(sub) + "</div></div>";
}

function statusPill(status) {
  const map = { confirmed: "pill-green", inquiry: "pill-amber", completed: "pill-gray", cancelled: "pill-gray" };
  return '<span class="pill ' + (map[status] || "pill-gray") + '">' + esc(status || "—") + "</span>";
}

function groupSum(rows, keyFn) {
  const map = new Map();
  rows.forEach((r) => {
    const k = keyFn(r) || "Other";
    map.set(k, (map.get(k) || 0) + num(r.amount));
  });
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
}

function breakdown(pairs, color, emptyMsg) {
  if (!pairs.length) return '<p class="muted" style="font-size:13.5px;margin:0">' + esc(emptyMsg) + "</p>";
  const max = pairs[0][1] || 1;
  return pairs.slice(0, 8).map(([name, amt]) =>
    '<div class="bar-row"><div class="name" title="' + esc(name) + '">' + esc(name) + "</div>" +
    '<div class="bar-track"><div class="bar-fill" style="width:' + Math.max(2, (amt / max) * 100) +
    "%;background:" + color + '"></div></div>' +
    '<div class="amt">' + money(amt) + "</div></div>").join("");
}

function monthlyChart() {
  const y = state.year;
  const ins = new Array(12).fill(0);
  const outs = new Array(12).fill(0);
  DB.income.forEach((i) => { if (i.date && Number(i.date.slice(0, 4)) === y) ins[Number(i.date.slice(5, 7)) - 1] += num(i.amount); });
  DB.expenses.forEach((e) => { if (e.date && Number(e.date.slice(0, 4)) === y) outs[Number(e.date.slice(5, 7)) - 1] += num(e.amount); });
  const max = Math.max(1, ...ins, ...outs);
  const labels = ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  let bars = "";
  for (let m = 0; m < 12; m++) {
    const title = new Date(y, m, 1).toLocaleDateString(undefined, { month: "long" }) +
      " — in " + money(ins[m]) + ", out " + money(outs[m]);
    bars += '<div class="mc-col" title="' + esc(title) + '"><div class="mc-bars">' +
      '<div class="mc-bar mc-in' + (ins[m] ? "" : " mc-zero") + '" style="height:' + (ins[m] / max) * 100 + '%"></div>' +
      '<div class="mc-bar mc-out' + (outs[m] ? "" : " mc-zero") + '" style="height:' + (outs[m] / max) * 100 + '%"></div>' +
      '</div><div class="mc-label">' + labels[m] + "</div></div>";
  }
  return '<div class="mini-chart">' + bars + "</div>" +
    '<div class="legend"><span><i class="swatch" style="background:var(--money-in)"></i>Money in</span>' +
    '<span><i class="swatch" style="background:var(--money-out)"></i>Money out</span>' +
    '<span class="muted">Peak month: ' + money(max) + "</span></div>";
}

/* ============================================================
   CALENDAR
   ============================================================ */

/* ============================================================
   TODAY
   ============================================================ */

// Nudges are read straight off your own data - whatever is costing you money
// or attention right now, with the one action that clears it.
function nudges() {
  const today = todayISO();
  const out = [];

  const gigsToday = DB.gigs.filter((g) => g.date === today && g.status !== "cancelled");
  gigsToday.forEach((g) => out.push({
    tone: "green", icon: "\u25cf",
    text: "<strong>" + esc(g.title || "A gig") + "</strong> is today" +
      (g.startTime ? " at " + esc(fmtTime(g.startTime)) : "") + ".",
    action: { label: "Open", act: "edit-gig", id: g.id },
  }));

  const overdue = DB.invoices.filter((inv) => invoiceStatus(inv) === "overdue");
  if (overdue.length) {
    const owed = overdue.reduce((sum, inv) => sum + (invoiceTotals(inv).total - invoicePaid(inv)), 0);
    out.push({
      tone: "red", icon: "\u25cf",
      text: "<strong>" + money(owed) + "</strong> is overdue across " + overdue.length +
        " invoice" + (overdue.length === 1 ? "" : "s") + ".",
      action: { label: "Chase", view: "invoices" },
    });
  }

  const drafts = DB.invoices.filter((inv) => invoiceStatus(inv) === "draft");
  const draftValue = drafts.reduce((sum, inv) => sum + invoiceTotals(inv).total, 0);
  if (draftValue > 0) {
    out.push({
      tone: "amber", icon: "\u25cf",
      text: "<strong>" + money(draftValue) + "</strong> is sitting in invoices you haven't sent. " +
        "Fastest money you've got.",
      action: { label: "Send them", view: "invoices" },
    });
  }

  const unbilled = DB.gigs.filter((g) => g.status === "completed" && !g.invoiceId && gigValue(g) > 0);
  if (unbilled.length) {
    const value = unbilled.reduce((sum, g) => sum + gigValue(g), 0);
    out.push({
      tone: "amber", icon: "\u25cf",
      text: unbilled.length + " finished gig" + (unbilled.length === 1 ? "" : "s") +
        " worth <strong>" + money(value) + "</strong> never got invoiced.",
      action: { label: "Invoice", view: "calendar" },
    });
  }

  const due = (DB.outreach || []).filter((o) => o.nextFollowUp && o.nextFollowUp <= today &&
    !["booked", "passed"].includes(o.status));
  if (due.length) {
    out.push({
      tone: "amber", icon: "\u25cf",
      text: due.length + " follow-up" + (due.length === 1 ? "" : "s") + " due \u2014 " +
        esc(due.slice(0, 2).map((o) => o.venue).join(", ")) +
        (due.length > 2 ? " and " + (due.length - 2) + " more" : "") + ".",
      action: { label: "Outreach", view: "outreach" },
    });
  }

  const soon = DB.gigs.filter((g) => g.date > today && g.date <= addDays(today, 7) &&
    g.status === "confirmed");
  if (soon.length && !gigsToday.length) {
    out.push({
      tone: "green", icon: "\u25cf",
      text: soon.length + " confirmed gig" + (soon.length === 1 ? "" : "s") + " in the next 7 days.",
      action: { label: "Calendar", view: "calendar" },
    });
  }

  return out;
}

VIEWS.today = function () {
  let html = "";

  if (!setupComplete()) {
    html += '<div class="nudge tone-amber"><div class="nudge-text">' +
      "<strong>Add your name and email</strong> so your invoices carry your details.</div>" +
      '<button class="btn btn-primary btn-sm" data-act="goto" data-view="settings">Settings</button></div>';
  }

  const list = nudges();
  list.forEach((n) => {
    html += '<div class="nudge tone-' + n.tone + '"><div class="nudge-text">' + n.text + "</div>" +
      '<button class="btn btn-primary btn-sm" data-act="' + (n.action.act || "goto") + '"' +
      (n.action.view ? ' data-view="' + n.action.view + '"' : "") +
      (n.action.id ? ' data-id="' + n.action.id + '"' : "") + ">" + esc(n.action.label) + "</button></div>";
  });
  if (!list.length && setupComplete()) {
    html += '<div class="nudge tone-green"><div class="nudge-text">Nothing on fire. ' +
      "Good time to chase a venue or line up next month.</div>" +
      '<button class="btn btn-primary btn-sm" data-act="goto" data-view="outreach">Outreach</button></div>';
  }

  /* ---- two columns: priorities on the left, the backlog on the right ---- */
  const todos = DB.todos || [];
  html += '<div class="today-cols"><div>';
  html += '<h2 class="section-head">Top 3 today</h2>';
  for (let i = 0; i < 3; i++) {
    const t = todos.find((x) => x.top && !x.done && x.topRank === i);
    html += t
      ? '<div class="slot filled" data-slot="' + i + '" draggable="true" data-todo-id="' + t.id + '">' +
        '<span class="slot-n">' + (i + 1) + "</span>" +
        '<label class="slot-task"><input type="checkbox" data-act="toggle-todo" data-id="' + t.id + '">' +
        '<span class="todo-text">' + esc(t.text) + "</span></label>" +
        '<button class="slot-x" data-act="untop-todo" data-id="' + t.id + '" title="Remove from Top 3">\u00d7</button></div>'
      : '<div class="slot" data-slot="' + i + '" data-act="pick-top" data-rank="' + i + '">' +
        '<span class="slot-n">' + (i + 1) + "</span>" +
        '<span class="slot-empty">Drag a task here<span class="tap-hint"> \u00b7 or tap to pick</span></span></div>';
  }

  html += "</div><div>";

  /* ---- all tasks ---- */
  const open = todos.filter((t) => !t.done && !t.top);
  const done = todos.filter((t) => t.done);
  html += '<h2 class="section-head">All tasks' +
    (open.length ? ' <span class="count">' + open.length + "</span>" : "") + "</h2>";
  html += '<div class="card card-pad todo-card">' +
    '<div class="todo-add">' +
    '<input id="todo-input" type="text" placeholder="Add a task\u2026" maxlength="200">' +
    '<button class="btn btn-sm" data-act="add-todo">Add</button></div>' +
    '<div id="todo-list">' + todoListHTML() + "</div></div>";

  if (done.length) {
    html += '<button class="disclosure" data-act="toggle-done">' +
      (state.showDone ? "\u25be" : "\u25b8") + " Completed <span class=\"count\">" + done.length + "</span></button>";
    if (state.showDone) {
      html += '<div class="card card-pad todo-card">' + done.map((t) =>
        '<label class="todo done"><input type="checkbox" data-act="toggle-todo" data-id="' + t.id + '" checked>' +
        '<span class="todo-text">' + esc(t.text) + "</span>" +
        '<button class="todo-del" data-act="delete-todo" data-id="' + t.id + '">\u00d7</button></label>').join("") +
        '<button class="btn btn-sm btn-ghost" data-act="clear-done" style="margin-top:10px">Clear ' +
        done.length + " finished</button></div>";
    }
  }

  html += "</div></div>";
  return html;
};

/* ============================================================
   MONEY
   ============================================================ */

VIEWS.money = function () {
  const f = ytdFigures();
  const open = DB.invoices.filter((inv) => ["sent", "overdue", "partial"].includes(invoiceStatus(inv)));
  const awaiting = open.reduce((s, inv) => s + (invoiceTotals(inv).total - invoicePaid(inv)), 0);

  let html = '<div class="card card-pad hero">';
  html += '<div class="hero-top"><span class="hero-num">' + money(f.net) + "</span>" +
    (f.goal
      ? '<span class="hero-goal">of <strong>' + money(f.goal) + "</strong> goal</span>"
      : '<a href="#" class="hero-goal" data-act="set-goal">set a goal</a>') + "</div>";
  if (f.goal) {
    const pct = Math.max(0, Math.min(100, (f.net / f.goal) * 100));
    html += '<div class="progress"><div class="progress-fill" style="width:' + pct + '%"></div></div>';
  }
  html += '<div class="hero-rows">' +
    row("Awaiting payment", money(awaiting), awaiting > 0 ? "amber" : "") +
    row("Earned this year", money(f.earned), "") +
    row("Spent this year", money(f.spent), "") +
    (f.goal ? row("Weeks left in " + f.year, f.weeksLeft.toFixed(1), "") : "") +
    (f.goal ? row("Pace needed", money(f.pace) + "/wk", "") : "") +
    "</div></div>";

  html += '<div class="btn-row">' +
    '<button class="btn" data-act="new-income">Log income</button>' +
    '<button class="btn" data-act="new-expense">Log expense</button>' +
    '<button class="btn" data-act="goto" data-view="income">All income</button>' +
    '<button class="btn" data-act="goto" data-view="expenses">All expenses</button></div>';

  html += '<h2 class="section-head">By month</h2>';
  const y = f.year;
  const now = new Date();
  const months = [];
  for (let m = 0; m < 12; m++) {
    const key = y + "-" + String(m + 1).padStart(2, "0");
    const made = DB.income.filter((i) => (i.date || "").slice(0, 7) === key)
      .reduce((s, i) => s + num(i.amount), 0);
    const spent = DB.expenses.filter((e) => (e.date || "").slice(0, 7) === key)
      .reduce((s, e) => s + num(e.amount), 0);
    // Money already booked for that month but not yet in the bank.
    const owed = DB.gigs.filter((g) => (g.date || "").slice(0, 7) === key &&
      ["confirmed", "completed"].includes(g.status) && !g.invoiceId)
      .reduce((s, g) => s + gigValue(g), 0) +
      DB.invoices.filter((inv) => (inv.issueDate || "").slice(0, 7) === key &&
        !["paid", "draft"].includes(invoiceStatus(inv)))
        .reduce((s, inv) => s + (invoiceTotals(inv).total - invoicePaid(inv)), 0);
    if (made || spent || owed || m === now.getMonth()) months.push({ m, key, made, spent, owed });
  }
  if (!months.length) {
    html += '<div class="card empty"><h3>Nothing logged yet</h3>' +
      "<p>Record a payment or an expense and the months fill in.</p></div>";
  } else {
    months.reverse().forEach((x) => {
      const label = new Date(y, x.m, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      html += '<div class="card card-pad month"><div class="month-name">' + esc(label) + "</div>" +
        row("Made (net)", money(x.made - x.spent), x.made - x.spent > 0 ? "green" : "") +
        row("Upcoming / owed", money(x.owed), x.owed > 0 ? "amber" : "") +
        '<div class="month-total"><span>Projected</span><span>' + money(x.made - x.spent + x.owed) + "</span></div>" +
        "</div>";
    });
  }

  html += '<h2 class="section-head">In vs. out</h2>' +
    '<div class="card card-pad">' + monthlyChart() + "</div>";
  html += '<h2 class="section-head">Where it went</h2>' +
    '<div class="card card-pad">' +
    breakdown(groupSum(DB.expenses.filter((e) => (e.date || "").slice(0, 4) === String(y)),
      (e) => e.category || "Uncategorised"), "var(--money-out)", "No expenses logged this year.") +
    "</div>";
  return html;
};

function row(label, value, tone) {
  return '<div class="krow"><span>' + esc(label) + '</span><span class="' +
    (tone ? "v-" + tone : "") + '">' + value + "</span></div>";
}

VIEWS.calendar = function () {
  if (!state.calMonth) {
    const n = new Date();
    state.calMonth = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
  }
  return state.calMode === "events" ? eventsCalendar() : gigsCalendar();
};

function calTabs() {
  const t = (mode, label) =>
    '<button class="seg' + (state.calMode === mode || (mode === "gigs" && !state.calMode) ? " active" : "") +
    '" data-act="cal-mode" data-mode="' + mode + '">' + label + "</button>";
  return '<div class="segmented">' + t("gigs", "My Gigs") + t("events", "Local Events") + "</div>";
}

function calNav(monthLabel) {
  return '<div class="cal-head">' +
    '<button class="btn btn-sm" data-act="cal-prev">\u2039</button>' +
    '<button class="btn btn-sm" data-act="cal-next">\u203a</button>' +
    "<h2>" + esc(monthLabel) + "</h2>" +
    '<button class="btn btn-sm" data-act="cal-today">Today</button></div>';
}

// Shared month grid. `paint` returns the inner HTML for one day cell.
function monthGrid(paint, dayAct) {
  const [yy, mm] = state.calMonth.split("-").map(Number);
  const first = new Date(yy, mm - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());

  let html = '<div class="cal-grid">';
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    html += '<div class="cal-dow">' + d + "</div>";
  });

  const today = todayISO();
  const cur = new Date(start);
  for (let i = 0; i < 42; i++) {
    const iso = isoOf(cur);
    const other = cur.getMonth() !== mm - 1;
    const cls = "cal-day" + (other ? " other" : "") + (iso === today ? " today" : "");
    html += "<div class=\"" + cls + "\"" + (dayAct ? ' data-act="' + dayAct + '" data-date="' + iso + '"' : "") + ">" +
      '<div class="cal-date">' + cur.getDate() + "</div>" + paint(iso) + "</div>";
    cur.setDate(cur.getDate() + 1);
  }
  return html + "</div>";
}

function monthLabelOf(calMonth) {
  const [yy, mm] = calMonth.split("-").map(Number);
  return new Date(yy, mm - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function gigsCalendar() {
  const byDate = {};
  DB.gigs.forEach((g) => { (byDate[g.date] = byDate[g.date] || []).push(g); });

  const monthGigs = DB.gigs
    .filter((g) => g.date && g.date.slice(0, 7) === state.calMonth && g.status !== "cancelled");
  const monthValue = monthGigs.reduce((s, g) => s + gigValue(g), 0);

  let html =
    '<div class="page-head"><div><h1>Calendar</h1>' +
    "<p>Click any day to add a gig. " + monthGigs.length + " gig" + (monthGigs.length === 1 ? "" : "s") +
    " this month, worth " + money(monthValue) + ".</p></div>" +
    '<div class="page-actions">' + calTabs() +
    '<button class="btn btn-primary" data-act="new-gig">Add gig</button></div></div>';

  html += calNav(monthLabelOf(state.calMonth));

  html += monthGrid((iso) => (byDate[iso] || []).map((g) => {
    const label = (g.startTime ? fmtTime(g.startTime) + " " : "") + (g.title || "Gig");
    return '<div class="cal-event ev-' + esc(g.status || "confirmed") + '" data-act="edit-gig" data-id="' +
      g.id + '" title="' + esc((g.title || "Gig") + " \u2014 " + clientName(g.clientId) + " \u2014 " + money(gigValue(g))) + '">' +
      esc(label) + "</div>";
  }).join(""), "cal-day");

  html += '<div class="legend">' +
    '<span><i class="swatch" style="background:var(--money-in)"></i>Confirmed</span>' +
    '<span><i class="swatch" style="background:var(--warn)"></i>Inquiry / tentative</span>' +
    '<span><i class="swatch" style="background:var(--ink-3)"></i>Completed</span>' +
    '<span><i class="swatch" style="background:var(--border-strong)"></i>Cancelled</span></div>';

  return html;
}

function eventsCalendar() {
  const all = DB.localEvents || [];
  // Edmtrain flags festivals separately from club and venue shows. They're
  // different propositions - multi-day, booked further out - so they can be
  // looked at on their own.
  const kind = state.eventKind || "";
  const events = kind === "festival" ? all.filter((e) => e.festival)
    : kind === "show" ? all.filter((e) => !e.festival)
    : all;
  const byDate = {};
  events.forEach((e) => { (byDate[e.date] = byDate[e.date] || []).push(e); });
  // Festivals first within a day. The grid only shows the first few events per
  // cell, and a festival is the last thing that should be collapsed behind a
  // "+2 more" - it's the biggest booking on offer.
  Object.keys(byDate).forEach((d) => {
    byDate[d].sort((a, b) => (b.festival ? 1 : 0) - (a.festival ? 1 : 0) ||
      (a.venue || "").localeCompare(b.venue || ""));
  });
  const monthEvents = events.filter((e) => e.date && e.date.slice(0, 7) === state.calMonth);
  const venues = new Set(monthEvents.map((e) => e.venue).filter(Boolean));
  const kindWord = kind === "festival" ? "festival" : "show";
  const n = monthEvents.length;

  let html =
    '<div class="page-head"><div><h1>Local Events</h1><p>' +
    (all.length
      ? (n
          ? n + " " + kindWord + (n === 1 ? "" : "s") + " this month" +
            (kind === "festival" ? "" : " across " + venues.size +
              " venue" + (venues.size === 1 ? "" : "s")) +
            " in " + esc(DB.settings.eventCity || "your area") + "."
          : "No " + kindWord + "s listed this month in " +
            esc(DB.settings.eventCity || "your area") + ".")
      : "Shows near you, pulled from Edmtrain.") + "</p></div>" +
    '<div class="page-actions">' + calTabs() +
    '<button class="btn" data-act="refresh-events">Refresh</button>' +
    '<button class="btn btn-primary" data-act="new-local-event">Add event</button></div></div>';

  html += eventsStatusBar();
  if (!all.length) return html + eventsEmptyState();

  const inMonth = (list) => list.filter((e) => (e.date || "").slice(0, 7) === state.calMonth).length;
  const kinds = [
    { key: "", label: "Everything", n: inMonth(all) },
    { key: "show", label: "Shows", n: inMonth(all.filter((e) => !e.festival)) },
    { key: "festival", label: "Festivals", n: inMonth(all.filter((e) => e.festival)) },
  ];
  html += '<div class="chips">' + kinds.map((k) =>
    '<button class="chip' + (kind === k.key ? " active" : "") +
    '" data-act="event-kind" data-key="' + k.key + '">' + esc(k.label) +
    '<span class="n">' + k.n + "</span></button>").join("") + "</div>";

  html += calNav(monthLabelOf(state.calMonth));

  if (isNarrow()) { return html + eventsAgenda(byDate); }

  html += monthGrid((iso) => {
    const list = byDate[iso] || [];
    return list.slice(0, 3).map((e) =>
      '<div class="cal-event ev-show' + (e.manual ? " ev-mine" : e.festival ? " ev-fest" : "") +
      '" data-act="show-event" data-id="' +
      esc(e.id) + '" title="' + esc(eventTooltip(e)) + '">' +
      '<span class="ev-who">' + esc(eventWho(e)) + "</span>" +
      (e.venue ? '<span class="ev-venue">' + esc(e.venue) + "</span>" : "") +
      "</div>").join("") +
      (list.length > 3 ? '<div class="cal-more">+' + (list.length - 3) + " more</div>" : "");
  }, "local-day");

  html += '<div class="legend"><span><i class="swatch" style="background:#6f5bd1"></i>Show</span>' +
    '<span><i class="swatch" style="background:#c2557a"></i>Festival</span>' +
    '<span><i class="swatch" style="background:#b07d2b"></i>Added by you</span>' +
    '<span class="muted">Click a day to add a show, or a show for its details.</span></div>';

  // The grid gives the shape of the month; this lists every show underneath in
  // full, so nothing is hidden behind a "+2 more" or trimmed to fit a cell.
  const monthCount = Object.keys(byDate)
    .filter((d) => d.slice(0, 7) === state.calMonth)
    .reduce((n, d) => n + byDate[d].length, 0);
  html += '<h2 class="section-head">Day by day' +
    (monthCount ? ' <span class="count">' + monthCount + " show" + (monthCount === 1 ? "" : "s") + "</span>" : "") +
    "</h2>";
  html += eventsAgenda(byDate);

  return html;
}

// Seven columns need roughly 900px to stay legible. Below that a month grid
// gives each day about 50px, which cannot hold a venue name, so the same events
// are listed by day instead.
const NARROW = window.matchMedia("(max-width: 899px)");
function isNarrow() { return NARROW.matches; }

// Re-render when crossing the breakpoint so the right layout is always showing.
NARROW.addEventListener("change", () => { if (DB) render(); });

function eventsAgenda(byDate) {
  const dates = Object.keys(byDate)
    .filter((d) => d.slice(0, 7) === state.calMonth)
    .sort();
  if (!dates.length) {
    return '<div class="card card-pad"><p class="muted" style="margin:0;font-size:14px">' +
      "Nothing listed for " + esc(monthLabelOf(state.calMonth)) + ".</p></div>";
  }
  const today = todayISO();
  return dates.map((d) => {
    const list = byDate[d].slice().sort((a, b) => (b.festival ? 1 : 0) - (a.festival ? 1 : 0) ||
      (a.venue || "").localeCompare(b.venue || ""));
    const day = parseISO(d);
    return '<div class="agenda-day">' +
      '<div class="agenda-date' + (d === today ? " is-today" : "") + '">' +
      '<span class="agenda-dow">' + esc(day.toLocaleDateString(undefined, { weekday: "short" })) + "</span>" +
      '<span class="agenda-num">' + esc(day.toLocaleDateString(undefined, { month: "short", day: "numeric" })) + "</span>" +
      (d === today ? '<span class="agenda-dow">today</span>' : "") +
      '<span class="agenda-count">' + list.length + " show" + (list.length === 1 ? "" : "s") + "</span></div>" +
      list.map((e) =>
        '<div class="agenda-row' + (e.manual ? " mine" : e.festival ? " fest" : "") +
        '" data-act="show-event" data-id="' +
        esc(e.id) + '"><span class="agenda-dot"></span><div class="agenda-body">' +
        '<div class="agenda-venue">' + esc(eventLineup(e)) +
        (e.festival ? ' <span class="tag-fest">festival</span>' : "") + "</div>" +
        // When the feed gave no lineup the headline falls back to the venue,
        // so don't print the venue a second time underneath it.
        (function () {
          const sub = [];
          if (e.venue && eventLineup(e) !== e.venue) sub.push(esc(e.venue));
          if (e.ages) sub.push(esc(e.ages));
          return sub.length ? '<div class="agenda-name">' + sub.join(" \u00b7 ") + "</div>" : "";
        })() +
        "</div></div>").join("") +
      "</div>";
  }).join("");
}

// Who's playing, which is the thing worth reading at a glance. The lineup is
// more useful than the event title, which is often just the venue's night name.
function eventWho(e) {
  const acts = (e.artists || []).filter(Boolean);
  if (!acts.length) {
    return (e.name && e.name !== "Untitled event") ? e.name : (e.venue || "Show");
  }
  if (acts.length === 1) return acts[0];
  if (acts.length === 2) return acts[0] + " + " + acts[1];
  return acts[0] + " +" + (acts.length - 1) + " more";
}

// The complete bill, for places with room to show it.
function eventLineup(e) {
  const acts = (e.artists || []).filter(Boolean);
  if (acts.length) return acts.join(", ");
  // No lineup came back from the feed - fall back to whatever names the event.
  if (e.name && e.name !== "Untitled event") return e.name;
  return e.venue || "Show";
}

// Everything about the show, for the hover tooltip.
function eventTooltip(e) {
  const acts = (e.artists || []).filter(Boolean);
  return (acts.length ? acts.join(", ") : e.name || "Show") +
    (e.venue ? "\n" + e.venue : "") +
    (e.ages ? "\n" + e.ages : "");
}

function eventsAgeHours() {
  if (!DB.localEventsFetchedAt) return null;
  return (Date.now() - new Date(DB.localEventsFetchedAt).getTime()) / 3600000;
}

function eventsStatusBar() {
  const age = eventsAgeHours();
  if (age === null) return "";
  const stale = age > 24;
  const when = age < 1
    ? "just now"
    : age < 24 ? Math.round(age) + "h ago"
    : Math.round(age / 24) + " day" + (Math.round(age / 24) === 1 ? "" : "s") + " ago";
  if (!stale) return '<p class="feed-status">Updated ' + when + ".</p>";
  return '<div class="notice"><div><strong>Last updated ' + when + ".</strong> Edmtrain asks that their data " +
    "isn't shown more than 24 hours stale, so give it a refresh.</div>" +
    '<button class="btn btn-sm" data-act="refresh-events">Refresh now</button></div>';
}

function eventsEmptyState() {
  if (!(DB.settings.edmtrainKey || "").trim()) {
    return '<div class="card empty"><h3>Connect Edmtrain to see local shows</h3>' +
      "<p>Edmtrain publishes a free API for personal use. Grab a key, paste it into Settings, " +
      "and this calendar fills with every upcoming show near you.</p>" +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">' +
      '<a class="btn btn-primary" href="https://edmtrain.com/developer-api" target="_blank" rel="noopener">Request a key</a>' +
      '<button class="btn" data-act="goto" data-view="settings">Paste it in Settings</button>' +
      '<button class="btn" data-act="new-local-event">Add one by hand</button></div>' +
      '<p class="muted" style="font-size:13px;margin-top:16px">No key needed to add shows yourself \u2014 ' +
      "handy for anything the feed doesn't carry.</p></div>";
  }
  return '<div class="card empty"><h3>No shows loaded yet</h3>' +
    "<p>Hit refresh to pull upcoming shows in " + esc(DB.settings.eventCity || "your city") + ".</p>" +
    '<button class="btn btn-primary" data-act="refresh-events">Refresh</button></div>';
}

function showEvent(id) {
  const e = (DB.localEvents || []).find((x) => String(x.id) === String(id));
  if (!e) return;
  const inPipeline = (DB.outreach || []).some((o) => o.venue && e.venue &&
    o.venue.toLowerCase() === e.venue.toLowerCase());
  const acts = (e.artists || []).filter(Boolean);
  const body =
    (acts.length ? '<p class="lineup">' + acts.map(esc).join(" \u00b7 ") + "</p>" : "") +
    '<p class="muted" style="margin-top:0">' + esc(fmtDateLong(e.date)) +
    (e.ages ? " \u00b7 " + esc(e.ages) : "") + (e.festival ? ' \u00b7 <span class="pill pill-amber">festival</span>' : "") + "</p>" +
    '<div class="field"><label>Venue</label><div class="strong">' + esc(e.venue || "\u2014") + "</div>" +
    (e.address ? '<div class="muted" style="font-size:13px">' + esc(e.address) +
      (e.city ? ", " + esc(e.city) : "") + "</div>" : "") + "</div>" +
    (e.artists && e.artists.length
      ? '<div class="field"><label>Lineup</label><div>' + e.artists.map(esc).join(", ") + "</div></div>" : "") +
    // Edmtrain's terms require their event link to be shown unmodified.
    (e.link
      ? '<div class="field"><label>' + (e.manual ? "Link" : "Listing") + "</label>" +
        '<a href="' + esc(e.link) + '" target="_blank" rel="noopener">' + esc(e.link) + "</a></div>"
      : "") +
    (e.notes ? '<div class="field"><label>Notes</label><div>' + esc(e.notes) + "</div></div>" : "");

  openModal(e.name, body,
    (e.manual ? '<button class="btn btn-sm" data-act="edit-local-event" data-id="' + esc(e.id) + '">Edit</button>' : "") +
    (inPipeline
      ? '<span class="muted" style="font-size:13px">' + esc(e.venue) + " is already in your outreach.</span>"
      : '<button class="btn" data-act="outreach-from-venue" data-venue="' + esc(e.venue || "") + '">Add venue to outreach</button>') +
    '<div class="spacer"></div><button class="btn btn-primary" data-act="close-modal">Done</button>',
    { noFocus: true });
}

/* ---------- events you add yourself ----------
   The Edmtrain feed can't carry everything (and some promoters don't allow
   their listings to be pulled at all), so any show can be typed in by hand.
   These are tagged manual:true and survive every feed refresh. */

function localEventForm(rec) {
  const e = rec || {
    id: null, name: "", date: todayISO(), venue: "", address: "", city: DB.settings.eventCity || "",
    state: DB.settings.eventState || "", link: "", artists: [], notes: "", manual: true,
  };
  const isNew = !e.id;
  const body =
    '<form id="local-event-form">' +
    '<div class="field"><label>Event name</label>' +
    '<input name="name" value="' + esc(e.name) + '" placeholder="e.g. Beyond Wonderland" required></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Date</label><input type="date" name="date" value="' + esc(e.date) + '" required></div>' +
    '<div class="field"><label>Venue</label><input name="venue" value="' + esc(e.venue) + '" placeholder="NOS Events Center"></div>' +
    "</div>" +
    '<div class="field-row">' +
    '<div class="field"><label>City</label><input name="city" value="' + esc(e.city) + '"></div>' +
    '<div class="field"><label>Address <span class="hint">optional</span></label>' +
    '<input name="address" value="' + esc(e.address) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Lineup <span class="hint">optional, comma separated</span></label>' +
    '<input name="artists" value="' + esc((e.artists || []).join(", ")) + '"></div>' +
    '<div class="field"><label>Link <span class="hint">optional \u2014 the official event page</span></label>' +
    '<input name="link" value="' + esc(e.link) + '" placeholder="https://"></div>' +
    '<div class="field"><label>Notes <span class="hint">optional</span></label>' +
    '<textarea name="notes">' + esc(e.notes || "") + "</textarea></div>" +
    "</form>";
  openModal(isNew ? "Add event" : "Edit event", body,
    (isNew ? "" : '<button class="btn btn-danger btn-sm" data-act="delete-local-event" data-id="' + esc(e.id) + '">Delete</button>') +
    '<div class="spacer"></div><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-local-event" data-id="' + esc(e.id || "") + '">' +
    (isNew ? "Add" : "Save") + "</button>");
}

function saveLocalEvent(id) {
  const v = formValues($("#local-event-form"));
  if (!v.name.trim()) { alert("Give the event a name."); return; }
  if (!v.date) { alert("Pick a date."); return; }
  DB.localEvents = DB.localEvents || [];
  const existing = id ? DB.localEvents.find((x) => String(x.id) === String(id)) : null;
  const rec = existing || { id: "manual-" + uid(), manual: true };
  Object.assign(rec, {
    name: v.name.trim(), date: v.date, venue: v.venue.trim(), address: v.address.trim(),
    city: v.city.trim(), state: v.state || DB.settings.eventState || "",
    link: v.link.trim(), notes: v.notes.trim(), manual: true,
    artists: v.artists.split(",").map((a) => a.trim()).filter(Boolean),
    festival: false, ages: "",
  });
  if (!existing) DB.localEvents.push(rec);
  DB.localEvents.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  save(); closeModal(); render();
}

/* ============================================================
   GIGS
   ============================================================ */

VIEWS.gigs = function () {
  const gigs = DB.gigs.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  let html =
    '<div class="page-head"><div><h1>Gigs</h1><p>Every job, past and future. ' +
    "Mark one “completed” and it's ready to invoice.</p></div>" +
    '<div class="page-actions"><button class="btn btn-primary" data-act="new-gig">Add gig</button></div></div>';

  html += '<div class="filters">' +
    '<input type="search" id="gig-search" placeholder="Search gigs…">' +
    '<select id="gig-status">' + selectOptions(
      ["inquiry", "confirmed", "completed", "cancelled"], "", "All statuses") + "</select></div>";

  if (!gigs.length) {
    return html + '<div class="card empty"><h3>No gigs yet</h3>' +
      "<p>Add your first booking and it will show up on the calendar.</p>" +
      '<button class="btn btn-primary" data-act="new-gig">Add a gig</button></div>';
  }

  html += '<div class="card table-wrap"><table><thead><tr>' +
    "<th>Date</th><th>Gig</th><th>Client</th><th>Rate</th>" +
    '<th class="num">Value</th><th>Status</th><th>Invoice</th><th></th>' +
    "</tr></thead><tbody id=\"gig-rows\">";
  gigs.forEach((g) => {
    const inv = g.invoiceId ? invoiceById(g.invoiceId) : null;
    html += '<tr data-search="' + esc(((g.title || "") + " " + clientName(g.clientId) + " " + (g.location || "")).toLowerCase()) +
      '" data-status="' + esc(g.status || "") + '">' +
      "<td><div>" + esc(fmtDate(g.date)) + "</div>" +
      (g.startTime ? '<div class="muted" style="font-size:12px">' + esc(fmtTime(g.startTime)) +
        (g.endTime ? "–" + esc(fmtTime(g.endTime)) : "") + "</div>" : "") + "</td>" +
      '<td><div class="strong">' + esc(g.title || "Untitled gig") + "</div>" +
      (g.location ? '<div class="muted" style="font-size:12.5px">' + esc(g.location) + "</div>" : "") + "</td>" +
      "<td>" + esc(clientName(g.clientId)) + "</td>" +
      '<td class="muted">' + (g.rateType === "hourly"
        ? money(g.rate) + "/hr × " + (num(g.hours) || 0) + "h" : "flat") + "</td>" +
      '<td class="num strong">' + money(gigValue(g)) + "</td>" +
      "<td>" + statusPill(g.status) + "</td>" +
      "<td>" + (inv
        ? '<a href="#" data-act="open-invoice" data-id="' + inv.id + '">' + esc(inv.number) + "</a>"
        : g.status === "completed"
          ? '<button class="btn btn-sm" data-act="invoice-gig" data-id="' + g.id + '">Create</button>'
          : '<span class="muted">—</span>') + "</td>" +
      '<td class="actions"><button class="btn btn-sm" data-act="edit-gig" data-id="' + g.id + '">Edit</button></td></tr>';
  });
  html += "</tbody></table></div>";
  return html;
};

VIEWS.gigs.after = function () {
  const apply = () => {
    const q = ($("#gig-search").value || "").toLowerCase().trim();
    const st = $("#gig-status").value;
    $$("#gig-rows tr").forEach((tr) => {
      const okQ = !q || tr.dataset.search.includes(q);
      const okS = !st || tr.dataset.status === st;
      tr.style.display = okQ && okS ? "" : "none";
    });
  };
  const s = $("#gig-search"), st = $("#gig-status");
  if (s) { s.oninput = apply; st.onchange = apply; }
};

function gigForm(gig) {
  const g = gig || {
    id: null, title: "", clientId: "", date: todayISO(), startTime: "", endTime: "",
    location: "", rateType: "flat", rate: DB.settings.defaultHourlyRate || "", hours: "",
    status: "inquiry", notes: "",
  };
  const isNew = !g.id;

  const body =
    '<form id="gig-form">' +
    '<div class="field"><label>What is it?</label>' +
    '<input name="title" value="' + esc(g.title) + '" placeholder="e.g. Wedding photo shoot, Brand video edit" required></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Client</label><select name="clientId">' + clientOptions(g.clientId) + "</select>" +
    '<div class="hint" style="margin-top:5px"><a href="#" data-act="quick-client">+ Add a new client</a></div></div>' +
    '<div class="field"><label>Status</label><select name="status">' +
    selectOptions([
      { value: "inquiry", label: "Inquiry / tentative" }, { value: "confirmed", label: "Confirmed" },
      { value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" },
    ], g.status) + "</select></div></div>" +
    '<div class="field-row-3">' +
    '<div class="field"><label>Date</label><input type="date" name="date" value="' + esc(g.date) + '" required></div>' +
    '<div class="field"><label>Start <span class="hint">optional</span></label><input type="time" name="startTime" value="' + esc(g.startTime) + '"></div>' +
    '<div class="field"><label>End <span class="hint">optional</span></label><input type="time" name="endTime" value="' + esc(g.endTime) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Location <span class="hint">optional</span></label>' +
    '<input name="location" value="' + esc(g.location) + '" placeholder="Studio, client office, remote…"></div>' +
    '<div class="field-row-3">' +
    '<div class="field"><label>How you charge</label><select name="rateType" id="rate-type">' +
    selectOptions([{ value: "flat", label: "Flat fee" }, { value: "hourly", label: "Hourly" }], g.rateType) +
    "</select></div>" +
    '<div class="field"><label id="rate-label">' + (g.rateType === "hourly" ? "Hourly rate" : "Fee") + "</label>" +
    '<input name="rate" type="number" step="0.01" min="0" value="' + esc(g.rate) + '" placeholder="0.00"></div>' +
    '<div class="field" id="hours-field"' + (g.rateType === "hourly" ? "" : ' style="display:none"') + ">" +
    '<label>Hours</label><input name="hours" type="number" step="0.25" min="0" value="' + esc(g.hours) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Notes <span class="hint">optional</span></label>' +
    '<textarea name="notes" placeholder="Deliverables, contacts, gear, anything you want to remember">' + esc(g.notes) + "</textarea></div>" +
    "</form>";

  const foot =
    (isNew ? "" : '<button class="btn btn-danger btn-sm" data-act="delete-gig" data-id="' + g.id + '">Delete</button>') +
    '<div class="spacer"></div>' +
    (!isNew && !g.invoiceId ? '<button class="btn" data-act="invoice-gig" data-id="' + g.id + '">Create invoice</button>' : "") +
    '<button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-gig" data-id="' + (g.id || "") + '">' +
    (isNew ? "Add gig" : "Save") + "</button>";

  openModal(isNew ? "New gig" : "Edit gig", body, foot);

  const rt = $("#rate-type");
  rt.onchange = () => {
    const hourly = rt.value === "hourly";
    $("#hours-field").style.display = hourly ? "" : "none";
    $("#rate-label").textContent = hourly ? "Hourly rate" : "Fee";
  };
}

function saveGig(id) {
  const v = formValues($("#gig-form"));
  if (!v.title.trim()) { alert("Give the gig a name."); return; }
  if (!v.date) { alert("Pick a date."); return; }
  const existing = id ? gigById(id) : null;
  const g = existing || { id: uid(), invoiceId: null };
  Object.assign(g, {
    title: v.title.trim(), clientId: v.clientId, date: v.date,
    startTime: v.startTime, endTime: v.endTime, location: v.location.trim(),
    rateType: v.rateType, rate: num(v.rate), hours: num(v.hours),
    status: v.status, notes: v.notes.trim(),
  });
  if (!existing) DB.gigs.push(g);
  save();
  closeModal();
  render();
}

/* ============================================================
   INVOICES
   ============================================================ */

VIEWS.invoices = function () {
  const invs = DB.invoices.slice();
  const byStatus = (st) => invs.filter((inv) => invoiceStatus(inv) === st);
  const sum = (list) => list.reduce((s, inv) => s + (invoiceTotals(inv).total - invoicePaid(inv)), 0);

  const drafts = byStatus("draft");
  const waiting = invs.filter((inv) => ["sent", "partial"].includes(invoiceStatus(inv)));
  const overdue = byStatus("overdue");
  const owing = invs.filter((inv) => !["paid"].includes(invoiceStatus(inv)) && invoiceTotals(inv).total > 0);

  let html = '<div class="stat-trio">' +
    trio("Not sent yet", money0(sum(drafts)), "you control this", drafts.length ? "amber" : "") +
    trio("Waiting", money0(sum(waiting)), "sent, not paid yet", "") +
    trio("Overdue", money0(sum(overdue)), "past the due date", overdue.length ? "red" : "") +
    "</div>";

  html += '<div class="btn-row">' +
    '<button class="btn btn-primary" data-act="new-invoice">New invoice</button>' +
    (invs.length ? '<button class="btn" data-act="goto" data-view="clients">Clients</button>' : "") +
    "</div>";

  if (!invs.length) {
    return html + '<div class="card empty"><h3>No invoices yet</h3>' +
      "<p>Create one from scratch, or from a finished gig.</p>" +
      '<button class="btn btn-primary" data-act="new-invoice">Create an invoice</button></div>';
  }

  /* ---- Get paid: everything still owed, grouped by client ---- */
  const groups = new Map();
  owing.forEach((inv) => {
    const key = inv.clientId || "__none";
    const g = groups.get(key) || { client: clientById(inv.clientId), rows: [], total: 0 };
    g.rows.push(inv);
    g.total += invoiceTotals(inv).total - invoicePaid(inv);
    groups.set(key, g);
  });

  const totalOwed = owing.reduce((s, inv) => s + (invoiceTotals(inv).total - invoicePaid(inv)), 0);
  html += '<h2 class="section-head">Get paid' +
    (owing.length ? ' <span class="count">' + money(totalOwed) + " across " + groups.size +
      " client" + (groups.size === 1 ? "" : "s") + "</span>" : "") + "</h2>";

  if (!owing.length) {
    html += '<div class="card card-pad"><p class="muted" style="margin:0;font-size:14px">' +
      "Everything is paid. Nothing to chase.</p></div>";
  } else {
    Array.from(groups.values())
      .sort((a, b) => b.total - a.total)
      .forEach((g) => {
        const unsent = g.rows.filter((inv) => invoiceStatus(inv) === "draft").length;
        const late = g.rows.some((inv) => invoiceStatus(inv) === "overdue");
        html += '<div class="paycard ' + (late ? "tone-red" : unsent ? "tone-amber" : "tone-green") + '">' +
          '<div class="paycard-head"><span class="paycard-who">' +
          esc(g.client ? g.client.name : "No client set") + "</span>" +
          (unsent ? '<span class="pill pill-amber">' + unsent + " not sent</span>" : "") +
          '<span class="paycard-amt">' + money(g.total) + "</span></div>";

        g.rows.forEach((inv) => {
          const st = invoiceStatus(inv);
          html += '<div class="payrow">' +
            '<span class="payrow-no">' + esc(inv.number) + "</span>" +
            '<span class="pill ' + STATUS_PILL[st] + '">' + st + "</span>" +
            '<span class="payrow-amt">' + money(invoiceTotals(inv).total - invoicePaid(inv)) + "</span>" +
            '<button class="btn btn-sm" data-act="preview-invoice" data-id="' + inv.id + '">Open</button>' +
            "</div>";
        });

        const first = g.rows[0];
        html += '<div class="paycard-actions">' +
          (g.client && g.client.email
            ? '<button class="btn btn-sm btn-primary" data-act="copy-email" data-id="' + first.id + '">Copy email</button>'
            : '<button class="btn btn-sm" data-act="edit-client-of" data-id="' + first.id + '">Add an email</button>') +
          '<button class="btn btn-sm" data-act="print-invoice" data-id="' + first.id + '">PDF</button>' +
          '<button class="btn btn-sm" data-act="mark-paid" data-id="' + first.id + '">Record payment</button>' +
          "</div>";

        if (!(g.client && g.client.email)) {
          html += '<p class="paycard-note">No email on file \u2014 that\u2019s the only thing between you and ' +
            money(g.total) + ".</p>";
        }
        html += "</div>";
      });
  }

  /* ---- everything else, compact ---- */
  const settled = invs.filter((inv) => invoiceStatus(inv) === "paid");
  if (settled.length) {
    html += '<h2 class="section-head">Paid <span class="count">' + settled.length + "</span></h2>";
    settled.sort((a, b) => (b.issueDate || "").localeCompare(a.issueDate || "")).forEach((inv) => {
      html += '<div class="listrow" data-act="preview-invoice" data-id="' + inv.id + '">' +
        '<span><strong>' + esc(inv.number) + "</strong><br>" +
        '<span class="muted" style="font-size:12.5px">' + esc(clientName(inv.clientId)) + " \u00b7 " +
        esc(fmtDate(inv.issueDate)) + "</span></span>" +
        '<span class="listrow-amt">' + money(invoiceTotals(inv).total) + "</span></div>";
    });
  }

  return html;
};

function trio(label, value, sub, tone) {
  return '<div class="trio"><div class="trio-label">' + esc(label) + "</div>" +
    '<div class="trio-value ' + (tone ? "v-" + tone : "") + '">' + value + "</div>" +
    '<div class="trio-sub">' + esc(sub) + "</div></div>";
}

function nextInvoiceNumber() {
  const s = DB.settings;
  return (s.invoicePrefix || "INV-") + String(s.nextInvoiceNumber || 1).padStart(4, "0");
}

function newInvoice(fromGig) {
  const terms = num(DB.settings.paymentTerms) || 14;
  const inv = {
    id: uid(),
    number: nextInvoiceNumber(),
    clientId: fromGig ? fromGig.clientId : "",
    gigIds: fromGig ? [fromGig.id] : [],
    issueDate: todayISO(),
    dueDate: addDays(todayISO(), terms),
    items: fromGig
      ? [{
          description: fromGig.title + (fromGig.date ? " — " + fmtDate(fromGig.date) : ""),
          qty: fromGig.rateType === "hourly" ? num(fromGig.hours) || 1 : 1,
          rate: fromGig.rateType === "hourly" ? num(fromGig.rate) : gigValue(fromGig),
        }]
      : [{ description: "", qty: 1, rate: "" }],
    taxRate: num(DB.settings.defaultTaxRate),
    discount: 0,
    notes: "",
    status: "draft",
    sentDate: null,
  };
  DB.invoices.push(inv);
  DB.settings.nextInvoiceNumber = (num(DB.settings.nextInvoiceNumber) || 1) + 1;
  if (fromGig) { fromGig.invoiceId = inv.id; }
  save();
  invoiceEditor(inv.id);
}

function invoiceEditor(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  const st = invoiceStatus(inv);
  const paid = invoicePaid(inv);

  const body =
    '<form id="inv-form">' +
    '<div class="field-row">' +
    '<div class="field"><label>Invoice number</label><input name="number" value="' + esc(inv.number) + '"></div>' +
    '<div class="field"><label>Client</label><select name="clientId">' + clientOptions(inv.clientId) + "</select>" +
    '<div class="hint" style="margin-top:5px"><a href="#" data-act="quick-client">+ Add a new client</a></div></div>' +
    "</div>" +
    '<div class="field-row">' +
    '<div class="field"><label>Issue date</label><input type="date" name="issueDate" value="' + esc(inv.issueDate) + '"></div>' +
    '<div class="field"><label>Due date</label><input type="date" name="dueDate" value="' + esc(inv.dueDate || "") + '"></div>' +
    "</div>" +
    '<div class="field"><label>Line items</label>' +
    '<table class="line-items"><thead><tr><th>Description</th>' +
    '<th style="width:78px">Qty</th><th style="width:110px">Rate</th>' +
    '<th style="width:104px" class="num">Amount</th><th style="width:30px"></th></tr></thead>' +
    '<tbody id="li-body"></tbody></table>' +
    '<button type="button" class="btn btn-sm" data-act="add-line" style="margin-top:8px">+ Add line</button></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Discount <span class="hint">flat amount</span></label>' +
    '<input name="discount" type="number" step="0.01" min="0" value="' + esc(inv.discount || 0) + '" class="recalc"></div>' +
    '<div class="field"><label>Tax rate <span class="hint">%</span></label>' +
    '<input name="taxRate" type="number" step="0.01" min="0" value="' + esc(inv.taxRate || 0) + '" class="recalc"></div>' +
    "</div>" +
    '<div class="totals" id="inv-totals"></div>' +
    '<div class="field" style="margin-top:16px"><label>Note on the invoice <span class="hint">optional</span></label>' +
    '<textarea name="notes" placeholder="Anything the client should see — scope, deliverables, thanks">' + esc(inv.notes || "") + "</textarea></div>" +
    '<div class="field"><label>Status</label><select name="status">' +
    selectOptions([
      { value: "draft", label: "Draft — not sent yet" },
      { value: "sent", label: "Sent — waiting on payment" },
      { value: "paid", label: "Paid in full" },
    ], inv.status) + "</select>" +
    (paid > 0 ? '<div class="hint" style="margin-top:5px">' + money(paid) + " already recorded against this invoice.</div>" : "") +
    "</div></form>";

  const foot =
    '<button class="btn btn-danger btn-sm" data-act="delete-invoice" data-id="' + inv.id + '">Delete</button>' +
    '<div class="spacer"></div>' +
    (st !== "paid"
      ? '<button class="btn" data-act="mark-paid" data-id="' + inv.id + '">Record payment</button>' : "") +
    '<button class="btn" data-act="save-invoice" data-id="' + inv.id + '" data-then="preview">Save &amp; view</button>' +
    '<button class="btn btn-primary" data-act="save-invoice" data-id="' + inv.id + '">Save</button>';

  openModal("Invoice " + inv.number, body, foot, { wide: true });

  renderLineItems(inv.items && inv.items.length ? inv.items : [{ description: "", qty: 1, rate: "" }]);
  recalcInvoice();
}

function renderLineItems(items) {
  const body = $("#li-body");
  body.innerHTML = items.map((it, i) =>
    '<tr data-i="' + i + '">' +
    '<td><input class="li-desc recalc" value="' + esc(it.description || "") + '" placeholder="What you did"></td>' +
    '<td><input class="li-qty recalc" type="number" step="0.25" value="' + esc(it.qty == null ? 1 : it.qty) + '"></td>' +
    '<td><input class="li-rate recalc" type="number" step="0.01" value="' + esc(it.rate == null ? "" : it.rate) + '" placeholder="0.00"></td>' +
    '<td class="li-total">' + money(num(it.qty) * num(it.rate)) + "</td>" +
    '<td><button type="button" class="btn btn-ghost btn-sm" data-act="del-line">×</button></td></tr>').join("");
}

function readLineItems() {
  return $$("#li-body tr").map((tr) => ({
    description: $(".li-desc", tr).value,
    qty: num($(".li-qty", tr).value),
    rate: num($(".li-rate", tr).value),
  }));
}

function recalcInvoice() {
  const form = $("#inv-form");
  if (!form) return;
  const items = readLineItems();
  $$("#li-body tr").forEach((tr, i) => {
    $(".li-total", tr).textContent = money(items[i].qty * items[i].rate);
  });
  const draft = {
    items,
    discount: num(form.discount.value),
    taxRate: num(form.taxRate.value),
  };
  const t = invoiceTotals(draft);
  $("#inv-totals").innerHTML =
    "<div><span>Subtotal</span><span>" + money(t.subtotal) + "</span></div>" +
    (t.discount ? "<div><span>Discount</span><span>-" + money(t.discount) + "</span></div>" : "") +
    (t.tax ? "<div><span>Tax (" + draft.taxRate + "%)</span><span>" + money(t.tax) + "</span></div>" : "") +
    '<div class="grand"><span>Total</span><span>' + money(t.total) + "</span></div>";
}

function saveInvoice(id, then) {
  const inv = invoiceById(id);
  const v = formValues($("#inv-form"));
  const items = readLineItems().filter((it) => it.description.trim() || it.rate);
  Object.assign(inv, {
    number: v.number.trim() || inv.number,
    clientId: v.clientId,
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    items: items.length ? items : [{ description: "", qty: 1, rate: 0 }],
    discount: num(v.discount),
    taxRate: num(v.taxRate),
    notes: v.notes.trim(),
    status: v.status,
  });
  if (v.status === "sent" && !inv.sentDate) inv.sentDate = todayISO();

  // "Paid in full" with nothing recorded yet? Log the payment so the money
  // actually shows up in the income totals rather than silently vanishing.
  if (v.status === "paid") {
    const owed = invoiceTotals(inv).total - invoicePaid(inv);
    if (owed > 0.005) {
      recordPayment(inv, { date: todayISO(), amount: owed, method: "", notes: "" });
    }
  }
  save();
  closeModal();
  if (then === "preview") previewInvoice(id);
  else render();
}

function recordPayment(inv, p) {
  DB.income.push({
    id: uid(),
    date: p.date || todayISO(),
    amount: num(p.amount),
    clientId: inv.clientId,
    invoiceId: inv.id,
    source: "Invoice " + inv.number,
    method: p.method || "",
    category: "Client work",
    notes: p.notes || "",
  });
  if (invoicePaid(inv) >= invoiceTotals(inv).total - 0.005) inv.status = "paid";
}

function markPaidDialog(id) {
  const inv = invoiceById(id);
  const owed = invoiceTotals(inv).total - invoicePaid(inv);
  const body =
    '<form id="pay-form">' +
    '<p class="muted" style="margin-top:0;font-size:13.5px">' + esc(inv.number) + " · " +
    esc(clientName(inv.clientId)) + " · " + money(owed) + " outstanding</p>" +
    '<div class="field-row">' +
    '<div class="field"><label>Date received</label><input type="date" name="date" value="' + todayISO() + '"></div>' +
    '<div class="field"><label>Amount</label><input type="number" step="0.01" name="amount" value="' + owed.toFixed(2) + '"></div>' +
    "</div>" +
    '<div class="field"><label>How were you paid?</label><select name="method">' +
    selectOptions(PAYMENT_METHODS, "", "— Not specified —") + "</select></div>" +
    '<div class="field"><label>Notes <span class="hint">optional</span></label><input name="notes"></div>' +
    "</form>";
  openModal("Record a payment", body,
    '<button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="confirm-payment" data-id="' + inv.id + '">Record it</button>');
}

/* ---------- invoice document ---------- */

function invoiceHTML(inv, forPrint) {
  const s = DB.settings;
  const c = clientById(inv.clientId);
  const t = invoiceTotals(inv);
  const st = invoiceStatus(inv);
  const paid = invoicePaid(inv);

  const fromLines = [s.address, s.email, s.phone, s.website, s.taxId ? "Tax ID: " + s.taxId : ""]
    .filter(Boolean).map((l) => "<div>" + esc(l).replace(/\n/g, "<br>") + "</div>").join("");

  const toLines = c
    ? [c.contactName, c.address, c.email, c.phone].filter(Boolean)
        .map((l) => "<div>" + esc(l).replace(/\n/g, "<br>") + "</div>").join("")
    : "";

  const rows = (inv.items || []).filter((it) => it.description || it.rate).map((it) =>
    "<tr><td>" + esc(it.description) + "</td>" +
    '<td class="num">' + (num(it.qty) || 0) + "</td>" +
    '<td class="num">' + money(it.rate) + "</td>" +
    '<td class="num">' + money(num(it.qty) * num(it.rate)) + "</td></tr>").join("");

  return '<div class="inv-doc">' +
    '<div class="inv-top">' +
    '<div class="inv-from"><h1>' + esc(s.businessName || s.yourName || "Your business") + "</h1>" +
    (s.businessName && s.yourName ? "<div>" + esc(s.yourName) + "</div>" : "") +
    fromLines + "</div>" +
    '<div class="inv-meta">' +
    (st === "paid" ? '<div class="paid-stamp">PAID</div>' : "") +
    '<div class="word">Invoice</div><table><tbody>' +
    "<tr><td>Number</td><td>" + esc(inv.number) + "</td></tr>" +
    "<tr><td>Issued</td><td>" + esc(fmtDate(inv.issueDate)) + "</td></tr>" +
    (inv.dueDate ? "<tr><td>Due</td><td>" + esc(fmtDate(inv.dueDate)) + "</td></tr>" : "") +
    "</tbody></table></div></div>" +
    '<div class="inv-billto"><div class="lbl">Bill to</div>' +
    '<div class="who">' + esc(c ? c.name : "—") + "</div>" + toLines + "</div>" +
    '<table class="inv-table"><thead><tr><th>Description</th>' +
    '<th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr></thead>' +
    "<tbody>" + rows + "</tbody></table>" +
    '<div class="inv-totals">' +
    "<div><span>Subtotal</span><span>" + money(t.subtotal) + "</span></div>" +
    (t.discount ? "<div><span>Discount</span><span>-" + money(t.discount) + "</span></div>" : "") +
    (t.tax ? "<div><span>Tax (" + num(inv.taxRate) + "%)</span><span>" + money(t.tax) + "</span></div>" : "") +
    '<div class="grand"><span>' + (st === "paid" ? "Total paid" : "Amount due") + "</span><span>" + money(t.total) + "</span></div>" +
    (paid > 0 && st !== "paid"
      ? "<div><span>Received</span><span>-" + money(paid) + "</span></div>" +
        '<div class="grand"><span>Balance</span><span>' + money(t.total - paid) + "</span></div>"
      : "") +
    "</div>" +
    '<div class="inv-pay">' +
    (s.paymentInstructions
      ? '<div class="block"><div class="lbl">How to pay</div><div class="body">' + esc(s.paymentInstructions) + "</div></div>" : "") +
    (inv.notes ? '<div class="block"><div class="lbl">Notes</div><div class="body">' + esc(inv.notes) + "</div></div>" : "") +
    "</div>" +
    (s.invoiceFooter ? '<div class="inv-foot">' + esc(s.invoiceFooter) + "</div>" : "") +
    "</div>";
}

function previewInvoice(id) {
  const inv = invoiceById(id);
  if (!inv) return;
  const warn = !setupComplete()
    ? '<div class="notice" style="margin:0 0 14px"><div>Your business details are blank — the invoice header will look empty. ' +
      "Fill them in once in Settings and every invoice picks them up.</div>" +
      '<button class="btn btn-sm" data-act="goto" data-view="settings">Settings</button></div>' : "";
  openModal("Invoice " + inv.number,
    warn + '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
    invoiceHTML(inv) + "</div>",
    '<button class="btn" data-act="open-invoice" data-id="' + inv.id + '">Edit</button>' +
    '<div class="spacer"></div>' +
    '<button class="btn" data-act="copy-email" data-id="' + inv.id + '">Copy email text</button>' +
    '<button class="btn btn-primary" data-act="print-invoice" data-id="' + inv.id + '">Save as PDF</button>',
    { wide: true, noFocus: true });
}

function printInvoice(id) {
  const inv = invoiceById(id);
  $("#invoice-print").innerHTML = invoiceHTML(inv, true);
  const prevTitle = document.title;
  // Safari and Chrome both use document.title as the default PDF filename.
  document.title = inv.number + (clientById(inv.clientId) ? " " + clientById(inv.clientId).name : "");
  window.print();
  setTimeout(() => { document.title = prevTitle; $("#invoice-print").innerHTML = ""; }, 800);
}

function emailText(inv) {
  const s = DB.settings;
  const c = clientById(inv.clientId);
  const t = invoiceTotals(inv);
  return "Hi " + ((c && (c.contactName || c.name)) || "there") + ",\n\n" +
    "Please find attached invoice " + inv.number + " for " + money(t.total) + "" +
    (inv.dueDate ? ", due " + fmtDateLong(inv.dueDate) : "") + ".\n\n" +
    (inv.items || []).filter((i) => i.description).map((i) => "  • " + i.description).join("\n") +
    "\n\n" + (s.paymentInstructions ? s.paymentInstructions + "\n\n" : "") +
    "Any questions, just reply to this email.\n\nThanks,\n" + (s.yourName || s.businessName || "");
}

/* ============================================================
   INCOME
   ============================================================ */

VIEWS.income = function () {
  const r = periodRange();
  const rows = DB.income.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const inPeriod = rows.filter((i) => inRange(i.date, r));
  const total = inPeriod.reduce((s, i) => s + num(i.amount), 0);

  let html =
    '<div class="page-head"><div><h1>Income</h1><p>' + money(total) + " received in " + esc(r.label) +
    ". Invoice payments land here automatically.</p></div>" +
    '<div class="page-actions">' + periodPicker() +
    '<button class="btn btn-primary" data-act="new-income">Log income</button></div></div>';

  if (!rows.length) {
    return html + '<div class="card empty"><h3>No income logged yet</h3>' +
      "<p>Record a payment on an invoice, or log money that came in some other way.</p>" +
      '<button class="btn btn-primary" data-act="new-income">Log income</button></div>';
  }

  html += '<div class="card table-wrap"><table><thead><tr>' +
    "<th>Date</th><th>From</th><th>Invoice</th><th>Method</th>" +
    '<th class="num">Amount</th><th></th></tr></thead><tbody>';
  inPeriod.forEach((i) => {
    const inv = i.invoiceId ? invoiceById(i.invoiceId) : null;
    html += "<tr><td>" + esc(fmtDate(i.date)) + "</td>" +
      '<td><div class="strong">' + esc(i.clientId ? clientName(i.clientId) : i.source || "—") + "</div>" +
      (i.notes ? '<div class="muted" style="font-size:12.5px">' + esc(i.notes) + "</div>" : "") + "</td>" +
      "<td>" + (inv ? '<a href="#" data-act="preview-invoice" data-id="' + inv.id + '">' + esc(inv.number) + "</a>"
        : '<span class="muted">—</span>') + "</td>" +
      '<td class="muted">' + esc(i.method || "—") + "</td>" +
      '<td class="num strong" style="color:var(--money-in)">' + money(i.amount) + "</td>" +
      '<td class="actions"><button class="btn btn-sm" data-act="edit-income" data-id="' + i.id + '">Edit</button></td></tr>';
  });
  if (!inPeriod.length) {
    html += '<tr><td colspan="6" class="muted" style="text-align:center;padding:28px">Nothing in ' + esc(r.label) + ".</td></tr>";
  }
  html += "</tbody></table></div>";
  return html;
};
VIEWS.income.after = periodPickerAfter;

function incomeForm(rec) {
  const i = rec || { id: null, date: todayISO(), amount: "", clientId: "", source: "", method: "", notes: "", invoiceId: null };
  const linked = i.invoiceId ? invoiceById(i.invoiceId) : null;
  const body =
    '<form id="income-form">' +
    (linked ? '<p class="muted" style="margin-top:0;font-size:13.5px">Linked to invoice ' + esc(linked.number) + ".</p>" : "") +
    '<div class="field-row">' +
    '<div class="field"><label>Date received</label><input type="date" name="date" value="' + esc(i.date) + '" required></div>' +
    '<div class="field"><label>Amount</label><input type="number" step="0.01" name="amount" value="' + esc(i.amount) + '" required></div>' +
    "</div>" +
    '<div class="field"><label>Client</label><select name="clientId">' + clientOptions(i.clientId) + "</select></div>" +
    '<div class="field"><label>Or describe the source <span class="hint">if it wasn\'t a client</span></label>' +
    '<input name="source" value="' + esc(i.source) + '" placeholder="Print sales, licensing, workshop…"></div>' +
    '<div class="field"><label>How you were paid</label><select name="method">' +
    selectOptions(PAYMENT_METHODS, i.method, "— Not specified —") + "</select></div>" +
    '<div class="field"><label>Notes <span class="hint">optional</span></label><input name="notes" value="' + esc(i.notes) + '"></div>' +
    "</form>";
  openModal(i.id ? "Edit income" : "Log income", body,
    (i.id ? '<button class="btn btn-danger btn-sm" data-act="delete-income" data-id="' + i.id + '">Delete</button>' : "") +
    '<div class="spacer"></div><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-income" data-id="' + (i.id || "") + '">Save</button>');
}

function saveIncome(id) {
  const v = formValues($("#income-form"));
  if (!num(v.amount)) { alert("Enter an amount."); return; }
  const existing = id ? DB.income.find((x) => x.id === id) : null;
  const rec = existing || { id: uid(), invoiceId: null, category: "Client work" };
  Object.assign(rec, {
    date: v.date, amount: num(v.amount), clientId: v.clientId,
    source: v.source.trim(), method: v.method, notes: v.notes.trim(),
  });
  if (!existing) DB.income.push(rec);
  if (rec.invoiceId) {
    const inv = invoiceById(rec.invoiceId);
    if (inv) inv.status = invoicePaid(inv) >= invoiceTotals(inv).total - 0.005 ? "paid" : "sent";
  }
  save(); closeModal(); render();
}

/* ============================================================
   EXPENSES
   ============================================================ */

VIEWS.expenses = function () {
  const r = periodRange();
  const rows = DB.expenses.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const inPeriod = rows.filter((e) => inRange(e.date, r));
  const total = inPeriod.reduce((s, e) => s + num(e.amount), 0);
  const deductible = inPeriod.filter((e) => e.deductible).reduce((s, e) => s + num(e.amount), 0);

  let html =
    '<div class="page-head"><div><h1>Expenses</h1><p>' + money(total) + " spent in " + esc(r.label) +
    " · " + money(deductible) + " marked deductible.</p></div>" +
    '<div class="page-actions">' + periodPicker() +
    '<button class="btn btn-primary" data-act="new-expense">Log expense</button></div></div>';

  if (!rows.length) {
    return html + '<div class="card empty"><h3>No expenses yet</h3>' +
      "<p>Gear, software, travel, that coffee with a client — log it and it comes off your net.</p>" +
      '<button class="btn btn-primary" data-act="new-expense">Log an expense</button></div>';
  }

  html += '<div class="card table-wrap"><table><thead><tr>' +
    "<th>Date</th><th>What</th><th>Category</th><th>Method</th>" +
    '<th class="num">Amount</th><th></th></tr></thead><tbody>';
  inPeriod.forEach((e) => {
    html += "<tr><td>" + esc(fmtDate(e.date)) + "</td>" +
      '<td><div class="strong">' + esc(e.vendor || "—") + "</div>" +
      (e.notes ? '<div class="muted" style="font-size:12.5px">' + esc(e.notes) + "</div>" : "") + "</td>" +
      '<td><span class="pill pill-gray">' + esc(e.category || "Uncategorised") + "</span>" +
      (e.deductible ? ' <span class="pill pill-green">deductible</span>' : "") + "</td>" +
      '<td class="muted">' + esc(e.method || "—") + "</td>" +
      '<td class="num strong" style="color:var(--money-out)">' + money(e.amount) + "</td>" +
      '<td class="actions"><button class="btn btn-sm" data-act="edit-expense" data-id="' + e.id + '">Edit</button></td></tr>';
  });
  if (!inPeriod.length) {
    html += '<tr><td colspan="6" class="muted" style="text-align:center;padding:28px">Nothing in ' + esc(r.label) + ".</td></tr>";
  }
  html += "</tbody></table></div>";
  return html;
};
VIEWS.expenses.after = periodPickerAfter;

function expenseForm(rec) {
  const e = rec || { id: null, date: todayISO(), amount: "", vendor: "", category: "", method: "", deductible: true, notes: "" };
  const body =
    '<form id="expense-form">' +
    '<div class="field-row">' +
    '<div class="field"><label>Date</label><input type="date" name="date" value="' + esc(e.date) + '" required></div>' +
    '<div class="field"><label>Amount</label><input type="number" step="0.01" name="amount" value="' + esc(e.amount) + '" required></div>' +
    "</div>" +
    '<div class="field"><label>Paid to / what for</label>' +
    '<input name="vendor" value="' + esc(e.vendor) + '" placeholder="Adobe, B&amp;H Photo, Uber…" required></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Category</label><select name="category">' +
    selectOptions(EXPENSE_CATEGORIES, e.category, "— Pick one —") + "</select></div>" +
    '<div class="field"><label>Paid with</label><select name="method">' +
    selectOptions(PAYMENT_METHODS, e.method, "— Not specified —") + "</select></div>" +
    "</div>" +
    '<div class="field check"><input type="checkbox" id="ded" name="deductible"' + (e.deductible ? " checked" : "") + ">" +
    '<label for="ded">Business expense (counts as deductible)</label></div>' +
    '<div class="field"><label>Notes <span class="hint">optional</span></label><input name="notes" value="' + esc(e.notes) + '"></div>' +
    "</form>";
  openModal(e.id ? "Edit expense" : "Log expense", body,
    (e.id ? '<button class="btn btn-danger btn-sm" data-act="delete-expense" data-id="' + e.id + '">Delete</button>' : "") +
    '<div class="spacer"></div><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-expense" data-id="' + (e.id || "") + '">Save</button>');
}

function saveExpense(id) {
  const v = formValues($("#expense-form"));
  if (!num(v.amount)) { alert("Enter an amount."); return; }
  const existing = id ? DB.expenses.find((x) => x.id === id) : null;
  const rec = existing || { id: uid() };
  Object.assign(rec, {
    date: v.date, amount: num(v.amount), vendor: v.vendor.trim(),
    category: v.category, method: v.method, deductible: !!v.deductible, notes: v.notes.trim(),
  });
  if (!existing) DB.expenses.push(rec);
  save(); closeModal(); render();
}

/* ============================================================
   CLIENTS
   ============================================================ */

VIEWS.clients = function () {
  let html =
    '<div class="page-head"><div><h1>Clients</h1><p>Saved once, reused on every gig and invoice.</p></div>' +
    '<div class="page-actions"><button class="btn btn-primary" data-act="new-client">Add client</button></div></div>';

  if (!DB.clients.length) {
    return html + '<div class="card empty"><h3>No clients yet</h3>' +
      "<p>Add one and their billing details fill in automatically on invoices.</p>" +
      '<button class="btn btn-primary" data-act="new-client">Add a client</button></div>';
  }

  html += '<div class="card table-wrap"><table><thead><tr>' +
    "<th>Client</th><th>Contact</th><th>Gigs</th>" +
    '<th class="num">Billed</th><th class="num">Paid</th><th class="num">Owed</th><th></th>' +
    "</tr></thead><tbody>";
  DB.clients.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((c) => {
    const invs = DB.invoices.filter((i) => i.clientId === c.id && i.status !== "draft");
    const billed = invs.reduce((s, i) => s + invoiceTotals(i).total, 0);
    const paid = DB.income.filter((i) => i.clientId === c.id).reduce((s, i) => s + num(i.amount), 0);
    const gigCount = DB.gigs.filter((g) => g.clientId === c.id).length;
    const owed = invs.reduce((s, i) => s + (invoiceStatus(i) === "paid" ? 0 : invoiceTotals(i).total - invoicePaid(i)), 0);
    html += '<tr><td><div class="strong">' + esc(c.name) + "</div>" +
      (c.rate ? '<div class="muted" style="font-size:12.5px">' + money(c.rate) + "/hr</div>" : "") + "</td>" +
      "<td>" + (c.contactName ? esc(c.contactName) + "<br>" : "") +
      '<span class="muted" style="font-size:12.5px">' + esc(c.email || "") + "</span></td>" +
      '<td class="muted">' + gigCount + "</td>" +
      '<td class="num">' + money(billed) + "</td>" +
      '<td class="num" style="color:var(--money-in)">' + money(paid) + "</td>" +
      '<td class="num strong">' + (owed > 0.005 ? money(owed) : '<span class="muted">—</span>') + "</td>" +
      '<td class="actions"><button class="btn btn-sm" data-act="edit-client" data-id="' + c.id + '">Edit</button></td></tr>';
  });
  html += "</tbody></table></div>";
  return html;
};

function clientForm(rec, opts = {}) {
  const c = rec || { id: null, name: "", contactName: "", email: "", phone: "", address: "", rate: "", notes: "" };
  const body =
    '<form id="client-form">' +
    '<div class="field"><label>Client or company name</label>' +
    '<input name="name" value="' + esc(c.name) + '" required></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Contact person <span class="hint">optional</span></label><input name="contactName" value="' + esc(c.contactName) + '"></div>' +
    '<div class="field"><label>Email</label><input type="email" name="email" value="' + esc(c.email) + '"></div>' +
    "</div>" +
    '<div class="field-row">' +
    '<div class="field"><label>Phone <span class="hint">optional</span></label><input name="phone" value="' + esc(c.phone) + '"></div>' +
    '<div class="field"><label>Their usual rate <span class="hint">optional, per hour</span></label>' +
    '<input type="number" step="0.01" name="rate" value="' + esc(c.rate) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Billing address <span class="hint">appears on their invoices</span></label>' +
    '<textarea name="address">' + esc(c.address) + "</textarea></div>" +
    '<div class="field"><label>Notes <span class="hint">optional</span></label><input name="notes" value="' + esc(c.notes) + '"></div>' +
    "</form>";
  openModal(c.id ? "Edit client" : "New client", body,
    (c.id ? '<button class="btn btn-danger btn-sm" data-act="delete-client" data-id="' + c.id + '">Delete</button>' : "") +
    '<div class="spacer"></div><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-client" data-id="' + (c.id || "") +
    '" data-return="' + esc(opts.returnTo || "") + '">Save</button>');
}

function saveClient(id, returnTo) {
  const v = formValues($("#client-form"));
  if (!v.name.trim()) { alert("Give the client a name."); return; }
  const existing = id ? clientById(id) : null;
  const c = existing || { id: uid() };
  Object.assign(c, {
    name: v.name.trim(), contactName: v.contactName.trim(), email: v.email.trim(),
    phone: v.phone.trim(), address: v.address.trim(), rate: num(v.rate), notes: v.notes.trim(),
  });
  if (!existing) DB.clients.push(c);
  save();
  closeModal();
  // If this was opened from inside a gig or invoice form, reopen that form with
  // the new client already selected instead of dumping the user back to a list.
  if (returnTo === "gig") { gigForm(window.__pendingGig); if ($("#gig-form")) $("#gig-form").clientId.value = c.id; }
  else if (returnTo && returnTo.startsWith("invoice:")) {
    const inv = invoiceById(returnTo.slice(8));
    if (inv) { inv.clientId = c.id; save(); invoiceEditor(inv.id); }
  } else render();
}

/* ============================================================
   OUTREACH
   ============================================================ */

const OUTREACH_STATUSES = [
  { value: "to-contact", label: "To contact", pill: "pill-gray" },
  { value: "contacted", label: "Contacted", pill: "pill-blue" },
  { value: "follow-up", label: "Needs follow-up", pill: "pill-amber" },
  { value: "replied", label: "Replied", pill: "pill-blue" },
  { value: "booked", label: "Booked", pill: "pill-green" },
  { value: "passed", label: "Passed", pill: "pill-gray" },
];

const outreachLabel = (v) => (OUTREACH_STATUSES.find((s) => s.value === v) || {}).label || v;
const outreachPill = (v) => (OUTREACH_STATUSES.find((s) => s.value === v) || {}).pill || "pill-gray";

// Venues appearing in the local events feed that aren't in the pipeline yet.
function venueSuggestions() {
  const known = new Set((DB.outreach || []).map((o) => (o.venue || "").toLowerCase()).filter(Boolean));
  const map = new Map();
  (DB.localEvents || []).forEach((e) => {
    if (!e.venue) return;
    const key = e.venue.toLowerCase();
    if (known.has(key)) return;
    const entry = map.get(key) || { venue: e.venue, city: e.city, shows: 0, next: null };
    entry.shows += 1;
    if (!entry.next || e.date < entry.next) entry.next = e.date;
    map.set(key, entry);
  });
  return Array.from(map.values()).sort((a, b) => b.shows - a.shows);
}

VIEWS.outreach = function () {
  const rows = (DB.outreach || []).slice();
  const count = (v) => rows.filter((r) => r.status === v).length;
  const today = todayISO();
  const due = rows.filter((r) => r.nextFollowUp && r.nextFollowUp <= today &&
    !["booked", "passed"].includes(r.status));

  let html = '<div class="stat-trio">' +
    trio("To contact", count("to-contact"), "warm leads first", count("to-contact") ? "amber" : "") +
    trio("Waiting on reply", count("contacted") + count("follow-up"), "sent, no answer yet", "") +
    trio("Booked", count("booked"), "turned into work", count("booked") ? "green" : "") +
    "</div>";

  if (due.length) {
    html += '<div class="nudge tone-amber"><div class="nudge-text">' +
      "<strong>" + due.length + " follow-up" + (due.length === 1 ? "" : "s") + " due</strong> \u2014 " +
      esc(due.slice(0, 2).map((r) => r.venue).join(", ")) +
      (due.length > 2 ? " and " + (due.length - 2) + " more" : "") + ".</div></div>";
  }

  const filters = [
    { key: "", label: "Everything", n: rows.length },
    { key: "to-contact", label: "To contact", n: count("to-contact") },
    { key: "contacted", label: "Waiting", n: count("contacted") + count("follow-up") },
    { key: "replied", label: "Replied", n: count("replied") },
    { key: "booked", label: "Booked", n: count("booked") },
  ];
  html += '<div class="chips">' + filters.map((f) =>
    '<button class="chip' + ((state.outreachFilter || "") === f.key ? " active" : "") +
    '" data-act="outreach-filter" data-key="' + f.key + '">' + esc(f.label) +
    '<span class="n">' + f.n + "</span></button>").join("") + "</div>";

  html += '<div class="btn-row">' +
    '<button class="btn btn-primary" data-act="new-outreach">Add venue</button>' +
    '<button class="btn" data-act="refresh-events">Refresh local shows</button>' +
    '<button class="btn" data-act="goto" data-view="clients">Clients</button></div>';

  /* ---- pipeline ---- */
  const active = state.outreachFilter
    ? rows.filter((r) => state.outreachFilter === "contacted"
        ? ["contacted", "follow-up"].includes(r.status)
        : r.status === state.outreachFilter)
    : rows;

  html += '<h2 class="section-head">Pipeline' +
    (active.length ? ' <span class="count">' + active.length + "</span>" : "") + "</h2>";

  if (!rows.length) {
    html += '<div class="card empty"><h3>Nobody in the pipeline yet</h3>' +
      "<p>Add a venue by hand, or pull local shows and pick from the venues already " +
      "booking acts near you.</p>" +
      '<button class="btn btn-primary" data-act="new-outreach">Add a venue</button></div>';
  } else if (!active.length) {
    html += '<div class="card card-pad"><p class="muted" style="margin:0;font-size:14px">' +
      "Nothing at this stage.</p></div>";
  } else {
    const order = OUTREACH_STATUSES.map((x) => x.value);
    active.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) ||
      (a.venue || "").localeCompare(b.venue || ""));
    active.forEach((r) => {
      const overdue = r.nextFollowUp && r.nextFollowUp <= today &&
        !["booked", "passed"].includes(r.status);
      html += '<div class="paycard ' + (overdue ? "tone-red" : "tone-green") +
        '" data-act="edit-outreach" data-id="' + r.id + '" style="cursor:pointer">' +
        '<div class="paycard-head" style="border-bottom:0;padding-bottom:0">' +
        '<span class="paycard-who">' + esc(r.venue || "\u2014") + "</span>" +
        '<span class="pill ' + outreachPill(r.status) + '">' + esc(outreachLabel(r.status)) + "</span>" +
        "</div>";
      const bits = [];
      if (r.contactName) bits.push(esc(r.contactName));
      if (r.email) bits.push(esc(r.email));
      if (r.phone) bits.push(esc(r.phone));
      if (bits.length) html += '<p class="paycard-note" style="margin-top:8px">' + bits.join(" \u00b7 ") + "</p>";
      const when = [];
      if (r.lastContact) when.push("last contact " + esc(fmtDate(r.lastContact, { month: "short", day: "numeric" })));
      if (r.nextFollowUp) {
        when.push((overdue ? "<strong>follow up " : "follow up ") +
          esc(fmtDate(r.nextFollowUp, { month: "short", day: "numeric" })) + (overdue ? "</strong>" : ""));
      }
      if (when.length) html += '<p class="paycard-note" style="margin-top:4px">' + when.join(" \u00b7 ") + "</p>";
      html += "</div>";
    });
  }

  /* ---- venues from the local shows feed ---- */
  const suggestions = venueSuggestions();
  html += '<h2 class="section-head">Venues booking near you</h2>';
  if (!(DB.localEvents || []).length) {
    html += '<div class="card card-pad"><p class="muted" style="margin:0 0 12px;font-size:14px">' +
      "Pull the local shows feed and every venue putting on events nearby shows up here.</p>" +
      '<button class="btn btn-sm" data-act="goto" data-view="calendar">See Local Events</button></div>';
  } else if (!suggestions.length) {
    html += '<div class="card card-pad"><p class="muted" style="margin:0;font-size:14px">' +
      "Every venue in the feed is already in your pipeline.</p></div>";
  } else {
    suggestions.slice(0, 12).forEach((v) => {
      html += '<div class="listrow"><span><strong>' + esc(v.venue) + "</strong><br>" +
        '<span class="muted" style="font-size:12.5px">' + v.shows + " show" + (v.shows === 1 ? "" : "s") +
        " \u00b7 next " + esc(fmtDate(v.next, { month: "short", day: "numeric" })) + "</span></span>" +
        '<button class="btn btn-sm" data-act="outreach-from-venue" data-venue="' + esc(v.venue) + '">Add</button></div>';
    });
  }

  return html;
};

function outreachForm(rec) {
  const r = rec || {
    id: null, venue: "", contactName: "", email: "", phone: "", website: "",
    status: "to-contact", lastContact: "", nextFollowUp: "", notes: "",
  };
  const body =
    '<form id="outreach-form">' +
    '<div class="field"><label>Venue or promoter</label>' +
    '<input name="venue" value="' + esc(r.venue) + '" required></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Contact person <span class="hint">optional</span></label>' +
    '<input name="contactName" value="' + esc(r.contactName) + '"></div>' +
    '<div class="field"><label>Email</label><input type="email" name="email" value="' + esc(r.email) + '"></div>' +
    "</div>" +
    '<div class="field-row">' +
    '<div class="field"><label>Phone <span class="hint">optional</span></label>' +
    '<input name="phone" value="' + esc(r.phone) + '"></div>' +
    '<div class="field"><label>Website <span class="hint">optional</span></label>' +
    '<input name="website" value="' + esc(r.website) + '"></div>' +
    "</div>" +
    '<div class="field-row-3">' +
    '<div class="field"><label>Status</label><select name="status">' +
    selectOptions(OUTREACH_STATUSES.map((s) => ({ value: s.value, label: s.label })), r.status) + "</select></div>" +
    '<div class="field"><label>Last contact</label><input type="date" name="lastContact" value="' + esc(r.lastContact) + '"></div>' +
    '<div class="field"><label>Follow up on</label><input type="date" name="nextFollowUp" value="' + esc(r.nextFollowUp) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Notes <span class="hint">what you pitched, who you spoke to</span></label>' +
    '<textarea name="notes">' + esc(r.notes) + "</textarea></div>" +
    "</form>";
  openModal(r.id ? "Edit outreach" : "Add venue to outreach", body,
    (r.id ? '<button class="btn btn-danger btn-sm" data-act="delete-outreach" data-id="' + r.id + '">Delete</button>' : "") +
    '<div class="spacer"></div><button class="btn" data-act="close-modal">Cancel</button>' +
    '<button class="btn btn-primary" data-act="save-outreach" data-id="' + (r.id || "") + '">Save</button>');
}

function saveOutreach(id) {
  const v = formValues($("#outreach-form"));
  if (!v.venue.trim()) { alert("Give the venue a name."); return; }
  const existing = id ? (DB.outreach || []).find((x) => x.id === id) : null;
  const rec = existing || { id: uid() };
  Object.assign(rec, {
    venue: v.venue.trim(), contactName: v.contactName.trim(), email: v.email.trim(),
    phone: v.phone.trim(), website: v.website.trim(), status: v.status,
    lastContact: v.lastContact, nextFollowUp: v.nextFollowUp, notes: v.notes.trim(),
  });
  if (!existing) { DB.outreach = DB.outreach || []; DB.outreach.push(rec); }
  save(); closeModal(); render();
}

/* ---------- pulling the local events feed ---------- */

let refreshing = false;

// Edmtrain's API sends access-control-allow-origin: *, so the browser can call
// it directly - no server needed. Their terms allow this via the API only.
async function edmtrainGet(path, params, key) {
  const q = new URLSearchParams(Object.assign({}, params, { client: key }));
  const res = await fetch("https://edmtrain.com/api/" + path + "?" + q.toString());
  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new Error("Edmtrain sent back something unreadable (HTTP " + res.status + ").");
  }
  if (payload && payload.success === false) {
    throw new Error(payload.message || "Edmtrain rejected the request.");
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error("Edmtrain rejected the API key. Check it in Settings.");
    if (res.status === 429) throw new Error("Edmtrain is rate-limiting us. Try again shortly.");
    throw new Error("Edmtrain returned HTTP " + res.status + ".");
  }
  return (payload && payload.data) || [];
}

async function refreshEvents(quiet) {
  if (refreshing) return;
  const key = (DB.settings.edmtrainKey || "").trim();
  if (!key) {
    if (!quiet) { state.view = "calendar"; state.calMode = "events"; render(); }
    return;
  }
  refreshing = true;
  if (!quiet) setSaveState("Fetching\u2026", "saving");
  try {
    const city = (DB.settings.eventCity || "Los Angeles").trim();
    const st = (DB.settings.eventState || "California").trim();

    const locations = await edmtrainGet("locations", { city: city, state: st }, key);
    const ids = locations.map((l) => l.id).filter((x) => x != null);
    if (!ids.length) throw new Error("Edmtrain has no location matching " + city + ", " + st + ".");

    const today = todayISO();
    const end = addDays(today, num(DB.settings.eventLookaheadDays) || 120);
    const raw = await edmtrainGet("events",
      { locationIds: ids.join(","), startDate: today, endDate: end }, key);

    const fetched = raw.map((e) => {
      const venue = e.venue || {};
      const artists = (e.artistList || []).map((a) => a.name).filter(Boolean);
      return {
        id: String(e.id),
        name: e.name || artists.join(", ") || "Untitled event",
        date: e.date,
        link: e.link || "",          // their terms require this shown unmodified
        venue: venue.name || "",
        address: venue.address || "",
        city: venue.location || city,
        state: venue.state || st,
        artists: artists,
        festival: !!e.festivalInd,
        ages: e.ages || "",
        manual: false,
      };
    }).filter((e) => e.date && e.date >= today);

    // Anything you added by hand survives the refresh.
    const mine = (DB.localEvents || []).filter((e) => e.manual);
    const seen = new Set(fetched.map((e) => e.id));
    DB.localEvents = fetched.concat(mine.filter((e) => !seen.has(e.id)))
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    DB.localEventsFetchedAt = new Date().toISOString();
    save();

    if (!quiet) {
      setSaveState("Updated", "");
      setTimeout(() => setSaveState("", ""), 1800);
    }
    render();
  } catch (err) {
    setSaveState("", "");
    if (!quiet) {
      openModal("Couldn't refresh local shows", "<p>" + esc(err.message) + "</p>",
        '<button class="btn" data-act="goto" data-view="settings">Open Settings</button>' +
        '<div class="spacer"></div><button class="btn btn-primary" data-act="close-modal">OK</button>');
    }
  } finally {
    refreshing = false;
  }
}

// Edmtrain asks that cached data isn't displayed more than 24h stale, so top it
// up quietly whenever the app opens and the feed has gone off.
function autoRefreshIfStale() {
  if (!(DB.settings.edmtrainKey || "").trim()) return;
  const age = eventsAgeHours();
  if (age === null || age > 24) refreshEvents(true);
}

/* ============================================================
   SETTINGS
   ============================================================ */

VIEWS.settings = function () {
  const s = DB.settings;
  return '<div class="page-head"><div><h1>Settings</h1>' +
    "<p>These details appear on every invoice you send. Fill them in once.</p></div>" +
    '<div class="page-actions"><button class="btn btn-primary" data-act="save-settings">Save settings</button></div></div>' +

    '<form id="settings-form"><div class="two-col">' +

    '<div><div class="card card-pad" style="margin-bottom:16px">' +
    '<p class="card-title">Your details</p>' +
    '<div class="field-row">' +
    '<div class="field"><label>Your name</label><input name="yourName" value="' + esc(s.yourName) + '" placeholder="Your name"></div>' +
    '<div class="field"><label>Business name <span class="hint">if different</span></label>' +
    '<input name="businessName" value="' + esc(s.businessName) + '"></div></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Email</label><input type="email" name="email" value="' + esc(s.email) + '"></div>' +
    '<div class="field"><label>Phone</label><input name="phone" value="' + esc(s.phone) + '"></div></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>Website <span class="hint">optional</span></label><input name="website" value="' + esc(s.website) + '"></div>' +
    '<div class="field"><label>Tax / business ID <span class="hint">optional</span></label><input name="taxId" value="' + esc(s.taxId) + '"></div></div>' +
    '<div class="field"><label>Address</label><textarea name="address" placeholder="Street&#10;City, State ZIP">' + esc(s.address) + "</textarea></div>" +
    "</div>" +

    '<div class="card card-pad">' +
    '<p class="card-title">Getting paid</p>' +
    '<div class="field"><label>Payment instructions <span class="hint">printed on every invoice</span></label>' +
    '<textarea name="paymentInstructions" placeholder="Bank transfer to …&#10;or Venmo @yourhandle&#10;or PayPal you@email.com">' +
    esc(s.paymentInstructions) + "</textarea></div>" +
    '<div class="field-row-3">' +
    '<div class="field"><label>Payment terms <span class="hint">days</span></label>' +
    '<input type="number" name="paymentTerms" value="' + esc(s.paymentTerms) + '"></div>' +
    '<div class="field"><label>Default tax rate <span class="hint">%</span></label>' +
    '<input type="number" step="0.01" name="defaultTaxRate" value="' + esc(s.defaultTaxRate) + '"></div>' +
    '<div class="field"><label>Default hourly rate</label>' +
    '<input type="number" step="0.01" name="defaultHourlyRate" value="' + esc(s.defaultHourlyRate) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Income goal for the year <span class="hint">net, 0 to hide</span></label>' +
    '<input type="number" name="incomeGoal" step="100" min="0" value="' + esc(s.incomeGoal) + '"></div>' +
    '<div class="field"><label>Closing line on invoices</label>' +
    '<input name="invoiceFooter" value="' + esc(s.invoiceFooter) + '"></div>' +
    "</div></div>" +

    '<div><div class="card card-pad" style="margin-bottom:16px">' +
    '<p class="card-title">Invoice numbering</p>' +
    '<div class="field-row">' +
    '<div class="field"><label>Prefix</label><input name="invoicePrefix" value="' + esc(s.invoicePrefix) + '"></div>' +
    '<div class="field"><label>Next number</label><input type="number" name="nextInvoiceNumber" value="' + esc(s.nextInvoiceNumber) + '"></div>' +
    "</div>" +
    '<p class="muted" style="font-size:13px;margin:0">Your next invoice will be <strong>' + esc(nextInvoiceNumber()) + "</strong>.</p>" +
    "</div>" +

    '<div class="card card-pad stack">' +
    '<p class="card-title">Currency</p>' +
    '<div class="field-row">' +
    '<div class="field"><label>Code</label><input name="currency" value="' + esc(s.currency) + '"></div>' +
    '<div class="field"><label>Symbol</label><input name="currencySymbol" value="' + esc(s.currencySymbol) + '"></div>' +
    "</div></div>" +

    '<div class="card card-pad stack">' +
    '<p class="card-title">Local shows (Edmtrain)</p>' +
    '<p class="muted" style="font-size:13.5px;margin-top:0">Edmtrain publishes a free API for ' +
    "personal use. Request a key, paste it here, and the Local Events calendar fills with " +
    "upcoming shows near you.</p>" +
    '<div class="field"><label>API key <span class="hint">' +
    '<a href="https://edmtrain.com/developer-api" target="_blank" rel="noopener">request one here</a></span></label>' +
    '<input name="edmtrainKey" value="' + esc(s.edmtrainKey) + '" placeholder="paste your client key"></div>' +
    '<div class="field-row">' +
    '<div class="field"><label>City</label><input name="eventCity" value="' + esc(s.eventCity) + '"></div>' +
    '<div class="field"><label>State</label><input name="eventState" value="' + esc(s.eventState) + '"></div>' +
    "</div>" +
    '<div class="field"><label>Look ahead <span class="hint">days</span></label>' +
    '<input type="number" name="eventLookaheadDays" value="' + esc(s.eventLookaheadDays) + '"></div>' +
    '<button type="button" class="btn" data-act="refresh-events">Refresh shows now</button>' +
    "</div>" +

    '<div class="card card-pad">' +
    '<p class="card-title">Your data</p>' +
    '<p class="muted" style="font-size:13.5px;margin-top:0">Everything lives in <code>data.json</code> inside the ' +
    "<code>income-tracker</code> folder. A dated copy is tucked into <code>backups/</code> the first time you " +
    "change anything each day.</p>" +
    '<p class="muted" style="font-size:13px;margin:0 0 12px">Signed in as <strong>' +
    esc((Cloud.session && Cloud.session.email) || "") + "</strong>. " +
    'Your records sync to every device you sign in on.</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '<button type="button" class="btn" data-act="export-json">Download everything (JSON)</button>' +
    '<button type="button" class="btn" data-act="export-income">Income CSV</button>' +
    '<button type="button" class="btn" data-act="export-expenses">Expenses CSV</button>' +
    '<button type="button" class="btn btn-danger" data-act="sign-out">Sign out</button>' +
    "</div></div></div>" +

    "</div></form>";
};

function saveSettings() {
  const v = formValues($("#settings-form"));
  Object.assign(DB.settings, {
    yourName: v.yourName.trim(), businessName: v.businessName.trim(),
    email: v.email.trim(), phone: v.phone.trim(), website: v.website.trim(),
    taxId: v.taxId.trim(), address: v.address.trim(),
    paymentInstructions: v.paymentInstructions.trim(),
    paymentTerms: num(v.paymentTerms), defaultTaxRate: num(v.defaultTaxRate),
    defaultHourlyRate: num(v.defaultHourlyRate), invoiceFooter: v.invoiceFooter.trim(),
    incomeGoal: num(v.incomeGoal),
    invoicePrefix: v.invoicePrefix, nextInvoiceNumber: num(v.nextInvoiceNumber) || 1,
    currency: v.currency.trim(), currencySymbol: v.currencySymbol.trim() || "$",
    edmtrainKey: v.edmtrainKey.trim(), eventCity: v.eventCity.trim(),
    eventState: v.eventState.trim(), eventLookaheadDays: num(v.eventLookaheadDays) || 120,
  });
  save();
  render();
  setSaveState("Saved", "");
}

/* ---------- shared period picker ---------- */

function periodPicker() {
  return '<select id="period-select">' + selectOptions([
    { value: "month", label: "This month" }, { value: "quarter", label: "This quarter" },
    { value: "year", label: "This year" }, { value: "all", label: "All time" },
  ], state.period) + "</select>" +
    '<select id="year-select">' + selectOptions(
      yearChoices().map((y) => ({ value: String(y), label: String(y) })), String(state.year)) + "</select>";
}

function periodPickerAfter() {
  const p = $("#period-select"), y = $("#year-select");
  if (p) p.onchange = (e) => { state.period = e.target.value; render(); };
  if (y) y.onchange = (e) => { state.year = Number(e.target.value); render(); };
}

/* ---------- export ---------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function csv(rows) {
  return rows.map((r) => r.map((cell) => {
    const s = String(cell == null ? "" : cell);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",")).join("\n");
}

function exportIncome() {
  const rows = [["Date", "Client", "Source", "Invoice", "Method", "Amount", "Notes"]];
  DB.income.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((i) => {
    const inv = i.invoiceId ? invoiceById(i.invoiceId) : null;
    rows.push([i.date, i.clientId ? clientName(i.clientId) : "", i.source || "",
      inv ? inv.number : "", i.method || "", num(i.amount).toFixed(2), i.notes || ""]);
  });
  download("income-" + todayISO() + ".csv", csv(rows), "text/csv");
}

function exportExpenses() {
  const rows = [["Date", "Paid to", "Category", "Deductible", "Method", "Amount", "Notes"]];
  DB.expenses.slice().sort((a, b) => a.date.localeCompare(b.date)).forEach((e) => {
    rows.push([e.date, e.vendor || "", e.category || "", e.deductible ? "yes" : "no",
      e.method || "", num(e.amount).toFixed(2), e.notes || ""]);
  });
  download("expenses-" + todayISO() + ".csv", csv(rows), "text/csv");
}

/* ============================================================
   EVENT WIRING
   ============================================================ */

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const id = el.dataset.id;

  // Clicking the empty part of a calendar cell adds a gig on that day; clicking
  // an event inside it opens the event instead (handled by its own data-act).
  if (act === "backdrop") { if (e.target === el) closeModal(); return; }
  if (act === "cal-day") { if (e.target === el || e.target.classList.contains("cal-date")) newGigOn(el.dataset.date); return; }
  if (act === "local-day") {
    if (e.target === el || e.target.classList.contains("cal-date")) {
      localEventForm(null);
      const f = $("#local-event-form");
      if (f) { f.date.value = el.dataset.date; f.name.focus(); }
    }
    return;
  }

  if (el.tagName === "A") e.preventDefault();

  switch (act) {
    case "close-modal": closeModal(); break;
    case "goto": go(el.dataset.view); closeModal(); break;

    case "cal-prev": shiftMonth(-1); break;
    case "cal-next": shiftMonth(1); break;
    case "cal-today": {
      const n = new Date();
      state.calMonth = n.getFullYear() + "-" + String(n.getMonth() + 1).padStart(2, "0");
      render(); break;
    }

    case "new-gig": gigForm(null); break;
    case "edit-gig": gigForm(gigById(id)); break;
    case "save-gig": saveGig(id || null); break;
    case "delete-gig":
      confirmDelete("this gig", () => {
        DB.gigs = DB.gigs.filter((g) => g.id !== id);
        save(); closeModal(); render();
      });
      break;
    case "invoice-gig": { const g = gigById(id); if (g) newInvoice(g); break; }

    case "new-invoice": newInvoice(null); break;
    case "edit-client-of": {
      const inv = invoiceById(id);
      if (inv && inv.clientId) clientForm(clientById(inv.clientId));
      else invoiceEditor(id);       // no client attached yet - set one first
      break;
    }
    case "open-invoice": closeModal(); invoiceEditor(id); break;
    case "preview-invoice": closeModal(); previewInvoice(id); break;
    case "save-invoice": saveInvoice(id, el.dataset.then); break;
    case "print-invoice": printInvoice(id); break;
    case "copy-email": copyEmail(id); break;
    case "mark-paid": closeModal(); markPaidDialog(id); break;
    case "confirm-payment": {
      const inv = invoiceById(id);
      const v = formValues($("#pay-form"));
      if (!num(v.amount)) { alert("Enter an amount."); break; }
      recordPayment(inv, v);
      save(); closeModal(); render();
      break;
    }
    case "delete-invoice":
      confirmDelete("invoice " + (invoiceById(id) || {}).number, () => {
        DB.invoices = DB.invoices.filter((i) => i.id !== id);
        DB.gigs.forEach((g) => { if (g.invoiceId === id) g.invoiceId = null; });
        DB.income.forEach((i) => { if (i.invoiceId === id) i.invoiceId = null; });
        save(); closeModal(); render();
      });
      break;
    case "add-line": {
      const items = readLineItems();
      items.push({ description: "", qty: 1, rate: "" });
      renderLineItems(items); recalcInvoice();
      $$("#li-body .li-desc").pop().focus();
      break;
    }
    case "del-line": {
      const items = readLineItems();
      const i = Number(el.closest("tr").dataset.i);
      items.splice(i, 1);
      renderLineItems(items.length ? items : [{ description: "", qty: 1, rate: "" }]);
      recalcInvoice();
      break;
    }

    case "new-income": incomeForm(null); break;
    case "edit-income": incomeForm(DB.income.find((x) => x.id === id)); break;
    case "save-income": saveIncome(id || null); break;
    case "delete-income":
      confirmDelete("this income entry", () => {
        DB.income = DB.income.filter((x) => x.id !== id);
        DB.invoices.forEach((inv) => {
          if (inv.status === "paid" && invoicePaid(inv) < invoiceTotals(inv).total - 0.005) inv.status = "sent";
        });
        save(); closeModal(); render();
      });
      break;

    case "add-todo": addTodo(); break;
    case "toggle-done": state.showDone = !state.showDone; render(); break;
    case "pick-top": {
      // only the empty part of the slot opens the picker
      if (e.target.closest("button") && e.target.closest("button") !== el) break;
      pickTopDialog(Number(el.dataset.rank));
      break;
    }
    case "pick-task": {
      closeModal();
      assignTop(id, Number(el.dataset.rank));
      break;
    }
    case "untop-todo": {
      e.preventDefault();
      const t = (DB.todos || []).find((x) => x.id === id);
      if (t) { t.top = false; t.topRank = null; save(); render(); }
      break;
    }
    case "set-goal": setGoalDialog(); break;
    case "save-goal":
      DB.settings.incomeGoal = num(formValues($("#goal-form")).incomeGoal);
      save(); closeModal(); render();
      break;
    case "toggle-todo": toggleTodo(id); break;
    case "delete-todo":
      e.preventDefault();
      DB.todos = (DB.todos || []).filter((x) => x.id !== id);
      save(); refreshTodoList();
      break;
    case "clear-done":
      DB.todos = (DB.todos || []).filter((x) => !x.done);
      save(); refreshTodoList();
      break;

    case "new-expense": expenseForm(null); break;
    case "edit-expense": expenseForm(DB.expenses.find((x) => x.id === id)); break;
    case "save-expense": saveExpense(id || null); break;
    case "delete-expense":
      confirmDelete("this expense", () => {
        DB.expenses = DB.expenses.filter((x) => x.id !== id);
        save(); closeModal(); render();
      });
      break;

    case "new-client": clientForm(null); break;
    case "edit-client": clientForm(clientById(id)); break;
    case "save-client": saveClient(id || null, el.dataset.return); break;
    case "delete-client":
      confirmDelete("this client", () => {
        DB.clients = DB.clients.filter((c) => c.id !== id);
        save(); closeModal(); render();
      });
      break;
    case "quick-client": quickClient(); break;

    case "cal-mode": state.calMode = el.dataset.mode; render(); break;
    case "event-kind": state.eventKind = el.dataset.key; render(); break;
    case "new-local-event": localEventForm(null); break;
    case "edit-local-event": {
      closeModal();
      localEventForm((DB.localEvents || []).find((x) => String(x.id) === String(id)));
      break;
    }
    case "save-local-event": saveLocalEvent(id || null); break;
    case "delete-local-event":
      confirmDelete("this event", () => {
        DB.localEvents = (DB.localEvents || []).filter((x) => String(x.id) !== String(id));
        save(); closeModal(); render();
      });
      break;
    case "show-event": showEvent(id); break;
    case "refresh-events": closeModal(); refreshEvents(false); break;

    case "outreach-filter": state.outreachFilter = el.dataset.key; render(); break;
    case "new-outreach": outreachForm(null); break;
    case "edit-outreach": outreachForm((DB.outreach || []).find((x) => x.id === id)); break;
    case "save-outreach": saveOutreach(id || null); break;
    case "delete-outreach":
      confirmDelete("this outreach entry", () => {
        DB.outreach = (DB.outreach || []).filter((x) => x.id !== id);
        save(); closeModal(); render();
      });
      break;
    case "outreach-from-venue": {
      closeModal();
      const venue = el.dataset.venue || "";
      const seen = (DB.localEvents || []).filter((e) => e.venue === venue);
      outreachForm({
        id: null, venue: venue, contactName: "", email: "", phone: "", website: "",
        status: "to-contact", lastContact: "", nextFollowUp: "",
        notes: seen.length
          ? "Found on Edmtrain \u2014 " + seen.length + " upcoming show" + (seen.length === 1 ? "" : "s") +
            ", next on " + fmtDate(seen[0].date) + "."
          : "",
      });
      break;
    }

    case "sign-out": signOutNow(); break;
    case "retry-load": start(); break;
    case "save-settings": saveSettings(); break;
    case "export-json": download("income-tracker-" + todayISO() + ".json", JSON.stringify(DB, null, 2), "application/json"); break;
    case "export-income": exportIncome(); break;
    case "export-expenses": exportExpenses(); break;

    case "confirm-delete": { const f = window.__confirmYes; window.__confirmYes = null; if (f) f(); break; }
  }
});

// Live totals as you type in the invoice editor.
document.addEventListener("input", (e) => {
  if (e.target.closest("#inv-form") && e.target.classList.contains("recalc")) recalcInvoice();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "todo-input") { e.preventDefault(); addTodo(); return; }
  if (e.key === "Escape" && $(".modal-backdrop")) closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    const btn = $(".modal-foot .btn-primary");
    if (btn) { e.preventDefault(); btn.click(); }
  }
});

// Pressing Enter in a single-line field submits the dialog instead of doing nothing.
document.addEventListener("submit", (e) => {
  e.preventDefault();
  const btn = $(".modal-foot .btn-primary");
  if (btn) btn.click();
});

function shiftMonth(delta) {
  const [y, m] = state.calMonth.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.calMonth = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  render();
}

function newGigOn(date) {
  gigForm(null);
  const f = $("#gig-form");
  if (f) { f.date.value = date; f.title.focus(); }
}

function quickClient() {
  const gigForm_ = $("#gig-form");
  const invForm = $("#inv-form");
  if (gigForm_) {
    const v = formValues(gigForm_);
    v.id = ($(".modal-foot [data-act=save-gig]") || {}).dataset ?
      $(".modal-foot [data-act=save-gig]").dataset.id || null : null;
    window.__pendingGig = v.id ? Object.assign({}, gigById(v.id), v) : Object.assign({ id: null }, v);
    clientForm(null, { returnTo: "gig" });
  } else if (invForm) {
    const invId = $(".modal-foot [data-act=save-invoice]").dataset.id;
    saveInvoiceQuietly(invId);
    clientForm(null, { returnTo: "invoice:" + invId });
  } else {
    clientForm(null);
  }
}

function saveInvoiceQuietly(id) {
  const inv = invoiceById(id);
  const v = formValues($("#inv-form"));
  Object.assign(inv, {
    number: v.number.trim() || inv.number,
    issueDate: v.issueDate, dueDate: v.dueDate,
    items: readLineItems(), discount: num(v.discount), taxRate: num(v.taxRate),
    notes: v.notes.trim(), status: v.status,
  });
  save();
}

async function copyEmail(id) {
  const inv = invoiceById(id);
  const text = emailText(inv);
  try {
    await navigator.clipboard.writeText(text);
    setSaveState("Copied", "");
    setTimeout(() => setSaveState("", ""), 1800);
  } catch (err) {
    openModal("Email text", '<textarea style="width:100%;min-height:220px">' + esc(text) + "</textarea>",
      '<button class="btn btn-primary" data-act="close-modal">Done</button>');
  }
}

/* ---------- sign in ---------- */

function showChrome(on) {
  document.querySelector(".appbar").style.display = on ? "" : "none";
  document.querySelector(".tabbar").style.display = on ? "" : "none";
}

function renderLogin(message) {
  showChrome(false);
  document.body.dataset.view = "login";
  $("#view").innerHTML =
    '<div class="login"><h1 class="login-title">Income Tracker</h1>' +
    '<p class="login-sub">Sign in to reach your gigs, invoices and income from any device.</p>' +
    (message ? '<div class="login-error">' + esc(message) + "</div>" : "") +
    '<form id="login-form" class="card card-pad">' +
    '<div class="field"><label>Email</label>' +
    '<input type="email" name="email" autocomplete="username" required></div>' +
    '<div class="field"><label>Password</label>' +
    '<input type="password" name="password" autocomplete="current-password" required></div>' +
    '<button class="btn btn-primary" id="login-btn" style="width:100%">Sign in</button>' +
    "</form>" +
    '<p class="login-foot">Use the email and password you created in Firebase.</p></div>';
  const f = $("#login-form");
  f.addEventListener("submit", (e) => { e.preventDefault(); doSignIn(); });
  const first = f.querySelector("input");
  if (first) first.focus();
}

async function doSignIn() {
  const f = $("#login-form");
  const btn = $("#login-btn");
  const v = formValues(f);
  btn.disabled = true;
  btn.textContent = "Signing in\u2026";
  try {
    await Cloud.signIn(v.email.trim(), v.password);
    await start();
  } catch (err) {
    renderLogin(err.message);
  }
}

async function signOutNow() {
  // An edit may still be sitting in the 400ms debounce. Push it through before
  // the session goes: otherwise the write fires with no token, throws, and that
  // change is lost without the user ever being told.
  clearTimeout(saveTimer);
  saveTimer = null;
  if (dirty || saveInFlight || savePending) {
    setSaveState("Saving\u2026", "saving");
    try {
      await flush();
    } catch (err) {
      // Offline, or the session already expired. Nothing more we can do here,
      // and the local copy is still in data.json terms unchanged.
    }
  }
  Cloud.signOut();
  DB = null;
  renderLogin("Signed out.");
}

/* ---------- start ---------- */

async function start() {
  try {
    await load();
  } catch (err) {
    if (/sign in|expired/i.test(err.message)) { Cloud.signOut(); renderLogin(err.message); return; }
    showChrome(false);
    const d = Cloud.diagnostics();
    $("#view").innerHTML =
      '<div class="card card-pad" style="margin-top:40px;max-width:560px;margin-left:auto;margin-right:auto">' +
      '<h3 style="margin-top:0">Could not load your data</h3>' +
      '<p style="font-size:14px;line-height:1.5">' + esc(err.message) + "</p>" +
      '<table style="font-size:13px;margin:16px 0"><tbody>' +
      Object.keys(d).map((k) =>
        "<tr><td style=\"color:var(--ink-3);padding-right:14px\">" + esc(k) + "</td>" +
        "<td><code>" + esc(String(d[k])) + "</code></td></tr>").join("") +
      "</tbody></table>" +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-primary" data-act="retry-load">Try again</button>' +
      '<button class="btn" data-act="sign-out">Sign out</button></div></div>';
    return;
  }
  showChrome(true);
  if (!DB.gigs.length && !DB.invoices.length && !DB.income.length && !setupComplete()) {
    state.view = "settings";
  }
  render();
  autoRefreshIfStale();
}

Cloud.restore();
if (Cloud.signedIn()) start();
else renderLogin();
