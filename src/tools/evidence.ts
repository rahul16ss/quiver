/**
 * Evidence Tool — the agent-facing tool for live lineage.
 *
 * The agent calls this tool during document drafting to:
 * - `register_source`: register a source (file, filing, transcript, etc.)
 * - `exclude_source`: exclude a source with a reason
 * - `record_claim`: record a claim with its source references and review status
 * - `update_claim`: update a claim's review status
 * - `register_input`: register an input file with its SHA-256 hash
 * - `validate`: validate that all quantitative claims have sources
 * - `finalize`: write Evidence.json and Run_Record.json alongside the document
 * - `status`: show current evidence tracker state
 *
 * This is how the agent emits the evidence-model JSON during live drafting
 * (build-order #3). The GUI reads Evidence.json to render lineage chips.
 */

import { z } from "zod";
import path from "path";
import { Tool } from "../registry.js";
import { EvidenceTracker } from "../evidence/tracker.js";
import type {
  SourceRecord,
  ClaimRecord,
  SourceType,
  Relationship,
  ReviewStatus,
} from "../evidence/model.js";

// Singleton tracker — one per agent session
let sessionTracker: EvidenceTracker | null = null;

export function getEvidenceTracker(): EvidenceTracker {
  if (!sessionTracker) sessionTracker = new EvidenceTracker();
  return sessionTracker;
}

export function resetEvidenceTracker(): void {
  sessionTracker = null;
}

export const tool: Tool = {
  name: "evidence",
  description:
    "Register sources, record claims, and emit Evidence.json for live document lineage. " +
    "Use this when drafting Office documents (Word/Excel/PowerPoint) to ensure every " +
    "quantitative figure is traceable to a source. Call 'register_source' for each input " +
    "file, 'record_claim' for each key figure in the document, and 'finalize' when the " +
    "document is complete to write Evidence.json alongside it.",
  parameters: z.object({
    action: z
      .enum([
        "register_source",
        "exclude_source",
        "record_claim",
        "update_claim",
        "register_input",
        "validate",
        "finalize",
        "status",
      ])
      .describe("The evidence operation to perform."),
    source_id: z
      .string()
      .optional()
      .describe(
        "Source ID (e.g., SRC-001). Required for register_source and exclude_source.",
      ),
    source_type: z
      .enum([
        "excel_model",
        "filing",
        "transcript",
        "internal_note",
        "vendor_export",
        "web",
        "template",
        "research_report",
        "news",
        "other",
      ])
      .optional()
      .describe("Type of source. Used with register_source."),
    title: z
      .string()
      .optional()
      .describe(
        "Human-readable title for the source or document. Used with register_source or set_metadata.",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "File path for the source. Used with register_source or register_input.",
      ),
    as_of: z
      .string()
      .optional()
      .describe(
        "As-of date for the source (YYYY-MM-DD). Used with register_source.",
      ),
    location: z
      .string()
      .optional()
      .describe(
        "JSON string describing source location: {sheet, cell, section, page, url, description}. Used with register_source.",
      ),
    sensitivity: z
      .string()
      .optional()
      .describe(
        "Sensitivity label for the source (e.g., 'public', 'confidential', 'synthetic'). Used with register_source.",
      ),
    approved: z
      .boolean()
      .optional()
      .describe(
        "Whether the source is approved for use. Default true. Used with register_source.",
      ),
    excerpt: z
      .string()
      .optional()
      .describe("Excerpt from the source. Used with register_source."),
    extracted_value: z
      .string()
      .optional()
      .describe(
        "Value extracted from the source (e.g., '48200000'). Used with register_source.",
      ),
    exclusion_reason: z
      .string()
      .optional()
      .describe("Reason for excluding a source. Used with exclude_source."),
    claim_id: z
      .string()
      .optional()
      .describe(
        "Claim ID (e.g., CLM-001). Required for record_claim and update_claim.",
      ),
    rendered_text: z
      .string()
      .optional()
      .describe(
        "The text as it appears in the document. Used with record_claim.",
      ),
    source_ids: z
      .array(z.string())
      .optional()
      .describe("Source IDs that support this claim. Used with record_claim."),
    relationship: z
      .enum(["sourced", "derived", "estimate", "unresolved"])
      .optional()
      .describe(
        "Relationship type: sourced (direct), derived (computed), estimate, unresolved. Used with record_claim.",
      ),
    review_status: z
      .enum(["verified", "needs_analyst", "flagged", "unresolved"])
      .optional()
      .describe(
        "Review status for the claim. Used with record_claim or update_claim.",
      ),
    is_quantitative: z
      .boolean()
      .optional()
      .describe(
        "Whether the claim contains a quantitative figure. Default true. Used with record_claim.",
      ),
    review_note: z
      .string()
      .optional()
      .describe(
        "Note explaining the review status. Used with record_claim or update_claim.",
      ),
    verification: z
      .string()
      .optional()
      .describe(
        "JSON string with verification details (excel_cell or excel_derived). Used with record_claim.",
      ),
    table: z
      .string()
      .optional()
      .describe(
        "JSON string with table entry {metric, value, source, status}. Used with record_claim.",
      ),
    output_dir: z
      .string()
      .optional()
      .describe("Directory to write Evidence.json. Used with finalize."),
    doc_file: z
      .string()
      .optional()
      .describe(
        "Document filename (e.g., 'Project_Alder_IC_Memo.docx'). Used with finalize to name the evidence file.",
      ),
    company: z
      .string()
      .optional()
      .describe("Company name. Used with finalize."),
    workflow: z
      .string()
      .optional()
      .describe("Workflow name. Used with finalize."),
    subtitle: z
      .string()
      .optional()
      .describe("Document subtitle. Used with finalize."),
  }),

  execute: async (args: any) => {
    const tracker = getEvidenceTracker();

    switch (args.action) {
      // ─── register_source ─────────────────────────────────────────────
      case "register_source": {
        if (!args.source_id)
          return "Error: source_id is required for register_source.";
        if (!args.source_type)
          return "Error: source_type is required for register_source.";
        if (!args.title) return "Error: title is required for register_source.";

        let location: SourceRecord["location"] = {};
        if (args.location) {
          try {
            location = JSON.parse(args.location);
          } catch {
            return `Error: Invalid location JSON: ${args.location}`;
          }
        }

        const source: SourceRecord = {
          source_id: args.source_id,
          source_type: args.source_type as SourceType,
          title: args.title,
          file: args.file || "(not specified)",
          as_of: args.as_of || new Date().toISOString().split("T")[0],
          location,
          sensitivity: args.sensitivity || "public",
          approved: args.approved !== false,
          ...(args.extracted_value
            ? { extracted_value: args.extracted_value }
            : {}),
          ...(args.excerpt ? { excerpt: args.excerpt } : {}),
          ...(args.exclusion_reason
            ? { exclusion_reason: args.exclusion_reason }
            : {}),
        };

        const result = tracker.registerSource(source);
        return result.registered
          ? `✓ Source ${result.source_id} registered: "${source.title}" (${source.source_type}, ${source.approved ? "approved" : "not approved"})`
          : `Error: Could not register source ${result.source_id} (tracker may be finalized).`;
      }

      // ─── exclude_source ──────────────────────────────────────────────
      case "exclude_source": {
        if (!args.source_id)
          return "Error: source_id is required for exclude_source.";
        if (!args.exclusion_reason)
          return "Error: exclusion_reason is required for exclude_source.";

        const result = tracker.excludeSource(
          args.source_id,
          args.exclusion_reason,
        );
        return result.excluded
          ? `✓ Source ${result.source_id} excluded: ${args.exclusion_reason}`
          : `Error: Could not exclude source ${result.source_id}.`;
      }

      // ─── record_claim ────────────────────────────────────────────────
      case "record_claim": {
        if (!args.claim_id)
          return "Error: claim_id is required for record_claim.";
        if (!args.rendered_text)
          return "Error: rendered_text is required for record_claim.";
        if (!args.source_ids)
          return "Error: source_ids is required for record_claim.";

        let verification: ClaimRecord["verification"] | undefined;
        if (args.verification) {
          try {
            verification = JSON.parse(args.verification);
          } catch {
            return `Error: Invalid verification JSON: ${args.verification}`;
          }
        }

        let table: ClaimRecord["table"] | undefined;
        if (args.table) {
          try {
            table = JSON.parse(args.table);
          } catch {
            return `Error: Invalid table JSON: ${args.table}`;
          }
        }

        const claim: ClaimRecord = {
          claim_id: args.claim_id,
          rendered_text: args.rendered_text,
          source_ids: args.source_ids,
          relationship: (args.relationship || "sourced") as Relationship,
          review_status: (args.review_status || "verified") as ReviewStatus,
          reviewer_decision: null,
          is_quantitative: args.is_quantitative !== false,
          ...(args.review_note ? { review_note: args.review_note } : {}),
          ...(verification ? { verification } : {}),
          ...(table ? { table } : {}),
        };

        const result = tracker.recordClaim(claim);
        return result.recorded
          ? `✓ Claim ${result.claim_id} recorded: "${claim.rendered_text}" (${claim.source_ids.length} source(s), ${claim.review_status})`
          : `Error: Could not record claim ${result.claim_id}.`;
      }

      // ─── update_claim ───────────────────────────────────────────────
      case "update_claim": {
        if (!args.claim_id)
          return "Error: claim_id is required for update_claim.";
        if (!args.review_status)
          return "Error: review_status is required for update_claim.";

        const result = tracker.updateClaimStatus(
          args.claim_id,
          args.review_status as ReviewStatus,
          args.review_note,
        );
        return result.updated
          ? `✓ Claim ${result.claim_id} updated: ${args.review_status}${args.review_note ? ` — ${args.review_note}` : ""}`
          : `Error: Claim ${result.claim_id} not found.`;
      }

      // ─── register_input ─────────────────────────────────────────────
      case "register_input": {
        if (!args.file) return "Error: file is required for register_input.";
        const result = await tracker.registerInput(args.file);
        return result.sha256
          ? `✓ Input registered: ${args.file} (SHA-256: ${result.sha256.slice(0, 12)}…)`
          : `Error: Could not hash file ${args.file} — file may not exist.`;
      }

      // ─── reset ─────────────────────────────────────────────────────
      // H4: the tracker is a process-global singleton. Call reset before
      // starting a NEW document so the previous document's sources/claims
      // do not contaminate it (the agent also resets automatically after
      // finalize, but use this if a document is abandoned mid-draft).
      case "reset": {
        resetEvidenceTracker();
        return "✓ Evidence tracker reset — ready for a new document.";
      }

      // ─── validate ───────────────────────────────────────────────────
      case "validate": {
        const result = tracker.validateEvidence();
        if (result.valid) {
          return `✓ Evidence valid: ${result.summary}. All quantitative claims have approved sources or are flagged.`;
        }
        return `⚠ Evidence validation found ${result.problems.length} problem(s):\n${result.problems.map((p) => `  - ${p}`).join("\n")}\n\nSummary: ${result.summary}`;
      }

      // ─── finalize ───────────────────────────────────────────────────
      case "finalize": {
        tracker.setMetadata({ workflow: args.workflow, company: args.company, title: args.title, subtitle: args.subtitle });
        const result = tracker.finalize(args.output_dir || "", args.doc_file);
        const docPath = args.doc_file ? path.join(args.output_dir || "", args.doc_file) : args.output_dir || "";
        // SPEC §8.1: append a "Lineage & Sources" appendix (endnote form) to the
        // .docx so a reviewer opening the memo in Word sees the lineage inline,
        // not only in the companion Evidence.json / GUI chips.
        let lineageAppendix = { ok: false, detail: "skipped" };
        try {
          const { appendLineageAppendix, entriesFromEvidence } = await import("../document/word_lineage.js");
          lineageAppendix = await appendLineageAppendix(
            docPath,
            entriesFromEvidence(
              tracker.getClaims().map((c) => ({ claim_id: c.claim_id, rendered_text: c.rendered_text, source_ids: c.source_ids, review_status: c.review_status, is_quantitative: c.is_quantitative })),
              tracker.getSources().map((s) => ({ source_id: s.source_id, title: s.title, file: s.file, location: s.location })),
            ),
          );
        } catch (e: any) {
          lineageAppendix = { ok: false, detail: `lineage appendix error: ${e?.message || e}` };
        }
        const structured = { ok: !!(result.evidencePath), action: "finalize", docPath, evidencePath: result.evidencePath, runRecord: result.runRecordPath, claims: tracker.getClaims().map((c) => ({ claim_id: c.claim_id, rendered_text: c.rendered_text, source_ids: c.source_ids, is_quantitative: c.is_quantitative, review_status: c.review_status, relationship: c.relationship })), sources: tracker.getSources().map((s) => ({ source_id: s.source_id, title: s.title, source_type: s.source_type, file: s.file, location: s.location, approved: s.approved, excerpt: s.excerpt, extracted_value: s.extracted_value, sensitivity: s.sensitivity })), excludedSources: tracker.getExcludedSources().map((e) => e.source_id), validation: result.validation, lineageAppendix };
        return JSON.stringify(structured, null, 2);
      }

      // ─── status ─────────────────────────────────────────────────────
      case "status": {
        const sources = tracker.getSources();
        const claims = tracker.getClaims();
        const excluded = tracker.getExcludedSources();
        const lines = [
          `Evidence Tracker Status:`,
          `  Sources: ${sources.length} (${sources.filter((s) => s.approved).length} approved, ${excluded.length} excluded)`,
          `  Claims: ${claims.length} (${claims.filter((c) => c.is_quantitative).length} quantitative)`,
          `  Review statuses: ${claims.filter((c) => c.review_status === "verified").length} verified, ${claims.filter((c) => c.review_status === "flagged").length} flagged, ${claims.filter((c) => c.review_status === "unresolved").length} unresolved, ${claims.filter((c) => c.review_status === "needs_analyst").length} needs_analyst`,
          `  Finalized: ${tracker.isFinalized() ? "yes" : "no"}`,
        ];
        if (sources.length > 0) {
          lines.push(`  Sources:`);
          for (const s of sources) {
            lines.push(
              `    ${s.source_id}: ${s.title} (${s.approved ? "approved" : "excluded"})`,
            );
          }
        }
        if (claims.length > 0) {
          lines.push(`  Claims:`);
          for (const c of claims) {
            lines.push(
              `    ${c.claim_id}: "${c.rendered_text}" [${c.review_status}] → ${c.source_ids.join(", ")}`,
            );
          }
        }
        return lines.join("\n");
      }

      default:
        return `Error: Unknown action '${args.action}'.`;
    }
  },
};
