/**
 * Episodic workflow harvester.
 *
 * A completed workflow may contain durable operating knowledge, but it must
 * enter the same pending review queue as every other memory fact. This module
 * only extracts explicitly labelled lines from the train/verify output; it
 * never promotes model prose directly into active memory.
 */

import {
  appendMemoryFact,
  createMemoryFact,
  readAllMemoryFacts,
} from "./schema.js";
import type { MemoryPrivacy } from "./schema.js";
import type { WorkflowDefinition, WorkflowRun } from "../workflow/types.js";
import { redactSecrets } from "../security/secrets.js";

export interface HarvestResult {
  created: number;
  skipped: number;
  candidates: string[];
}

const CANDIDATE_LINE = /^\s*(?:[-*]\s*)?(?:decision|key decision|house (?:rule|style)|lesson|constraint|preference)\s*:\s*(.+)$/gim;

function extractCandidates(run: WorkflowRun): string[] {
  const text = run.phases
    .filter((phase) => phase.phase === "train" || phase.phase === "verify")
    .map((phase) => phase.output || "")
    .join("\n");
  const candidates: string[] = [];
  for (const match of text.matchAll(CANDIDATE_LINE)) {
    const candidate = redactSecrets(match[1].trim()).replace(/\s+/g, " ");
    if (candidate.length >= 12 && candidate.length <= 500) {
      candidates.push(candidate);
    }
  }
  return [...new Set(candidates)];
}

/**
 * Harvest a completed run into pending, provenance-bearing memory facts.
 * Re-running the same workflow cannot duplicate its candidates.
 */
export async function harvestWorkflowCompletion(
  def: WorkflowDefinition,
  run: WorkflowRun,
): Promise<HarvestResult> {
  if (run.status !== "completed") {
    return { created: 0, skipped: 0, candidates: [] };
  }

  const candidates = extractCandidates(run);
  if (candidates.length === 0) {
    return { created: 0, skipped: 0, candidates: [] };
  }

  const existing = await readAllMemoryFacts();
  if (existing.some((fact) => fact.source_session === run.run_id)) {
    return { created: 0, skipped: candidates.length, candidates };
  }

  const privacy: MemoryPrivacy =
    def.data_sensitivity === "public" || def.data_sensitivity === "synthetic"
      ? "project"
      : "private";
  for (const content of candidates) {
    await appendMemoryFact(
      createMemoryFact({
        type: "workspace_fact",
        content,
        source_session: run.run_id,
        confidence: "low",
        privacy,
      }),
    );
  }
  return { created: candidates.length, skipped: 0, candidates };
}
