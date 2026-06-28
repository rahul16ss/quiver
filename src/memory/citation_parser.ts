/**
 * Memory Citation Parser — US-4.3
 *
 * Parses model outputs for memory citations.
 * The harness adapter enforces a specific citation tag format.
 * Citation count is tracked; unused memories decay.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { getProjectMemoryDir } from "../paths.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface MemoryCitation {
  file: string;
  section?: string;
  text: string;
  position: number;
}

export interface UsageStats {
  file: string;
  last_used: string | null;
  hit_count: number;
}

// ─── Citation Parsing ─────────────────────────────────────────────────

/**
 * Parse memory citations from model output.
 * Supports XML-style: <memory-citation doc="file" section="section">text</memory-citation>
 * Also supports markdown-style: [file §section](text)
 *
 * @param output - The model's text output
 * @returns Array of parsed citations
 */
export function parseMemoryCitations(output: string): MemoryCitation[] {
  const results: MemoryCitation[] = [];

  // XML style citations
  const xmlPattern = /<memory-citation\s+doc="([^"]*)"(?:\s+section="([^"]*)")?>([\s\S]*?)<\/memory-citation>/gi;
  let match: RegExpExecArray | null;

  while ((match = xmlPattern.exec(output)) !== null) {
    results.push({
      file: match[1],
      section: match[2] || undefined,
      text: match[3].trim(),
      position: match.index,
    });
  }

  // Markdown style citations
  const mdPattern = /\[memory:([^\]§\s]+)(?:\s*§([^\]]+))?\]\(([^)]*)\)/gi;
  while ((match = mdPattern.exec(output)) !== null) {
    results.push({
      file: match[1],
      section: match[2] || undefined,
      text: match[3].trim(),
      position: match.index,
    });
  }

  return results;
}

/**
 * Validate citations — check that cited files actually exist.
 * False citations are ignored and logged.
 */
export function validateCitations(
  citations: MemoryCitation[],
  existingMemoryFiles: string[],
): { valid: MemoryCitation[]; invalid: MemoryCitation[] } {
  const valid: MemoryCitation[] = [];
  const invalid: MemoryCitation[] = [];

  for (const citation of citations) {
    if (existingMemoryFiles.includes(citation.file)) {
      valid.push(citation);
    } else {
      invalid.push(citation);
    }
  }

  return { valid, invalid };
}

// ─── Usage Tracking ───────────────────────────────────────────────────

/**
 * Get the path to the usage stats file.
 */
function getUsageStatsPath(): string {
  return path.join(getProjectMemoryDir(), "usage_stats.json");
}

/**
 * Load usage stats from disk.
 */
async function loadUsageStats(): Promise<Record<string, UsageStats>> {
  try {
    const content = await fs.readFile(getUsageStatsPath(), "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

/**
 * Save usage stats to disk.
 */
async function saveUsageStats(stats: Record<string, UsageStats>): Promise<void> {
  const statsPath = getUsageStatsPath();
  await fs.mkdir(path.dirname(statsPath), { recursive: true });
  await fs.writeFile(statsPath, JSON.stringify(stats, null, 2), "utf8");
}

/**
 * Update usage stats based on citations found in model output.
 * Increments hit_count and updates last_used for each cited file.
 */
export async function updateUsageStats(citations: MemoryCitation[]): Promise<void> {
  if (citations.length === 0) return;

  const stats = await loadUsageStats();
  const now = new Date().toISOString();

  for (const citation of citations) {
    const key = citation.file;
    if (!stats[key]) {
      stats[key] = {
        file: key,
        last_used: now,
        hit_count: 1,
      };
    } else {
      stats[key].last_used = now;
      stats[key].hit_count += 1;
    }
  }

  await saveUsageStats(stats);
}

/**
 * Get usage stats for a specific memory file.
 */
export async function getUsageStatsForFile(file: string): Promise<UsageStats | null> {
  const stats = await loadUsageStats();
  return stats[file] || null;
}

/**
 * Get all usage stats.
 */
export async function getAllUsageStats(): Promise<Record<string, UsageStats>> {
  return loadUsageStats();
}