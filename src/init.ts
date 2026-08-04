import { copyFileSync, existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import * as path from "path";
import { theme, statusLine, EXIT } from "./cli_ui.js";
import {
  isKeychainAvailable,
  migrateEnvToKeychain,
  setCredential,
} from "./secrets/keychain.js";
import { findBinary } from "./utils/find_binary.js";

const PACKAGE_ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const ENV_EXAMPLE = path.join(PACKAGE_ROOT, ".env.example");
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
    statusLine("ERROR", `Missing .env.example at ${ENV_EXAMPLE}.`);
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

  const configuredOfficeCli = process.env.QUIVER_OFFICECLI_PATH?.trim();
  const officeCli = configuredOfficeCli
    ? (existsSync(configuredOfficeCli)
        ? configuredOfficeCli
        : findBinary(configuredOfficeCli))
    : findBinary("officecli");
  if (officeCli) {
    statusLine("OK", `OfficeCLI detected: ${officeCli}`);
  } else {
    const installHint =
      process.platform === "win32"
        ? "install the official Windows binary (PowerShell installer or Scoop)"
        : "install it from https://d.officecli.ai";
    statusLine(
      "WARN",
      `OfficeCLI was not found. Before Office workflows, ${installHint} or set QUIVER_OFFICECLI_PATH.`,
    );
  }

  const migrated = await migrateEnvToKeychain(ENV_FILE);
  if (migrated.migrated.length > 0) {
    statusLine(
      "OK",
      `Moved ${migrated.migrated.join(", ")} from .env into the OS credential store.`,
    );
  }

  const apiKey = await promptLine(
    t.cyan("Enter your LLM_API_KEY (press Enter to skip): "),
  );

  if (apiKey) {
    const storedInKeychain =
      isKeychainAvailable() && (await setCredential("LLM_API_KEY", apiKey));
    if (storedInKeychain) {
      // Keep the template entry but never leave the secret in plaintext.
      const envContent = readFileSync(ENV_FILE, "utf8").replace(
        /^LLM_API_KEY=.*$/m,
        "LLM_API_KEY=",
      );
      writeFileSync(ENV_FILE, envContent, "utf8");
      statusLine("OK", "Saved LLM_API_KEY to the OS credential store.");
    } else {
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
      statusLine("WARN", "Saved LLM_API_KEY to .env (0600 plaintext fallback).");
    }
    try {
      chmodSync(ENV_FILE, 0o600);
    } catch {
      // Ignore permission setting errors on non-Unix platforms
    }
  } else {
    statusLine("INFO", "Skipped API key — edit .env manually when ready.");
  }

  console.log("");
  statusLine("OK", "Setup complete. Run 'quiver' to start a session.");
  try {
    const { ensureDirectories } = await import("./paths.js");
    await ensureDirectories();
    statusLine("OK", "Seeded local skills and project directories.");
  } catch (err: any) {
    statusLine(
      "WARN",
      `Could not seed skills/directories: ${err?.message || String(err)}`,
    );
  }
  console.log(
    t.gray("  Configure LLM_API_BASE_URL and LLM_MODEL_NAME in .env to point Quiver at any OpenAI-compatible endpoint.\n"),
  );
  console.log(
    t.yellow("  Remote endpoints receive the prompts and files you submit; use an approved provider or local endpoint for sensitive work.\n"),
  );
  console.log(t.gray("  Docs: README.md\n"));
}
