import { copyFileSync, existsSync, readFileSync, writeFileSync } from "fs";
import * as path from "path";
import readline from "readline";
import { theme, statusLine, EXIT } from "./cli_ui.js";

const ENV_EXAMPLE = path.resolve(".env.example");
const ENV_FILE = path.resolve(".env");

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
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
    statusLine("OK", "Saved LLM_API_KEY to .env");
  } else {
    statusLine("INFO", "Skipped API key — edit .env manually when ready.");
  }

  console.log("");
  statusLine("OK", "Setup complete. Run 'quiver' to start a session.");
  console.log(
    t.gray("  To use Ollama cloud models & web search: run 'quiver signin'\n"),
  );
  console.log(t.gray("  Docs: README.md\n"));
}
