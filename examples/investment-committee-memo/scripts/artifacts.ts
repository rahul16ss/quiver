/**
 * Generators for the evidence map (JSON + HTML), review checklist, and run
 * record. All paths written into artifacts are relative to the example
 * directory so the exports contain no local absolute paths.
 *
 * Illustrative workflow — synthetic data.
 */
import * as fs from "node:fs";
import {
  ClaimRecord,
  INPUT_FILES,
  LABEL,
  MemoContent,
  OUTPUT,
  ReviewStatus,
  SourceRecord,
  SourceRegistry,
  loadChecklist,
  loadWorkflowMeta,
  officecliVersion,
  p,
  sha256,
} from "./lib.ts";

export interface EvidenceClaim extends ClaimRecord {
  sources: SourceRecord[];
}

export interface EvidenceMap {
  label: string;
  workflow: string;
  workflow_version: string;
  company: string;
  as_of: string;
  lineage_note: string;
  summary: {
    sources_reviewed: number;
    sources_excluded: number;
    claims_total: number;
    figures_flagged: number;
  };
  claims: EvidenceClaim[];
  excluded_sources: SourceRecord[];
}

const FLAGGED_STATUSES: ReviewStatus[] = ["needs_analyst", "flagged", "unresolved"];

export function buildEvidenceMap(memo: MemoContent, registry: SourceRegistry): EvidenceMap {
  const byId = new Map(registry.sources.map((s) => [s.source_id, s]));
  const approved = registry.sources.filter((s) => s.approved);
  const excluded = registry.sources.filter((s) => !s.approved);
  const claims: EvidenceClaim[] = memo.claims.map((c) => ({
    ...c,
    sources: c.source_ids.map((id) => {
      const s = byId.get(id);
      if (!s) throw new Error(`claim ${c.claim_id} references unknown source ${id}`);
      return s;
    }),
  }));
  return {
    label: LABEL,
    workflow: memo.workflow,
    workflow_version: memo.workflow_version,
    company: memo.company,
    as_of: memo.as_of,
    lineage_note:
      "Cell-level lineage is demonstrated only for Excel-sourced figures (sheet+cell re-read by the acceptance checks). Filing, transcript, note, and CSV references are section- or page-level.",
    summary: {
      sources_reviewed: approved.length,
      sources_excluded: excluded.length,
      claims_total: claims.length,
      figures_flagged: claims.filter((c) => FLAGGED_STATUSES.includes(c.review_status)).length,
    },
    claims,
    excluded_sources: excluded,
  };
}

// ---------------------------------------------------------------------------
// Evidence HTML
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const REL_COLORS: Record<string, string> = {
  sourced: "#166534",
  derived: "#1d4ed8",
  estimate: "#92400e",
  unresolved: "#991b1b",
};

const STATUS_COLORS: Record<ReviewStatus, string> = {
  verified: "#166534",
  needs_analyst: "#92400e",
  flagged: "#b45309",
  unresolved: "#991b1b",
};

function badge(text: string, color: string): string {
  return `<span class="badge" style="color:${color};border-color:${color}">${esc(text)}</span>`;
}

function sourceLocation(s: SourceRecord): string {
  if (s.location.sheet && s.location.cell) return `${s.location.sheet}!${s.location.cell}`;
  const bits: string[] = [];
  if (s.location.section) bits.push(s.location.section);
  if (s.location.page !== undefined) bits.push(`page ${s.location.page}`);
  return bits.join(", ") || "n/a";
}

export function renderEvidenceHtml(ev: EvidenceMap): string {
  const claimBlocks = ev.claims
    .map((c) => {
      const sources = c.sources
        .map(
          (s) => `
        <div class="source">
          <div class="source-head"><strong>${esc(s.source_id)}</strong> · ${esc(s.title)}</div>
          <div class="source-meta">${esc(s.source_type)} · <code>${esc(s.file)}</code> · location: <strong>${esc(sourceLocation(s))}</strong> · as of ${esc(s.as_of)}</div>
          ${s.extracted_value ? `<div class="source-meta">extracted value: <code>${esc(s.extracted_value)}</code></div>` : ""}
          ${s.excerpt ? `<blockquote>${esc(s.excerpt)}</blockquote>` : ""}
        </div>`,
        )
        .join("\n");
      return `
    <article class="claim">
      <header>
        <span class="claim-id">${esc(c.claim_id)}</span>
        ${badge(c.relationship, REL_COLORS[c.relationship] ?? "#334155")}
        ${badge(c.review_status.replace("_", " "), STATUS_COLORS[c.review_status])}
      </header>
      <p class="rendered">&ldquo;${esc(c.rendered_text)}&rdquo;</p>
      ${c.review_note ? `<p class="note"><strong>Review note:</strong> ${esc(c.review_note)}</p>` : ""}
      ${sources}
    </article>`;
    })
    .join("\n");

  const excluded = ev.excluded_sources
    .map(
      (s) => `
      <div class="source excluded">
        <div class="source-head"><strong>${esc(s.source_id)}</strong> · ${esc(s.title)} ${badge("excluded", "#991b1b")}</div>
        <div class="source-meta">${esc(s.exclusion_reason ?? "")}</div>
      </div>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(ev.company)} — Evidence Map</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1e293b; margin: 0; background: #f8fafc; }
  .wrap { max-width: 960px; margin: 0 auto; padding: 32px 24px 64px; }
  .label-banner { background: #1f3864; color: #fff; padding: 10px 24px; font-size: 13px; letter-spacing: 0.02em; }
  h1 { font-size: 26px; margin: 24px 0 4px; color: #1f3864; }
  .sub { color: #475569; margin: 0 0 20px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin: 0 0 28px; }
  .stat { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 18px; }
  .stat .n { font-size: 22px; font-weight: 700; color: #1f3864; }
  .stat .t { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
  .claim { background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px; margin-bottom: 14px; }
  .claim header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .claim-id { font-family: ui-monospace, Menlo, monospace; font-size: 13px; color: #475569; font-weight: 600; }
  .badge { display: inline-block; border: 1px solid; border-radius: 999px; padding: 1px 10px; font-size: 12px; font-weight: 600; }
  .rendered { font-size: 16px; margin: 4px 0 10px; }
  .note { background: #fffbeb; border-left: 3px solid #b45309; padding: 8px 12px; font-size: 14px; }
  .source { border-top: 1px dashed #e2e8f0; padding: 10px 0 2px; margin-top: 8px; }
  .source-head { font-size: 14px; }
  .source-meta { font-size: 13px; color: #64748b; }
  .source.excluded { border-top: none; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 12px 16px; }
  blockquote { margin: 6px 0 4px; padding-left: 12px; border-left: 3px solid #cbd5e1; color: #475569; font-size: 14px; }
  code { font-family: ui-monospace, Menlo, monospace; font-size: 13px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  h2 { font-size: 18px; color: #1f3864; margin: 32px 0 12px; }
  .foot { margin-top: 32px; font-size: 13px; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 16px; }
</style>
</head>
<body>
<div class="label-banner">${esc(ev.label)} · Draft for review — no reviewer sign-off recorded</div>
<div class="wrap">
  <h1>${esc(ev.company)} — Evidence Map</h1>
  <p class="sub">Workflow ${esc(ev.workflow)} v${esc(ev.workflow_version)} · as of ${esc(ev.as_of)}</p>
  <div class="stats">
    <div class="stat"><div class="n">${ev.summary.sources_reviewed}</div><div class="t">Sources reviewed</div></div>
    <div class="stat"><div class="n">${ev.summary.figures_flagged}</div><div class="t">Figures to verify</div></div>
    <div class="stat"><div class="n">${ev.summary.claims_total}</div><div class="t">Claims tracked</div></div>
    <div class="stat"><div class="n">${ev.summary.sources_excluded}</div><div class="t">Sources excluded</div></div>
  </div>
  ${claimBlocks}
  <h2>Excluded sources</h2>
  ${excluded}
  <p class="foot">${esc(ev.lineage_note)} All data is synthetic; this page is generated by the demo pipeline and carries no reviewer sign-off.</p>
</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Review checklist (markdown)
// ---------------------------------------------------------------------------

export function renderReviewChecklist(ev: EvidenceMap): string {
  const lines: string[] = [];
  lines.push(`# ${ev.company} — Review Checklist`);
  lines.push("");
  lines.push(`> ${ev.label} · Draft for review`);
  lines.push("");
  lines.push(`Workflow: ${ev.workflow} v${ev.workflow_version} · as of ${ev.as_of}`);
  lines.push("Review status: draft_for_review — reviewer_decision is null on every claim until sign-off.");
  lines.push("");
  const flagged = ev.claims.filter((c) => FLAGGED_STATUSES.includes(c.review_status));
  lines.push(`## Figures to verify (${flagged.length} flagged)`);
  lines.push("");
  const groups: Array<[ReviewStatus, string]> = [
    ["needs_analyst", "Needs analyst review"],
    ["flagged", "Flagged"],
    ["unresolved", "Unresolved"],
  ];
  for (const [status, title] of groups) {
    const items = flagged.filter((c) => c.review_status === status);
    if (items.length === 0) continue;
    lines.push(`### ${title}`);
    lines.push("");
    for (const c of items) {
      const srcs = c.sources.map((s) => `${s.source_id} (${sourceLocation(s)})`).join(", ");
      lines.push(`- [ ] **${c.claim_id}** — "${c.rendered_text}" (relationship: ${c.relationship}; sources: ${srcs})`);
      if (c.review_note) lines.push(`  - What to verify: ${c.review_note}`);
    }
    lines.push("");
  }
  lines.push("## Standing checks (enforced automatically on every run)");
  lines.push("");
  for (const check of loadChecklist()) {
    lines.push(`- ${check.name} (\`${check.id}\`)`);
  }
  lines.push("");
  lines.push("## Excluded sources");
  lines.push("");
  for (const s of ev.excluded_sources) {
    lines.push(`- ${s.source_id} — ${s.title}: ${s.exclusion_reason ?? "excluded"}`);
  }
  lines.push("");
  lines.push(`## Sources reviewed (${ev.summary.sources_reviewed})`);
  lines.push("");
  const seen = new Set<string>();
  for (const c of ev.claims) {
    for (const s of c.sources) {
      if (seen.has(s.source_id)) continue;
      seen.add(s.source_id);
      lines.push(`- ${s.source_id} — ${s.title} (${s.source_type}; ${sourceLocation(s)})`);
    }
  }
  lines.push("");
  lines.push(
    "Cell-level lineage applies to the Excel-sourced figures only; filing, transcript, note, and CSV references are section- or page-level. All data is synthetic.",
  );
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Run record
// ---------------------------------------------------------------------------

export function buildRunRecord(ev: EvidenceMap): Record<string, unknown> {
  const wf = loadWorkflowMeta();
  const usedIds = new Set(ev.claims.flatMap((c) => c.source_ids));
  return {
    label: LABEL,
    workflow: wf.name,
    workflow_version: wf.version,
    as_of: ev.as_of,
    review_status: "draft_for_review",
    retrieval: { mode: "static", network_access: "none", credentials_required: false },
    determinism_note:
      "All source data is committed fixture content with static as-of dates; no wall-clock timestamps are embedded, so re-runs produce identical JSON/HTML/Markdown artifacts. Tool versions below reflect the environment that produced this record.",
    inputs: INPUT_FILES.map((f) => ({ file: f, sha256: sha256(p(f)) })),
    template: { file: "template/ic-memo-template.docx", sha256: sha256(p("template/ic-memo-template.docx")) },
    fixtures: ["fixtures/sources.json", "fixtures/memo-content.json"].map((f) => ({ file: f, sha256: sha256(p(f)) })),
    sources_used: ev.claims
      .flatMap((c) => c.sources)
      .filter((s, i, all) => all.findIndex((x) => x.source_id === s.source_id) === i)
      .map((s) => ({ source_id: s.source_id, title: s.title, location: sourceLocation(s), used: usedIds.has(s.source_id) })),
    sources_excluded: ev.excluded_sources.map((s) => ({
      source_id: s.source_id,
      title: s.title,
      reason: s.exclusion_reason ?? "excluded",
    })),
    figures_flagged: ev.claims
      .filter((c) => FLAGGED_STATUSES.includes(c.review_status))
      .map((c) => ({ claim_id: c.claim_id, review_status: c.review_status })),
    unresolved_items: ev.claims
      .filter((c) => c.review_status === "unresolved")
      .map((c) => ({ claim_id: c.claim_id, rendered_text: c.rendered_text, note: c.review_note ?? "" })),
    tool_versions: { officecli: officecliVersion(), node: process.version },
    artifacts: [OUTPUT.docx, OUTPUT.evidenceJson, OUTPUT.evidenceHtml, OUTPUT.reviewChecklist, OUTPUT.runRecord],
  };
}

export function writeArtifacts(ev: EvidenceMap): void {
  fs.writeFileSync(p(OUTPUT.evidenceJson), JSON.stringify(ev, null, 2) + "\n");
  fs.writeFileSync(p(OUTPUT.evidenceHtml), renderEvidenceHtml(ev));
  fs.writeFileSync(p(OUTPUT.reviewChecklist), renderReviewChecklist(ev));
  fs.writeFileSync(p(OUTPUT.runRecord), JSON.stringify(buildRunRecord(ev), null, 2) + "\n");
}
