import { $ } from "./dom.js";
import { api, state } from "./state.js";
import { addActivity } from "./activity.js";
import { closeOverlay, showOverlay } from "./overlays.js";
import {
  sendPrompt,
  toggleContextDrawer,
  toggleActivityDrawer,
  autoSize,
  clearChat,
  showEmpty,
  hideEmpty,
  approveAction,
  rejectAction,
  requestRevision,
} from "./chat.js";
import {
  saveMemoryFile,
  deleteMemoryFile,
  saveCoreMemory,
  saveSkill,
  openReviewQueue,
  renderAttachments,
} from "./context.js";
import { openSessions } from "./sessions.js";
import { ensureDocumentCard, loadEvidenceFromDisk } from "./cards.js";
import {
  markVerified,
  markFlagged,
  markNeedsAnalyst,
  markFinalForCurrentDocument,
  overrideFinalForCurrentDocument,
} from "./lineage.js";
import {
  consentApprove,
  consentDecline,
  consentExclude,
  compactionApprove,
  compactionDecline,
  evidenceConsentApprove,
  evidenceConsentDecline,
} from "./consent.js";

function wireButtons() {
  state.sendBtn.addEventListener("click", sendPrompt);
  state.stopBtn.addEventListener("click", async () => {
    state.turnRunning = false;
    state.liveRunActive = false;
    await api.stopAgent();
  });

  $("toggleContextBtn")?.addEventListener("click", toggleContextDrawer);
  $("toggleActivityBtn")?.addEventListener("click", toggleActivityDrawer);
  $("trustContextPill")?.addEventListener("click", toggleContextDrawer);

  $("approveBtn").addEventListener("click", () => approveAction(false));
  $("approveAllBtn").addEventListener("click", () => approveAction(true));
  $("reviseBtn").addEventListener("click", requestRevision);
  $("rejectBtn").addEventListener("click", rejectAction);
  $("memorySaveBtn").addEventListener("click", saveMemoryFile);
  $("memoryDeleteBtn").addEventListener("click", deleteMemoryFile);
  $("coreSaveBtn").addEventListener("click", saveCoreMemory);
  $("skillSaveBtn").addEventListener("click", saveSkill);
  $("openReviewBtn").addEventListener("click", openReviewQueue);
  $("sessionsBtn").addEventListener("click", openSessions);
  $("newSessionBtn").addEventListener("click", async () => {
    closeOverlay("sessionsOverlay");
    clearChat();
    showEmpty();
    $("conversationTitle").textContent = "New work";
    $("ctxTurns").textContent = "New session";
    $("ctxTokensSection").hidden = true;
    state.activityStream.innerHTML =
      '<div id="activityEmpty" class="activity-empty">Activity will appear here when Quiver starts working.</div>';
    $("activityClearBtn").hidden = true;
    state.lastContextEntryText = null;
    try {
      await api.sendToAgent("/reset");
      addActivity("Started a new draft session.", "ok");
    } catch (error) {
      addActivity("Could not reset the session: " + (error?.message || error), "err");
    }
    state.promptInput.focus();
  });
  $("settingsBtn").addEventListener("click", () => api.loadSettings());
  $("ctxEditBtn").addEventListener("click", () => showOverlay("coreOverlay"));
  $("activityClearBtn").addEventListener("click", () => {
    state.activityStream.innerHTML =
      '<div id="activityEmpty" class="activity-empty">Activity will appear here when Quiver starts working.</div>';
    $("activityClearBtn").hidden = true;
    state.lastContextEntryText = null;
  });
  $("attachments").addEventListener("click", (e) => {
    const x = e.target.closest(".attach-x");
    if (!x) return;
    const removed = state.attachments.find((a) => a.path === x.dataset.path);
    if (removed?.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
    state.attachments = state.attachments.filter((a) => a.path !== x.dataset.path);
    renderAttachments();
  });

  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeOverlay(b.dataset.close)),
  );
  // Click outside the card closes an overlay.
  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("click", (e) => {
      if (e.target === o) closeOverlay(o.id);
    }),
  );

  // suggestion chips
  const chips = [
    "Prepare an investment committee memo from my files",
    "Review a company's latest earnings and draft the evidence pack",
    "Build a portfolio review from the approved workspace sources",
  ];
  const wrap = $("suggestionChips");
  const existingChips = [...(wrap?.querySelectorAll(".chip") || [])];
  const chipButtons = existingChips.length
    ? existingChips
    : chips.map((c) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = c;
        wrap.appendChild(b);
        return b;
      });
  for (const b of chipButtons) {
    const c = b.dataset.suggestion || b.textContent || "";
    b.addEventListener("click", () => {
      state.promptInput.value = c;
      autoSize();
      sendPrompt();
    });
  }

  // S12: Workflow rerun button — re-run the flagship IC memo demo
  const rerunBtn = $("runWorkflowBtn");
  if (rerunBtn) {
    rerunBtn.addEventListener("click", async () => {
      rerunBtn.disabled = true;
      rerunBtn.textContent = "Running workflow…";
      addActivity("Re-running IC memo workflow (deterministic)", "tool");
      try {
        const result = await api.rerunWorkflow();
        if (result?.success) {
          addActivity(`Workflow complete — ${result.checks}/8 checks passed`, "ok");
          hideEmpty();
          // Route through the same evidence-checked card lifecycle as agent docs.
          const demoPath =
            result.outputPath ||
            result.deliverable ||
            "examples/investment-committee-memo/output/Project_Alder_IC_Memo.docx";
          const card = ensureDocumentCard(demoPath);
          const titleEl = card.querySelector(".draft-title");
          const sub = card.querySelector(".draft-sub");
          const actions = card.querySelector(".draft-actions");
          if (titleEl) titleEl.textContent = "Project Alder IC Memo";
          if (sub) sub.textContent = `Workflow demo · ${result.checks || 8}/8 checks · checking evidence…`;
          if (actions) actions.hidden = true;
          card.classList.remove("ready", "evidence-invalid", "canceled");
          card.classList.add("evidence-pending");
          state.documentCards.set(demoPath, card);
          loadEvidenceFromDisk(demoPath).then(() => {
            if (sub && card.classList.contains("ready")) {
              sub.textContent = `Workflow demo · ${result.checks || 8}/8 checks passed · evidence validated`;
            }
          });
          // Wire Open/Reveal if the demo returned an absolute path
          if (result.outputPath) {
            card.querySelector(".doc-open")?.addEventListener("click", async (e) => {
              e.stopPropagation();
              await api.openFile(result.outputPath);
            }, { once: true });
          }
        } else {
          addActivity("Workflow failed — " + (result?.output || "").slice(0, 120), "err");
        }
      } catch (e) {
        addActivity("Could not run workflow: " + (e?.message || e), "err");
      }
      rerunBtn.disabled = false;
      rerunBtn.textContent = "Run workflow demo";
    });
  }
}

function wireNewButtons() {
  const mv = $("markVerifiedBtn");
  if (mv) mv.addEventListener("click", markVerified);
  const mf = $("markFlaggedBtn");
  if (mf) mf.addEventListener("click", markFlagged);
  const mn = $("markNeedsAnalystBtn");
  if (mn) mn.addEventListener("click", markNeedsAnalyst);
  const ca = $("consentApproveBtn");
  if (ca) ca.addEventListener("click", consentApprove);
  const cd = $("consentDeclineBtn");
  if (cd) cd.addEventListener("click", consentDecline);
  const ce = $("consentExcludeBtn");
  if (ce) ce.addEventListener("click", consentExclude);
  const cpa = $("compactionApproveBtn");
  if (cpa) cpa.addEventListener("click", compactionApprove);
  const cpd = $("compactionDeclineBtn");
  if (cpd) cpd.addEventListener("click", compactionDecline);
  const eca = $("evidenceConsentApproveBtn");
  if (eca) eca.addEventListener("click", evidenceConsentApprove);
  const ecd = $("evidenceConsentDeclineBtn");
  if (ecd) ecd.addEventListener("click", evidenceConsentDecline);
  const mf2 = $("markFinalBtn");
  if (mf2) mf2.addEventListener("click", () => markFinalForCurrentDocument());
  const ov = $("overrideBtn");
  if (ov) ov.addEventListener("click", () => overrideFinalForCurrentDocument());
}

export { wireButtons, wireNewButtons };
