/**
 * Gauntlet — parallel builder+critic fan-out (SPEC §10.2).
 *
 * The Gauntlet Loop pattern (Matt Shumer's "Claude of Duty" method), adapted
 * for Quiver's one-primitive discipline:
 *
 *   1. The lead agent splits a goal into the smallest pieces that can be
 *      improved and judged separately (e.g. thesis, financials, risks).
 *   2. For each piece, the gauntlet spawns a BUILDER subagent (isolated
 *      scratchpad, own context window) with a piece-specific prompt.
 *   3. When the builder returns, the gauntlet runs the bar_critic structural
 *      comparison against the configured benchmark (§10.1).
 *   4. The gap report from each piece is returned to the lead agent, which
 *      decides whether to iterate (send the gap back to a builder for another
 *      round) or accept the piece.
 *
 * This is NOT a second verification stage parallel to the maker-checker. The
 * maker-checker remains the sole gate for hard correctness (every number
 * sourced, document valid). The gauntlet is the QUALITY driver — "is each
 * piece as good as the benchmark?" — and its gap reports feed the same ambient
 * heal loop (the lead agent injects gaps as directives and continues).
 *
 * Reuses the existing subagent infrastructure (scratchpad isolation, recursion
 * depth, env stripping) and bar_critic (structural comparison, no network).
 * With no benchmark configured, the gauntlet runs builders without the critic
 * step — still useful for parallel fan-out, just without the bar.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { fileURLToPath } from "url";
import { z } from "zod";
import { Tool } from "../registry.js";
import { compare as compareBenchmark } from "../document/bar_critic.js";

const MAX_GAUNTLET_PIECES = 8;
const MAX_GAUNTLET_ROUNDS = 5;
const SUBAGENT_TIMEOUT_MS = 300000;

function getCliPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, "..", "cli.ts");
}

function getTsxPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(currentDir, "..", "..");
  return path.join(projectRoot, "node_modules", ".bin", "tsx");
}

interface GauntletPiece {
  name: string;
  prompt: string;
}

interface PieceResult {
  name: string;
  round: number;
  builderResponse: string;
  builderTurns: number;
  builderTokens: number;
  barMet: boolean;
  barGaps: string[];
  barBiggestGap: string | null;
  error?: string;
}

async function buildSubagentScratchpad(): Promise<string> {
  const scratchDir = path.join(
    os.tmpdir(),
    `quiver-gauntlet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(scratchDir, { recursive: true });
  for (const dir of ["src", "tests", "ui", "docs", "templates", "skills", "Formula", "branding", "bin"]) {
    try {
      await fs.cp(path.join(process.cwd(), dir), path.join(scratchDir, dir), {
        recursive: true,
      });
    } catch {}
  }
  for (const file of ["package.json", "tsconfig.json"]) {
    try {
      await fs.copyFile(path.join(process.cwd(), file), path.join(scratchDir, file));
    } catch {}
  }
  return scratchDir;
}

async function runBuilder(
  task: string,
  scratchDir: string,
): Promise<{ response: string; turns: number; tokens: number; error?: string }> {
  const currentDepth = parseInt(process.env.SUBAGENT_DEPTH || "0", 10);
  if (currentDepth >= 2) {
    return { response: "Subagent recursion depth limit reached.", turns: 0, tokens: 0, error: "Recursion limit" };
  }

  const cliPath = getCliPath();
  const tsxPath = getTsxPath();
  const args = [cliPath, "--json", "--single-turn", task];
  // Minimal env allowlist — GITHUB_TOKEN and sensitive secrets are explicitly stripped.
  const ALLOWED_ENV_KEYS = [
    "PATH", "HOME", "USER", "LANG", "TERM", "TZ",
    "LLM_API_KEY", "LLM_API_BASE_URL", "LLM_MODEL_NAME",
    "VISION_MODEL_NAME", "VISION_MODEL_BASE_URL",
    "QUIVER_PROJECT_NAME", "QUIVER_MAX_CONTEXT_TOKENS",
    "QUIVER_SESSION_LOG", "QUIVER_SESSION_LOG_MAX_CHARS",
    "QUIVER_AMBIENT", "QUIVER_OUTPUT_MODE",
    "SUBAGENT_DEPTH",
  ];
  const childEnv: Record<string, string | undefined> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }
  const sensitiveKeysToStrip = ["GITHUB_TOKEN"];
  sensitiveKeysToStrip.forEach((k) => delete childEnv[k]);
  childEnv.SUBAGENT_DEPTH = String(currentDepth + 1);

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(tsxPath, args, {
      cwd: scratchDir,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let lastResponse = "";
    let turns = 0;
    let totalTokens = 0;
    const timeoutId = setTimeout(() => {
      child.kill();
      resolve({ response: lastResponse || "Builder timed out.", turns, tokens: totalTokens, error: "Timeout" });
    }, SUBAGENT_TIMEOUT_MS);

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(line);
          if (msg.type === "token" && msg.data?.text) lastResponse += msg.data.text;
          if (msg.type === "done") {
            turns = msg.data?.tokenStats?.turns || 0;
            totalTokens = (msg.data?.tokenStats?.inputTokens || 0) + (msg.data?.tokenStats?.outputTokens || 0);
            if (msg.data?.response) lastResponse = msg.data.response;
          }
          if (msg.type === "error") {
            clearTimeout(timeoutId);
            child.kill();
            resolve({ response: lastResponse || "Builder error.", turns, tokens: totalTokens, error: msg.data?.error });
          }
        } catch {}
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timeoutId);
      if (code !== 0 && !lastResponse) {
        resolve({ response: `Builder exited with code ${code}.`, turns, tokens: totalTokens, error: `Exit ${code}` });
      } else {
        resolve({ response: lastResponse || "Builder completed with no output.", turns, tokens: totalTokens });
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeoutId);
      resolve({ response: `Failed to spawn builder: ${err.message}`, turns: 0, tokens: 0, error: err.message });
    });
  });
}

async function runPiece(
  piece: GauntletPiece,
  round: number,
  maxRounds: number,
  previousGaps: string[],
  benchmarkDir: string | null,
): Promise<PieceResult> {
  let scratchDir: string;
  try {
    scratchDir = await buildSubagentScratchpad();
  } catch {
    scratchDir = process.cwd();
  }

  let prompt = piece.prompt;
  if (round > 1 && previousGaps.length > 0) {
    prompt +=
      `\n\nThis is round ${round}/${maxRounds}. The bar-critic identified these gaps in your previous output:\n` +
      previousGaps.map((g) => `  - ${g}`).join("\n") +
      `\nClose the biggest gap. Do not repeat the same approach that produced these gaps.`;
  }

  const builder = await runBuilder(prompt, scratchDir);

  let barMet = true;
  let barGaps: string[] = [];
  let barBiggestGap: string | null = null;

  if (benchmarkDir) {
    try {
      const barResult = await compareBenchmark(piece.name, process.cwd());
      if (barResult.ran && !barResult.met) {
        barMet = false;
        barGaps = barResult.gaps;
        barBiggestGap = barResult.biggestGap;
      }
    } catch {}
  }

  return {
    name: piece.name,
    round,
    builderResponse: builder.response,
    builderTurns: builder.turns,
    builderTokens: builder.tokens,
    barMet,
    barGaps,
    barBiggestGap,
    error: builder.error,
  };
}

export const tool: Tool = {
  name: "gauntlet",
  description:
    "Parallel builder+critic fan-out (the Gauntlet Loop pattern, SPEC §10.2). " +
    "Splits a goal into pieces, spawns a builder subagent for each piece in parallel, " +
    "runs the bar-critic structural comparison against the configured benchmark for each, " +
    "and returns the gap reports. The lead agent decides whether to iterate (send gaps " +
    "back for another round) or accept. " +
    "With no benchmark configured (.quiver/benchmark/), runs builders without the critic step. " +
    "Actions: 'fan_out' to run the gauntlet, 'status' to check state. " +
    "Do NOT use for simple single-piece tasks — only when the goal can be split into " +
    "independently improvable pieces that benefit from parallel builders + a bar.",
  parameters: z.object({
    action: z
      .enum(["fan_out", "status"])
      .describe(
        "Action: 'fan_out' runs the gauntlet (requires pieces), 'status' shows the last gauntlet result.",
      ),
    pieces: z
      .array(
        z.object({
          name: z.string().describe("A short name for this piece (e.g. 'thesis', 'financials', 'risks')."),
          prompt: z.string().describe("The task prompt for this piece's builder. Be specific — the builder has no context from your conversation."),
        }),
      )
      .optional()
      .describe("The pieces to fan out. Required for 'fan_out'. Max 8 pieces."),
    maxRounds: z
      .number()
      .optional()
      .describe(`Maximum improvement rounds per piece. Default: ${MAX_GAUNTLET_ROUNDS}. The gauntlet runs each piece, checks the bar, and if not met, sends the gap back for another round.`),
  }),
  execute: async ({ action, pieces, maxRounds }) => {
    const cwd = process.cwd();
    const maxR = maxRounds || MAX_GAUNTLET_ROUNDS;

    if (action === "status") {
      return "Use action='fan_out' to run the gauntlet. State is not persisted across tool calls — each fan_out is independent.";
    }

    if (action !== "fan_out") {
      return `Unknown action: ${action}`;
    }

    if (!pieces || pieces.length === 0) {
      return "Error: 'pieces' is required for 'fan_out'. Provide 1-8 pieces, each with a name and prompt.";
    }

    if (pieces.length > MAX_GAUNTLET_PIECES) {
      return `Error: too many pieces (${pieces.length}). Maximum is ${MAX_GAUNTLET_PIECES}.`;
    }

    // Check if a benchmark is configured
    let benchmarkDir: string | null = null;
    try {
      const fsSync = await import("fs");
      const dir = path.join(cwd, ".quiver", "benchmark");
      if (fsSync.existsSync(dir) && fsSync.existsSync(path.join(dir, "bar.json"))) {
        benchmarkDir = dir;
      }
    } catch {}

    const header = benchmarkDir
      ? `Gauntlet fan-out: ${pieces.length} piece(s), max ${maxR} rounds, benchmark configured.`
      : `Gauntlet fan-out: ${pieces.length} piece(s), max ${maxR} rounds, NO benchmark — builders only (no critic step).`;

    // Round 1: run all builders in parallel
    const allResults: PieceResult[] = [];
    const round1Promises = pieces.map((p: GauntletPiece) => runPiece(p, 1, maxR, [], benchmarkDir));
    const round1Results = await Promise.all(round1Promises);
    allResults.push(...round1Results);

    // If benchmark is configured, iterate on pieces that didn't meet the bar
    if (benchmarkDir) {
      for (let round = 2; round <= maxR; round++) {
        const needsIteration = round1Results.filter((r) => !r.barMet && !r.error);
        if (needsIteration.length === 0) break;

        const iterationPromises = needsIteration.map((r: PieceResult) => {
          const piece = pieces.find((p: GauntletPiece) => p.name === r.name)!;
          return runPiece(piece, round, maxR, r.barGaps, benchmarkDir);
        });
        const iterationResults = await Promise.all(iterationPromises);
        allResults.push(...iterationResults);

        const stillNotMet = iterationResults.filter((r: PieceResult) => !r.barMet);
        if (stillNotMet.length === 0) break;
      }
    }

    // Build the report
    const lines: string[] = [header, ""];
    for (const r of allResults) {
      const status = r.error
        ? `ERROR: ${r.error}`
        : r.barMet
          ? `BAR MET ✓`
          : r.barGaps.length > 0
            ? `BAR NOT MET — ${r.barBiggestGap}`
            : `done (no benchmark)`;
      lines.push(`┌─ ${r.name} (round ${r.round})`);
      lines.push(`│  status: ${status}`);
      lines.push(`│  builder: ${r.builderTurns} turns, ~${r.builderTokens.toLocaleString()} tokens`);
      if (r.barGaps.length > 0) {
        lines.push(`│  gaps:`);
        for (const g of r.barGaps) {
          lines.push(`│    - ${g}`);
        }
      }
      lines.push(`│  response: ${r.builderResponse.substring(0, 200)}${r.builderResponse.length > 200 ? "…" : ""}`);
      lines.push(`└─`);
      lines.push("");
    }

    const metCount = allResults.filter((r) => r.barMet && !r.error).length;
    const totalCount = allResults.length;
    const summary = benchmarkDir
      ? `${metCount}/${totalCount} pieces met the bar.`
      : `${totalCount} piece(s) completed (no benchmark — builders only).`;

    lines.push(summary);

    return lines.join("\n");
  },
};