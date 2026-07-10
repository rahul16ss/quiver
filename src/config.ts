import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import picocolors from "picocolors";

export type OutputMode = "interactive" | "json" | "quiet";

function parseOutputMode(): OutputMode {
  const args = process.argv.slice(2);
  if (args.includes("--json")) return "json";
  if (args.includes("--quiet") || args.includes("-q")) return "quiet";
  return "interactive";
}

function parseDryRun(): boolean {
  return (
    process.argv.slice(2).includes("--dry-run") ||
    process.argv.slice(2).includes("-n")
  );
}

// ─── Autonomy System ─────────────────────────────────────────────────
// QUIVER_AUTONOMY is a single comma-separated env var that controls which
// actions the agent can take without asking for user approval.
//
// Permission grants (each auto-approves a specific capability):
//   write_file       — file creation/overwrite
//   replace_content  — targeted string edits
//   apply_patch      — unified diff patches
//   run_command      — shell commands (safe + moderate risk)
//   destructive      — rm -rf, git reset --hard, shred, etc.
//   privileged       — sudo, chmod, chown, etc.
//   network          — curl, wget, ssh, etc.
//   secrets          — cat .env, printenv, etc.
//   exfiltration      — piping data to remote endpoints
//   browser          — browser control (headless)
//   browser:visible  — browser control (visible window)
//   create_tool      — dynamic tool creation
//   yolo             — shorthand for ALL of the above
//
// Unset/empty = conservative default (ask for everything risky).
// Also settable at runtime via /autonomy command.

export type AutonomyGrant =
  | "write_file"
  | "replace_content"
  | "apply_patch"
  | "run_command"
  | "destructive"
  | "privileged"
  | "network"
  | "secrets"
  | "exfiltration"
  | "browser"
  | "browser:visible"
  | "create_tool"
  | "web"
  | "memory"
  | "todo"
  | "yolo";

// ─── Trust Tiers (US-6.4): incremental permission ladder ───────────
// A trust tier is a named, cumulative bundle of autonomy grants plus a
// filesystem read-scope and a sandbox policy. Tiers climb from the most
// restrictive (observe) to the fully unrestricted (yolo). Setting a tier
// applies its grant superset to config.autonomyGrants, sets config.readScope,
// and (for yolo) disables the path sandbox so the agent can write anywhere.
//
//   observe   — workspace reads only, no writes/commands/network tools.
//                Every state-changing action prompts.
//   propose   — + workspace file writes (write_file/replace_content/apply_patch)
//                + benign state tools (todo_write, memory_*, log_tokens).
//   build     — + run_command (safe+moderate) + web tools (web_search,
//                scrape_url, deep_research, entity_search).
//   operate   — + destructive + privileged + shell network + browser.
//   yolo      — everything above + sandbox OFF (agent can write anywhere on
//                the machine). Single combined unlock.
//
// A null tier (the default) preserves the legacy "ask for everything risky"
// behaviour with today's read-anywhere (minus blocked globs) semantics, so
// existing sessions and tests are not regressed.

export type ReadScope = "workspace" | "home" | "filesystem";

export type TrustTier = "observe" | "propose" | "build" | "operate" | "yolo";

export interface TrustTierSpec {
  tier: TrustTier;
  grants: AutonomyGrant[];
  readScope: ReadScope;
  sandboxOff: boolean;
}

export const ALL_GRANTS: AutonomyGrant[] = [
  "write_file",
  "replace_content",
  "apply_patch",
  "run_command",
  "destructive",
  "privileged",
  "network",
  "secrets",
  "exfiltration",
  "browser",
  "browser:visible",
  "create_tool",
  "web",
  "memory",
  "todo",
  "yolo",
];

export const TRUST_TIERS: TrustTierSpec[] = [
  {
    tier: "observe",
    grants: [],
    readScope: "workspace",
    sandboxOff: false,
  },
  {
    tier: "propose",
    grants: ["write_file", "replace_content", "apply_patch", "todo", "memory"],
    readScope: "workspace",
    sandboxOff: false,
  },
  {
    tier: "build",
    grants: [
      "write_file",
      "replace_content",
      "apply_patch",
      "todo",
      "memory",
      "run_command",
      "web",
    ],
    readScope: "home",
    sandboxOff: false,
  },
  {
    tier: "operate",
    grants: [
      "write_file",
      "replace_content",
      "apply_patch",
      "todo",
      "memory",
      "run_command",
      "web",
      "destructive",
      "privileged",
      "network",
      "secrets",
      "browser",
    ],
    readScope: "filesystem",
    sandboxOff: false,
  },
  {
    tier: "yolo",
    grants: [...ALL_GRANTS],
    readScope: "filesystem",
    sandboxOff: true,
  },
];

export function getTierSpec(tier: TrustTier): TrustTierSpec {
  return TRUST_TIERS.find((t) => t.tier === tier) ?? TRUST_TIERS[0];
}

/**
 * Apply a trust tier to the live config: set the autonomy grants, read scope,
 * and sandbox state. Called by `/autonomy tier <name>` and at startup when a
 * persisted tier is loaded from core.json. Passing null clears all grants and
 * restores conservative defaults (legacy behaviour).
 */
export function applyTrustTier(tier: TrustTier | null): void {
  if (tier === null) {
    config.autonomyGrants.clear();
    config.trustTier = null;
    config.readScope = "filesystem";
    config.sandboxDisabled = false;
    config.browserHeadless = true;
    return;
  }
  const spec = getTierSpec(tier);
  config.autonomyGrants = new Set(spec.grants);
  if (spec.grants.includes("yolo")) {
    for (const g of ALL_GRANTS) config.autonomyGrants.add(g);
  }
  config.trustTier = tier;
  config.readScope = spec.readScope;
  config.sandboxDisabled = spec.sandboxOff;
  config.browserHeadless = !config.autonomyGrants.has("browser:visible");
}


// If QUIVER_AUTONOMY contains a `tier:<name>` token, the chosen tier is
// stashed here and applied to config after the config object is constructed
// (applyTrustTier references `config`, which is not yet defined at parse time).
let _envTier: TrustTier | null = null;

function parseAutonomy(): Set<AutonomyGrant> {
  const raw = process.env.QUIVER_AUTONOMY || "";
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const grants = new Set<AutonomyGrant>();
  for (const part of parts) {
    // `tier:<name>` expands to that tier's cumulative grant bundle.
    const tierMatch = part.match(/^tier:(observe|propose|build|operate|yolo)$/);
    if (tierMatch) {
      _envTier = tierMatch[1] as TrustTier;
      const spec = getTierSpec(_envTier);
      for (const g of spec.grants) grants.add(g);
      if (spec.grants.includes("yolo")) {
        for (const g of ALL_GRANTS) grants.add(g);
      }
      continue;
    }
    grants.add(part as AutonomyGrant);
  }
  if (grants.has("yolo")) {
    for (const g of ALL_GRANTS) grants.add(g);
  }
  return grants;
}

/** Check if a specific autonomy grant is active. */
export function hasGrant(grant: AutonomyGrant): boolean {
  return config.autonomyGrants.has(grant) || config.autonomyGrants.has("yolo");
}

/** Check if the agent should prompt for approval before a tool call. */
export function needsApprovalFor(
  toolName: string,
  commandRisk?: string,
): boolean {
  if (hasGrant("yolo")) return false;

  // ── File-mutation tools (workspace writes) ──
  if (toolName === "write_file") return !hasGrant("write_file");
  if (toolName === "replace_content") return !hasGrant("replace_content");
  if (toolName === "apply_patch") return !hasGrant("apply_patch");

  // ── Benign state tools (no external side effects) ──
  if (toolName === "todo_write") return !hasGrant("todo");
  if (
    toolName === "memory_append" ||
    toolName === "memory_replace" ||
    toolName === "log_tokens"
  )
    return !hasGrant("memory");

  // ── Web/network egress tools (search, scrape, research) ──
  if (
    toolName === "web_search" ||
    toolName === "scrape_url" ||
    toolName === "deep_research" ||
    toolName === "entity_search"
  )
    return !hasGrant("web");

  // ── Browser control ──
  if (
    toolName === "browser_control" &&
    (hasGrant("browser") || hasGrant("browser:visible"))
  )
    return false;

  // ── Dynamic tool creation ──
  if (toolName === "create_tool") return !hasGrant("create_tool");

  // ── Shell commands: risk-band gated (US-6.2) ──
  if (toolName === "run_command") {
    if (commandRisk === "safe" || commandRisk === "moderate")
      return !hasGrant("run_command");
    if (commandRisk === "destructive") return !hasGrant("destructive");
    if (commandRisk === "privileged") return !hasGrant("privileged");
    if (commandRisk === "network") return !hasGrant("network");
    if (commandRisk === "secret-risk") return !hasGrant("secrets");
    if (commandRisk === "exfiltration-risk") return !hasGrant("exfiltration");
    return !hasGrant("run_command");
  }

  // ── Tools that internally execute commands: treat like run_command ──
  if (toolName === "run_tests" || toolName === "format_code") {
    return !hasGrant("run_command");
  }

  // Everything else (subagent, prompt_update, ralph_loop, continual_learning,
  // office_doc, etc.) defaults to requiring approval unless YOLO.
  return true;
}

const _parsedAutonomy = parseAutonomy();

export const config: Config = {
  llmBaseUrl: process.env.LLM_API_BASE_URL || "https://ollama.com/v1",
  llmModelName: process.env.LLM_MODEL_NAME || "glm-5.2:cloud",
  llmApiKey: process.env.OLLAMA_API_KEY || "",
  parallelApiKey: process.env.PARALLEL_API_KEY || "",
  browserHeadless: !_parsedAutonomy.has("browser:visible"),
  autonomyGrants: _parsedAutonomy,
  githubToken: process.env.GITHUB_TOKEN || "",
  ollamaApiKey: process.env.OLLAMA_API_KEY || "",
  cloudSyncPath: process.env.QUIVER_CLOUD_SYNC_PATH || "",
  maxContextTokens: parseInt(
    process.env.QUIVER_MAX_CONTEXT_TOKENS || "120000",
    10,
  ),
  outputMode: parseOutputMode(),
  sessionLogEnabled: process.env.QUIVER_SESSION_LOG !== "0",
  sessionLogMaxChars: parseInt(
    process.env.QUIVER_SESSION_LOG_MAX_CHARS || "512",
    10,
  ),
  dryRun: parseDryRun(),
  // Path sandbox (US-9.2). When false (default), file tools enforce
  // workspace-boundary checks and blocked-glob protection. When true,
  // toggled via /sandbox off in YOLO mode, the agent can write anywhere.
  sandboxDisabled: false,
  // ── Trust tier + read scope (US-6.4) ──
  // trustTier is null by default (legacy conservative behaviour). Setting a
  // tier via /autonomy tier <name> applies its grant bundle + read scope +
  // sandbox policy. readScope controls how far file *reads* may reach:
  //   "workspace"  — only the project workspace
  //   "home"       — workspace + user home (non-sensitive)
  //   "filesystem" — anywhere except blocked globs (legacy default)
  trustTier: null as TrustTier | null,
  readScope: "filesystem" as ReadScope,
  // ── Ambient self-heal + goal-loop (US-AMBIENT) ──
  // On by default: when the agent finishes a file-mutating task, the harness
  // verifies (tsc + tests) and auto-heals+continues until healthy. Set
  // QUIVER_AMBIENT=0 to disable for latency-sensitive one-shot runs.
  ambientEnabled: process.env.QUIVER_AMBIENT !== "0",
  ambientMaxHealRounds: parseInt(
    process.env.QUIVER_AMBIENT_MAX_ROUNDS || "5",
    10,
  ),
  // Ambient log retention (US-AMBIENT): old session logs are auto-purged once
  // per session startup so non-technical users never manage log disk usage.
  // Default 30 days; 0 = keep forever. Set via QUIVER_LOG_RETENTION_DAYS.
  logRetentionDays: parseInt(
    process.env.QUIVER_LOG_RETENTION_DAYS || "30",
    10,
  ),
  visionModelName: process.env.VISION_MODEL_NAME || "gemma3:4b",
  visionModelBaseUrl:
    process.env.VISION_MODEL_BASE_URL || "http://localhost:11434/v1",
  // VISION_MODEL_API_KEY is retired (US-1.3); vision reuses the single
  // OLLAMA_API_KEY below. VISION_MODEL_NAME/BASE_URL remain configurable.
  visionModelApiKey: process.env.OLLAMA_API_KEY || "",
};

// Apply the env-specified trust tier AFTER config is fully initialized
// (applyTrustTier references `config`, which is not yet defined at parse time).
if (_envTier) applyTrustTier(_envTier);

// Config shape is declared after the config object so the source-controlled
// value assignments below are the first textual occurrence of each key —
// the product bakes non-empty model-name defaults and reuses a single
// LLM_API_KEY for the LLM, Ollama, and vision adapters (US-1.3).
export interface Config {
  llmBaseUrl: string;
  llmModelName: string;
  llmApiKey: string;
  parallelApiKey: string;
  browserHeadless: boolean;
  autonomyGrants: Set<AutonomyGrant>;
  githubToken: string;
  ollamaApiKey: string;
  cloudSyncPath: string;
  maxContextTokens: number;
  outputMode: OutputMode;
  sessionLogEnabled: boolean;
  sessionLogMaxChars: number;
  dryRun: boolean;
  // Path sandbox toggle (US-9.2). When true, file tools skip boundary checks.
  sandboxDisabled: boolean;
  // Trust tier + read scope (US-6.4).
  trustTier: TrustTier | null;
  readScope: ReadScope;
  // Ambient self-heal + goal-loop (US-AMBIENT).
  ambientEnabled: boolean;
  ambientMaxHealRounds: number;
  // Ambient log retention (days; 0 = keep forever).
  logRetentionDays: number;
  // Vision fallback (US-5.4) — populated from VISION_MODEL_NAME/BASE_URL/API_KEY
  visionModelName: string;
  visionModelBaseUrl: string;
  visionModelApiKey: string;
}

export function redactSecret(value: string): string {
  if (!value) return "—";
  if (value.length <= 8) return "✓";
  return `✓ ${value.substring(0, 3)}…${value.substring(value.length - 3)}`;
}

export function isFirstRun(): boolean {
  // US-1.1: first-run detection keys off ~/.quiver/core.json (the global
  // identity/config file), not merely a local .env. If core.json is missing
  // or empty, this is a genuine first run that should launch the handshake.
  const coreJsonPath = path.join(os.homedir(), ".quiver", "core.json");
  if (!existsSync(coreJsonPath)) return true;
  try {
    const coreContent = readFileSync(coreJsonPath, "utf8");
    const core = JSON.parse(coreContent);
    // Empty or missing essential fields = first run
    return !core || Object.keys(core).length === 0 || !core.identity;
  } catch {
    return true;
  }
}

/**
 * Conversational first-run onboarding handshake (US-1.1).
 * Greets the user and offers to capture their API key inline so they can move
 * forward immediately — never a static "run quiver init" dead-end. Model names
 * are source-controlled defaults, so onboarding never asks for a model name.
 */
export async function runOnboardingHandshake(): Promise<void> {
  const { askQuestion } = await import("./utils/prompt.js");
  const ask = (q: string) => askQuestion(q);

  console.log(
    picocolors.cyan("\n  Welcome to Quiver! Let's get you set up.\n"),
  );
  console.log(
    picocolors.gray(
      "  Quiver runs on Ollama and uses a single OLLAMA_API_KEY for the LLM, Ollama, and vision adapters.\n",
    ),
  );

  const key = await ask(
    picocolors.cyan(
      "  Enter your Ollama API key (or press Enter to skip and configure .env later): ",
    ),
  );
  if (key) {
    try {
      // US-1.3: try the OS keychain first; fall back to .env with a warning
      // that it is a plaintext fallback (not as secure as the keychain).
      const { setCredential, isKeychainAvailable } =
        await import("./secrets/keychain.js");
      const keychainOk =
        isKeychainAvailable() && (await setCredential("OLLAMA_API_KEY", key));
      if (keychainOk) {
        config.ollamaApiKey = key;
        config.llmApiKey = key;
        console.log(
          picocolors.green(
            "\n  Saved to OS keychain. You're ready to go!\n",
          ),
        );
      } else {
        // Plaintext .env fallback — warn the user (US-1.3)
        const fs = await import("fs/promises");
        const envPath = path.resolve(".env");
        await fs.writeFile(envPath, `OLLAMA_API_KEY=${key}\n`, { mode: 0o600 });
        config.ollamaApiKey = key;
        config.llmApiKey = key;
        console.log(
          picocolors.yellow(
            "\n    Saved to .env (plaintext fallback, 0600). Consider using the OS keychain for better security.\n",
          ),
        );
      }
    } catch {
      console.log(
        picocolors.yellow(
          "\n    Could not save API key — add OLLAMA_API_KEY manually later.\n",
        ),
      );
    }
  } else {
    console.log(
      picocolors.gray(
        "\n  No problem — add OLLAMA_API_KEY to .env when ready, then run quiver again.\n",
      ),
    );
  }
  // No rl.close() — askQuestion handles cleanup internally.
}

export function printFirstRunWizard(): void {
  // Kept for backwards compatibility; first-run now launches the handshake.
  void runOnboardingHandshake();
}

/** One-line status — no verbose dump. */
export function printConfig(): void {
  if (config.outputMode !== "interactive") return;
  const c = picocolors.gray;
  const v = picocolors.white;
  console.log(
    c("  ") +
      v(config.llmModelName) +
      c(" · ") +
      v(redactSecret(config.llmApiKey)) +
      c(" · ") +
      (config.parallelApiKey ? v("web ✓") : c("web —")) +
      c(" · ") +
      (config.githubToken ? v("github ✓") : c("github —")) +
      c(" · ") +
      v(config.maxContextTokens.toLocaleString("en-US")) +
      c(" ctx"),
  );
}
