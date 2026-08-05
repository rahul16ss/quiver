import { $, escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { STATUS_ICONS } from "./icons.js";
import { addActivity } from "./activity.js";
import { showOverlay } from "./overlays.js";

function renderLineageChip(claim) {
  const chip = document.createElement("span");
  chip.className = "lineage-chip";
  chip.dataset.claimId = claim.claim_id || "";
  chip.dataset.sourceIds = (claim.source_ids || []).join(",");
  chip.dataset.reviewStatus = claim.review_status || "unverified";
  chip.title = `Source: ${(claim.source_ids || []).join(", ") || "unsourced"}`;
  const icon = claim.review_status === "verified" ? STATUS_ICONS.ok :
               claim.review_status === "flagged" ? STATUS_ICONS.flagged :
               claim.review_status === "needs_analyst" ? STATUS_ICONS.needs : STATUS_ICONS.pending;
  chip.innerHTML = `<span class="lineage-chip-icon">${icon}</span><span class="lineage-chip-text">${escapeHtml(claim.claim_text || claim.rendered_text || "")}</span>`;
  chip.addEventListener("click", () => openVerificationRail(claim));
  return chip;
}

function renderLineageChipsForDocument(filePath, claims, sources) {
  const card = state.documentCards.get(filePath);
  if (!card) return;
  // Register the document's sources so the verification rail can render the
  // actual provenance (file / sheet / cell / url / excerpt) per SPEC §8.3.
  if (Array.isArray(sources)) {
    const map = new Map();
    for (const s of sources) map.set(s.source_id, s);
    state.documentSources.set(filePath, map);
  }
  let chipRow = card.querySelector(".lineage-chips-row");
  if (!chipRow) {
    chipRow = document.createElement("div");
    chipRow.className = "lineage-chips-row";
    card.querySelector(".draft-meta").appendChild(chipRow);
  }
  chipRow.innerHTML = "";
  for (const claim of claims) {
    state.lineageClaims.set(claim.claim_id, claim);
    state.claimToDocument.set(claim.claim_id, filePath);
    chipRow.appendChild(renderLineageChip(claim));
  }
}

// ─── S9 / SPEC §8.3: Verification rail ───────────────────────────────────
// Clicking a figure/lineage chip opens a right-hand verification panel
// showing the source IN PLACE: an Excel cell rendered with its formula and
// value, a filing excerpt with the surrounding paragraph, or a web page.

function renderSourceInRail(sid, source) {
  const src = document.createElement("div");
  src.className = "source-panel";
  if (!source) {
    src.innerHTML = `<div class="ap-label">Source: ${escapeHtml(sid)}</div>` +
      `<div class="ap-value muted">Source details not available.</div>`;
    return src;
  }
  const type = source.source_type || "other";
  const loc = source.location || {};
  let body = "";
  if (type === "excel_model" || loc.sheet || loc.cell) {
    // Excel cell: render with its file, sheet, cell, and extracted value.
    const cellRef = [loc.sheet, loc.cell].filter(Boolean).join("!") || "—";
    const file = source.file || "—";
    const value = source.extracted_value || "";
    body =
      `<div class="ap-row"><span class="ap-label">Excel cell</span><span class="ap-value">${escapeHtml(cellRef)}</span></div>` +
      `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(file)}</span></div>` +
      (value ? `<div class="ap-row"><span class="ap-label">Cell value</span><span class="ap-value code">${escapeHtml(value)}</span></div>` : "") +
      (loc.description ? `<div class="ap-row"><span class="ap-label">Formula / notes</span><span class="ap-value code">${escapeHtml(loc.description)}</span></div>` : "") +
      `<div class="ctx-hint">Dependents are read back from the model via officecli; the cited value must match the cell's current value.</div>`;
  } else if (type === "filing" || type === "transcript" || type === "internal_note" || type === "research_report" || type === "news") {
    const file = source.file || "";
    const where = [loc.section, loc.page ? `p.${loc.page}` : null].filter(Boolean).join(" · ");
    const excerpt = source.excerpt || "";
    body =
      (file ? `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(file)}</span></div>` : "") +
      (where ? `<div class="ap-row"><span class="ap-label">Location</span><span class="ap-value">${escapeHtml(where)}</span></div>` : "") +
      (excerpt ? `<div class="ap-excerpt">${escapeHtml(excerpt)}</div>` : `<div class="ap-value muted">No excerpt recorded.</div>`);
  } else if (type === "web" || loc.url) {
    const url = loc.url || "";
    body =
      `<div class="ap-row"><span class="ap-label">Web source</span><span class="ap-value">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : "—"}</span></div>` +
      (source.excerpt ? `<div class="ap-excerpt">${escapeHtml(source.excerpt)}</div>` : "");
  } else {
    body =
      `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(source.file || "—")}</span></div>` +
      (source.excerpt ? `<div class="ap-excerpt">${escapeHtml(source.excerpt)}</div>` : "");
  }
  src.innerHTML =
    `<div class="ap-label">${escapeHtml(source.title || sid)} <span class="muted">(${escapeHtml(type)})</span></div>` +
    body;
  return src;
}

function openVerificationRail(claim) {
  state.currentVerificationClaim = claim;
  state.currentReviewDocument = state.claimToDocument.get(claim.claim_id) || null;
  $("verificationRailTitle").textContent = claim.claim_text || claim.rendered_text || "Source";
  const body = $("verificationRailBody");
  const sourceIds = claim.source_ids || [];
  if (!sourceIds.length) {
    body.innerHTML = '<div class="ctx-value muted">No sources recorded for this figure — this is an unsourced claim.</div>';
  } else {
    body.innerHTML = "";
    const sources = (state.currentReviewDocument && state.documentSources.get(state.currentReviewDocument)) || new Map();
    for (const sid of sourceIds) {
      body.appendChild(renderSourceInRail(sid, sources.get(sid)));
    }
  }
  // Show review buttons based on current status
  const status = claim.review_status || "unverified";
  $("markVerifiedBtn").classList.toggle("active", status === "verified");
  $("markFlaggedBtn").classList.toggle("active", status === "flagged");
  $("markNeedsAnalystBtn").classList.toggle("active", status === "needs_analyst");
  // Refresh the final/override row for this document
  refreshFinalRow();
  showOverlay("verificationRail");
}

// ─── S10 / SPEC §8.3: Review flow ────────────────────────────────────────
// Marcus can mark each figure verified / flagged / needs-analyst. The memo
// cannot be marked final while flags are open; an override is possible and is
// logged to the tamper-evident audit chain. The reviewer's checks become the
// review record that goes with the memo.

function reviewStatusFor(filePath) {
  if (!state.documentReviewStatus.has(filePath)) state.documentReviewStatus.set(filePath, new Map());
  return state.documentReviewStatus.get(filePath);
}

function openFlagsFor(filePath) {
  const statuses = reviewStatusFor(filePath);
  let n = 0;
  for (const s of statuses.values()) if (s === "flagged" || s === "needs_analyst") n++;
  return n;
}

function figureStatusesFor(filePath) {
  const statuses = reviewStatusFor(filePath);
  return [...statuses.entries()].map(([claimId, status]) => ({ claimId, status }));
}

function markVerified() {
  if (!state.currentVerificationClaim) return;
  const cid = state.currentVerificationClaim.claim_id;
  const doc = state.currentReviewDocument;
  reviewStatusFor(doc).set(cid, "verified");
  state.currentVerificationClaim.review_status = "verified";
  updateLineageChipStatus(cid, "verified");
  refreshFinalRow();
  addActivity(`Figure verified: ${state.currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "ok");
}

function markFlagged() {
  if (!state.currentVerificationClaim) return;
  const cid = state.currentVerificationClaim.claim_id;
  const doc = state.currentReviewDocument;
  reviewStatusFor(doc).set(cid, "flagged");
  state.currentVerificationClaim.review_status = "flagged";
  updateLineageChipStatus(cid, "flagged");
  refreshFinalRow();
  addActivity(`Figure flagged: ${state.currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "warn");
}

function markNeedsAnalyst() {
  if (!state.currentVerificationClaim) return;
  const cid = state.currentVerificationClaim.claim_id;
  const doc = state.currentReviewDocument;
  reviewStatusFor(doc).set(cid, "needs_analyst");
  state.currentVerificationClaim.review_status = "needs_analyst";
  updateLineageChipStatus(cid, "needs_analyst");
  refreshFinalRow();
  addActivity(`Figure needs analyst: ${state.currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "warn");
}

function updateLineageChipStatus(claimId, status) {
  const chip = document.querySelector(`.lineage-chip[data-claim-id="${claimId}"]`);
  if (!chip) return;
  chip.dataset.reviewStatus = status;
  const icon = status === "verified" ? STATUS_ICONS.ok : status === "flagged" ? STATUS_ICONS.flagged : STATUS_ICONS.needs;
  const iconEl = chip.querySelector(".lineage-chip-icon");
  if (iconEl) iconEl.innerHTML = icon;
}

// Refresh the Mark-final / Override row in the verification rail to reflect
// the current document's open-flag state (SPEC §8.3 block-final).
function refreshFinalRow() {
  const doc = state.currentReviewDocument;
  const openFlags = doc ? openFlagsFor(doc) : 0;
  const overridden = doc ? state.documentOverrideLogged.get(doc) === true : false;
  const finalBtn = $("markFinalBtn");
  const overrideBtn = $("overrideBtn");
  if (!finalBtn || !overrideBtn) return;
  const blocked = openFlags > 0 && !overridden;
  finalBtn.classList.toggle("disabled", blocked);
  finalBtn.title = blocked ? "Resolve open flags first, or override (logged)" : "Mark this document final";
  overrideBtn.hidden = openFlags === 0 || overridden;
}

// Mark the current document final. Blocked while open flags exist and the
// reviewer has not overridden. The decision + the reviewer's per-figure
// checks are logged to the tamper-evident audit chain via IPC.
function markFinalForCurrentDocument() {
  const doc = state.currentReviewDocument;
  if (!doc) { addActivity("Open a figure first to review this document.", "warn"); return; }
  const openFlags = openFlagsFor(doc);
  const overridden = state.documentOverrideLogged.get(doc) === true;
  if (openFlags > 0 && !overridden) {
    addActivity(`Cannot mark final — ${openFlags} open flag(s). Resolve them, or override (the override is logged).`, "err");
    refreshFinalRow();
    return false;
  }
  api.reviewMarkFinal(doc, openFlags, figureStatusesFor(doc)).then((res) => {
    if (!res || res.blocked || res.logged === false) {
      addActivity(`Cannot mark final — ${res?.error || "evidence or review validation failed."}`, "err");
      return;
    }
    state.documentMarkedFinal.set(doc, true);
    addActivity(overridden ? "Document marked final with override — open flags explicitly overridden (logged)" : "Document marked final — all figures verified (logged)", overridden ? "warn" : "ok");
    markCardFinal(doc);
  }).catch(() => addActivity("Could not log the final decision.", "err"));
  return true;
}

function overrideFinalForCurrentDocument() {
  const doc = state.currentReviewDocument;
  if (!doc) return;
  const openFlags = openFlagsFor(doc);
  api.reviewOverride(doc, openFlags, figureStatusesFor(doc)).then((res) => {
    if (!res || res.blocked || res.logged === false) {
      addActivity(`Could not log the override — ${res?.error || "evidence or review validation failed."}`, "err");
      return;
    }
    state.documentOverrideLogged.set(doc, true);
    addActivity("Override logged — open flags explicitly overridden by reviewer (audit chain).", "warn");
    refreshFinalRow();
    // Mark final now that the override is logged.
    markFinalForCurrentDocument();
  }).catch(() => addActivity("Could not log the override.", "err"));
}

function markCardFinal(filePath) {
  const card = state.documentCards.get(filePath);
  if (!card) return;
  card.classList.add("doc-final");
  const meta = card.querySelector(".draft-meta");
  if (meta && !meta.querySelector(".doc-final-badge")) {
    const badge = document.createElement("span");
    badge.className = "doc-final-badge";
    badge.innerHTML = STATUS_ICONS.ok + "<span>Marked final</span>";
    meta.appendChild(badge);
  }
}

// ─── S11 / SPEC §6: Deliverable context view ─────────────────────────────
// For each deliverable, a reviewer can see what informed THIS document —
// files, sources, excluded material, where prompts went.

function recordDeliverableContext(filePath, contextData) {
  state.deliverableContextRecords.set(filePath, contextData);
}

function openDeliverableContext(filePath) {
  const record = state.deliverableContextRecords.get(filePath);
  const title = $("deliverableContextTitle");
  const body = $("deliverableContextBody");
  title.textContent = `Context used for ${filePath.split("/").pop()}`;
  if (!record) {
    body.innerHTML = '<div class="ctx-value muted">No context record available for this document.</div>';
  } else {
    body.innerHTML = "";
    // Show input files
    if (record.inputs?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Input files</h4>";
      for (const inp of record.inputs) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(inp.file || inp)}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show sources
    if (record.sources?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Sources</h4>";
      for (const src of record.sources) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(src.source_id || "")}</span><span class="ap-value">${escapeHtml(src.title || src.location?.description || "")}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show excluded sources
    if (record.excludedSources?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Excluded sources</h4>";
      for (const ex of record.excludedSources) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(ex)}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show run record reference
    if (record.runRecord) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = `<h4>Run record</h4><div class="ap-row"><span class="ap-value">${escapeHtml(record.runRecord)}</span></div>`;
      body.appendChild(section);
    }
  }
  showOverlay("deliverableContextOverlay");
}

export {
  renderLineageChip,
  renderLineageChipsForDocument,
  renderSourceInRail,
  openVerificationRail,
  reviewStatusFor,
  openFlagsFor,
  figureStatusesFor,
  markVerified,
  markFlagged,
  markNeedsAnalyst,
  updateLineageChipStatus,
  refreshFinalRow,
  markFinalForCurrentDocument,
  overrideFinalForCurrentDocument,
  markCardFinal,
  recordDeliverableContext,
  openDeliverableContext,
};
