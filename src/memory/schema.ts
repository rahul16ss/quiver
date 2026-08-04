/**
 * Memory Schema & Provenance — US-12.1
 *
 * Stores facts in ~/.quiver/projects/{project_id}/memory/facts.jsonl
 * Every learned memory includes provenance: source session, timestamp,
 * confidence, privacy label, review status, and usage stats.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { getProjectMemoryDir } from "../paths.js";
import { atomicWrite, CorruptStateError } from "../fs/atomic_write.js";

// ─── Schema ──────────────────────────────────────────────────────────

export const MEMORY_SCHEMA_VERSION = 1;

export type MemoryType =
  | "workspace_fact"
  | "user_preference"
  | "code_behavior"
  | "architecture_note"
  | "error_pattern"
  | "skill_accretion";

export type MemoryConfidence = "high" | "medium" | "low";
export type MemoryPrivacy = "public" | "project" | "private" | "secret";

export interface MemoryFact {
  schema_version: number;
  id: string;
  type: MemoryType;
  content: string;
  source_session: string;
  source_timestamp: string;
  confidence: MemoryConfidence;
  privacy: MemoryPrivacy;
  reviewed: boolean;
  created_at: string;
  last_used_at: string | null;
  hit_count: number;
}

// ─── Storage ──────────────────────────────────────────────────────────

/**
 * Get the path to the facts.jsonl file.
 */
function getFactsPath(): string {
  return path.join(getProjectMemoryDir(), "facts.jsonl");
}

// Memory facts are shared by workflow harvesters and interactive review
// actions. Serialize read-modify-write operations so two completions cannot
// overwrite one another even though each individual write is atomic.
let memoryWriteQueue: Promise<void> = Promise.resolve();

function enqueueMemoryWrite<T>(operation: () => Promise<T>): Promise<T> {
  const next = memoryWriteQueue.then(operation, operation);
  memoryWriteQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `mem_${timestamp}${random}`;
}

/**
 * Create a new memory fact.
 */
export function createMemoryFact(params: {
  type: MemoryType;
  content: string;
  source_session: string;
  confidence?: MemoryConfidence;
  privacy?: MemoryPrivacy;
}): MemoryFact {
  return {
    schema_version: MEMORY_SCHEMA_VERSION,
    id: generateMemoryId(),
    type: params.type,
    content: params.content,
    source_session: params.source_session,
    source_timestamp: new Date().toISOString(),
    confidence: params.confidence || "medium",
    privacy: params.privacy || "project",
    reviewed: false,
    created_at: new Date().toISOString(),
    last_used_at: null,
    hit_count: 0,
  };
}

/**
 * Append a memory fact to the facts.jsonl file.
 */
export async function appendMemoryFact(fact: MemoryFact): Promise<void> {
  await enqueueMemoryWrite(async () => {
    const factsPath = getFactsPath();
    await fs.mkdir(path.dirname(factsPath), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(factsPath, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const prefix = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    await atomicWrite(factsPath, `${prefix}${JSON.stringify(fact)}\n`);
  });
}

/**
 * Read all memory facts from the facts.jsonl file.
 */
export async function readAllMemoryFacts(): Promise<MemoryFact[]> {
  const factsPath = getFactsPath();
  let content: string;
  try {
    content = await fs.readFile(factsPath, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const facts: MemoryFact[] = [];
  for (const [index, line] of content
    .split("\n")
    .filter((item) => item.trim())
    .entries()) {
    try {
      facts.push(JSON.parse(line) as MemoryFact);
    } catch {
      throw new CorruptStateError(
        factsPath,
        `invalid JSON on facts line ${index + 1}`,
      );
    }
  }
  return facts;
}

/**
 * Read only reviewed (accepted) memory facts.
 */
export async function readReviewedMemoryFacts(): Promise<MemoryFact[]> {
  const facts = await readAllMemoryFacts();
  return facts.filter((f) => f.reviewed);
}

/**
 * Read only pending (unreviewed) memory facts.
 */
export async function readPendingMemoryFacts(): Promise<MemoryFact[]> {
  const facts = await readAllMemoryFacts();
  return facts.filter((f) => !f.reviewed);
}

/**
 * Update a memory fact in the facts.jsonl file.
 * This rewrites the entire file with the updated fact.
 */
export async function updateMemoryFact(
  factId: string,
  updates: Partial<MemoryFact>,
): Promise<void> {
  await enqueueMemoryWrite(async () => {
    const facts = await readAllMemoryFacts();
    const updated = facts.map((f) =>
      f.id === factId ? { ...f, ...updates } : f,
    );

    const factsPath = getFactsPath();
    const content = updated.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await atomicWrite(factsPath, content);
  });
}

/**
 * Mark a memory fact as reviewed (accepted).
 */
export async function acceptMemoryFact(factId: string): Promise<void> {
  await updateMemoryFact(factId, { reviewed: true });
}

/**
 * Mark a memory fact as reviewed and update its content (edit).
 */
export async function editMemoryFact(factId: string, content: string): Promise<void> {
  await updateMemoryFact(factId, { reviewed: true, content });
}

/**
 * Delete a memory fact from the facts.jsonl file.
 */
export async function deleteMemoryFact(factId: string): Promise<void> {
  await enqueueMemoryWrite(async () => {
    const facts = await readAllMemoryFacts();
    const filtered = facts.filter((f) => f.id !== factId);

    const factsPath = getFactsPath();
    const content = filtered.map((f) => JSON.stringify(f)).join("\n");
    await atomicWrite(factsPath, content + (content ? "\n" : ""));
  });
}

/**
 * Update the last_used_at and increment hit_count for a memory fact.
 */
export async function touchMemoryFact(factId: string): Promise<void> {
  await enqueueMemoryWrite(async () => {
    const facts = await readAllMemoryFacts();
    const updated = facts.map((f) =>
      f.id === factId
        ? {
            ...f,
            last_used_at: new Date().toISOString(),
            hit_count: f.hit_count + 1,
          }
        : f,
    );

    const factsPath = getFactsPath();
    const content = updated.map((f) => JSON.stringify(f)).join("\n") + "\n";
    await atomicWrite(factsPath, content);
  });
}
