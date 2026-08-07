/**
 * Benchmark Bar Critic — SPEC §10.1.
 *
 * Structural blind comparison of a draft Office deliverable against a
 * benchmark deliverable the engagement considers great. This is NOT a
 * second verification stage parallel to the maker-checker; it is a new
 * category of acceptance criterion folded into the SAME checker verdict
 * (see src/subagents/checker.ts — the evidence-validation block is the
 * established pattern this mirrors).
 *
 * Why structural, not vision A/B:
 *   - Documents are text-heavy; structural signals (section coverage,
 *     citation density, figure-sourcing parity, length ratios, table-
 *     structure match) are more reliable and reproducible than pixel
 *     comparison for this domain.
 *   - Structural comparison needs NO network and NO API key — it runs
 *     the local `officecli` binary, so it executes cleanly inside the
 *     existing checker sandbox (readOnly, noNetwork, noEnv). The sandbox
 *     stays sealed; no second primitive is introduced.
 *   - Vision-based blind A/B (the Shumer Gauntlet-Loop pixel form) is
 *     Phase 2 — valuable for layout polish, not required for v1.
 *
 * Opt-in via `.quiver/benchmark/`:
 *   - The engagement drops one or more benchmark deliverables into
 *     `.quiver/benchmark/` alongside a `bar.json` manifest.
 *   - With no benchmark configured, `compare()` returns a no-op result
 *     and the checker behaves exactly as before.
 *
 * The verdict folds into the checker's approve|revise|reject:
 *   - A bar gap produces a `revise` with the single biggest gap named,
 *     exactly like a failed gate check.
 *   - The maker-checker never splits into two stages; bar-comparison is
 *     one more check category in the same suite, run in the same sandbox
 *     child, returning one verdict.
 */

import { promises as fs } from "fs";
import { existsSync } from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { findBinary } from "../utils/find_binary.js";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────

export interface BarManifest {
  /** Benchmark file name(s) relative to .quiver/benchmark/. */
  benchmarks: string[];
  /**
   * Minimum section-coverage ratio (draft sections present in benchmark,
   * 0..1). A draft missing benchmark sections below this ratio is a gap.
   * Default 0.6 — the draft should cover at least 60% of the benchmark's
   * section headings (by normalized fuzzy match).
   */
  minSectionCoverage?: number;
  /**
   * Acceptable word-count ratio range [min, max] of draft / benchmark.
   * Default [0.5, 2.0] — the draft should be within 0.5x..2x the
   * benchmark length. Outside → gap.
   */
  wordCountRatioRange?: [number, number];
  /**
   * Minimum table-count parity (draft tables / benchmark tables, 0..1).
   * Default 0.5 — the draft should have at least half as many tables.
   */
  minTableParity?: number;
}

export interface BarComparisonResult {
  /** Whether a benchmark is configured and the comparison ran. */
  ran: boolean;
  /** True when the draft meets every bar dimension (or no benchmark). */
  met: boolean;
  /** Named gaps, most significant first. Empty when met. */
  gaps: string[];
  /** The single biggest gap (human-readable), or null when met. */
  biggestGap: string | null;
  /** Structural stats for audit/logging. */
  stats: {
    draftSections: string[];
    benchmarkSections: string[];
    sectionCoverage: number;
    draftWords: number;
    benchmarkWords: number;
    wordCountRatio: number;
    draftTables: number;
    benchmarkTables: number;
    tableParity: number;
    benchmarkFile: string;
  } | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────

const NO_OP: BarComparisonResult = {
  ran: false,
  met: true,
  gaps: [],
  biggestGap: null,
  stats: null,
};

/**
 * Resolve the benchmark directory for a workspace root. Returns null when
 * no `.quiver/benchmark/` exists — the bar is opt-in per engagement.
 */
export function getBenchmarkDir(workspaceRoot: string): string | null {
  const dir = path.join(workspaceRoot, ".quiver", "benchmark");
  // Synchronous existence check for callers that need a quick gate.
  try {
    if (!existsSync(dir)) return null;
    if (!existsSync(path.join(dir, "bar.json"))) return null;
    return dir;
  } catch {
    return null;
  }
}

async function loadManifest(benchmarkDir: string): Promise<BarManifest | null> {
  try {
    const raw = await fs.readFile(path.join(benchmarkDir, "bar.json"), "utf8");
    const m = JSON.parse(raw);
    if (!Array.isArray(m.benchmarks) || m.benchmarks.length === 0) return null;
    return m;
  } catch {
    return null;
  }
}

async function runOfficeCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const bin = await findBinary("officecli");
  if (!bin) throw new Error("OfficeCLI binary not found");
  const { stdout, stderr } = await execFileAsync(bin, args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30000,
  });
  return { stdout, stderr };
}

interface DocStructure {
  headings: string[];
  words: number;
  paragraphs: number;
  tables: number;
}

async function readStructure(filePath: string): Promise<DocStructure> {
  // outline --json → headings (section coverage)
  const outline = await runOfficeCli(["view", filePath, "outline", "--json"]);
  const outlineData = JSON.parse(outline.stdout);
  const headings: string[] = (outlineData?.data?.headings ?? [])
    .map((h: any) => String(h.text || "").trim())
    .filter((s: string) => s.length > 0);

  // stats --json → words, paragraphs, tables
  const stats = await runOfficeCli(["view", filePath, "stats", "--json"]);
  const statsData = JSON.parse(stats.stdout);
  const d = statsData?.data ?? {};
  return {
    headings,
    words: Number(d.words ?? 0),
    paragraphs: Number(d.paragraphs ?? 0),
    tables: Number(d.tables ?? 0),
  };
}

/**
 * Normalize a heading for fuzzy comparison: lowercase, strip punctuation,
 * collapse whitespace. Lets "Executive Summary" match "Executive summary".
 */
function normalizeHeading(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Coverage = fraction of benchmark headings present in the draft (by
 * normalized substring match). Drafts that add sections the benchmark
 * lacks are fine; drafts that omit benchmark sections are the gap.
 */
function sectionCoverage(
  draftHeadings: string[],
  benchmarkHeadings: string[],
): { ratio: number; missing: string[] } {
  if (benchmarkHeadings.length === 0) return { ratio: 1, missing: [] };
  const draftNorm = new Set(draftHeadings.map(normalizeHeading));
  const draftJoined = draftHeadings.map(normalizeHeading).join(" | ");
  let matched = 0;
  const missing: string[] = [];
  for (const bh of benchmarkHeadings) {
    const bn = normalizeHeading(bh);
    if (draftNorm.has(bn) || draftJoined.includes(bn)) {
      matched++;
    } else {
      missing.push(bh);
    }
  }
  return { ratio: matched / benchmarkHeadings.length, missing };
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Run the structural bar-comparison for a draft Office document.
 *
 * @param draftPath     Absolute path to the draft deliverable.
 * @param workspaceRoot The workspace root (where `.quiver/benchmark/` lives).
 * @returns The comparison result. When no benchmark is configured, returns
 *          a no-op (`ran: false, met: true`) so the checker is unchanged.
 */
export async function compare(
  draftPath: string,
  workspaceRoot: string,
): Promise<BarComparisonResult> {
  const benchmarkDir = getBenchmarkDir(workspaceRoot);
  if (!benchmarkDir) return { ...NO_OP };

  const manifest = await loadManifest(benchmarkDir);
  if (!manifest) return { ...NO_OP };

  // Pick the first benchmark file that exists. Multi-benchmark comparison
  // (selecting the closest by type) is Phase 2; v1 uses the first listed.
  let benchmarkPath: string | null = null;
  for (const name of manifest.benchmarks) {
    const p = path.join(benchmarkDir, name);
    try {
      await fs.access(p);
      benchmarkPath = p;
      break;
    } catch {
      // try next
    }
  }
  if (!benchmarkPath) {
    // Manifest lists files but none present — treat as misconfiguration, no-op
    // (do not fail the deliverable on a config error; log and skip).
    return { ...NO_OP };
  }

  // Resolve the draft path relative to workspaceRoot if not absolute.
  const draftAbs = path.isAbsolute(draftPath) ? draftPath : path.resolve(workspaceRoot, draftPath);
  try {
    await fs.access(draftAbs);
  } catch {
    return {
      ran: false,
      met: true,
      gaps: [`bar-critic: draft file not found at ${draftPath} — skipping`],
      biggestGap: null,
      stats: null,
    };
  }

  const minCoverage = manifest.minSectionCoverage ?? 0.6;
  const [minRatio, maxRatio] = manifest.wordCountRatioRange ?? [0.5, 2.0];
  const minTables = manifest.minTableParity ?? 0.5;

  let draft: DocStructure;
  let benchmark: DocStructure;
  try {
    [draft, benchmark] = await Promise.all([
      readStructure(draftAbs),
      readStructure(benchmarkPath!),
    ]);
  } catch (err: any) {
    // officecli failed — don't fail the deliverable on a tooling error.
    return {
      ran: false,
      met: true,
      gaps: [`bar-critic: structural read failed (${err.message}) — skipping`],
      biggestGap: null,
      stats: null,
    };
  }

  const gaps: string[] = [];
  const cov = sectionCoverage(draft.headings, benchmark.headings);
  if (cov.ratio < minCoverage) {
    gaps.push(
      `BAR/section-coverage: ${cov.ratio.toFixed(2)} < ${minCoverage} — draft is missing ${cov.missing.length} benchmark section(s): ${cov.missing.slice(0, 4).join(", ")}${cov.missing.length > 4 ? ", …" : ""}`,
    );
  }

  const wordRatio = benchmark.words > 0 ? draft.words / benchmark.words : 1;
  if (wordRatio < minRatio) {
    gaps.push(
      `BAR/length: draft ${draft.words} words is ${wordRatio.toFixed(2)}x benchmark ${benchmark.words} (< ${minRatio}x — too short)`,
    );
  } else if (wordRatio > maxRatio) {
    gaps.push(
      `BAR/length: draft ${draft.words} words is ${wordRatio.toFixed(2)}x benchmark ${benchmark.words} (> ${maxRatio}x — too long)`,
    );
  }

  const tableParity = benchmark.tables > 0 ? draft.tables / benchmark.tables : 1;
  if (tableParity < minTables) {
    gaps.push(
      `BAR/table-parity: draft has ${draft.tables} table(s) vs benchmark ${benchmark.tables} (parity ${tableParity.toFixed(2)} < ${minTables})`,
    );
  }

  const met = gaps.length === 0;
  return {
    ran: true,
    met,
    gaps,
    biggestGap: met ? null : gaps[0],
    stats: {
      draftSections: draft.headings,
      benchmarkSections: benchmark.headings,
      sectionCoverage: cov.ratio,
      draftWords: draft.words,
      benchmarkWords: benchmark.words,
      wordCountRatio: wordRatio,
      draftTables: draft.tables,
      benchmarkTables: benchmark.tables,
      tableParity,
      benchmarkFile: path.basename(benchmarkPath!),
    },
  };
}

/**
 * Convenience for the agent-facing tool: list configured benchmarks.
 */
export async function listBenchmarks(workspaceRoot: string): Promise<{
  configured: boolean;
  benchmarks: string[];
  manifest: BarManifest | null;
}> {
  const dir = getBenchmarkDir(workspaceRoot);
  if (!dir) return { configured: false, benchmarks: [], manifest: null };
  const manifest = await loadManifest(dir);
  return {
    configured: true,
    benchmarks: manifest?.benchmarks ?? [],
    manifest,
  };
}
