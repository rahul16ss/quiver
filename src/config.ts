import dotenv from "dotenv";
import * as fs from "fs";
// Load .env but do NOT override env vars already set by the parent process
// (e.g. the GUI agent-bridge sets LLM_API_BASE_URL to the fake model for QA,
// or a user may pre-export a different endpoint). Without override:false,
// dotenv silently replaces the parent-provided value with the .env file's
// value (which may be empty for local-only / OpenRouter configs).
//
// Try CWD first (the CLI's workspace), then walk up to find a repo .env
// (for the Electron main process whose CWD is the workspace, not the repo,
// and for tsx where __dirname is CWD not the source file location).
dotenv.config({ override: false });
try {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate, override: false });
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
} catch {
  // Non-critical — CWD .env is the primary source.
}
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import picocolors from "picocolors";
import { resolveSecretSync } from "./secrets/keychain.js";

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

function parseFiniteEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalFiniteEnvNumber(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFiniteEnvInteger(name: string, fallback: number): number {
  return Math.trunc(parseFiniteEnvNumber(name, fallback));
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

/** Read-only inspection tools — auto-approved; path policy still applies. */
const READ_ONLY_TOOLS = new Set([
  "view_file",
  "list_dir",
  "glob",
  "grep_search",
  "pdf_read",
  "find_all",
]);

/** Check if the agent should prompt for approval before a tool call. */
export function needsApprovalFor(
  toolName: string,
  commandRisk?: string,
): boolean {
  if (hasGrant("yolo")) return false;

  // Observe+ promise: workspace reads without a prompt. Writes/commands/web
  // still gate. Path sandbox / readScope remain the hard boundary.
  if (READ_ONLY_TOOLS.has(toolName)) return false;

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

  // Everything else (subagent, continual_learning, office_doc, etc.)
  // defaults to requiring approval unless YOLO.
  return true;
}

const _parsedAutonomy = parseAutonomy();

export const config: Config = {
  llmBaseUrl: process.env.LLM_API_BASE_URL || "",
  llmModelName: process.env.LLM_MODEL_NAME || "",
  llmApiKey: resolveSecretSync("LLM_API_KEY"),
  // Sampling parameters (configurable per deployment via .env).
  // These are passed to every model call; models that don't support a
  // parameter silently ignore it (OpenAI-compatible behavior).
  temperature: parseFiniteEnvNumber("LLM_TEMPERATURE", 0.7),
  topP: parseOptionalFiniteEnvNumber("LLM_TOP_P"),
  topK: parseOptionalFiniteEnvNumber("LLM_TOP_K"),
  reasoningEffort: process.env.LLM_REASONING_EFFORT || undefined,
  // Checker model (optional): when set, the checker subagent uses a
  // different model than the maker. Falls back to the primary LLM model.
  checkerModelName: process.env.CHECKER_LLM_MODEL_NAME || "",
  checkerBaseUrl: process.env.CHECKER_LLM_API_BASE_URL || "",
  // Local model endpoint (US-17.17 / SPEC §4.3 high-sensitivity escape hatch).
  // Point LLM_API_BASE_URL at any OpenAI-compatible local server (vLLM,
  // llama.cpp, LM Studio, etc.) for air-gapped / MNPI work.
  localLlmBaseUrl: process.env.QUIVER_LOCAL_LLM_API_BASE_URL || "",
  localLlmModelName: process.env.QUIVER_LOCAL_LLM_MODEL_NAME || "",
  parallelApiKey: resolveSecretSync("PARALLEL_API_KEY"),
  // ── OpenRouter — the sole cloud model gateway (ADR-001). When set, the
  // harness QuiverOpenRouterProvider enforces ZDR/data_collection=deny/
  // require_parameters/no-fallback on every cloud request. The legacy
  // OpenAI-compatible path remains for local/private endpoints; the final
  // getActiveProvider() flip is gated on spec updates.
  openRouterApiKey: resolveSecretSync("OPENROUTER_API_KEY"),
  openRouterModelProfile: process.env.OPENROUTER_MODEL_PROFILE || "",
  browserHeadless: !_parsedAutonomy.has("browser:visible"),
  autonomyGrants: _parsedAutonomy,
  maxContextTokens: parseFiniteEnvInteger("QUIVER_MAX_CONTEXT_TOKENS", 120000),
  outputMode: parseOutputMode(),
  sessionLogEnabled: process.env.QUIVER_SESSION_LOG !== "0",
  sessionLogMaxChars: parseFiniteEnvInteger(
    "QUIVER_SESSION_LOG_MAX_CHARS",
    512,
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
  ambientMaxHealRounds: parseFiniteEnvInteger(
    "QUIVER_AMBIENT_MAX_ROUNDS",
    5,
  ),
  // Ambient log retention (US-AMBIENT): old session logs are auto-purged once
  // per session startup so non-technical users never manage log disk usage.
  // Default 30 days; 0 = keep forever. Set via QUIVER_LOG_RETENTION_DAYS.
  logRetentionDays: parseFiniteEnvInteger(
    "QUIVER_LOG_RETENTION_DAYS",
    30,
  ),
  // Finance-client profiles require a structurally valid evidence companion
  // before an Office deliverable can be marked final. Other deployments may
  // explicitly opt out while they are still prototyping.
  evidenceRequired: process.env.QUIVER_EVIDENCE_REQUIRED !== "0",
  // ── Consent gate (SPEC §6 — "a gate, not a post-hoc log") ──
  // The finance-client profile defaults to an explicit pre-action approval.
  // Other profiles can opt in, while QUIVER_CONSENT_GATE=0 remains an explicit
  // opt-out for controlled development/testing environments.
  consentGateEnabled:
    process.env.QUIVER_CONSENT_GATE === "1" ||
    (process.env.QUIVER_PROFILE === "finance-client" &&
      process.env.QUIVER_CONSENT_GATE !== "0"),
};

// Apply the env-specified trust tier AFTER config is fully initialized
// (applyTrustTier references `config`, which is not yet defined at parse time).
if (_envTier) applyTrustTier(_envTier);

// Config shape is declared after the config object so the source-controlled
// value assignments below are the first textual occurrence of each key —
// the product is env-driven (US-1.3 revision 2026-07-28): no model name,
// base URL, or API key is baked in; the single LLM_API_KEY powers the LLM
// and vision adapters.
export interface Config {
  llmBaseUrl: string;
  llmModelName: string;
  llmApiKey: string;
  // Sampling parameters (configurable via .env).
  temperature: number;
  topP?: number;
  topK?: number;
  reasoningEffort?: string;
  // Checker model (optional different model for the checker).
  checkerModelName: string;
  checkerBaseUrl: string;
  // Local model endpoint (US-17.17 high-sensitivity escape hatch).
  localLlmBaseUrl: string;
  localLlmModelName: string;
  parallelApiKey: string;
  /** OpenRouter API key (sole cloud gateway, ADR-001). Empty = not configured. */
  openRouterApiKey: string;
  /** Certified ModelProfile slug to use for OpenRouter cloud requests. */
  openRouterModelProfile: string;
  browserHeadless: boolean;
  autonomyGrants: Set<AutonomyGrant>;
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
  // Require valid Evidence.json for Office deliverable finalization.
  evidenceRequired: boolean;
  // Consent gate (SPEC §6). When true the agent blocks on a pre-action
  // approval before each model call.
  consentGateEnabled: boolean;
}

export function redactSecret(value: string): string {
  if (!value) return "—";
  return `✓ (set, ${value.length} chars)`;
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
 * forward immediately — never a static "run quiver init" dead-end. The model
 * name and base URL come from .env (provider-agnostic, US-1.3 revision
 * 2026-07-28), so onboarding never asks for a model name — only the API key.
 */
export async function runOnboardingHandshake(): Promise<void> {
  const { askQuestion } = await import("./utils/prompt.js");
  const ask = (q: string) => askQuestion(q);

  console.log(
    picocolors.cyan("\n  Welcome to Quiver! Let's get you set up.\n"),
  );
  console.log(
    picocolors.gray(
      "  Quiver uses OpenRouter as the sole cloud model gateway (set OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE), or a local/private endpoint via LLM_API_BASE_URL for the high-sensitivity escape hatch.\n",
    ),
  );
  console.log(
    picocolors.gray(
      "  A single LLM_API_KEY powers the LLM and vision adapters.\n",
    ),
  );
  console.log(
    picocolors.yellow(
      "  If your endpoint is remote, prompts and files you submit may leave this machine and be processed by that provider. Use a local endpoint or your firm's approved provider for sensitive work.\n",
    ),
  );

  const key = await ask(
    picocolors.cyan(
      "  Enter your LLM API key (or press Enter to skip and configure .env later): ",
    ),
  );
  if (key) {
    try {
      // US-1.3: try the OS keychain first; fall back to .env with a warning
      // that it is a plaintext fallback (not as secure as the keychain).
      const { setCredential, isKeychainAvailable } =
        await import("./secrets/keychain.js");
      const keychainOk =
        isKeychainAvailable() && (await setCredential("LLM_API_KEY", key));
      if (keychainOk) {
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
        await fs.writeFile(envPath, `LLM_API_KEY=${key}\n`, { mode: 0o600 });
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
          "\n    Could not save API key — add LLM_API_KEY manually later.\n",
        ),
      );
    }
  } else {
    console.log(
      picocolors.gray(
        "\n  No problem — add LLM_API_KEY to .env when ready, then run quiver again.\n",
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
      v(config.maxContextTokens.toLocaleString("en-US")) +
      c(" ctx"),
  );
}

export interface RuntimeConfigPreflight {
  valid: boolean;
  errors: string[];
  warnings: string[];
  remoteEndpoint: boolean;
}

/**
 * Validate the minimum configuration required to make a model call.
 *
 * This is intentionally a preflight, not a provider connectivity test: it
 * catches missing or malformed configuration without sending user data. A
 * remote endpoint requires an API key; local endpoints may authenticate
 * through the local service itself. Cloud inference goes through OpenRouter
 * (OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE).
 */
export function validateRuntimeConfig(): RuntimeConfigPreflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  const endpoint = config.llmBaseUrl.trim();
  const hasOpenRouter = Boolean(
    config.openRouterApiKey && config.openRouterModelProfile,
  );
  let remoteEndpoint = true;

  if (!endpoint) {
    if (!hasOpenRouter) {
      errors.push(
        "LLM_API_BASE_URL is not configured (point at a local OpenAI-compatible endpoint, or set OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE for cloud inference).",
      );
    } else {
      // OpenRouter (cloud) is configured — no local endpoint needed.
      remoteEndpoint = false;
    }
  } else {
    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        errors.push("LLM_API_BASE_URL must use http:// or https://.");
      }
      remoteEndpoint = !["localhost", "127.0.0.1", "::1"].includes(
        parsed.hostname.toLowerCase(),
      );
    } catch {
      errors.push("LLM_API_BASE_URL is not a valid URL.");
    }
  }

  if (!config.llmModelName.trim() && !hasOpenRouter) {
    errors.push("LLM_MODEL_NAME is not configured.");
  }

  if (remoteEndpoint && !config.llmApiKey.trim() && !hasOpenRouter) {
    errors.push(
      "LLM_API_KEY is required for a remote endpoint (store it in the OS keychain or .env).",
    );
  }
  if (
    (config.checkerModelName &&
      !config.checkerBaseUrl &&
      !config.llmBaseUrl) ||
    (!config.checkerModelName && config.checkerBaseUrl)
  ) {
    warnings.push(
      "Checker model settings are incomplete; set CHECKER_LLM_API_BASE_URL, or Quiver will use the maker endpoint when possible.",
    );
  }

  return { valid: errors.length === 0, errors, warnings, remoteEndpoint };
}
