import { escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { docKindFor, OFFICE_MUTATING_ACTIONS } from "./icons.js";
import { addActivity } from "./activity.js";
import { hideEmpty, scrollChat } from "./chat.js";
import { openPreview } from "./context.js";
import {
  renderLineageChipsForDocument,
  recordDeliverableContext,
  openDeliverableContext,
} from "./lineage.js";

function ensureDocumentCard(filePath) {
  if (state.documentCards.has(filePath)) return state.documentCards.get(filePath);
  hideEmpty();
  const kind = docKindFor(filePath);
  const name = String(filePath).split("/").pop();
  const card = document.createElement("div");
  card.className = "draft-card";
  card.innerHTML =
    '<div class="draft-icon ' +
    kind.iconClass +
    '">' +
    kind.svg +
    "</div>" +
    '<div class="draft-meta">' +
    '<div class="draft-title">Creating ' +
    escapeHtml(name) +
    "…</div>" +
    '<div class="draft-sub">' +
    escapeHtml(kind.label) +
    " · " +
    escapeHtml(filePath) +
    "</div>" +
    '<div class="draft-actions" hidden>' +
    '<button type="button" class="ghost-btn doc-open">Open</button>' +
    '<button type="button" class="ghost-btn doc-reveal">Show in Folder</button>' +
    '<button type="button" class="ghost-btn doc-preview">Preview</button>' +
    '<button type="button" class="ghost-btn doc-context">Context</button>' +
    "</div></div>";
  card.querySelector(".doc-open").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await api.openFile(filePath);
    if (res?.error) addActivity("Couldn't open " + name + ": " + res.error, "err");
  });
  card.querySelector(".doc-reveal").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await api.showInFolder(filePath);
    if (res?.error) addActivity("Couldn't reveal " + name + ": " + res.error, "err");
  });
  card.querySelector(".doc-preview").addEventListener("click", (e) => {
    e.stopPropagation();
    openPreview(filePath, name);
  });
  card.querySelector(".doc-context").addEventListener("click", (e) => {
    e.stopPropagation();
    openDeliverableContext(filePath);
  });
  card.addEventListener("click", () => openPreview(filePath, name));
  state.chatArea.appendChild(card);
  scrollChat();
  state.documentCards.set(filePath, card);
  return card;
}

function handleOfficeDocResult(args, ok) {
  const filePath = typeof args?.file === "string" ? args.file : "";
  if (!filePath || !OFFICE_MUTATING_ACTIONS.has(String(args?.action))) return;
  const card = ensureDocumentCard(filePath);
  const name = String(filePath).split("/").pop();
  const kind = docKindFor(filePath);
  const titleEl = card.querySelector(".draft-title");
  const actionsEl = card.querySelector(".draft-actions");
  if (ok) {
    if (titleEl) titleEl.textContent = name;
    card.querySelector(".draft-sub").textContent = kind.label + " · checking evidence…";
    card.querySelector(".draft-sub").title = filePath;
    if (actionsEl) actionsEl.hidden = true;
    card.classList.remove("canceled");
    card.classList.remove("ready", "evidence-invalid");
    // Stay pending until loadEvidenceFromDisk validates the companion.
    // Never flash ready before evidence clears (north-star: no unverified claim).
    card.classList.add("evidence-pending");
    loadEvidenceFromDisk(filePath);
  } else if (!card.classList.contains("ready")) {
    if (titleEl) titleEl.textContent = "Creation canceled — " + name;
    card.classList.add("canceled");
  }
  scrollChat();
}

// Load Evidence.json from disk and render lineage chips for a document.
// This complements the live evidence tool events — it picks up evidence
// from prior sessions or when reopening a document.
async function loadEvidenceFromDisk(filePath) {
  const card = state.documentCards.get(filePath);
  const sub = card?.querySelector(".draft-sub");
  const actions = card?.querySelector(".draft-actions");
  const kind = docKindFor(filePath);
  try {
    const result = await api.loadEvidence(filePath);
    if (!result || result.error || result.valid === false) {
      card?.classList.remove("ready", "evidence-pending");
      card?.classList.add("evidence-invalid");
      if (actions) actions.hidden = true;
      if (sub) {
        sub.textContent = `${kind.label} · not reviewable — evidence ${result?.missing ? "missing" : "invalid"}`;
      }
      addActivity(
        `${filePath.split("/").pop()}: evidence is ${result?.missing ? "missing" : "invalid"}; document remains a draft.`,
        "err",
      );
      return;
    }
    if (result.claims && result.claims.length > 0) {
      renderLineageChipsForDocument(filePath, result.claims, result.sources);
    }
    if (result.runRecord) {
      recordDeliverableContext(filePath, result);
    }
    card?.classList.remove("evidence-pending", "evidence-invalid");
    card?.classList.add("ready");
    if (actions) actions.hidden = false;
    if (sub) {
      // S7: the card should feel like receiving work — name what you're
      // getting: how many figures are sourced and how many still need you.
      const claims = Array.isArray(result.claims) ? result.claims : [];
      const open = claims.filter(
        (c) =>
          c.relationship === "unresolved" ||
          c.review_status === "flagged" ||
          c.review_status === "needs_analyst",
      ).length;
      const sourced =
        claims.length > 0
          ? ` · ${claims.length} figure${claims.length === 1 ? "" : "s"} sourced`
          : "";
      const toReview = open > 0 ? ` · ${open} to review` : "";
      sub.textContent = `${kind.label} · draft · evidence validated${sourced}${toReview}`;
    }
  } catch {
    card?.classList.remove("ready", "evidence-pending");
    card?.classList.add("evidence-invalid");
    if (actions) actions.hidden = true;
    if (sub) sub.textContent = `${kind.label} · not reviewable — evidence unavailable`;
    addActivity(
      `${filePath.split("/").pop()}: evidence could not be validated; document remains a draft.`,
      "err",
    );
  }
}

export { ensureDocumentCard, handleOfficeDocResult, loadEvidenceFromDisk, OFFICE_MUTATING_ACTIONS };
