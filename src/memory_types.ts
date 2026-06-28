/**
 * Memory Type Classification
 *
 * Classifies persistent memory entries into three cognitive-science-inspired
 * categories, matching the three-tier memory architecture shown on the
 * landing page:
 *
 *   Semantic (Facts)     — General knowledge, preferences, stable facts
 *                          about the user and workspace.
 *                          Files: persona.txt, human.txt, user-preferences.md
 *
 *   Episodic (History)   — Session-specific events, conversation history,
 *                          things that happened at a point in time.
 *                          Files: workspace-facts.md, session logs
 *
 *   Procedural (Skills)  — How-to knowledge, learned procedures, code
 *                          patterns, tool usage conventions.
 *                          Files: skills/ SKILL.md, procedural patterns
 *
 * This module provides:
 * 1. classifyMemoryFile() — maps a memory filename to its type
 * 2. classifyMemoryEntry() — classifies a single bullet-point entry by content
 * 3. getMemoryTypeMetadata() — returns display metadata (color, label) for a type
 * 4. loadClassifiedMemory() — loads all memory files and returns them tagged
 *
 * The classification is rule-based (keyword matching) — transparent and
 * auditable, not a black-box ML model. Users can see exactly why each
 * entry was classified the way it was.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { getProjectMemoryDir, getSkillsDir } from "./paths.js";

// ─── Types ────────────────────────────────────────────────────────────

export type MemoryType = "semantic" | "episodic" | "procedural";

export interface ClassifiedMemoryEntry {
  text: string;
  type: MemoryType;
  source: string; // filename the entry came from
  confidence: number; // 0-1, how confident the classification is
}

export interface ClassifiedMemoryFile {
  filename: string;
  type: MemoryType;
  content: string;
  entries: ClassifiedMemoryEntry[];
}

export interface MemoryTypeMetadata {
  label: string;
  fullLabel: string;
  color: string;
  description: string;
}

// ─── File-to-Type Mapping ─────────────────────────────────────────────

/**
 * Known memory files and their default classification.
 * This is the primary classification signal — the filename determines
 * the type, and individual entries can be reclassified by content.
 */
const FILE_TYPE_MAP: Record<string, MemoryType> = {
  "persona.txt": "procedural",
  "human.txt": "semantic",
  "user-preferences.md": "semantic",
  "workspace-facts.md": "episodic",
  "project.json": "semantic",
};

/**
 * Classify a memory file by its filename.
 * Falls back to "semantic" for unknown files.
 */
export function classifyMemoryFile(filename: string): MemoryType {
  const lower = filename.toLowerCase();
  if (FILE_TYPE_MAP[lower]) return FILE_TYPE_MAP[lower];

  // Heuristic: files with "skill" or "procedure" in the name are procedural
  if (lower.includes("skill") || lower.includes("procedure"))
    return "procedural";
  // Files with "history" or "log" or "session" are episodic
  if (
    lower.includes("history") ||
    lower.includes("log") ||
    lower.includes("session")
  )
    return "episodic";
  // Files with "fact" or "pref" are semantic
  if (lower.includes("fact") || lower.includes("pref")) return "semantic";

  return "semantic";
}

// ─── Entry Classification by Content ──────────────────────────────────

/**
 * Keyword patterns for classifying individual memory entries (bullet points).
 * Each pattern maps to a memory type. The first matching pattern wins.
 *
 * These are intentionally transparent — users can see exactly which keywords
 * trigger which classification.
 */
const ENTRY_PATTERNS: {
  type: MemoryType;
  keywords: string[];
  weight: number;
}[] = [
  // Procedural: how-to, tool usage, code patterns, build commands
  {
    type: "procedural",
    keywords: [
      "build",
      "compile",
      "run command",
      "test command",
      "deploy",
      "how to",
      "use ",
      "tool",
      "script",
      "npm ",
      "npx ",
      "tsx ",
      "format",
      "lint",
      "pattern",
      "convention",
      "always use",
      "never use",
      "should use",
      "must use",
      "procedure",
    ],
    weight: 0.8,
  },
  // Episodic: events, things that happened, session-specific
  {
    type: "episodic",
    keywords: [
      "session",
      "happened",
      "yesterday",
      "last week",
      "previously",
      "encountered",
      "fixed",
      "resolved",
      "issue",
      "bug",
      "error",
      "crash",
      "failed",
      "updated",
      "changed",
      "migrated",
      "installed",
      "created",
      "deleted",
      "ran into",
    ],
    weight: 0.7,
  },
  // Semantic: stable facts, preferences, identity
  {
    type: "semantic",
    keywords: [
      "prefer",
      "like",
      "dislike",
      "always",
      "never",
      "identity",
      "name is",
      "works at",
      "uses ",
      "project is",
      "workspace is",
      "is a",
      "has ",
      "contains ",
      "consists of",
      "located at",
    ],
    weight: 0.6,
  },
];

/**
 * Classify a single memory entry (bullet point) by its text content.
 * Returns the type and a confidence score.
 */
export function classifyMemoryEntry(
  text: string,
  defaultType: MemoryType = "semantic",
): { type: MemoryType; confidence: number } {
  const lower = text.toLowerCase();

  let bestType = defaultType;
  let bestConfidence = 0.3; // Base confidence for default classification

  for (const pattern of ENTRY_PATTERNS) {
    for (const keyword of pattern.keywords) {
      if (lower.includes(keyword)) {
        if (pattern.weight > bestConfidence) {
          bestType = pattern.type;
          bestConfidence = pattern.weight;
        }
        break; // First matching keyword in this pattern is enough
      }
    }
  }

  return { type: bestType, confidence: bestConfidence };
}

// ─── Display Metadata ─────────────────────────────────────────────────

const TYPE_METADATA: Record<MemoryType, MemoryTypeMetadata> = {
  semantic: {
    label: "Semantic",
    fullLabel: "Semantic (Facts)",
    color: "#93c5fd",
    description:
      "General knowledge, preferences, and stable facts about the user and workspace.",
  },
  episodic: {
    label: "Episodic",
    fullLabel: "Episodic (History)",
    color: "#d8b4fe",
    description:
      "Session-specific events, conversation history, and things that happened at a point in time.",
  },
  procedural: {
    label: "Procedural",
    fullLabel: "Procedural (Skills)",
    color: "#6ee7b7",
    description:
      "How-to knowledge, learned procedures, code patterns, and tool usage conventions.",
  },
};

export function getMemoryTypeMetadata(type: MemoryType): MemoryTypeMetadata {
  return TYPE_METADATA[type];
}

export function getAllMemoryTypeMetadata(): MemoryTypeMetadata[] {
  return Object.values(TYPE_METADATA);
}

// ─── Loading & Classification ─────────────────────────────────────────

/**
 * Load all memory files from the project memory directory and classify
 * each file and its individual entries.
 *
 * Returns an array of ClassifiedMemoryFile objects, each containing:
 * - The filename and its classified type
 * - The full file content
 * - Individual bullet-point entries with their own classifications
 */
export async function loadClassifiedMemory(): Promise<ClassifiedMemoryFile[]> {
  const memoryDir = getProjectMemoryDir();
  const results: ClassifiedMemoryFile[] = [];

  try {
    await fs.mkdir(memoryDir, { recursive: true });
    const files = await fs.readdir(memoryDir);

    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || file.startsWith(".") || file === "project.json") {
        continue;
      }

      const content = await fs.readFile(filePath, "utf8");
      const fileType = classifyMemoryFile(file);

      // Parse bullet points and classify each one
      const entries: ClassifiedMemoryEntry[] = [];
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
          const text = trimmed.substring(2).trim();
          const { type, confidence } = classifyMemoryEntry(text, fileType);
          entries.push({ text, type, source: file, confidence });
        }
      }

      results.push({
        filename: file,
        type: fileType,
        content,
        entries,
      });
    }
  } catch {
    // Ignore directory read errors
  }

  return results;
}

/**
 * Get a summary of memory types currently in use.
 * Returns counts of entries by type, for display in the context manifest
 * or the /memory command.
 */
export async function getMemoryTypeSummary(): Promise<{
  total: number;
  byType: Record<MemoryType, number>;
  files: ClassifiedMemoryFile[];
}> {
  const files = await loadClassifiedMemory();
  const byType: Record<MemoryType, number> = {
    semantic: 0,
    episodic: 0,
    procedural: 0,
  };

  let total = 0;
  for (const file of files) {
    for (const entry of file.entries) {
      byType[entry.type]++;
      total++;
    }
  }

  return { total, byType, files };
}
