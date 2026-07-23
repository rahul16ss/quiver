/**
 * Word lineage appendix — SPEC §8.1 ("Rendered as a Word comment or endnote
 * in the exported .docx").
 *
 * Inline Word comments require commentRangeStart/End XML surgery around text
 * that may be split across runs — fragile. The spec explicitly allows an
 * **endnote** form, so this module appends a "Lineage & Sources" appendix to
 * the .docx via officecli `add` (paragraphs): one heading + one line per
 * figure linking it to its source. Robust (no raw XML), testable (the section
 * is in the document), and survives Word's own editing.
 *
 * This is the inline-comment fallback; a future polish can add true
 * commentRange-anchored comments where the anchor run is stable.
 */
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { findBinary } from "../utils/find_binary.js";

const execFileAsync = promisify(execFile);

async function getOfficeCli(): Promise<string | null> {
  return findBinary("officecli");
}

interface LineageEntry {
  figure: string; // e.g. "$48.2M"
  sourceRef: string; // e.g. "Model_v12.xlsx!RevenueBuild!C8"
  status: string; // e.g. "sourced · verified" | "flagged" | "unresolved"
}

/**
 * Append a "Lineage & Sources" appendix to a .docx. Returns a summary string
 * (or an error message). Best-effort: a failure to append does not block the
 * deliverable — the Evidence.json alongside is the canonical record.
 */
export async function appendLineageAppendix(
  docPath: string,
  entries: LineageEntry[],
): Promise<{ ok: boolean; detail: string }> {
  if (!docPath.endsWith(".docx")) {
    return { ok: true, detail: "lineage appendix skipped (not a .docx)" };
  }
  if (!entries.length) {
    return { ok: true, detail: "lineage appendix skipped (no claims)" };
  }
  const bin = await getOfficeCli();
  if (!bin) {
    return { ok: false, detail: "officecli binary not found — lineage appendix not written" };
  }
  // Build a batch of add commands to /body. officecli .docx element types
  // are paragraph/run/table/... (no "heading" type — a heading is a paragraph
  // with a Heading style). The batch is ATOMIC, so every command must succeed.
  const commands: any[] = [
    {
      command: "add",
      parent: "/body",
      type: "paragraph",
      props: { text: "Lineage & Sources", style: "Heading2" },
    },
    {
      command: "add",
      parent: "/body",
      type: "paragraph",
      props: {
        text: "Every figure below traces to a source. Unsourced figures are flagged for review. This appendix is the endnote form of the lineage chips in the desktop app.",
      },
    },
  ];
  for (const e of entries) {
    commands.push({
      command: "add",
      parent: "/body",
      type: "paragraph",
      props: { text: `• ${e.figure} — ${e.sourceRef} (${e.status})` },
    });
  }
  try {
    const { stdout } = await execFileAsync(
      bin,
      ["batch", docPath, "--commands", JSON.stringify(commands)],
      { maxBuffer: 10 * 1024 * 1024, timeout: 60000 },
    );
    if (/"success":\s*false/i.test(stdout)) {
      return { ok: false, detail: `officecli batch reported a failure:\n${stdout}` };
    }
    return { ok: true, detail: `Lineage appendix appended (${entries.length} figures) to ${path.basename(docPath)}` };
  } catch (err: any) {
    return { ok: false, detail: `lineage appendix failed: ${err?.message || err}` };
  }
}

/**
 * Build lineage entries from an evidence tracker's claims + sources, for the
 * appendix. Quantitative claims first, then flagged/unresolved.
 */
export function entriesFromEvidence(
  claims: Array<{ claim_id: string; rendered_text: string; source_ids: string[]; review_status: string; is_quantitative: boolean }>,
  sources: Array<{ source_id: string; title: string; file: string; location?: { sheet?: string; cell?: string; section?: string; page?: number; url?: string } }>,
): LineageEntry[] {
  const locStr = (sid: string): string => {
    const s = sources.find((x) => x.source_id === sid);
    if (!s) return sid;
    const loc = s.location || {};
    const where =
      [loc.sheet && `${loc.sheet}!${loc.cell || ""}`, loc.section, loc.page ? `p.${loc.page}` : "", loc.url]
        .filter(Boolean).join(" · ") || s.file || sid;
    return `${s.file || s.title}${where ? ` · ${where}` : ""}`;
  };
  const statusFor = (r: string): string =>
    r === "verified" ? "sourced · verified"
    : r === "flagged" ? "flagged"
    : r === "needs_analyst" ? "needs analyst"
    : r === "unresolved" ? "unresolved"
    : "sourced";
  const sorted = [...claims].sort((a, b) => Number(b.is_quantitative) - Number(a.is_quantitative));
  return sorted.map((c) => ({
    figure: c.rendered_text || c.claim_id,
    sourceRef: c.source_ids.length ? c.source_ids.map(locStr).join(" ; ") : "unsourced",
    status: statusFor(c.review_status),
  }));
}

/**
 * Convenience: build lineage entries from the tracker's claims/sources and
 * append the appendix to the .docx in one call. Returns the appendix result
 * (best-effort; failures are returned as {ok:false, detail}, never thrown).
 * Used by the evidence tool's finalize so the finalize case stays short.
 */
export async function appendLineageForTracker(
  docPath: string,
  claims: Array<{ claim_id: string; rendered_text: string; source_ids: string[]; review_status: string; is_quantitative: boolean }>,
  sources: Array<{ source_id: string; title: string; file: string; location?: any }>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    return await appendLineageAppendix(docPath, entriesFromEvidence(claims, sources));
  } catch (e: any) {
    return { ok: false, detail: `lineage appendix error: ${e?.message || e}` };
  }
}
