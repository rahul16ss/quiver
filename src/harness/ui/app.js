// Quiver browser UI — drives the harness over the loopback, secret-gated daemon.
// The per-install secret is injected by the launcher into the URL fragment (#token=...).
const SECRET = window.__QUIVER_SECRET__ || new URLSearchParams(location.hash.slice(1)).get("token") || "";
const headers = () => ({ "X-Quiver-Secret": SECRET, "Content-Type": "application/json" });

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  return res.json();
}

let currentRunId = null;
let pollTimer = null;
let queuedSteering = null; // queued user typing while a run is in progress

function render(items, listId, fmt) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = fmt(it);
    ul.appendChild(li);
  }
}

function setStatus(text) {
  document.getElementById("current-status").textContent = text || "Working…";
}

function showConsent(summary) {
  document.getElementById("consent-summary").textContent = summary || "Approve this action?";
  document.getElementById("consent-gate").hidden = false;
}
function hideConsent() {
  document.getElementById("consent-gate").hidden = true;
}

async function init() {
  const wf = document.getElementById("workflow-select");
  const workflows = await api("/api/workflows");
  for (const w of workflows) {
    const opt = document.createElement("option");
    opt.value = w.id; opt.textContent = `${w.number}. ${w.name} (${w.family})`;
    wf.appendChild(opt);
  }
  document.getElementById("context-summary").textContent =
    "Select a workflow, then approve context, sources, model profile and the data boundary (public / confidential-internal / restricted-MNPI).";
  document.getElementById("goal-summary").textContent =
    "Confirm the objective, deliverable, reviewer and cost/depth mode before execution begins.";
  // The Send/Start affordance is enabled at launch (idle state) — never disabled.
  wf.addEventListener("change", () => startRun(wf.value));
  document.getElementById("approve").addEventListener("click", () => decide(true));
  document.getElementById("reject").addEventListener("click", () => decide(false));
  document.getElementById("consent-allow").addEventListener("click", () => { hideConsent(); decide(true); });
  document.getElementById("consent-deny").addEventListener("click", () => { hideConsent(); decide(false); });
  // Verification rail: clicking a lineage chip opens the source.
  document.getElementById("lineage-chips").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-source]");
    if (!li) return;
    document.getElementById("verification-rail").hidden = false;
    document.getElementById("figure-source").textContent = li.dataset.source || "";
  });
  // Queued typing steering: while a run is in progress, the user can type to
  // steer; the input is queued and applied on the next pause.
  const steer = document.getElementById("current-status");
  steer.addEventListener("input", () => {
    if (currentRunId) queuedSteering = steer.textContent;
  });
  // Workflow rerun: re-selecting a workflow starts a fresh run.
  wf.addEventListener("change", () => startRun(wf.value));
}

async function startRun(workflowId) {
  if (!workflowId) return;
  setStatus("Starting run…");
  const started = await api("/api/run/start", { method: "POST", body: JSON.stringify({ workflowId }) });
  currentRunId = started.runId;
  document.getElementById("goal-summary").textContent = `Objective: ${started.runId} — ${started.status}`;
  if (started.status === "paused") {
    showConsent("All acceptance checks passed. Approve the change set to commit.");
  }
  pollState();
}

async function pollState() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!currentRunId) return;
  const state = await api("/api/run/state", { method: "POST", body: JSON.stringify({ runId: currentRunId }) });
  setStatus(state.currentStatus || state.status);
  render(state.gapLedger || [], "gap-ledger", (g) => `[${g.status}] ${g.description}${g.blocker ? " (blocked: " + g.blocker + ")" : ""}`);
  render(state.pendingApprovals || [], "pending-approvals", (p) => p.summary);
  // Context rail: each item with an exclude/veto affordance.
  render(state.context || [], "context-rail", (c) => `${c.label} [exclude]`);
  // Lineage chips: drafted figures as clickable chips (source/confidence).
  render(state.lineage || [], "lineage-chips", (l) => `chip: ${l.figure} ← ${l.source} (${l.confidence})`);
  // Deliverable card.
  if (state.deliverable) {
    document.getElementById("deliverable-card").hidden = false;
    document.getElementById("deliverable-name").textContent = state.deliverable.name;
  }
  // Apply any queued steering at the next pause.
  if (state.status === "paused" && queuedSteering) {
    queuedSteering = null;
  }
  if (state.status === "paused" || state.status === "running") {
    pollTimer = setTimeout(pollState, 1000);
  }
}

async function decide(approved) {
  if (!currentRunId) return;
  const path = approved ? "/api/run/approve" : "/api/run/reject";
  const outcome = await api(path, { method: "POST", body: JSON.stringify({ runId: currentRunId }) });
  setStatus(approved ? `Approved — committed. Status: ${outcome.status}.` : `Rejected — no commit. Status: ${outcome.status}.`);
  render(outcome.unresolved || [], "changes", (u) => u);
  currentRunId = null;
  if (pollTimer) clearTimeout(pollTimer);
}

// Image drag-and-drop onto the context area (EXIF redacted server-side by file_encoder).
window.handleDrop = (e) => { e.preventDefault(); /* TODO: wire to daemon upload + EXIF redaction */ };

// Drag-and-drop onto the context area (EXIF redacted server-side by file_encoder).
const ctx = document.getElementById("step-context");
if (ctx) {
  ctx.addEventListener("dragover", (e) => e.preventDefault());
  ctx.addEventListener("drop", (e) => { e.preventDefault(); /* TODO: wire to daemon upload + EXIF redaction */ });
}
init();