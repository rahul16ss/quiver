import { $ } from "./dom.js";
import { state } from "./state.js";

function getFocusable(root) {
  return [...root.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((el) => !el.hidden && el.offsetParent !== null);
}

function trapFocus(e) {
  if (e.key !== "Tab" || !state.activeOverlayTrap) return;
  const focusables = getFocusable(state.activeOverlayTrap);
  if (focusables.length === 0) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function showOverlay(id) {
  const el = $(id);
  if (!el) return;
  el.hidden = false;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  state.overlayFocusStack.push(document.activeElement);
  state.activeOverlayTrap = el;
  const focusables = getFocusable(el);
  (focusables[0] || el).focus?.();
}

function closeOverlay(id, force = false) {
  // Decision overlays are modal gates, not dismissible notifications. A
  // backdrop click, Escape, or a generic close button must not leave the
  // agent waiting while the UI suggests that the decision was skipped.
  if (
    !force &&
    ((id === "approvalOverlay" && state.pendingApproval) ||
      (id === "consentGateOverlay" && state.consentGateActive) ||
      (id === "compactionOverlay" && state.compactionGateActive) ||
      (id === "evidenceConsentOverlay" && state.evidenceConsentActive))
  ) {
    return;
  }
  const el = $(id);
  if (!el) return;
  el.hidden = true;
  if (state.activeOverlayTrap === el) state.activeOverlayTrap = null;
  const prev = state.overlayFocusStack.pop();
  if (prev && typeof prev.focus === "function") prev.focus();
}

function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    let host = $("appDialog");
    if (!host) {
      host = document.createElement("div");
      host.id = "appDialog";
      host.className = "app-dialog";
      host.hidden = true;
      host.innerHTML =
        '<div class="app-dialog-card" role="document">' +
        "<h3 id=\"appDialogTitle\"></h3>" +
        "<p id=\"appDialogMessage\"></p>" +
        '<div class="app-dialog-actions">' +
        '<button type="button" class="ghost-btn" id="appDialogCancel">Cancel</button>' +
        '<button type="button" class="primary-btn" id="appDialogConfirm">Confirm</button>' +
        "</div></div>";
      document.body.appendChild(host);
    }
    $("appDialogTitle").textContent = title;
    $("appDialogMessage").textContent = message;
    const confirmBtn = $("appDialogConfirm");
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = danger ? "danger-btn" : "primary-btn";
    host.hidden = false;
    host.setAttribute("role", "dialog");
    host.setAttribute("aria-modal", "true");
    state.activeOverlayTrap = host;
    confirmBtn.focus();
    const done = (value) => {
      host.hidden = true;
      if (state.activeOverlayTrap === host) state.activeOverlayTrap = null;
      $("appDialogCancel").onclick = null;
      confirmBtn.onclick = null;
      resolve(value);
    };
    $("appDialogCancel").onclick = () => done(false);
    confirmBtn.onclick = () => done(true);
  });
}

document.addEventListener("keydown", (e) => {
  trapFocus(e);
  if (e.key !== "Escape") return;
  if (state.pendingApproval || state.consentGateActive || state.compactionGateActive || state.evidenceConsentActive) return;
  const open = [...document.querySelectorAll(".overlay:not([hidden]), .app-dialog:not([hidden])")];
  const top = open[open.length - 1];
  if (top?.id) closeOverlay(top.id, true);
  else if (top) { top.hidden = true; state.activeOverlayTrap = null; }
});

export {
  getFocusable,
  trapFocus,
  showOverlay,
  closeOverlay,
  confirmDialog,
};
