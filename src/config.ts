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
  return process.argv.slice(2).includes("--dry-run") || process.argv.slice(2).includes("-n");
}

const DEFAULT_APPROVALS = "run_command,write_file,replace_content,browser_control,create_tool";

function parseApprovals(): string[] {
  const raw = process.env.REQUIRE_APPROVAL_FOR;
  const source = raw === undefined ? DEFAULT_APPROVALS : raw;
  return source.split(",").map((s) => s.trim()).filter(Boolean);
}

export const config: Config = {
  llmBaseUrl: process.env.LLM_API_BASE_URL || "https://ollama.com/v1",
  llmModelName: process.env.LLM_MODEL_NAME || "glm-5.2:cloud",
  llmApiKey: process.env.OLLAMA_API_KEY || "",
  parallelApiKey: process.env.PARALLEL_API_KEY || "",
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  requireApprovalFor: parseApprovals(),
  githubToken: process.env.GITHUB_TOKEN || "",
  ollamaApiKey: process.env.OLLAMA_API_KEY || "",
  cloudSyncPath: process.env.QUIVER_CLOUD_SYNC_PATH || "",
  maxContextTokens: parseInt(process.env.QUIVER_MAX_CONTEXT_TOKENS || "120000", 10),
  outputMode: parseOutputMode(),
  sessionLogEnabled: process.env.QUIVER_SESSION_LOG !== "0",
  sessionLogMaxChars: parseInt(process.env.QUIVER_SESSION_LOG_MAX_CHARS || "512", 10),
  dryRun: parseDryRun(),
  visionModelName: process.env.VISION_MODEL_NAME || "gemma3:4b",
  visionModelBaseUrl: process.env.VISION_MODEL_BASE_URL || "http://localhost:11434/v1",
  // VISION_MODEL_API_KEY is retired (US-1.3); vision reuses the single
  // OLLAMA_API_KEY below. VISION_MODEL_NAME/BASE_URL remain configurable.
  visionModelApiKey: process.env.OLLAMA_API_KEY || "",
};

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
  requireApprovalFor: string[];
  githubToken: string;
  ollamaApiKey: string;
  cloudSyncPath: string;
  maxContextTokens: number;
  outputMode: OutputMode;
  sessionLogEnabled: boolean;
  sessionLogMaxChars: number;
  dryRun: boolean;
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
  const readline = await import("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, (a) => resolve(a.trim())));

  console.log(picocolors.cyan("\n  ⚡ Welcome to Quiver! Let's get you set up.\n"));
  console.log(picocolors.gray("  Quiver runs on Ollama and uses a single OLLAMA_API_KEY for the LLM, Ollama, and vision adapters.\n"));

  const key = await ask(picocolors.cyan("  Enter your Ollama API key (or press Enter to skip and configure .env later): "));
  if (key) {
    try {
      // US-1.3: try the OS keychain first; fall back to .env with a warning
      // that it is a plaintext fallback (not as secure as the keychain).
      const { setCredential, isKeychainAvailable } = await import("./secrets/keychain.js");
      const keychainOk = isKeychainAvailable() && await setCredential("OLLAMA_API_KEY", key);
      if (keychainOk) {
        config.ollamaApiKey = key;
        config.llmApiKey = key;
        console.log(picocolors.green("\n  ✅ Saved to OS keychain. You're ready to go!\n"));
      } else {
        // Plaintext .env fallback — warn the user (US-1.3)
        const fs = await import("fs/promises");
        const envPath = path.resolve(".env");
        await fs.writeFile(envPath, `OLLAMA_API_KEY=${key}\n`, { mode: 0o600 });
        config.ollamaApiKey = key;
        config.llmApiKey = key;
        console.log(picocolors.yellow("\n  ⚠️  Saved to .env (plaintext fallback, 0600). Consider using the OS keychain for better security.\n"));
      }
    } catch {
      console.log(picocolors.yellow("\n  ⚠️  Could not save API key — add OLLAMA_API_KEY manually later.\n"));
    }
  } else {
    console.log(picocolors.gray("\n  No problem — add OLLAMA_API_KEY to .env when ready, then run quiver again.\n"));
  }
  rl.close();
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
    c("  ") + v(config.llmModelName) + c(" · ") +
    v(redactSecret(config.llmApiKey)) + c(" · ") +
    (config.parallelApiKey ? v("web ✓") : c("web —")) + c(" · ") +
    (config.githubToken ? v("github ✓") : c("github —")) + c(" · ") +
    v(config.maxContextTokens.toLocaleString("en-US")) + c(" ctx"),
  );
}