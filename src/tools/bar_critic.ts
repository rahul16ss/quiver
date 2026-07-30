/**
 * Bar Critic tool — agent-facing wrapper for the benchmark bar-comparison
 * (SPEC §10.1).
 *
 * The agent can request a bar-comparison on demand (not only at the
 * ambient completion gate). This is useful mid-draft: the agent asks "how
 * does my draft compare to the benchmark?" and gets the biggest gap to
 * close before declaring done.
 *
 * Actions:
 *   - compare : run the structural bar-comparison on a draft file
 *   - status  : is a benchmark configured for this workspace?
 *   - list    : list configured benchmark files
 *
 * With no `.quiver/benchmark/` configured, every action is a clean no-op
 * — the tool reports "no benchmark configured" and the agent moves on.
 */

import { z } from "zod";
import { promises as fs } from "fs";
import * as path from "path";
import { Tool } from "../registry.js";
import { compare, listBenchmarks } from "../document/bar_critic.js";

export const tool: Tool = {
  name: "bar_critic",
  description:
    "Structural bar-comparison of a draft Office deliverable against a benchmark the engagement considers great (SPEC §10.1). " +
    "Compares section coverage, length, and table parity via the local officecli (no network). " +
    "Opt-in via .quiver/benchmark/ with a bar.json manifest; a clean no-op when no benchmark is configured. " +
    "Actions: 'compare' to run the comparison on a draft file, 'status' to check whether a benchmark is configured, 'list' to list configured benchmark files.",
  parameters: z.object({
    action: z
      .enum(["compare", "status", "list"])
      .describe(
        "Action: 'compare' runs the structural bar-comparison (requires file), 'status' reports whether a benchmark is configured, 'list' names the configured benchmark files.",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "Path to the draft Office document (.docx/.xlsx/.pptx) to compare against the benchmark. Required for 'compare'.",
      ),
  }),
  execute: async ({ action, file }) => {
    const cwd = process.cwd();
    try {
      switch (action) {
        case "status": {
          const { configured, benchmarks, manifest } = await listBenchmarks(cwd);
          if (!configured) {
            return "No benchmark configured (.quiver/benchmark/bar.json not found). The bar-critic is a no-op — the maker-checker remains the sole verification primitive.";
          }
          const thresholds = manifest
            ? `thresholds: section-coverage ≥ ${manifest.minSectionCoverage ?? 0.6}, word-ratio ${JSON.stringify(manifest.wordCountRatioRange ?? [0.5, 2.0])}, table-parity ≥ ${manifest.minTableParity ?? 0.5}`
            : "thresholds: defaults (manifest missing)";
          return `Benchmark configured.\nFiles: ${benchmarks.join(", ") || "(none listed)"}\n${thresholds}`;
        }
        case "list": {
          const { configured, benchmarks } = await listBenchmarks(cwd);
          if (!configured) return "No benchmark configured.";
          if (benchmarks.length === 0) return "Benchmark dir exists but bar.json lists no files.";
          return `Configured benchmark files (in .quiver/benchmark/):\n${benchmarks.map((b) => `  - ${b}`).join("\n")}`;
        }
        case "compare": {
          if (!file) {
            return "Error: 'file' is required for the 'compare' action.";
          }
          const result = await compare(file, cwd);
          if (!result.ran) {
            return "No benchmark configured — bar-comparison is a no-op. The maker-checker remains the sole verification primitive.";
          }
          if (result.met) {
            const s = result.stats!;
            return (
              `Bar met ✓ — draft compares favourably with benchmark (${s.benchmarkFile}).\n` +
              `  section coverage: ${s.sectionCoverage.toFixed(2)} (≥ ${(0.6).toFixed(1)} OK)\n` +
              `  words: ${s.draftWords} vs ${s.benchmarkWords} (ratio ${s.wordCountRatio.toFixed(2)}x)\n` +
              `  tables: ${s.draftTables} vs ${s.benchmarkTables} (parity ${s.tableParity.toFixed(2)})`
            );
          }
          const s = result.stats!;
          return (
            `Bar NOT met — ${result.biggestGap}\n\n` +
            `All gaps (most significant first):\n${result.gaps.map((g) => `  - ${g}`).join("\n")}\n\n` +
            `Structural stats vs benchmark (${s.benchmarkFile}):\n` +
            `  draft sections:    ${s.draftSections.length} — ${s.draftSections.slice(0, 5).join(", ")}${s.draftSections.length > 5 ? ", …" : ""}\n` +
            `  benchmark sections: ${s.benchmarkSections.length} — ${s.benchmarkSections.slice(0, 5).join(", ")}${s.benchmarkSections.length > 5 ? ", …" : ""}\n` +
            `  section coverage:  ${s.sectionCoverage.toFixed(2)}\n` +
            `  words:             ${s.draftWords} vs ${s.benchmarkWords} (ratio ${s.wordCountRatio.toFixed(2)}x)\n` +
            `  tables:            ${s.draftTables} vs ${s.benchmarkTables} (parity ${s.tableParity.toFixed(2)})`
          );
        }
        default:
          return `Unknown action: ${action}`;
      }
    } catch (err: any) {
      return `Error in bar_critic: ${err.message}`;
    }
  },
};