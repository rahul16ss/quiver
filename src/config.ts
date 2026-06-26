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
  skillsDir: string;
  memoryDir: string;
  browserHeadless: boolean;
  requireApprovalFor: string[];
  context7ApiKey: string;
  githubToken: string;
  ollamaApiKey: string;
  maxLoops: number;
  maxContextTokens: number;
  outputMode: OutputMode;
  sessionLogEnabled: boolean;
  sessionLogMaxChars: number;
  dryRun: boolean;
}

// Parse output mode from CLI args (called before config object is frozen)
function parseOutputMode(): OutputMode {
  const args = process.argv.slice(2);
  if (args.includes("--json")) return "json";
  if (args.includes("--quiet") || args.includes("-q")) return "quiet";
  return "interactive";
}

function parseDryRun(): boolean {
  const args = process.argv.slice(2);
  return args.includes("--dry-run") || args.includes("-n");
}

const DEFAULT_APPROVAL_TOOLS =
  "run_command,write_file,replace_content,browser_control,create_tool";

/** Parse REQUIRE_APPROVAL_FOR; empty string explicitly disables all gates. */
function parseApprovalList(): string[] {
  const raw = process.env.REQUIRE_APPROVAL_FOR;
  const source = raw === undefined ? DEFAULT_APPROVAL_TOOLS : raw;
  return source
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config: Config = {
  llmBaseUrl: process.env.LLM_API_BASE_URL || "https://ollama.com/v1",
  llmModelName: process.env.LLM_MODEL_NAME || "glm-5.2:cloud",
  llmApiKey: process.env.LLM_API_KEY || "",
  parallelApiKey: process.env.PARALLEL_API_KEY || "",
  skillsDir: process.env.QUIVER_SKILLS_DIR || "./skills",
  memoryDir: process.env.QUIVER_MEMORY_DIR || "./memory",
  browserHeadless: process.env.BROWSER_HEADLESS !== "false",
  requireApprovalFor: parseApprovalList(),
  context7ApiKey: process.env.CONTEXT7_API_KEY || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  ollamaApiKey: process.env.OLLAMA_API_KEY || "",
  maxLoops: parseInt(process.env.QUIVER_MAX_LOOPS || "100", 10),
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
};

/**
 * Redact a secret for safe display: shows first 3 and last 3 chars.
 * Returns "No" for empty strings and "Yes (sk-...xyz)" for set keys.
 */
export function redactSecret(value: string, label?: string): string {
  if (!value) return "No";
  if (value.length <= 8) return `Yes (${value.length} chars)`;
  const prefix = value.substring(0, 3);
  const suffix = value.substring(value.length - 3);
  return `Yes (${prefix}...${suffix})`;
}

/**
 * Check if this is a first run (no .env file and no API key set).
 */
export function isFirstRun(): boolean {
  const envPath = path.resolve(".env");
  return !existsSync(envPath) && !config.llmApiKey;
}

/**
 * Print a friendly first-run onboarding wizard.
 */
export function printFirstRunWizard(): void {
  console.log(
    picocolors.cyan(`
  ┌────────────────────────────────────────────┐
  │  👋 Welcome to Quiver!                      │
  │                                            │
  │  It looks like this is your first run.     │
  │  Let's get you set up:                     │
  │                                            │
  │  1. Run: quiver init                       │
  │  2. Add your API key to LLM_API_KEY        │
  │  3. Run 'quiver' again                     │
  │                                            │
  │  📖 Full guide: README.md                  │
  └────────────────────────────────────────────┘`),
  );
}

export function validateConfig(): void {
  if (config.outputMode !== "interactive") return; // Skip in json/quiet mode

  console.log(`\n⚙️  Quiver Config Loaded:`);
  console.log(`   - Endpoint Base:    ${config.llmBaseUrl}`);
  console.log(`   - Target Model:      ${config.llmModelName}`);
  console.log(`   - LLM API Key:       ${redactSecret(config.llmApiKey)}`);
  console.log(`   - Ollama Pro Key:    ${redactSecret(config.ollamaApiKey)}`);
  console.log(`   - Parallel Key:      ${redactSecret(config.parallelApiKey)}`);
  console.log(`   - GitHub Token:      ${redactSecret(config.githubToken)}`);
  console.log(`   - Context7 Key:      ${redactSecret(config.context7ApiKey)}`);
  console.log(`   - Skills Dir:        ${config.skillsDir}`);
  console.log(`   - Memory Dir:        ${config.memoryDir}`);
  console.log(`   - Browser Headless:  ${config.browserHeadless}`);
  console.log(`   - Max Loop Turns:    ${config.maxLoops}`);
  console.log(
    `   - Max Context Tokens: ${config.maxContextTokens.toLocaleString()}`,
  );
  console.log(
    `   - Approvals For:     ${config.requireApprovalFor.join(", ") || "None"}`,
  );
  console.log("");
}
