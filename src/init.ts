import { copyFileSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import * as path from "path";
import { theme, statusLine, EXIT } from "./cli_ui.js";

const ENV_EXAMPLE = path.resolve(".env.example");
const ENV_FILE = path.resolve(".env");

async function promptLine(question: string): Promise<string> {
  const { askQuestion } = await import("./utils/prompt.js");
  return askQuestion(question);
}

/**
 * Interactive first-run setup: copies .env.example and optionally collects API key.
 */
export async function runInitWizard(): Promise<void> {
  const t = theme();

  console.log(
    t.cyan(`
  ┌────────────────────────────────────────────┐
  │  Welcome to Quiver                          │
  │                                            │
  │  This wizard sets up your local config.    │
  └────────────────────────────────────────────┘`),
  );

  if (!existsSync(ENV_EXAMPLE)) {
    statusLine("ERROR", "Missing .env.example in the project root.");
    process.exit(EXIT.CONFIG);
  }

  if (existsSync(ENV_FILE)) {
    statusLine("WARN", ".env already exists — skipping copy.");
  } else {
    copyFileSync(ENV_EXAMPLE, ENV_FILE);
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch {
      // Ignore permission setting errors on non-Unix platforms
    }
    statusLine("OK", "Created .env from .env.example");
  }

  const apiKey = await promptLine(
    t.cyan("Enter your LLM_API_KEY (press Enter to skip): "),
  );

  if (apiKey) {
    let envContent = readFileSync(ENV_FILE, "utf8");
    if (/^LLM_API_KEY=.*$/m.test(envContent)) {
      envContent = envContent.replace(
        /^LLM_API_KEY=.*$/m,
        `LLM_API_KEY=${apiKey}`,
      );
    } else {
      envContent += `\nLLM_API_KEY=${apiKey}\n`;
    }
    writeFileSync(ENV_FILE, envContent, "utf8");
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch {
      // Ignore
    }
    statusLine("OK", "Saved LLM_API_KEY to .env");
  } else {
    statusLine("INFO", "Skipped API key — edit .env manually when ready.");
  }

  console.log("");
  statusLine("OK", "Setup complete. Run 'quiver' to start a session.");
  console.log(
    t.gray("  Configure LLM_API_BASE_URL and LLM_MODEL_NAME in .env to point Quiver at any OpenAI-compatible endpoint.\n"),
  );
  console.log(t.gray("  Docs: README.md\n"));
}
