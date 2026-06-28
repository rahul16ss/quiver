/**
 * Memory Review Queue — US-12.2
 *
 * Extracted facts start as 'pending'. User can accept, edit, reject, pin,
 * or expire facts. Only accepted facts enter active prompt assembly.
 *
 * CLI exposes /memory review. GUI exposes memory review panel.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { getProjectMemoryDir } from "../paths.js";
import {
  type MemoryFact,
  readAllMemoryFacts,
  readPendingMemoryFacts,
  acceptMemoryFact,
  editMemoryFact,
  deleteMemoryFact,
  updateMemoryFact,
} from "./schema.js";

// ─── Types ───────────────────────────────────────────────────────────

export type ReviewAction = "accept" | "edit" | "reject" | "pin" | "expire";

export interface ReviewResult {
  action: ReviewAction;
  factId: string;
  success: boolean;
  message: string;
}

// ─── Review Queue ─────────────────────────────────────────────────────

/**
 * Get all pending facts for review.
 */
export async function getPendingFacts(): Promise<MemoryFact[]> {
  return readPendingMemoryFacts();
}

/**
 * Get all facts (pending and reviewed) for the review panel.
 */
export async function getAllFactsForReview(): Promise<MemoryFact[]> {
  return readAllMemoryFacts();
}

/**
 * Process a review action on a memory fact.
 */
export async function processReview(
  factId: string,
  action: ReviewAction,
  newContent?: string,
): Promise<ReviewResult> {
  try {
    switch (action) {
      case "accept":
        await acceptMemoryFact(factId);
        return { action, factId, success: true, message: "Fact accepted into active memory." };

      case "edit":
        if (!newContent) {
          return { action, factId, success: false, message: "New content required for edit action." };
        }
        await editMemoryFact(factId, newContent);
        return { action, factId, success: true, message: "Fact edited and accepted." };

      case "reject":
        await deleteMemoryFact(factId);
        return { action, factId, success: true, message: "Fact rejected and deleted." };

      case "pin":
        await updateMemoryFact(factId, { reviewed: true, confidence: "high" });
        return { action, factId, success: true, message: "Fact pinned with high confidence." };

      case "expire":
        await updateMemoryFact(factId, { reviewed: false, confidence: "low" });
        return { action, factId, success: true, message: "Fact expired (marked low confidence)." };

      default:
        return { action, factId, success: false, message: `Unknown action: ${action}` };
    }
  } catch (error: any) {
    return { action, factId, success: false, message: error.message };
  }
}

/**
 * Format the review queue for CLI display.
 */
export function formatReviewQueueForCLI(facts: MemoryFact[]): string {
  if (facts.length === 0) {
    return "No pending memories to review.";
  }

  const lines: string[] = [];
  lines.push(`Memory Review Queue (${facts.length} pending):`);
  lines.push("");

  facts.forEach((fact, i) => {
    lines.push(`  ${i + 1}. [${fact.type}] ${fact.content.substring(0, 80)}${fact.content.length > 80 ? "..." : ""}`);
    lines.push(`     ID: ${fact.id}`);
    lines.push(`     Confidence: ${fact.confidence} | Privacy: ${fact.privacy}`);
    lines.push(`     Source: ${fact.source_session} (${fact.source_timestamp})`);
    lines.push("");
  });

  lines.push("Actions: accept <id> | edit <id> <content> | reject <id> | pin <id> | expire <id>");
  return lines.join("\n");
}

/**
 * Get only facts that should be included in active prompt assembly.
 * Only reviewed facts with non-secret privacy are included by default.
 */
export async function getActiveMemoryFacts(includePrivate: boolean = false): Promise<MemoryFact[]> {
  const facts = await readAllMemoryFacts();
  return facts.filter((f) => {
    if (!f.reviewed) return false;
    if (f.privacy === "secret") return false;
    if (f.privacy === "private" && !includePrivate) return false;
    return true;
  });
}

/**
 * Get the count of pending and reviewed facts.
 */
export async function getMemoryStats(): Promise<{ pending: number; reviewed: number; total: number }> {
  const facts = await readAllMemoryFacts();
  const pending = facts.filter((f) => !f.reviewed).length;
  const reviewed = facts.filter((f) => f.reviewed).length;
  return { pending, reviewed, total: facts.length };
}