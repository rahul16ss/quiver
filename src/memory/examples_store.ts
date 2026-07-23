/**
 * Episodic examples store — SPEC §7.4.
 *
 * A praised past deliverable can be promoted into a retrievable example the
 * agent consults on future runs. Promotion captures the document structure
 * (officecli `view <file> outline`) + the lineage/audit excerpt (the
 * Evidence.json alongside, if present) as provenance, and writes an example
 * record to the per-project examples store. On future runs the loaded
 * examples are an episodic-memory component — visible, editable, excludable
 * in the consent gate (§6 layer B).
 *
 * officecli has no `dump` verb in this version, so the structure is captured
 * via `view <file> outline` (the closest structural snapshot).
 */
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getProjectRoot } from "../paths.js";
import { findBinary } from "../utils/find_binary.js";

export interface ExampleRecord {
  id: string;
  name: string;
  kind: "docx" | "xlsx" | "pptx" | "other";
  promotedAt: string;
  sourceDeliverable: string;
  /** officecli structural snapshot (view outline). */
  structure: string;
  /** Lineage/audit excerpt (Evidence.json summary) — the provenance. */
  provenance: string;
  /** Why this example was promoted (the user's note). */
  note: string;
}

function examplesDir(): string {
  return path.join(getProjectRoot(), "examples");
}

function officecli(args: string[]): string {
  const bin = findBinary("officecli");
  if (!bin) return "";
  try {
    return execFileSync(bin, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 });
  } catch {
    return "";
  }
}

function kindOf(file: string): ExampleRecord["kind"] {
  if (file.endsWith(".docx")) return "docx";
  if (file.endsWith(".xlsx")) return "xlsx";
  if (file.endsWith(".pptx")) return "pptx";
  return "other";
}

/**
 * Promote a finished deliverable into the examples store. Captures the
 * structure (officecli view outline) + the Evidence.json provenance if it
 * sits alongside the deliverable. Returns the record (or null on failure).
 */
export function promoteExample(
  deliverablePath: string,
  note: string,
): ExampleRecord | null {
  if (!fs.existsSync(deliverablePath)) return null;
  const dir = examplesDir();
  fs.mkdirSync(dir, { recursive: true });
  const base = path.basename(deliverablePath);
  const id = `${Date.now()}-${base.replace(/\.(docx|xlsx|pptx)$/, "")}`;
  // Structure: officecli view outline (best-effort; empty if officecli absent).
  const structure = officecli(["view", deliverablePath, "outline"]).trim() || "(structure unavailable — officecli not found)";
  // Provenance: the Evidence.json alongside the deliverable, if present.
  const evidencePath = deliverablePath.replace(/\.(docx|xlsx|pptx)$/, "_Evidence.json");
  let provenance = "(no Evidence.json alongside the deliverable)";
  if (fs.existsSync(evidencePath)) {
    try {
      const ev = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
      provenance = `${(ev.claims || []).length} claims, ${(ev.sources || []).length} sources` +
        (ev.review_status ? `, status: ${ev.review_status}` : "");
    } catch {
      provenance = "(Evidence.json present but unreadable)";
    }
  }
  const record: ExampleRecord = {
    id, name: base, kind: kindOf(deliverablePath),
    promotedAt: new Date().toISOString(),
    sourceDeliverable: deliverablePath,
    structure, provenance, note,
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2), "utf8");
  return record;
}

/** List all promoted examples in the store. */
export function listExamples(): ExampleRecord[] {
  const dir = examplesDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ExampleRecord; } catch { return null; } })
    .filter((x): x is ExampleRecord => !!x && !!x.id);
}

/**
 * Load the examples as an episodic-memory context component (a short summary
 * per example the agent can consult). Used by the consent gate (§6 layer B)
 * and the system prompt.
 */
export function loadExampleContext(): string {
  const examples = listExamples();
  if (!examples.length) return "";
  const lines = examples.map((e) =>
    `[Example: ${e.name} (${e.kind}) — ${e.provenance}]\nWhy praised: ${e.note}\nStructure:\n${e.structure.slice(0, 800)}\n`,
  );
  return `--- EPISODIC EXAMPLES (promoted past deliverables) ---\n${lines.join("\n")}`;
}

/** Remove an example from the store by id. */
export function removeExample(id: string): boolean {
  const p = path.join(examplesDir(), `${id}.json`);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}