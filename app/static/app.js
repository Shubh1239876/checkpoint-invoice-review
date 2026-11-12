// Checkpoint UI — plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inr = (n) => (n === null || n === undefined || isNaN(n)) ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
const inrShort = (n) => !n ? "₹0" : n >= 1e7 ? "₹" + (n / 1e7).toFixed(2) + " Cr" : n >= 1e5 ? "₹" + (n / 1e5).toFixed(1) + "L" : inr(n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const when = (iso) => iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const initials = (s) => (s || "?").replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}
const post = (path, data) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data || {}) });
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2800);
}
function modal(title, inner) {
  const m = $("#modal");
  m.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="bar2"><b>${esc(title)}</b><button class="small white" id="mClose">Close</button></div>${inner}</div>`;
  m.hidden = false;
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  $("#mClose").onclick = close; m.onclick = (e) => { if (e.target === m) close(); };
  document.addEventListener("keydown", function k(e) { if (e.key === "Escape") { close(); document.removeEventListener("keydown", k); } });
}

const STAGES = [
  ["intake", "Receive document", "code"], ["extract", "Read invoice", "AI"], ["validate", "Validate fields & arithmetic", "rules"],
  ["vendor", "Verify vendor", "rules"], ["duplicate", "Check for duplicates", "rules"], ["po", "Match purchase order", "rules"],
  ["amount", "Check amounts against PO", "rules"], ["decide", "Decide", "rules"], ["explain", "Explain", "AI"],
];
const MARK = { pass: "✓", warn: "!", hold: "!", reject: "✕", skip: "–" };
const DECISION_WORD = { APPROVE: "Approved", HOLD: "On hold", REJECT: "Rejected" };
const REVIEW_LABEL = { pending: "Awaiting review", approved: "Approved by reviewer", rejected: "Rejected by reviewer", superseded: "Re-checked with chosen PO" };
const SAMPLE_TITLES = {
  "01": "Clean invoice, exact PO match", "02": "Scanned, tax hidden inside prices", "03": "Split PO — 3rd instalment overruns",
  "04": "Disguised duplicate (scanned re-send)", "05": "No PO number, two POs fit", "06": "Perfect invoice, new bank account",
  "07": "Blocked vendor", "08": "Monthly retainer — same amount as last month", "09": "Totals don't add up, no invoice number",
  "10": "Next month's freight bill, no PO again", "11": "Next Acme invoice, new bank account",
};

let timers = [], currentSource = null, RUN_CTX = {};
function clearPage() { timers.forEach(clearInterval); timers = []; if (currentSource) { currentSource.close(); currentSource = null; } }

// ------------------------------------------------------------------ shell
const routes = { "": viewNew, dashboard: viewDashboard, review: viewReview, reference: viewReference, rules: viewRules, run: viewRun };
async function route() {
  clearPage();
  const [, name = "", arg] = location.hash.split("/");
  $$(".nav").forEach((a) => a.classList.toggle("active", a.dataset.nav === (name === "run" ? "dashboard" : name || "new")));
  window.scrollTo(0, 0);
  try { await (routes[name] || viewNew)(arg); } catch (e) { $("#view").innerHTML = `<div class="card empty">Couldn't load this page: ${esc(e.message)}</div>`; }
  refreshShell();
}
window.addEventListener("hashchange", route);

async function refreshShell() {
  try {
    const m = await api("/api/metrics");
    $("#navQueue").textContent = m.pending_review;
    $("#topQueueText").textContent = m.pending_review ? `${m.pending_review} awaiting review` : "Review queue";
    $("#oA").textContent = m.approved; $("#oH").textContent = m.held; $("#oR").textContent = m.rejected;
  } catch {}
}
async function health() {
  const names = { groq: "Groq", gemini: "Gemini" }, use = { groq: "digital PDFs", gemini: "scans" };
  try {
    const s = await api("/api/health");
    if (s.extractor !== "extract_invoice") { $("#aiRows").innerHTML = `<div class="row"><span class="dot" style="background:var(--hold)"></span>Offline test mode<span></span></div>`; return; }
    $("#aiRows").innerHTML = s.providers.length ? s.providers.map((p) => `<div class="row"><span class="dot" style="background:var(--ok)"></span>${names[p] || p}<span>${use[p] || ""}</span></div>`).join("")
      : `<div class="row"><span class="dot" style="background:var(--bad)"></span>No AI key set<span></span></div>`;
  } catch { $("#aiRows").innerHTML = `<div class="row"><span class="dot" style="background:var(--bad)"></span>Server unreachable<span></span></div>`; }
}
async function startUpload(files) {
  files = [...(files || [])].filter(Boolean);
  if (!files.length) return;
  const ids = [];
  for (const f of files) {
    const fd = new FormData(); fd.append("file", f);
    try { ids.push((await api("/api/runs", { method: "POST", body: fd })).id); } catch (e) { toast(`${f.name}: ${e.message}`); }
  }
  if (ids.length === 1) location.hash = `#/run/${ids[0]}`;
  else if (ids.length > 1) { toast(`${ids.length} invoices queued — processing one by one`); location.hash = "#/dashboard"; }
}
$("#topUpload").onchange = (e) => { startUpload(e.target.files); e.target.value = ""; };
$("#today").textContent = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

// ------------------------------------------------------------------ new run
async function viewNew() {
  const samples = await api("/api/samples");
  const group = (p) => samples.filter((s) => s.file.includes(`_${p}`));
  const card = (s) => `
    <div class="sample">
      <div class="chips"><span class="chip">${s.scanned ? "scanned PDF" : "digital PDF"}</span><span class="chip">#${s.file.slice(0, 2)}</span></div>
      <div class="t">${esc(SAMPLE_TITLES[s.file.slice(0, 2)] || s.file)}</div>
      <div class="d">${esc(s.scenario)}</div>
      <div class="row"><a class="btn small white" href="/api/samples/${encodeURIComponent(s.file)}" target="_blank" rel="noopener">View PDF</a>
        <button class="small primary" data-run="${esc(s.file)}">Run <span aria-hidden="true">→</span></button></div>
    </div>`;
  $("#view").innerHTML = `
    <div class="crumbs">Checkpoint / <b>New run</b></div>
    <div class="pagehead"><div><h1>Check an invoice</h1>
      <p>Checkpoint reads the invoice, checks it against the vendor master, the purchase orders and past invoices, and decides whether it can be paid — showing every step.</p></div></div>
    <div class="cols stretch">
      <div class="col-main">
        <label class="drop" id="drop" for="file">
          <div class="inner">
            <span class="icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"></path></svg></span>
            <div class="big">Drop an invoice PDF here, or click to choose</div>
            <div class="muted">Digital or scanned · up to 10 MB each · select several for a batch</div>
          </div>
        </label>
        <input type="file" id="file" accept="application/pdf" class="sr" multiple>
        <div class="card" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px;justify-content:space-between">
          <div><b>Batch demo</b><div class="muted" style="font-size:13px">Queue all 9 sample invoices and watch the dashboard fill up, one by one.</div></div>
          <button class="dark" id="runAll">Run all 9 samples <span aria-hidden="true">→</span></button></div>
      </div>
      <div class="col-side">
        <div class="card"><div class="cardhead"><span class="t">What happens</span><span class="chip soft">9 steps</span></div>
          <div class="steps-mini">${STAGES.map(([, l, by], i) => `<div><span class="n">${i + 1}</span>${l}<span class="by ${by === "AI" ? "ai" : ""}" style="margin-left:auto">${by}</span></div>`).join("")}</div>
        </div>
      </div>
    </div>
    <div class="sectionhead" style="margin-top:22px"><h2>Happy path</h2><span class="muted">should go straight through</span></div>
    <div class="samples" style="margin-top:10px">${group("happy").map(card).join("")}</div>
    <div class="sectionhead" style="margin-top:22px"><h2>Edge cases</h2><span class="muted">realistic situations where the process must behave differently</span></div>
    <div class="samples" style="margin-top:10px">${group("edge").map(card).join("")}</div>
    <div class="sectionhead" style="margin-top:22px"><h2>Also handled</h2></div>
    <div class="samples" style="margin-top:10px">${group("extra").map(card).join("")}</div>
    <div class="sectionhead" style="margin-top:22px"><h2>Learning from the reviewer</h2><span class="muted">run these before and after resolving #05 and #06</span></div>
    <div class="samples" style="margin-top:10px">${group("learn").map(card).join("")}</div>`;
  const drop = $("#drop");
  $("#file").onchange = (e) => startUpload(e.target.files);
  $("#runAll").onclick = async () => { $("#runAll").disabled = true; try { const { ids } = await post("/api/runs/samples"); toast(`${ids.length} invoices queued`); location.hash = "#/dashboard"; } catch (e) { toast(e.message); $("#runAll").disabled = false; } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); startUpload(e.dataTransfer.files); };
  $$("[data-run]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { const { id } = await api(`/api/runs/sample/${encodeURIComponent(b.dataset.run)}`, { method: "POST" }); location.hash = `#/run/${id}`; }
    catch (e) { toast(e.message); b.disabled = false; }
  }));
}

// ------------------------------------------------------------------ run view
async function viewRun(id) {
  let run = await api(`/api/runs/${id}`);
  const state = { stages: {}, running: null, done: run.status !== "running", toggled: {}, fresh: null };
  (run.stages || []).forEach((s) => (state.stages[s.stage] = s));
  RUN_CTX = { id: run.id, pending: run.review_status === "pending" };

  $("#view").innerHTML = `
    <div class="crumbs"><a href="#/dashboard">Runs</a> / <span id="crumbVendor">${esc(run.vendor_name || run.filename)}</span> / <b>Run #${run.id}</b></div>
    <div class="pagehead"><h1>Run #${run.id}</h1>
      <div class="actions"><button class="white" id="btnPdf">View PDF</button><button class="white" id="btnAudit">Audit trail</button><a class="btn white" href="#/">New run</a></div></div>
    <div class="cols">
      <div class="col-main">
        <div class="grid2" id="sumcards"></div>
        <div class="card verdict" id="verdict"></div>
        <div class="sectionhead"><h2>Pipeline</h2><span class="muted">9 steps · AI reads, rules decide</span></div>
        <div class="card pipeline" id="timeline"></div>
      </div>
      <div class="col-side">
        <div class="card tight" id="findings"></div>
        <div class="card" id="readby"></div>
        <div class="card" id="fields"></div>
      </div>
    </div>`;
  $("#btnPdf").onclick = () => modal(run.filename, `<iframe src="/api/runs/${id}/file" title="Invoice PDF"></iframe>`);
  $("#btnAudit").onclick = async () => { const r = await api(`/api/runs/${id}`); modal(`Audit trail · run #${id}`, `<pre>${esc(JSON.stringify(r, null, 2))}</pre>`); };

  const render = () => {
    $("#sumcards").innerHTML = sumCardsHTML(run, state);
    $("#timeline").innerHTML = STAGES.map(([k, label, by], i) => stageHTML(k, label, by, i + 1, state)).join("");
    $("#findings").innerHTML = findingsHTML(run, state);
    $("#readby").innerHTML = readByHTML(state);
    $("#fields").innerHTML = fieldsHTML(state.stages.extract?.data?.extraction || run.extraction);
    $$(".step-head").forEach((h) => (h.onclick = () => {
      const el = h.parentElement; if (el.classList.contains("waiting")) return;
      el.classList.toggle("open"); state.toggled[el.dataset.key] = el.classList.contains("open");
      h.setAttribute("aria-expanded", el.classList.contains("open"));
    }));
    $$(".fieldrow").forEach((f) => (f.onclick = () => f.classList.toggle("show")));
    if ($("#btnCompare")) $("#btnCompare").onclick = () => {
      modal("Compare with PDF", `<div style="display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,1fr);min-height:0">
        <iframe src="/api/runs/${id}/file" title="Invoice PDF" style="height:80vh"></iframe>
        <div style="padding:14px;overflow:auto;max-height:80vh">${fieldsHTML(state.stages.extract?.data?.extraction || run.extraction).replace(/<button class="small white" id="btnCompare">Compare with PDF<\/button>/, "")}</div></div>`);
      $$("#modal .fieldrow").forEach((f) => { f.classList.add("show"); });
    };
    $$("[data-goto]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); const st = $(`.step[data-key="${a.dataset.goto}"]`); if (st) { st.classList.add("open"); state.toggled[a.dataset.goto] = true; st.scrollIntoView({ behavior: "smooth", block: "center" }); } }));
    $$("[data-usepo]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { const { id: nid } = await post(`/api/runs/${run.id}/use-po`, { po_number: b.dataset.usepo }); toast(`Re-checking against ${b.dataset.usepo}…`); location.hash = `#/run/${nid}`; }
      catch (e) { toast(e.message); b.disabled = false; }
    }));
    const vb = $("#crumbVendor"); if (vb && run.vendor_name) vb.textContent = run.vendor_name;
  };
  const renderVerdict = () => {
    $("#verdict").innerHTML = state.done ? verdictHTML(run) :
      `<div class="processing"><span class="spin"></span><div><div class="chips"><span class="status running">Processing</span></div>
        <div class="headline" style="margin-top:6px">${esc(state.running ? (STAGES.find((s) => s[0] === state.running) || [, ""])[1] + "…" : state.started ? "Starting…" : "Queued — waiting for earlier invoices to finish")}</div></div></div>`;
    if (state.done) bindReview(run, async () => { run = await api(`/api/runs/${id}`); RUN_CTX.pending = run.review_status === "pending"; renderVerdict(); render(); refreshShell(); });
  };
  render(); renderVerdict();
  if (state.done) return;

  // live: stream each stage as it finishes; pace slightly so every step is visible (real timings are shown)
  const queue = []; let finished = false;
  const es = new EventSource(`/api/runs/${id}/events`); currentSource = es;
  es.onmessage = (m) => queue.push(JSON.parse(m.data));
  es.onerror = () => es.close();
  while (!finished) {
    const ev = queue.shift();
    if (!ev) { await sleep(80); if (!document.body.contains($("#timeline"))) return; continue; }
    if (ev.type === "started") { state.started = true; renderVerdict(); }
    else if (ev.type === "stage_start") { state.running = ev.stage; render(); renderVerdict(); await sleep(ev.ai ? 0 : 200); }
    else if (ev.type === "stage_end") { state.stages[ev.stage] = ev; state.running = null; state.fresh = ev.stage; render(); await sleep(240); }
    else if (ev.type === "done" || ev.type === "error") {
      finished = true; es.close(); currentSource = null;
      run = await api(`/api/runs/${id}`); state.done = true; state.fresh = null;
      RUN_CTX.pending = run.review_status === "pending";
      render(); renderVerdict(); refreshShell();
    }
  }
}

function sumCardsHTML(run, state) {
  const v = state.stages.vendor?.data?.vendor, po = state.stages.po?.data?.po, intake = state.stages.intake?.data;
  const ex = state.stages.extract?.data?.extraction || run.extraction || {};
  const invNo = ex.invoice_number?.value || run.invoice_number;
  const total = state.stages.validate?.data?.total ?? run.total;
  const statusChip = state.done ? `<span class="status ${run.decision}">${DECISION_WORD[run.decision] || run.decision}</span>` : `<span class="status running">Running</span>`;
  const reviewChip = run.review_status ? `<span class="status ${run.review_status}">${REVIEW_LABEL[run.review_status]}</span>` : "";
  const firstFlag = STAGES.map((s) => s[0]).find((k) => /hold|reject/.test(state.stages[k]?.status || "") && k !== "decide");
  return `
    <div class="card sumcard">
      <div class="chips"><span class="chip">${esc(when(run.created_at))}</span><span class="chip">${inr(total)}</span>${statusChip}${reviewChip}</div>
      <div class="h">${state.done ? esc(run.decision === "APPROVE" ? "Ready for the payment run" : run.decision === "REJECT" ? "Must not be paid" : "A person needs to look at this") : "Checking…"}</div>
      <div class="s">Decision · made by rules, not by the AI</div>
      <div class="foot"><span class="muted" style="font-size:12px">${run.duration_ms ? "took " + (run.duration_ms / 1000).toFixed(1) + " s" : ""}</span>
        ${firstFlag ? `<a class="btn small dark" href="#" data-goto="${firstFlag}">See why <span aria-hidden="true">→</span></a>` : ""}</div>
    </div>
    <div class="card sumcard">
      <div class="chips"><span class="chip">${esc(invNo || "no invoice number")}</span><span class="chip">${esc(intake?.kind || "PDF")}</span>${po ? `<span class="chip">${esc(po.po_number)}</span>` : ""}</div>
      <div class="h">${esc(v?.legal_name || ex.vendor_name?.value || run.vendor_name || "Vendor not yet known")}</div>
      <div class="s">${v ? `${esc(v.vendor_id)} · ${v.status === "Active" ? "approved vendor" : esc(v.status)}` : state.stages.vendor ? "Not in the vendor master" : "…"}</div>
      <div class="foot"><span class="avatar" style="background:var(--accent-soft);color:var(--accent-ink)">${esc(initials(v?.legal_name || ex.vendor_name?.value))}</span>
        <button class="small dark" onclick="document.getElementById('btnPdf').click()">Open invoice <span aria-hidden="true">→</span></button></div>
    </div>`;
}

function stageHTML(k, label, by, n, state) {
  const s = state.stages[k];
  const status = s ? s.status : state.running === k ? "running" : "waiting";
  const flagged = s && /hold|reject/.test(s.status) && k !== "decide";
  const open = state.toggled[k] ?? flagged;
  const findings = s ? s.findings.filter((f) => f.severity !== "pass" || s.findings.length === 1) : [];
  const cls = ["step", s ? "" : status, open ? "open" : "", flagged ? "flag" : "", state.fresh === k ? "justdone" : ""].join(" ");
  return `<div class="${cls}" data-key="${k}">
    <button class="step-head" aria-expanded="${!!open}" ${s ? "" : "disabled"}>
      <span class="n">${status === "running" ? '<span class="spin"></span>' : n}</span>
      <div><div class="t">${esc(label)} <span class="by ${by === "AI" ? "ai" : ""}">${by}</span></div>
        <div class="s">${s ? esc(s.summary) : status === "running" ? (by === "AI" ? "Asking the AI model…" : "Running…") : ""}</div></div>
      <span class="ms">${s ? (s.ms >= 1000 ? (s.ms / 1000).toFixed(1) + " s" : s.ms + " ms") : ""}</span>
      ${s ? `<span class="mark ${s.status}" aria-label="${s.status}">${MARK[s.status] || "✓"}</span>` : "<span></span>"}
    </button>
    ${s ? `<div class="step-body">${findings.map(findingHTML).join("") || '<div class="muted">No issues.</div>'}${stageExtra(k, s)}</div>` : ""}
  </div>`;
}

function findingHTML(f) {
  return `<div class="finding"><span class="status ${f.severity}">${f.severity}</span><div>
    <div class="ft">${esc(f.title)}</div>${f.detail ? `<div class="fd">${esc(f.detail)}</div>` : ""}
    ${f.action && f.severity !== "info" ? `<div class="fa">${esc(f.action)}</div>` : ""}${findingExtra(f)}</div></div>`;
}

function findingExtra(f) {
  const d = f.data || {};
  if (f.code === "PO_AMBIGUOUS" || f.code === "PO_INFERRED") {
    const can = f.code === "PO_AMBIGUOUS" && RUN_CTX.pending;
    return `<table class="mini"><tr><th>Candidate PO</th><th>Description</th><th class="num">Left</th><th class="num">Score</th>${can ? "<th></th>" : ""}</tr>
      ${(d.candidates || []).map((c) => `<tr><td class="mono">${esc(c.po_number)}</td><td>${esc(c.description)}</td><td class="num">${inr(c.remaining)}</td><td class="num"><b>${c.score}</b></td>
      ${can ? `<td><button class="small primary" data-usepo="${esc(c.po_number)}">Use PO</button></td>` : ""}</tr>`).join("")}</table>`;
  }
  if (f.code === "PO_OVERRUN" || f.code === "AMOUNT_OK" || f.code === "WITHIN_TOLERANCE") return balanceHTML(d);
  if (f.code === "BANK_CHANGED") {
    const a = d.invoice || {}, m = d.master || {};
    return `<div class="compare"><span></span><span class="h">On invoice</span><span class="h">Vendor master</span>
      <span>Account</span><span class="mono ${a.account && a.account !== m.account ? "diff" : ""}">${esc(a.account)}</span><span class="mono">${esc(m.account)}</span>
      <span>IFSC</span><span class="mono ${a.ifsc && a.ifsc !== m.ifsc ? "diff" : ""}">${esc(a.ifsc)}</span><span class="mono">${esc(m.ifsc)}</span></div>`;
  }
  if (f.code === "PROBABLE_DUPLICATE" || f.code === "EXACT_DUPLICATE") {
    const m = d.match || {};
    return `<div class="compare"><span></span><span class="h">Already in the ledger</span><span></span>
      <span>Invoice</span><span class="mono">${esc(m.invoice_number)}</span><span></span><span>Date</span><span>${esc(m.invoice_date)}</span><span></span>
      <span>Amount</span><span>${inr(m.total)}</span><span></span><span>Status</span><span>${esc(m.status)}${m.paid_on ? " · " + esc(m.paid_on) : ""}</span><span></span></div>`;
  }
  return "";
}

function balanceHTML(d) {
  if (!d || d.po_subtotal === undefined) return "";
  const po = d.po_subtotal, before = Math.min(d.invoiced_before, po), mine = d.this_invoice || 0;
  const fitting = Math.max(0, Math.min(mine, po - before)), excess = Math.max(0, mine - Math.max(d.remaining, 0));
  const scale = Math.max(po, before + mine), pct = (x) => (100 * x / scale).toFixed(2) + "%";
  return `<div class="balance">
    <div class="figs"><div><small>Billed before</small>${inr(d.invoiced_before)}</div><div><small>Can be paid</small><b style="color:var(--accent-ink)">${inr(fitting)}</b></div>
      <div><small>${excess ? "Over the PO" : "Left after this"}</small><b style="color:${excess ? "var(--bad-ink)" : "var(--ok-ink)"}">${inr(excess || Math.max(0, d.remaining - mine))}</b></div></div>
    <div class="bar" style="margin-top:10px"><span style="width:${pct(before)};background:#B5C2D8"></span><span style="width:${pct(fitting)};background:var(--accent)"></span><span style="width:${pct(excess)};background:var(--bad)"></span></div>
    <div class="legend"><span>PO value ${inr(po)} pre-tax</span>${(d.prior_invoices || []).map((p) => `<span class="mono">${esc(p.invoice_number)} · ${inr(p.subtotal)}</span>`).join("")}</div></div>`;
}

function stageExtra(k, s) {
  const d = s.data || {};
  if (k === "intake") return `<div class="muted" style="font-size:12px">Fingerprint ${esc(d.sha256)}… · ${(d.bytes / 1024).toFixed(0)} KB</div>`;
  if (k === "extract" && d.model) return `<div class="muted" style="font-size:12px">Read by ${esc(d.provider)} · ${esc(d.model)} from the ${esc(d.mode)} · ${d.attempts} attempt(s)${d.fallbacks?.length ? ` · backup used (${esc(d.fallbacks.join(" · ").slice(0, 160))}…)` : ""}</div>`;
  if (k === "vendor" && d.vendor) return `<div class="muted" style="font-size:12px;margin-top:6px">Master record: GSTIN ${esc(d.vendor.gstin)} · ${esc(d.vendor.bank_name)} ${esc(d.vendor.bank_account)} · ${esc(d.vendor.registered_phone)}</div>`;
  if (k === "po" && d.po) return `<table class="mini"><tr><th>PO line</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
      ${d.po.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty.toLocaleString("en-IN")}</td><td class="num">${inr(l.unit_price)}</td><td class="num">${inr(l.amount)}</td></tr>`).join("")}</table>`;
  if (k === "explain") return `<div class="muted" style="font-size:12px">The decision was made by rules; this step only words it for the reader${d.explanation?.source === "template" ? " (template — AI unavailable)" : ""}.</div>`;
  return "";
}

function findingsHTML(run, state) {
  const all = STAGES.flatMap(([k]) => (state.stages[k]?.findings || []).map((f) => ({ ...f, stage: k })));
  const order = { reject: 0, hold: 1, warn: 2, info: 3, pass: 4 };
  const shown = all.filter((f) => f.severity !== "pass").sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 6);
  const okCount = STAGES.filter(([k]) => state.stages[k]?.status === "pass").length;
  const icon = { reject: "✕", hold: "!", warn: "!", info: "i" };
  return `<div class="cardhead" style="padding:6px 8px 0"><span class="t">Findings</span><span class="chip soft">${okCount} steps passed</span></div>
    <div class="alerts">${shown.length ? shown.map((f) => `<a class="alert" href="#" data-goto="${f.stage}" style="color:inherit">
      <span class="tile ${f.severity}">${icon[f.severity]}</span><div style="min-width:0;flex:1"><div class="at">${esc(f.title)}</div><div class="as">${esc((STAGES.find((s) => s[0] === f.stage) || [, ""])[1])}</div></div><span aria-hidden="true" class="muted">↗</span></a>`).join("")
      : `<div class="alert"><span class="tile pass">✓</span><div><div class="at">${state.done ? "Nothing to flag" : "Waiting for checks…"}</div><div class="as">${state.done ? "Every check passed" : ""}</div></div></div>`}</div>`;
}

function readByHTML(state) {
  const d = state.stages.extract?.data || {}, ex = d.extraction;
  if (!ex) return `<div class="cardhead"><span class="t">Read by AI</span></div><div class="muted">${state.stages.extract ? "The invoice could not be read." : "Waiting for the invoice to be read…"}</div>`;
  const confs = Object.values(ex).filter((v) => v && typeof v === "object" && "confidence" in v && v.value !== null && v.value !== "").map((v) => v.confidence);
  const min = confs.length ? Math.min(...confs) : 0;
  return `<div class="cardhead"><span class="t">Read by AI</span><span class="by ai">${esc(d.provider)}</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:10px">${esc(d.model)} · from the ${esc(d.mode)}${d.fallbacks?.length ? " · backup provider used" : ""}</div>
    <div class="chips">${d.cached_from ? `<span class="chip">reused from run #${d.cached_from}</span>` : ""}<span class="chip soft">${confs.length} fields</span><span class="chip soft">${(ex.line_items || []).length} line items</span>
      <span class="status ${min < 0.8 ? "hold" : "pass"}">lowest certainty ${Math.round(min * 100)}%</span></div>`;
}

function fieldsHTML(ex) {
  if (!ex) return `<div class="cardhead"><span class="t">Extracted fields</span></div><div class="muted">Fields appear here once read.</div>`;
  const rows = [["Invoice number", "invoice_number"], ["Invoice date", "invoice_date"], ["Vendor", "vendor_name"], ["Vendor GSTIN", "vendor_gstin"],
    ["Billed to GSTIN", "buyer_gstin"], ["PO reference", "po_reference"], ["Pre-tax subtotal", "subtotal", 1], ["GST rate %", "tax_rate_percent"],
    ["Total", "total", 1], ["Bank account", "bank_account"], ["IFSC", "ifsc"]];
  return `<div class="cardhead"><span class="t">Extracted fields</span><button class="small white" id="btnCompare">Compare with PDF</button></div>
    <div class="muted" style="font-size:12px;margin:-4px 0 10px">Click a field to see the exact text it was read from.</div>
    ${rows.map(([label, k, money]) => {
      const f = ex[k] || {}, has = f.value !== null && f.value !== undefined && f.value !== "";
      return `<button class="fieldrow" type="button"><span class="v">${has ? esc(money ? inr(f.value) : f.value) : '<span class="missing">not on invoice</span>'}</span>
        <span class="conf ${has && f.confidence < 0.8 ? "low" : ""}">${has ? Math.round((f.confidence || 0) * 100) + "%" : ""}</span>
        <span class="k">${label}</span><span></span>
        <span class="src">${f.source_text ? "“" + esc(f.source_text) + "”" : "no source text returned"}</span></button>`;
    }).join("")}
    ${(ex.line_items || []).length ? `<table class="mini"><tr><th>Line</th><th class="num">Qty</th><th class="num">Rate</th><th class="num">Amount</th></tr>
      ${ex.line_items.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.quantity ?? "—"}</td><td class="num">${inr(l.unit_price)}</td><td class="num">${inr(l.amount)}</td></tr>`).join("")}</table>` : ""}
    ${ex.notes ? `<div class="inset" style="margin-top:10px;font-size:13px"><b>Note on invoice:</b> ${esc(ex.notes)}</div>` : ""}`;
}

function verdictHTML(run) {
  const d = run.decision || "HOLD", e = run.explanation || {}, review = run.review_status;
  let side = "";
  if (d === "HOLD" && review === "pending") {
    const f = Object.fromEntries((run.findings || []).map((x) => [x.code, x]));
    const val = (run.stages || []).find((x) => x.stage === "validate")?.data || {};
    const over = f.PO_OVERRUN && f.PO_OVERRUN.data.remaining > 0 ? f.PO_OVERRUN.data : null;
    const partial = over ? Math.round(over.remaining * (1 + (val.tax_rate || 18) / 100) * 100) / 100 : 0;
    side = `<div class="inset"><h3>Your decision</h3>
      <label for="note" class="muted" style="font-size:12px">Note for the audit trail (required)</label>
      <textarea id="note" placeholder="${f.BANK_CHANGED ? "e.g. Called vendor on registered number — new account confirmed" : "Why are you approving or rejecting?"}"></textarea>
      ${f.BANK_CHANGED ? `<label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;margin-bottom:10px"><input type="checkbox" id="updBank" style="margin-top:3px">
        <span>I confirmed the new bank details with the vendor on their <b>registered</b> phone — update the vendor master so future invoices pass.</span></label>` : ""}
      ${over ? `<button class="dark" id="partial" style="width:100%;justify-content:center;margin-bottom:8px;min-height:44px">Pay only what's left on the PO · ${inr(partial)}</button>` : ""}
      <div class="btns"><button class="danger" id="reject">Reject</button><button class="primary" id="approve">${over ? "Approve full amount" : "Approve for payment"}</button></div></div>`;
  } else if (review && review !== "pending") {
    side = `<div class="inset"><h3>Reviewed</h3><span class="status ${review}">${REVIEW_LABEL[review]}</span>
      <div style="margin-top:8px">${esc(run.reviewer_note)}</div><div class="muted" style="font-size:12px">${when(run.reviewed_at)}</div></div>`;
  } else if (d === "APPROVE") {
    side = `<div class="inset"><h3>Posted to the ledger</h3><div class="muted" style="font-size:13px">Scheduled for the next payment run. A re-send of this invoice will now be caught as a duplicate.</div></div>`;
  } else if (d === "REJECT") {
    side = `<div class="inset"><h3>Not paid</h3><div class="muted" style="font-size:13px">Rejected invoices are never posted to the ledger.</div></div>`;
  }
  const steps = (e.next_steps || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const email = e.vendor_email ? `<details class="email inset" style="margin-top:10px"><summary>Draft email to vendor — ${esc(e.vendor_email.subject)}</summary>
      <div class="mailbody" id="emailBody">${esc(e.vendor_email.body)}</div><button class="small white" id="copyEmail" style="margin-top:8px">Copy email</button></details>` : "";
  return `<div class="chips"><span class="status ${d}">${DECISION_WORD[d]}</span>${e.source && e.source !== "template" ? `<span class="chip">worded by ${esc(e.source)}</span>` : ""}</div>
    <div class="headline">${esc(e.headline || run.headline || "")}</div>
    <div class="summary">${esc(e.summary || run.error || "")}</div>
    <div class="verdict-cols"><div>${steps ? `<h3>Next steps</h3><ol>${steps}</ol>` : ""}${email}</div><div>${side}</div></div>`;
}

function bindReview(run, after) {
  const go = async (action) => {
    const note = $("#note").value.trim();
    if (!note) { toast("Add a note so the audit trail says why."); $("#note").focus(); return; }
    const upd = !!($("#updBank") && $("#updBank").checked && action !== "reject");
    try { await post(`/api/runs/${run.id}/review`, { action, note, update_vendor_bank: upd });
      toast(action === "reject" ? "Rejected" : action === "approve_partial" ? "Short-paid — posted to the ledger" : upd ? "Approved — vendor master updated" : "Approved — posted to the ledger"); after(); }
    catch (e) { toast(e.message); }
  };
  if ($("#approve")) { $("#approve").onclick = () => go("approve"); $("#reject").onclick = () => go("reject"); }
  if ($("#partial")) $("#partial").onclick = () => go("approve_partial");
  if ($("#copyEmail")) $("#copyEmail").onclick = () => { navigator.clipboard.writeText($("#emailBody").textContent); toast("Email copied"); };
}

// ------------------------------------------------------------------ dashboard
async function viewDashboard() {
  let filter = "all";
  $("#view").innerHTML = `<div class="crumbs">Checkpoint / <b>Dashboard</b></div>
    <div class="pagehead"><h1>Dashboard</h1><div class="actions"><a class="btn white" href="#/review">Review queue</a><a class="btn primary" href="#/">New run <span aria-hidden="true">→</span></a></div></div>
    <div class="grid4" id="kpis"></div>
    <div class="cols" style="margin-top:14px">
      <div class="col-main"><div class="card tight">
        <div class="cardhead" style="padding:4px 4px 6px"><div class="tabs" role="tablist" aria-label="Filter runs" id="filters">
          ${[["all", "All runs"], ["HOLD", "On hold"], ["APPROVE", "Approved"], ["REJECT", "Rejected"], ["pending", "Awaiting review"]].map(([f, l]) =>
            `<button role="tab" aria-selected="${f === "all"}" data-f="${f}">${l}</button>`).join("")}</div><span class="muted" style="font-size:12px">updates live</span></div>
        <div class="runs" id="runsTable"></div></div></div>
      <div class="col-side"><div class="card" id="reasons"></div><div class="card" id="queueCard"></div></div>
    </div>`;
  const load = async () => {
    const [m, runs] = await Promise.all([api("/api/metrics"), api("/api/runs")]);
    const done = runs.filter((r) => r.status !== "running");
    const n = Math.max(1, m.processed), stp = m.straight_through_rate === null ? "—" : Math.round(m.straight_through_rate * 100) + "%";
    const stopped = (m.value_held || 0) + (m.value_rejected || 0);
    const segs = done.slice(0, 20).reverse();
    const spark = done.filter((r) => r.decision !== "APPROVE").slice(0, 8).reverse().map((r) => r.total || 0), smax = Math.max(1, ...spark);
    $("#kpis").innerHTML = `
      <div class="card kpi"><div class="l">Invoices processed</div><div class="v">${m.processed}</div><div class="s">${inr(m.value_processed)} in total</div>
        <div class="stack"><span style="width:${100 * m.approved / n}%;background:var(--ok)"></span><span style="width:${100 * m.held / n}%;background:var(--hold)"></span><span style="width:${100 * m.rejected / n}%;background:var(--bad)"></span></div></div>
      <div class="card kpi"><div class="l">Straight-through</div><div class="v">${stp}</div><div class="s">approved with no human touch</div>
        <div class="segs" style="grid-template-columns:repeat(${Math.max(segs.length, 1)},minmax(0,1fr))">${segs.map((r) => `<span class="${r.decision === "APPROVE" ? "on" : ""}" title="${esc(r.vendor_name || r.filename)}"></span>`).join("") || "<span></span>"}</div></div>
      <div class="card kpi"><div class="l">Money stopped</div><div class="v">${inrShort(stopped)}</div><div class="s">held or rejected before payment</div>
        <div class="spark">${spark.map((v) => `<span style="height:${Math.max(10, 100 * v / smax)}%"></span>`).join("")}</div></div>
      <div class="card kpi"><div class="l">Time per invoice</div><div class="v">${m.avg_seconds ?? "—"}${m.avg_seconds ? " s" : ""}</div><div class="s">vs. about 10 min by hand</div>
        <div class="stack" style="background:var(--muted)"><span style="width:${m.avg_seconds ? Math.max(1.5, Math.min(100, m.avg_seconds / 6)) : 0}%;background:var(--accent)"></span></div></div>`;
    const max = Math.max(1, ...m.reasons.map((r) => r[1]));
    $("#reasons").innerHTML = `<div class="cardhead"><span class="t">Why invoices stopped</span></div>${m.reasons.length ? m.reasons.map(([t, c]) =>
      `<div class="reason"><div class="rt"><span>${esc(t)}</span><span class="muted">${c}</span></div><div class="rb"><i style="width:${100 * c / max}%"></i></div></div>`).join("") : '<div class="muted">Nothing stopped yet.</div>'}`;
    const pend = runs.filter((r) => r.review_status === "pending");
    $("#queueCard").innerHTML = `<div class="cardhead"><span class="t">Review queue</span></div><div class="muted" style="font-size:12px;margin-bottom:12px">${pend.length} invoice${pend.length === 1 ? "" : "s"} · ${inr(pend.reduce((a, r) => a + (r.total || 0), 0))} waiting</div>
      <a class="btn small dark" href="#/review">${pend.length ? "Start reviewing" : "Open queue"} <span aria-hidden="true">→</span></a>`;
    const shown = runs.filter((r) => filter === "all" || (filter === "pending" ? r.review_status === "pending" : r.decision === filter));
    $("#runsTable").innerHTML = shown.length ? shown.map((r) => `
      <button class="runrow" data-id="${r.id}" type="button"><span class="ini">${r.status === "queued" || r.status === "running" ? '<span class="spin" style="width:14px;height:14px"></span>' : esc(initials(r.vendor_name || r.filename))}</span>
        <span class="who"><b>${esc(r.vendor_name || r.filename)}</b><span class="mono">${esc(r.invoice_number || "no number")} · #${r.id}</span></span>
        <span class="num">${inr(r.total)}</span>
        <span>${r.status === "running" ? '<span class="status running">Running</span>' : r.status === "queued" ? '<span class="status info">Queued</span>' : `<span class="status ${r.decision}">${DECISION_WORD[r.decision]}</span>`}
          ${r.review_status && r.review_status !== "pending" ? `<div style="margin-top:4px"><span class="status ${r.review_status}">${REVIEW_LABEL[r.review_status]}</span></div>` : ""}</span>
        <span class="why">${esc(r.status === "queued" ? "Waiting in the queue" : r.status === "running" ? "Being checked now" : r.top_reason || (r.decision === "APPROVE" ? "All checks passed" : ""))}</span>
        <span class="num muted" style="font-size:12px">${r.duration_ms ? (r.duration_ms / 1000).toFixed(1) + " s" : ""}</span></button>`).join("")
      : `<div class="empty">No runs here yet. <a href="#/">Check an invoice</a> to get started.</div>`;
    $$(".runrow").forEach((b) => (b.onclick = () => (location.hash = `#/run/${b.dataset.id}`)));
    refreshShell();
    const busy = runs.some((r) => r.status === "running" || r.status === "queued");
    clearTimeout(viewDashboard._t);
    if (busy && document.body.contains($("#runsTable"))) viewDashboard._t = setTimeout(load, 1500);
  };
  $$("#filters button").forEach((b) => (b.onclick = () => { filter = b.dataset.f; $$("#filters button").forEach((x) => x.setAttribute("aria-selected", x === b)); load(); }));
  await load();
  timers.push(setInterval(load, 5000));
}

// ------------------------------------------------------------------ review queue
async function viewReview() {
  const runs = (await api("/api/runs")).filter((r) => r.review_status === "pending");
  const full = await Promise.all(runs.map((r) => api(`/api/runs/${r.id}`)));
  $("#view").innerHTML = `<div class="crumbs">Checkpoint / <b>Review queue</b></div>
    <div class="pagehead"><div><h1>Review queue</h1><p>Invoices Checkpoint stopped. Each one says what's wrong and what to do; your decision and note go into the audit trail.</p></div></div>
    <div style="display:flex;flex-direction:column;gap:12px">${full.length ? full.map((r) => `
      <div class="card qitem"><div>
        <div class="chips"><span class="status HOLD">On hold</span><span class="chip">${esc(r.invoice_number || "no number")}</span><span class="chip">${inr(r.total)}</span><span class="chip">${esc(when(r.created_at))}</span></div>
        <div style="font-weight:600;font-size:16px;margin-top:10px">${esc(r.vendor_name || r.filename)}</div>
        <div style="margin-top:2px">${esc(r.headline)}</div>
        <ul>${(r.findings || []).filter((f) => f.severity === "hold").map((f) => `<li>${esc(f.title)}${f.action ? ` — <span style="color:var(--ink)">${esc(f.action)}</span>` : ""}</li>`).join("")}</ul>
      </div><div class="inset">
        <label for="n${r.id}" class="muted" style="font-size:12px">Note (required)</label>
        <textarea id="n${r.id}" data-note="${r.id}"></textarea>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="small danger" data-act="reject" data-id="${r.id}">Reject</button><button class="small primary" data-act="approve" data-id="${r.id}">Approve</button><a class="btn small white" href="#/run/${r.id}">Open run</a></div>
      </div></div>`).join("") : '<div class="card empty">Nothing waiting for review.</div>'}</div>`;
  $$("[data-act]").forEach((b) => (b.onclick = async () => {
    const note = $(`[data-note="${b.dataset.id}"]`).value.trim();
    if (!note) { toast("Add a note so the audit trail says why."); return; }
    try { await post(`/api/runs/${b.dataset.id}/review`, { action: b.dataset.act, note }); toast(b.dataset.act === "approve" ? "Approved — posted to the ledger" : "Rejected"); viewReview(); refreshShell(); }
    catch (e) { toast(e.message); }
  }));
}

// ------------------------------------------------------------------ reference
async function viewReference(sub = "pos") {
  const ref = await api("/api/reference");
  const tabs = { pos: "Purchase orders", vendors: "Vendor master", ledger: "Invoice ledger", learned: "Learned from reviewers" };
  const vname = (id) => (ref.vendors.find((v) => v.vendor_id === id) || {}).legal_name || id;
  let body = "";
  if (sub === "vendors") body = `<table class="data"><tr><th>Vendor</th><th>GSTIN</th><th>Bank account · IFSC</th><th>Registered phone</th><th>Status</th></tr>
    ${ref.vendors.map((v) => `<tr><td><b>${esc(v.legal_name)}</b><div class="muted mono">${v.vendor_id}</div></td><td class="mono">${v.gstin}</td>
      <td class="mono">${v.bank_account}<div class="muted">${v.ifsc} · ${esc(v.bank_name)}</div></td><td>${esc(v.registered_phone)}</td>
      <td>${v.status === "Active" ? '<span class="status APPROVE">Active</span>' : `<span class="status REJECT">${v.status}</span><div class="muted" style="font-size:12px;margin-top:4px">${esc(v.blocked_reason)}</div>`}</td></tr>`).join("")}</table>`;
  else if (sub === "learned") {
    const changed = ref.vendors.filter((v) => v.verified_change);
    body = `<div style="padding:8px 12px 14px"><p class="muted" style="margin:4px 0 12px">Things a person taught Checkpoint. Each one is used by the rules — and still checked against amounts and balances.</p>
      <h3>Remembered PO choices</h3>${ref.po_memory.length ? `<table class="data"><tr><th>Vendor</th><th>Charge</th><th>Goes to</th><th>Taught on</th></tr>${ref.po_memory.map((m) =>
        `<tr><td>${esc(vname(m.vendor_id))}</td><td>“${esc(m.description)}”</td><td class="mono">${esc(m.po_number)}</td><td><a href="#/run/${m.run_id}">Run #${m.run_id}</a> · ${esc(when(m.created_at))}</td></tr>`).join("")}</table>`
        : '<div class="muted" style="margin-bottom:14px">None yet — resolve an ambiguous PO (sample #05) with “Use PO”.</div>'}
      <h3 style="margin-top:16px">Verified vendor changes</h3>${changed.length ? `<table class="data"><tr><th>Vendor</th><th>New bank details</th><th>Verified</th></tr>${changed.map((v) =>
        `<tr><td>${esc(v.legal_name)}</td><td class="mono">${esc(v.bank_account)} · ${esc(v.ifsc)}</td><td><a href="#/run/${v.verified_change.run_id}">Run #${v.verified_change.run_id}</a> — ${esc(v.verified_change.note)}</td></tr>`).join("")}</table>`
        : '<div class="muted">None yet — approve sample #06 and tick “update the vendor master”.</div>'}</div>`;
  }
  else if (sub === "ledger") body = `<table class="data"><tr><th>Invoice</th><th>Vendor</th><th>PO</th><th>Date</th><th class="num">Pre-tax</th><th class="num">Total</th><th>Status</th><th>Source</th></tr>
    ${ref.ledger.map((l) => `<tr><td class="mono">${esc(l.invoice_number)}</td><td>${esc(vname(l.vendor_id))}</td><td class="mono">${esc(l.po_number)}</td><td>${esc(l.invoice_date)}</td>
      <td class="num">${inr(l.subtotal)}</td><td class="num">${inr(l.total)}</td><td>${esc(l.status)}${l.paid_on ? " · " + l.paid_on : ""}</td>
      <td>${l.source === "checkpoint" ? `<a href="#/run/${l.run_id}">Run #${l.run_id}</a>` : '<span class="muted">history</span>'}</td></tr>`).join("")}</table>`;
  else body = `<table class="data"><tr><th>PO</th><th>Vendor</th><th>Lines</th><th class="num">Value (pre-tax)</th><th>Billed so far</th><th class="num">Left</th><th>Status</th></tr>
    ${ref.purchase_orders.map((p) => { const pct = Math.min(100, 100 * p.invoiced / p.subtotal); return `<tr><td class="mono">${p.po_number}<div class="muted">${p.po_date}</div></td><td>${esc(p.vendor_name)}</td>
      <td>${p.lines.map((l) => `<div>${esc(l.description)} <span class="muted">· ${l.qty.toLocaleString("en-IN")} × ${inr(l.unit_price)}</span></div>`).join("")}</td>
      <td class="num">${inr(p.subtotal)}<div class="muted">GST ${p.tax_rate}%</div></td>
      <td><span class="progress ${pct >= 100 ? "full" : ""}"><i style="width:${pct}%"></i></span> <span class="muted">${Math.round(pct)}%</span></td>
      <td class="num">${inr(p.remaining)}</td><td><span class="status ${p.status === "Open" ? "info" : "superseded"}">${esc(p.status)}</span></td></tr>`; }).join("")}</table>`;
  $("#view").innerHTML = `<div class="crumbs">Checkpoint / <b>Reference data</b></div>
    <div class="pagehead"><div><h1>Reference data</h1><p>What every invoice is checked against. Buyer: ${esc(ref.buyer.name)} · GSTIN ${ref.buyer.gstin}</p></div></div>
    <div class="card tight"><div class="cardhead" style="padding:4px"><div class="tabs" role="tablist">${Object.entries(tabs).map(([k, t]) =>
      `<button role="tab" aria-selected="${k === sub}" onclick="location.hash='#/reference/${k}'">${t}</button>`).join("")}</div></div>
      <div style="overflow-x:auto">${body}</div></div>`;
}

// ------------------------------------------------------------------ rules
const SETTING_LABELS = {
  amount_tolerance_pct: ["Amount tolerance (%)", "Invoice may exceed the PO balance by this %…"],
  amount_tolerance_abs: ["Amount tolerance (₹)", "…or this many rupees, whichever is lower"],
  price_tolerance_pct: ["Unit price tolerance (%)", "How far a unit price may exceed the PO price"],
  auto_approve_limit: ["Auto-approval limit (₹)", "Above this, a finance manager must approve"],
  max_invoice_age_days: ["Max. invoice age (days)", "Older invoices are held"],
  min_field_confidence: ["Min. field certainty (0–1)", "Key fields read below this are not trusted"],
  po_inference_min_score: ["PO inference: min. score", "Used when an invoice has no PO number"],
  po_inference_min_gap: ["PO inference: min. lead", "Points the best PO must be ahead by"],
  duplicate_hold_score: ["Duplicate hold score", "Near-duplicate score (of 110) that triggers a hold"],
  reuse_readings: ["Reuse readings of identical files", "Same file fingerprint → skip the AI call; all checks still run"],
};
async function viewRules() {
  const s = await api("/api/settings");
  $("#view").innerHTML = `<div class="crumbs">Checkpoint / <b>Rules &amp; assumptions</b></div>
    <div class="pagehead"><div><h1>Rules &amp; assumptions</h1><p>AI reads the invoice and words the result. Everything on this page decides — deterministically, so the same invoice always gets the same answer.</p></div></div>
    <div class="cols"><div class="col-main">
      <div class="card"><div class="cardhead"><span class="t">Business rules</span><button class="primary small" id="save">Save rules</button></div>
        <div class="settings">${Object.entries(SETTING_LABELS).map(([k, [l, h]]) => typeof s[k] === "boolean"
          ? `<label>${l}<small>${h}</small><span style="display:flex;gap:8px;align-items:center"><input data-k="${k}" data-bool="1" type="checkbox" ${s[k] ? "checked" : ""} style="width:auto"> on</span></label>`
          : `<label>${l}<small>${h}</small><input data-k="${k}" type="number" step="any" value="${s[k]}"></label>`).join("")}</div>
        <div class="muted" style="font-size:12px;margin-top:10px">Changes apply to the next run.</div></div>
      <div class="card"><div class="cardhead"><span class="t">How a decision is made</span></div><ol class="steps-list" style="margin:0;padding-left:18px">
        <li><b>Read</b> (AI): every field with a certainty score and the exact text it came from. Digital PDFs are read from their text; scans from a page image.</li>
        <li><b>Validate</b>: required fields, line maths, subtotal + tax = total, GST type matches place of supply, GSTIN checksum (a failed checksum close to a known GSTIN is treated as a misread), billed to Kestrel, dates.</li>
        <li><b>Vendor</b>: in the vendor master and active; bank account and IFSC must match exactly — never auto-corrected.</li>
        <li><b>Duplicates</b>: exact number match → reject. Otherwise number core (+50), amount (+30), date (+15/20) and PO (+10) → hold at ${s.duplicate_hold_score}+.</li>
        <li><b>PO</b>: use the printed PO; if none, score the vendor's open POs and accept only a clear winner.</li>
        <li><b>Amounts</b>: pre-tax, against what is <i>left</i> on the PO after earlier invoices, plus unit prices and quantities.</li>
        <li><b>Decide</b>: the worst finding wins — any reject → Reject, any hold → Hold, otherwise Approve. When unsure, hold.</li></ol></div>
    </div><div class="col-side">
      <div class="card"><div class="cardhead"><span class="t">Assumptions</span></div><ul class="plain" style="margin:0;padding-left:18px">
        <li>One buyer: Kestrel Foods Pvt Ltd, Bengaluru (Karnataka). Currency INR.</li>
        <li>2-way match (invoice ↔ PO). Goods-receipt (3-way) matching is the natural next step.</li>
        <li>Approved invoices are posted to the ledger, so a re-send is caught next time.</li>
        <li>Invoices arrive as PDF uploads; email intake would sit in front of step 1 in production.</li>
        <li>Vendor master, POs and payment history are sample data made for this exercise.</li></ul></div>
      <div class="card"><div class="cardhead"><span class="t">Demo data</span></div><p class="muted" style="margin:0 0 12px">Clears all runs and restores the original ledger and rules.</p>
        <button class="danger" id="reset">Reset demo data</button></div>
    </div></div>`;
  $("#save").onclick = async () => {
    const vals = {}; $$("[data-k]").forEach((i) => (vals[i.dataset.k] = i.dataset.bool ? i.checked : Number(i.value)));
    await api("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(vals) }); toast("Rules saved");
  };
  let armed = false;
  $("#reset").onclick = async () => {
    if (!armed) { armed = true; $("#reset").textContent = "Click again to confirm"; setTimeout(() => { armed = false; if ($("#reset")) $("#reset").textContent = "Reset demo data"; }, 4000); return; }
    await post("/api/reset"); toast("Demo data reset"); viewRules(); refreshShell();
  };
}

health();
route();
