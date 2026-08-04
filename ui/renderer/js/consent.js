import { $, escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { addActivity } from "./activity.js";
import { showOverlay, closeOverlay } from "./overlays.js";

function excludeFromRun(memoryName, itemEl) {
  if (state.excludedFromRun.has(memoryName)) {
    // Un-exclude
    state.excludedFromRun.delete(memoryName);
    itemEl.classList.remove("excluded");
    addActivity(`Re-included memory: ${memoryName}`, "ok");
  } else {
    state.excludedFromRun.add(memoryName);
    itemEl.classList.add("excluded");
    addActivity(`Excluded from next run: ${memoryName}`, "warn");
  }
  // Record the exclusion via IPC so the agent loop knows
  try { api.excludeFromRun?.(memoryName); } catch {}
}

function showConsentGate(manifestData) {
  const summary = $("consentGateSummary");
  if (!summary) return;
  // The consent_gate event carries structured data (memoryFiles array,
  // skills array, toolNames array); the legacy context_manifest carried
  // pre-formatted strings. Handle both.
  const model = manifestData?.model || "—";
  const memRaw = manifestData?.memoryFiles || manifestData?.memory || [];
  const mem = Array.isArray(memRaw) ? (memRaw.length ? `${memRaw.length} file${memRaw.length === 1 ? "" : "s"}: ${memRaw.join(", ")}` : "none") : String(memRaw || "—");
  const skillsRaw = manifestData?.skills || manifestData?.skillsDetail || [];
  const skills = Array.isArray(skillsRaw) ? (skillsRaw.length ? skillsRaw.map((s) => `${s.id} v${s.version}`).join(", ") : "none") : String(skillsRaw || "—");
  const toolsRaw = manifestData?.toolNames || [];
  const toolCount = manifestData?.toolCount || (Array.isArray(toolsRaw) ? toolsRaw.length : manifestData?.tools || 0);
  const tools = Array.isArray(toolsRaw) && toolsRaw.length ? `${toolCount} tools: ${toolsRaw.join(", ")}` : `${toolCount || "—"} tools`;
  const tier = manifestData?.trustTier ? ` · tier: ${manifestData.trustTier}` : "";
  const tokens = manifestData?.tokenEstimate ? ` · ${manifestData.tokenEstimate}` : "";
  const excluded = state.excludedFromRun.size > 0
    ? `<div class="ap-row"><span class="ap-label">Excluded from this run:</span><span class="ap-value">${escapeHtml([...state.excludedFromRun].join(", "))}</span></div>`
    : "";
  summary.innerHTML =
    `<div class="ap-row"><span class="ap-label">Model:</span><span class="ap-value">${escapeHtml(model)}${escapeHtml(tier)}${escapeHtml(tokens)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Memory:</span><span class="ap-value">${escapeHtml(mem)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Skills:</span><span class="ap-value">${escapeHtml(skills)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Tools:</span><span class="ap-value">${escapeHtml(tools)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">This turn:</span><span class="ap-value">${escapeHtml((manifestData?.userRequestPreview || "").slice(0, 80) || "—")}</span></div>` +
    excluded;
  showOverlay("consentGateOverlay");
  state.consentGateActive = true;
  state.consentGateShown = true;
}

// Send the consent decision to the agent so it can unblock (approve) or
// abort the turn (decline/exclude). The agent logs it to the audit chain.
function consentApprove() {
  state.consentGateActive = false;
  closeOverlay("consentGateOverlay", true);
  addActivity("Consent gate approved — Quiver is running", "ok");
  api.consentRespond("approve");
}

function consentDecline() {
  state.consentGateActive = false;
  closeOverlay("consentGateOverlay", true);
  addActivity("Consent declined — turn aborted (nothing entered the model)", "warn");
  api.consentRespond("decline");
}

function consentExclude() {
  state.consentGateActive = false;
  closeOverlay("consentGateOverlay", true);
  addActivity("Routed back to the context rail — exclude items, then re-run", "warn");
  api.consentRespond("exclude");
  focusContextRail();
}

// Focus the context rail so the reviewer can exclude a memory/source before
// re-running (SPEC §6 layer E veto).
function focusContextRail() {
  const rail = document.querySelector("#context-plane");
  if (!rail) return;
  const workspace = $("workspace");
  workspace?.classList.add("drawer-context-open");
  workspace?.classList.remove("hide-context");
  $("toggleContextBtn")?.setAttribute("aria-pressed", "true");
  rail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  rail.classList.add("ctx-focused");
  const firstMemory = rail.querySelector(".ctx-item, button, [tabindex]");
  (firstMemory || rail).focus?.();
  setTimeout(() => rail.classList.remove("ctx-focused"), 1400);
}

export {
  excludeFromRun,
  showConsentGate,
  consentApprove,
  consentDecline,
  consentExclude,
  focusContextRail,
};
