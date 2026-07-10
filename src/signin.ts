import picocolors from "picocolors";
import { theme } from "./cli_ui.js";
import { detectOllamaIdentity, startOllamaSignin } from "./ollama_identity.js";
import { config } from "./config.js";

export async function runSignin(): Promise<void> {
  const t = theme();

  console.log(
    t.cyan(`
      ┌────────────────────────────────────────────┐
      │  🔑 Sign in via Ollama                     │
      │                                            │
      │  This links Quiver to your Ollama account  │
      │  for cloud models, web search, and more.   │
      └────────────────────────────────────────────┘`),
  );

  const id = detectOllamaIdentity();

  if (id.hasSignedIn) {
    console.log(
      picocolors.green(
        `\n  Already signed in via Ollama${id.publicKeyFingerprint ? ` (key: …${id.publicKeyFingerprint})` : ""}`,
      ),
    );
    console.log(
      picocolors.gray(
        `  Your local Ollama daemon will auto-authenticate cloud requests.\n`,
      ),
    );

    if (!id.hasApiKey) {
      console.log(
        picocolors.yellow(`    OLLAMA_API_KEY is not set in .env.`),
      );
      console.log(
        picocolors.gray(
          `  For direct API access (without local daemon), create a key at:\n  https://ollama.com/settings/keys\n  Then add it to .env as OLLAMA_API_KEY=...\n`,
        ),
      );
    }
    return;
  }

  if (!id.hasBinary) {
    console.log(
      picocolors.yellow(`\n    Ollama binary not found on this machine.`),
    );
    console.log(
      picocolors.gray(
        `  Install Ollama first: https://ollama.com/download\n  Then run: quiver signin\n`,
      ),
    );
    console.log(
      picocolors.gray(
        `  Alternatively, create an API key at https://ollama.com/settings/keys\n  and add OLLAMA_API_KEY=your_key to .env\n`,
      ),
    );
    return;
  }

  console.log(
    picocolors.gray(
      `\n  Opening browser for Ollama sign-in...\n  Complete the sign-in in your browser, then return here.\n`,
    ),
  );

  const success = startOllamaSignin(id.binaryPath!);

  if (success) {
    const newId = detectOllamaIdentity();
    if (newId.hasSignedIn) {
      console.log(
        picocolors.green(
          `\n  Sign-in successful! Key: …${newId.publicKeyFingerprint}`,
        ),
      );
      console.log(
        picocolors.gray(
          `  Your local Ollama daemon will now auto-authenticate cloud requests.\n`,
        ),
      );
    } else {
      console.log(
        picocolors.green(
          `\n  Sign-in flow completed. Run 'quiver signin' again to verify.\n`,
        ),
      );
    }
  } else {
    console.log(picocolors.red(`\n  Sign-in failed or was cancelled.\n`));
  }
}

export async function checkOllamaConnectivity(): Promise<boolean> {
  if (
    config.llmBaseUrl.includes("localhost") ||
    config.llmBaseUrl.includes("127.0.0.1")
  ) {
    const baseUrl = config.llmBaseUrl.replace(/\/v1\/?$/, "");
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch {
      return false;
    }
  }
  return true;
}
