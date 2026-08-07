// ─── Quiver Desktop — renderer entry (ES modules) ───────────────────────
// Three planes: Context | Conversation | Activity. The renderer is a thin
// view over the Quiver CLI (run in --json mode by the main process). It
// speaks only the allowlisted window.quiver IPC API exposed by preload.js.
// No framework, no build step, no inline scripts (CSP script-src 'self').

import { $ } from "./js/dom.js";
import { api, initDom, state } from "./js/state.js";
import { addActivity } from "./js/activity.js";
import { loadContextSurfaces } from "./js/context.js";
import {
  setWorking,
  syncDrawerControls,
  wireImageDrop,
  wireKeyboard,
  wireAgentEvents,
} from "./js/chat.js";
import { wireButtons, wireNewButtons } from "./js/wire.js";
import { initWorkflows } from "./js/runs.js";

async function init() {
  wireButtons();
  wireImageDrop();
  wireKeyboard();
  try {
    state.configured = await api.isConfigured();
  } catch {
    state.configured = false;
  }
  if (!state.configured) {
    api.loadOnboarding();
    return;
  }
  const config = await api.loadConfig();
  // Launch state is idle (Epic 2 §2.2): spawning the agent process is NOT
  // "working". Send stays visible/enabled; the dot goes amber only when a
  // prompt is dispatched or the agent reports activity.
  setWorking(false);
  try {
    await api.startAgent(config, false);
    state.agentAvailable = true;
  } catch (e) {
    state.agentAvailable = false;
    state.turnRunning = false;
    addActivity("Could not start the agent: " + (e?.message || e), "err");
  }
  // A failed/errored startup must never leave the working state stuck.
  setWorking(false);
  maybeShowWorkspaceWarning(config);
  loadContextSurfaces(config);
  syncDrawerControls();
  // Engagement-pack workflow picker + reattach to any run still going (ADR-009).
  initWorkflows();
}

// One-time, non-blocking banner when the configured workspace is Quiver's own
// app/source folder (Epic 2 §2.5). The path-policy hard block applies anyway;
// this just nudges the user toward a real documents folder.
function maybeShowWorkspaceWarning(config) {
  if (!config?.workspaceIsAppSource) return;
  const DISMISS_KEY = "quiver.workspaceWarningDismissed";
  try {
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
  } catch {}
  const banner = $("workspaceWarning");
  if (!banner) return;
  banner.hidden = false;
  $("workspaceWarningDismiss")?.addEventListener("click", () => {
    banner.hidden = true;
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {}
  });
}

initDom();
wireAgentEvents();
wireNewButtons();
init();
