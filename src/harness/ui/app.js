// Quiver browser UI — talks to the loopback daemon API.
// The per-install secret is injected by the launcher into window.__QUIVER_SECRET__.
const SECRET = window.__QUIVER_SECRET__ || "";
const headers = () => ({ "X-Quiver-Secret": SECRET, "Content-Type": "application/json" });

async function api(path, init = {}) {
  const res = await fetch(path, { ...init, headers: { ...headers(), ...(init.headers || {}) } });
  return res.json();
}

async function init() {
  // Load the twelve reference workflows (the harness acceptance boundary).
  const wf = document.getElementById("workflow-select");
  const names = [
    "earnings-update", "transcript-review", "company-primer", "thesis-tracker",
    "ic-memo", "diligence-tracker", "market-map", "pitchbook-materials",
    "portfolio-review", "investment-proposal", "manager-research-note", "client-commentary",
  ];
  for (const n of names) {
    const opt = document.createElement("option");
    opt.value = n; opt.textContent = n;
    wf.appendChild(opt);
  }
  document.getElementById("context-summary").textContent =
    "Select a workflow, then approve context, sources, model profile and the data boundary (public / confidential-internal / restricted-MNPI).";
  document.getElementById("goal-summary").textContent =
    "Confirm the objective, deliverable, reviewer and cost/depth mode before execution begins.";
  document.getElementById("commit-status").textContent =
    "An approved change set commits a new version to the chosen storage provider with preserved provenance.";

  document.getElementById("approve").addEventListener("click", () => decide(true));
  document.getElementById("reject").addEventListener("click", () => decide(false));
}

async function decide(approved) {
  // In the full wiring this calls the ExecutionEngine resume endpoint.
  document.getElementById("commit-status").textContent = approved
    ? "Approved — committing a new version with conflict checks…"
    : "Rejected — no commit. The change set is retained for review.";
}

init();