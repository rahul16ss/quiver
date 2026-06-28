/**
 * Memory Decay — US-4.3
 *
 * Unused memories decay with a configurable half-life decay function
 * based on the hit count and elapsed time.
 *
 * Decay score = hit_count × 0.5^(elapsed_days / half_life_days)
 *
 * Memories with a decay score below a threshold are candidates for
 * archival or removal.
 */

import type { UsageStats } from "./citation_parser.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface DecayConfig {
  /** Half-life in days (default: 30) */
  halfLifeDays: number;
  /** Minimum decay score before a memory is considered for archival */
  archivalThreshold: number;
  /** Minimum days since last use before decay is applied */
  minDaysSinceUse: number;
}

export interface DecayResult {
  file: string;
  hitCount: number;
  daysSinceUse: number;
  decayScore: number;
  shouldArchive: boolean;
}

// ─── Decay Calculation ───────────────────────────────────────────────

const DEFAULT_CONFIG: DecayConfig = {
  halfLifeDays: 30,
  archivalThreshold: 0.5,
  minDaysSinceUse: 7,
};

/**
 * Calculate the decay score for a memory file.
 *
 * @param stats - Usage stats for the memory file
 * @param config - Decay configuration
 * @returns Decay result with score and archival recommendation
 */
export function calculateDecay(
  stats: UsageStats | null,
  config: DecayConfig = DEFAULT_CONFIG,
): DecayResult {
  const now = Date.now();
  const hitCount = stats?.hit_count || 0;

  let daysSinceUse: number;
  if (stats?.last_used) {
    daysSinceUse = (now - new Date(stats.last_used).getTime()) / (1000 * 60 * 60 * 24);
  } else {
    // Never used — use a large number
    daysSinceUse = Infinity;
  }

  // Decay formula: hit_count × 0.5^(elapsed_days / half_life_days)
  let decayScore: number;
  if (daysSinceUse === Infinity || daysSinceUse < config.minDaysSinceUse) {
    // Recently used or never used — no decay
    decayScore = hitCount;
  } else {
    const decayFactor = Math.pow(0.5, daysSinceUse / config.halfLifeDays);
    decayScore = hitCount * decayFactor;
  }

  return {
    file: stats?.file || "",
    hitCount,
    daysSinceUse: daysSinceUse === Infinity ? -1 : Math.floor(daysSinceUse),
    decayScore,
    shouldArchive: decayScore < config.archivalThreshold && daysSinceUse > config.minDaysSinceUse,
  };
}

/**
 * Calculate decay for all memory files.
 *
 * @param allStats - Usage stats for all memory files
 * @param config - Decay configuration
 * @returns Array of decay results, sorted by decay score (lowest first)
 */
export function calculateAllDecay(
  allStats: Record<string, UsageStats>,
  config: DecayConfig = DEFAULT_CONFIG,
): DecayResult[] {
  const results: DecayResult[] = [];

  for (const file of Object.keys(allStats)) {
    results.push(calculateDecay(allStats[file], config));
  }

  // Sort by decay score (lowest = most decayed = archive candidates first)
  results.sort((a, b) => a.decayScore - b.decayScore);

  return results;
}

/**
 * Get files that should be archived based on decay.
 */
export function getArchivalCandidates(
  allStats: Record<string, UsageStats>,
  config: DecayConfig = DEFAULT_CONFIG,
): DecayResult[] {
  return calculateAllDecay(allStats, config).filter((r) => r.shouldArchive);
}

/**
 * Get the default decay configuration.
 */
export function getDefaultDecayConfig(): DecayConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Format decay results for CLI display.
 */
export function formatDecayForCLI(results: DecayResult[]): string {
  if (results.length === 0) {
    return "No memory files to analyze for decay.";
  }

  const lines: string[] = [];
  lines.push("Memory Decay Analysis:");
  lines.push("");

  for (const result of results) {
    const status = result.shouldArchive ? "⚠ ARCHIVE" : "✓ active";
    const daysStr = result.daysSinceUse === -1 ? "never used" : `${result.daysSinceUse}d ago`;
    lines.push(
      `  ${status} ${result.file.padEnd(30)} hits: ${result.hitCount} | ${daysStr} | score: ${result.decayScore.toFixed(2)}`,
    );
  }

  return lines.join("\n");
}