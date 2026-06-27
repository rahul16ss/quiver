import "dotenv/config";
import { existsSync } from "fs";
import * as path from "path";
import picocolors from "picocolors";

export type OutputMode = "interactive" | "json" | "quiet";

export interface Config {
  llmBaseUrl: string;
  llmModelName: string;
  llmApiKey: string;
  parallelApiKey: string;
  browserHeadless: boolean;
  requireApprovalFor: string[];
  context7ApiKey: string;
  githubToken: string;
  ollamaApiKey: string;
  cloudSyncPath: string;
  maxContextTokens: number;
  outputMode: OutputMode;
  sessionLogEnabled: boolean;
  sessionLogMaxChars: number;
  dryRun: boolean;
}

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
  llmApiKey: process.env.LLM_API_KEY || "",
  parallelApiKey: process.env.PARALLEL_API_KEY || "",
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  requireApprovalFor: parseApprovals(),
  context7ApiKey: process.env.CONTEXT7_API_KEY || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  ollamaApiKey: process.env.OLLAMA_API_KEY || "",
  cloudSyncPath: process.env.QUIVER_CLOUD_SYNC_PATH || "",
  maxContextTokens: parseInt(process.env.QUIVER_MAX_CONTEXT_TOKENS || "120000", 10),
  outputMode: parseOutputMode(),
  sessionLogEnabled: process.env.QUIVER_SESSION_LOG !== "0",
  sessionLogMaxChars: parseInt(process.env.QUIVER_SESSION_LOG_MAX_CHARS || "512", 10),
  dryRun: parseDryRun(),
};

export function redactSecret(value: string): string {
  if (!value) return "—";
  if (value.length <= 8) return "✓";
  return `✓ ${value.substring(0, 3)}…${value.substring(value.length - 3)}`;
}

export function isFirstRun(): boolean {
  return !existsSync(path.resolve(".env")) && !config.llmApiKey;
}

export function printFirstRunWizard(): void {
  console.log(
    picocolors.cyan(`
  Quiver — first run

  1. quiver init
  2. Add LLM_API_KEY to .env
  3. quiver
`),
  );
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
    v(config.maxContextTokens.toLocaleString()) + c(" ctx"),
  );
}