// Workflow runs — the engagement-pack workflow picker and the live run surface.
// Workflows come from the daemon's pack-gated /api/workflows; a run is followed
// live over /api/run/active + /api/run/state, surfaces in the Activity plane and
// the ambient ribbon, and re-attaches after a browser reload (the daemon keeps
// working while the window is closed).
import { $ } from "./dom.js";
import { api, state } from "./state.js";
import { addActivity } from "./activity.js";
import { setCurrentStatus } from "./chat.js";

const POLL_MS = 2500;
const dismissed = new Set(); // runIds whose approval overlay the user snoozed
const decided = new Set(); // runIds the user already approved/rejected
let activeRunId = null;
let pollTimer = null;
let lastPhase = "";

/** Load the engagement-pack workflows into the empty-state picker. */
export async function initWorkflows() {
  let specs = [];
  try {
    specs = (await api.listWorkflows()) ?? [];
  } catch {
    specs = [];
  }
  const box = $("workflowChips");
  if (box && Array.isArray(specs) && specs.length > 0) {
    box.innerHTML = "";
    const label = document.createElement("div");
    label.className = "chips-label";
    label.textContent = "Workflows from your engagement pack";
    box.appendChild(label);
    for (const s of specs) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip chip-workflow";
      b.dataset.workflowId = s.id;
      b.textContent = s.name;
      b.title = `${s.family} · produces ${s.deliverable?.type ?? "a deliverable"}`;
      box.appendChild(b);
    }
    box.hidden = false;
    box.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-workflow-id]");
      if (btn && !btn.disabled) startWorkflow(btn.dataset.workflowId, btn.textContent);
    });
  }
  // Ambient re-attach: a run started before this window opened is still going.
  try {
    const active = await api.listActiveRuns();
    if (active.length > 0) {
      const runId = active[active.length - 1];
      addActivity("Quiver kept working while you were away — reattached to the running workflow.", "tool");
      followRun(runId, "the workflow");
    }
  } catch { /* daemon without the harness API — chat-only mode */ }
}

/** Start a pack workflow and follow it live. */
async function startWorkflow(workflowId, name) {
  if (activeRunId) {
    addActivity("A workflow is already running — review or stop it before starting another.", "warn");
    return;
  }
  addActivity(`Workflow started: ${name}`, "tool");
  setCurrentStatus(`Running workflow: ${name}`);
  // The start request settles only when the run completes/pauses, so don't
  // await it here — follow live state via /api/run/active + /api/run/state.
  const startPromise = api.startWorkflowRun(workflowId);
  startPromise.then((outcome) => settleRun(workflowId, name, outcome)).catch((e) => {
    addActivity(`Workflow error: ${e?.message ?? e}`, "err");
    stopFollowing();
  });
  // Discover the run id once the daemon registers the in-flight run.
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    try {
      const active = await api.listActiveRuns();
      const mine = active.filter((id) => id.startsWith(`RUN-${workflowId}-`));
      if (mine.length > 0) {
        followRun(mine[mine.length - 1], name);
        return;
      }
    } catch { /* keep waiting */ }
  }
  addActivity("Could not attach to the workflow's live progress — it will report when done.", "warn");
}

/** Poll run state; surface phase changes, approvals, and completion. */
function followRun(runId, name) {
  activeRunId = runId;
  lastPhase = "";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => pollRun(runId, name), POLL_MS);
}

async function pollRun(runId, name) {
  let snap = null;
  try {
    snap = await api.runState(runId);
  } catch {
    return; // transient — next poll retries
  }
  if (!snap) return;
  if (snap.currentPhase && snap.currentPhase !== lastPhase) {
    lastPhase = snap.currentPhase;
    const open = (snap.gapLedger ?? []).filter((g) => g.status === "open" || g.status === "blocked").length;
    addActivity(`Workflow ${name}: ${phaseLabel(snap.currentPhase)}${open ? ` — ${open} open item${open === 1 ? "" : "s"}` : ""}`, "tool");
  }
  const pending = snap.pendingApprovals ?? [];
  if (pending.length > 0 && !decided.has(runId)) {
    if (dismissed.has(runId)) {
      const btn = $("pendingReviewBtn");
      if (btn) btn.hidden = false;
    } else {
      showRunApproval(runId, name, pending[0]?.summary);
    }
  }
}

/** The run's start request settled (completed, paused-awaiting-approval handled by poll). */
function settleRun(workflowId, name, outcome) {
  stopFollowing();
  const status = outcome?.status ?? "unknown";
  const artifacts = outcome?.artifacts ?? [];
  if (status === "completed") {
    addActivity(`Workflow ${name}: complete — ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} ready for review.`, "tool");
  } else if (status === "paused") {
    addActivity(`Workflow ${name}: waiting for your review.`, "warn");
  } else {
    const remaining = (outcome?.unresolved ?? []).slice(0, 3).join("; ");
    addActivity(`Workflow ${name}: ended ${status}${remaining ? ` — still open: ${remaining}` : ""}.`, "warn");
  }
  if (state.statusDot) state.statusDot.className = "status-dot idle";
}

function stopFollowing() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  activeRunId = null;
  setCurrentStatus("");
  const btn = $("pendingReviewBtn");
  if (btn) btn.hidden = true;
}

function showRunApproval(runId, name, summary) {
  const overlay = $("runApprovalOverlay");
  if (!overlay) return;
  const title = $("runApprovalTitle");
  const sum = $("runApprovalSummary");
  if (title) title.textContent = `${name} — ready for your review`;
  if (sum) sum.textContent = summary || "All acceptance checks passed. Approve the result to commit it, or send it back.";
  overlay.hidden = false;
  wireOnce("runApproveBtn", "click", async () => {
    overlay.hidden = true;
    decided.add(runId); // never re-prompt for a decided run
    addActivity("You approved the workflow result — committing.", "tool");
    try { await api.approveRun(runId); } catch (e) { addActivity(`Approve failed: ${e?.message ?? e}`, "err"); }
  });
  wireOnce("runRejectBtn", "click", async () => {
    overlay.hidden = true;
    decided.add(runId);
    addActivity("You sent the workflow back for rework.", "warn");
    try { await api.rejectRun(runId); } catch (e) { addActivity(`Reject failed: ${e?.message ?? e}`, "err"); }
  });
}

/** Snooze the approval overlay for this run; reopen from the activity plane. */
export function dismissRunApproval() {
  const overlay = $("runApprovalOverlay");
  if (overlay) overlay.hidden = true;
  if (activeRunId) {
    dismissed.add(activeRunId);
    const btn = $("pendingReviewBtn");
    if (btn) btn.hidden = false;
  }
}

/** Re-open the snoozed approval overlay (activity-plane "review pending" button). */
export function reopenRunApproval() {
  dismissed.delete(activeRunId);
  const overlay = $("runApprovalOverlay");
  if (overlay) overlay.hidden = false;
  const btn = $("pendingReviewBtn");
  if (btn) btn.hidden = true;
}

function wireOnce(id, kind, fn) {
  const el = $(id);
  if (!el) return;
  el.replaceWith(el.cloneNode(true)); // drop previous listeners (single-run surface)
  $(id).addEventListener(kind, fn);
}

function phaseLabel(phase) {
  const labels = {
    makePlan: "planning",
    runStep: "executing a step",
    runVerify: "verifying",
    runChecker: "independent check",
    runEvaluate: "evaluating",
    runApprove: "awaiting your review",
  };
  return labels[phase] ?? String(phase).replace(/^node\./, "").replace(/_/g, " ");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
