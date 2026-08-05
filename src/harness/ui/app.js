// Quiver browser UI — drives the harness over the loopback, secret-gated daemon.
// The per-install secret is injected by the launcher into window.__QUIVER_SECRET__.
const SECRET = window.__QUIVER_SECRET__ || new URLSearchParams(location.hash.slice(1)).get("token") || "";
const headers = () => ({ "X-Quiver-Secret": SECRET, "Content-Type": "application/json" });

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  return res.json();
}

let currentRunId = null;
let pollTimer = null;

function render(items, listId, fmt) {
  const ul = document.getElementById(listId);
  ul.innerHTML = "";
  for (const it of items) {
    const li = document.createElement("li");
    li.textContent = fmt(it);
    ul.appendChild(li);
  }
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
  wf.addEventListener("change", () => startRun(wf.value));
  document.getElementById("approve").addEventListener("click", () => decide(true));
  document.getElementById("reject").addEventListener("click", () => decide(false));
}

async function startRun(workflowId) {
  if (!workflowId) return;
  document.getElementById("commit-status").textContent = "Starting run…";
  const started = await api("/api/run/start", { method: "POST", body: JSON.stringify({ workflowId }) });
  currentRunId = started.runId;
  document.getElementById("goal-summary").textContent = `Objective: ${started.runId} — ${started.status}`;
  if (started.status === "paused") {
    document.getElementById("pending-approvals").innerHTML = "<li>All acceptance checks passed. Approve the change set to commit.</li>";
  }
  pollState();
}

async function pollState() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!currentRunId) return;
  const state = await api("/api/run/state", { method: "POST", body: JSON.stringify({ runId: currentRunId }) });
  render(state.gapLedger || [], "gap-ledger", (g) => `[${g.status}] ${g.description}${g.blocker ? " (blocked: " + g.blocker + ")" : ""}`);
  render(state.pendingApprovals || [], "pending-approvals", (p) => p.summary);
  if (state.status === "paused" || state.status === "running") {
    pollTimer = setTimeout(pollState, 1000);
  }
}

async function decide(approved) {
  if (!currentRunId) return;
  const path = approved ? "/api/run/approve" : "/api/run/reject";
  const outcome = await api(path, { method: "POST", body: JSON.stringify({ runId: currentRunId }) });
  document.getElementById("commit-status").textContent = approved
    ? `Approved — committed. Status: ${outcome.status}.`
    : `Rejected — no commit. Status: ${outcome.status}. Unresolved: ${(outcome.unresolved || []).join("; ")}`;
  render(outcome.unresolved || [], "changes", (u) => u);
  currentRunId = null;
  if (pollTimer) clearTimeout(pollTimer);
}

init();