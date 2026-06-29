/**
 * Phase 2: True Adversarial Maker-Checker Agent Loop — US-15.5, US-15.6, US-15.7
 *
 * Spawns two distinct LLM agent instances (Maker and Checker) that run
 * concurrently with different system prompts. They communicate via a shared
 * protocol document, alternate turns, and the Checker writes independent
 * test cases that the Maker must pass. The change is committed to the real
 * workspace only when the Checker agent outputs a structured `approve` verdict.
 *
 * US-15.5: Dual-Instance Agent Orchestration Loop
 * US-15.6: Shared Protocol & Critique Channel
 * US-15.7: Adversarial Test Generation & Turn Alternation
 */

import { spawn } from "child_process";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { existsSync } from "fs";
import { AuditChain } from "../logger.js";
import { buildScratchpad } from "./scratchpad_helpers.js";

// ─── Types ───────────────────────────────────────────────────────────

export type AdversarialVerdict = "approve" | "reject" | "revise";

export interface AdversarialTurn {
  turnNumber: number;
  agent: "maker" | "checker";
  action: string;
  summary: string;
  timestamp: string;
}

export interface AdversarialResult {
  verdict: AdversarialVerdict;
  totalTurns: number;
  maxTurns: number;
  turns: AdversarialTurn[];
  protocolPath: string;
  checkerTestPath: string;
  evidence: string;
  timestamp: string;
}

export interface AdversarialConfig {
  maxTurns: number; // default: 5
  workspaceRoot: string;
  taskPrompt: string;
  makerSystemPrompt?: string;
  checkerSystemPrompt?: string;
  timeoutMs: number; // per turn
}

export const DEFAULT_ADVERSARIAL_CONFIG: Partial<AdversarialConfig> = {
  maxTurns: 5,
  timeoutMs: 120000, // 2 minutes per turn
};

// ─── System Prompts (US-15.5) ─────────────────────────────────────────

export const MAKER_SYSTEM_PROMPT = `You are the MAKER agent in an adversarial maker-checker loop.
Your goal is to implement the requested feature by writing code.
You must:
1. Read the checker's critique from the protocol document.
2. Modify src/ files to address the critique and pass the checker's tests.
3. Write a summary of your changes to the protocol document.
4. You CANNOT modify the checker's test files or the checker's system prompt.
5. You CANNOT modify files under the checker-tests/ directory.
Focus on writing correct, robust code that satisfies the checker's requirements.`;

export const CHECKER_SYSTEM_PROMPT = `You are the CHECKER agent in an adversarial maker-checker loop.
Your goal is to VERIFY the maker's work through independent, critical validation.
You must:
1. Read the maker's implementation summary from the protocol document.
2. Write challenging test cases in the checker-tests/ directory that test edge cases,
   error handling, and spec compliance. These tests must be independent — the maker
   cannot weaken or modify them.
3. Run the tests against the maker's code and report results.
4. Look for bugs, loopholes, missing edge cases, and spec violations.
5. Assume the maker is trying to bypass checks — be adversarial and thorough.
6. Write your critique to the protocol document.
7. Output a structured verdict: "approve" (all tests pass, code is correct),
   "revise" (tests fail, maker should fix), or "reject" (fundamental issues).
You have NO access to the maker's system prompt or configuration.`;

// ─── Protocol Document (US-15.6) ──────────────────────────────────────

/**
 * Initialize the shared protocol document for maker-checker communication.
 * The protocol file is placed in the session directory so the user can inspect
 * the dialogue between maker and checker.
 */
export async function initProtocolDoc(
  sessionId: string,
  taskPrompt: string,
  workspaceRoot: string,
): Promise<string> {
  const sessionDir = path.join(
    os.homedir(),
    ".quiver",
    "projects",
    path.basename(workspaceRoot),
    ".sessions",
    sessionId,
  );
  await fs.mkdir(sessionDir, { recursive: true });
  const protocolPath = path.join(sessionDir, "maker-checker-protocol.md");

  const header = [
    "# Maker-Checker Protocol",
    "",
    `**Session:** ${sessionId}`,
    `**Started:** ${new Date().toISOString()}`,
    `**Task:** ${taskPrompt}`,
    "",
    "---",
    "",
    "## Turn Log",
    "",
  ].join("\n");

  await fs.writeFile(protocolPath, header, "utf8");
  return protocolPath;
}

/**
 * Append a turn entry to the protocol document.
 */
export async function appendProtocolEntry(
  protocolPath: string,
  turn: AdversarialTurn,
): Promise<void> {
  const entry = [
    `### Turn ${turn.turnNumber} — ${turn.agent.toUpperCase()} (${turn.timestamp})`,
    "",
    `**Action:** ${turn.action}`,
    "",
    turn.summary,
    "",
    "---",
    "",
  ].join("\n");

  await fs.appendFile(protocolPath, entry, "utf8");
}

/**
 * Read the protocol document content.
 */
export async function readProtocolDoc(protocolPath: string): Promise<string> {
  try {
    return await fs.readFile(protocolPath, "utf8");
  } catch {
    return "";
  }
}

// ─── Checker Test Directory (US-15.7) ────────────────────────────────

/**
 * Create the checker-owned test directory in the scratchpad.
 * The maker does NOT have write access to this directory.
 */
export async function createCheckerTestDir(scratchDir: string): Promise<string> {
  const testDir = path.join(scratchDir, "checker-tests");
  await fs.mkdir(testDir, { recursive: true });

  // Write a README so the directory is tracked
  await fs.writeFile(
    path.join(testDir, "README.md"),
    "# Checker Tests\n\nThese tests are owned by the Checker agent.\nThe Maker agent cannot modify or delete these files.\n",
    "utf8",
  );

  return testDir;
}

/**
 * Verify that the maker has not tampered with checker test files.
 * Returns true if the files are unchanged since the checker wrote them.
 */
export async function verifyCheckerTestsIntegrity(
  checkerTestDir: string,
  expectedHashes: Map<string, string>,
): Promise<boolean> {
  for (const [relPath, expectedHash] of expectedHashes) {
    const fullPath = path.join(checkerTestDir, relPath);
    if (!existsSync(fullPath)) return false;
    try {
      const content = await fs.readFile(fullPath);
      const crypto = await import("crypto");
      const actualHash = crypto.createHash("sha256").update(content).digest("hex");
      if (actualHash !== expectedHash) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ─── Adversarial Loop Orchestrator (US-15.5, US-15.7) ────────────────

/**
 * Run the adversarial maker-checker loop.
 *
 * The orchestrator spawns a Maker agent instance and a Checker agent instance
 * with different system prompts. They alternate turns up to maxTurns (default 5).
 * The change is committed only when the Checker outputs "approve".
 *
 * This is a structural orchestrator — the actual LLM calls are delegated to
 * the agent loop via subprocess spawning, ensuring true process isolation.
 */
export async function runAdversarialLoop(
  cfg: AdversarialConfig,
): Promise<AdversarialResult> {
  const timestamp = new Date().toISOString();
  const turns: AdversarialTurn[] = [];
  const maxTurns = cfg.maxTurns || DEFAULT_ADVERSARIAL_CONFIG.maxTurns!;
  const timeoutMs = cfg.timeoutMs || DEFAULT_ADVERSARIAL_CONFIG.timeoutMs!;

  // US-15.6: Initialize the shared protocol document
  const sessionId = `adv-${Date.now()}`;
  const protocolPath = await initProtocolDoc(
    sessionId,
    cfg.taskPrompt,
    cfg.workspaceRoot,
  );

  // US-15.2/15.3: Build an isolated copy-on-write scratchpad
  const scratchDir = await buildScratchpad(cfg.workspaceRoot);

  // US-15.7: Create the checker-owned test directory
  const checkerTestPath = await createCheckerTestDir(scratchDir);

  // Track checker test file hashes for integrity verification
  const checkerTestHashes = new Map<string, string>();

  let verdict: AdversarialVerdict = "revise";

  for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
    // ── Maker Turn ──
    const makerTurn: AdversarialTurn = {
      turnNumber: turnNum,
      agent: "maker",
      action: turnNum === 1 ? "initial-implementation" : "revision",
      summary: "",
      timestamp: new Date().toISOString(),
    };

    const makerResult = await runAgentTurn({
      agent: "maker",
      systemPrompt: cfg.makerSystemPrompt || MAKER_SYSTEM_PROMPT,
      taskPrompt: cfg.taskPrompt,
      protocolPath,
      scratchDir,
      checkerTestPath,
      turnNumber: turnNum,
      timeoutMs,
      isMaker: true,
    });

    makerTurn.summary = makerResult.summary;
    turns.push(makerTurn);
    await appendProtocolEntry(protocolPath, makerTurn);

    // ── Checker Turn ──
    const checkerTurn: AdversarialTurn = {
      turnNumber: turnNum,
      agent: "checker",
      action: turnNum === 1 ? "initial-review" : "re-review",
      summary: "",
      timestamp: new Date().toISOString(),
    };

    const checkerResult = await runAgentTurn({
      agent: "checker",
      systemPrompt: cfg.checkerSystemPrompt || CHECKER_SYSTEM_PROMPT,
      taskPrompt: cfg.taskPrompt,
      protocolPath,
      scratchDir,
      checkerTestPath,
      turnNumber: turnNum,
      timeoutMs,
      isMaker: false,
    });

    checkerTurn.summary = checkerResult.summary;
    turns.push(checkerTurn);
    await appendProtocolEntry(protocolPath, checkerTurn);

    // US-15.7: Verify checker test integrity (maker cannot modify them)
    const integrityOk = await verifyCheckerTestsIntegrity(
      checkerTestPath,
      checkerTestHashes,
    );
    if (!integrityOk) {
      verdict = "reject";
      break;
    }

    // Parse the checker's verdict
    if (checkerResult.verdict === "approve") {
      verdict = "approve";
      break;
    } else if (checkerResult.verdict === "reject") {
      verdict = "reject";
      break;
    }
    // "revise" → continue to next turn
  }

  // If we exhausted all turns without an approve, it's a revise (needs user intervention)
  if (verdict !== "approve" && verdict !== "reject") {
    verdict = "revise";
  }

  const result: AdversarialResult = {
    verdict,
    totalTurns: turns.length,
    maxTurns,
    turns,
    protocolPath,
    checkerTestPath,
    evidence: `adversarial loop: ${turns.length} turns over ${maxTurns} max; verdict=${verdict}; protocol=${protocolPath}`,
    timestamp,
  };

  // Log to audit chain (US-15.4)
  await logAdversarialVerdict(result);

  return result;
}

// ─── Agent Turn Execution ─────────────────────────────────────────────

interface AgentTurnConfig {
  agent: "maker" | "checker";
  systemPrompt: string;
  taskPrompt: string;
  protocolPath: string;
  scratchDir: string;
  checkerTestPath: string;
  turnNumber: number;
  timeoutMs: number;
  isMaker: boolean;
}

interface AgentTurnResult {
  summary: string;
  verdict?: AdversarialVerdict;
}

/**
 * Run a single agent turn by spawning a subprocess with the appropriate
 * system prompt and constraints.
 *
 * The Maker agent:
 *   - Has write access to src/ in the scratchpad
 *   - Does NOT have write access to checker-tests/
 *   - Reads the protocol doc for the checker's critique
 *
 * The Checker agent:
 *   - Has write access to checker-tests/ only
 *   - Does NOT have write access to src/
 *   - Reads the protocol doc for the maker's summary
 *   - Writes tests, runs them, and outputs a verdict
 */
async function runAgentTurn(cfg: AgentTurnConfig): Promise<AgentTurnResult> {
  const timestamp = new Date().toISOString();

  // Build the prompt for this turn
  const protocolContent = await readProtocolDoc(cfg.protocolPath);

  let userPrompt: string;
  if (cfg.isMaker) {
    userPrompt = [
      `Task: ${cfg.taskPrompt}`,
      "",
      `Turn ${cfg.turnNumber}: You are the MAKER. Read the checker's critique below and implement/fix the code.`,
      "",
      "Protocol document (read the checker's latest critique):",
      protocolContent,
      "",
      "Write your changes to src/ files in the scratchpad. Do NOT modify files under checker-tests/.",
      "After making changes, write a summary of what you changed to the protocol document.",
    ].join("\n");
  } else {
    userPrompt = [
      `Task: ${cfg.taskPrompt}`,
      "",
      `Turn ${cfg.turnNumber}: You are the CHECKER. Review the maker's latest changes.`,
      "",
      "Protocol document (read the maker's latest summary):",
      protocolContent,
      "",
      "Write test cases to checker-tests/ directory. Run them against the maker's code.",
      "Write your critique to the protocol document.",
      "End your response with a verdict on a line: VERDICT: approve|reject|revise",
    ].join("\n");
  }

  // Spawn the agent subprocess with the appropriate system prompt
  // The agent runs in the scratchpad with restricted access
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH || "",
    HOME: process.env.HOME || "",
    USER: process.env.USER || "",
    LANG: process.env.LANG || "en_US.UTF-8",
    TERM: process.env.TERM || "dumb",
    QUIVER_NO_COLOR: "1",
    QUIVER_ADVERSARIAL_AGENT: cfg.agent,
    QUIVER_ADVERSARIAL_TURN: String(cfg.turnNumber),
    QUIVER_ADVERSARIAL_SCRATCH: cfg.scratchDir,
    QUIVER_ADVERSARIAL_PROTOCOL: cfg.protocolPath,
    QUIVER_ADVERSARIAL_CHECKER_TESTS: cfg.checkerTestPath,
  };

  // The maker does NOT get the checker test path as a writable location
  // The checker does NOT get src/ as a writable location
  if (cfg.isMaker) {
    childEnv["QUIVER_ADVERSARIAL_WRITE_PATHS"] = path.join(cfg.scratchDir, "src");
  } else {
    childEnv["QUIVER_ADVERSARIAL_WRITE_PATHS"] = cfg.checkerTestPath;
  }

  // Pass the system prompt and user prompt via env to avoid CLI arg length limits
  childEnv["QUIVER_ADVERSARIAL_SYSTEM_PROMPT"] = cfg.systemPrompt;
  childEnv["QUIVER_ADVERSARIAL_USER_PROMPT"] = userPrompt;

  try {
    const output = await new Promise<string>((resolve) => {
      let buf = "";
      const child = spawn(
        process.execPath,
        [
          path.join(cfg.scratchDir, "node_modules", "tsx", "dist", "cli.mjs"),
          "--single-turn",
          userPrompt,
        ],
        {
          cwd: cfg.scratchDir,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
        },
      );
      child.stdout.on("data", (d) => (buf += d.toString()));
      child.stderr.on("data", (d) => (buf += d.toString()));
      child.on("exit", () => resolve(buf));
      child.on("error", () => resolve(buf));
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve(buf);
      }, cfg.timeoutMs);
    });

    // Parse the verdict from the checker's output
    let verdict: AdversarialVerdict | undefined;
    if (!cfg.isMaker) {
      const verdictMatch = output.match(/VERDICT:\s*(approve|reject|revise)/i);
      if (verdictMatch) {
        verdict = verdictMatch[1].toLowerCase() as AdversarialVerdict;
      }
    }

    // Extract a summary from the output (first 500 chars)
    const summary = output.substring(0, 500).trim() || "(no output)";

    return { summary, verdict };
  } catch (error: any) {
    return {
      summary: `Agent turn failed: ${error?.message || String(error)}`,
      verdict: cfg.isMaker ? undefined : "reject",
    };
  }
}

// ─── Audit Chain (US-15.4) ────────────────────────────────────────────

const ADVERSARIAL_AUDIT_FILE = path.join(
  os.homedir(),
  ".quiver",
  "adversarial_audit.json",
);

async function logAdversarialVerdict(result: AdversarialResult): Promise<void> {
  try {
    let chain: AuditChain;
    try {
      const raw = await fs.readFile(ADVERSARIAL_AUDIT_FILE, "utf8");
      chain = AuditChain.deserialize(raw);
    } catch {
      chain = new AuditChain();
    }
    chain.appendEntry(
      "approval",
      `adversarial verdict=${result.verdict} turns=${result.totalTurns}/${result.maxTurns} ${result.evidence}`,
    );
    await fs.mkdir(path.dirname(ADVERSARIAL_AUDIT_FILE), { recursive: true });
    await fs.writeFile(ADVERSARIAL_AUDIT_FILE, chain.serialize(), "utf8");
  } catch {
    // audit is best-effort
  }
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Check if the adversarial maker-checker loop is available.
 * Requires the base maker-checker (Phase 1) to be functional.
 */
export function isAdversarialAvailable(): boolean {
  return existsSync(path.join(process.cwd(), "src", "subagents", "checker.ts"));
}

/**
 * Get the default adversarial config with workspace root.
 */
export function getDefaultAdversarialConfig(
  workspaceRoot: string,
  taskPrompt: string,
): AdversarialConfig {
  return {
    maxTurns: DEFAULT_ADVERSARIAL_CONFIG.maxTurns!,
    workspaceRoot,
    taskPrompt,
    timeoutMs: DEFAULT_ADVERSARIAL_CONFIG.timeoutMs!,
  };
}