import picocolors from "picocolors";
import { theme, card, info, success, warn, dim } from "./cli_ui.js";
import { detectOllamaIdentity, startOllamaSignin } from "./ollama_identity.js";
import { config } from "./config.js";

export async function runSignin(): Promise<void> {
  const t = theme();

  card({
    title: "Sign in via Ollama",
    body: [
      "This links Quiver to your Ollama account for cloud models, web search, and more.",
    ],
    footer: "Your key is stored in your computer's keychain — never written where others can read it.",
    accent: "brand",
  });

  const id = detectOllamaIdentity();

  if (id.hasSignedIn) {
    success(`Already signed in via Ollama${id.publicKeyFingerprint ? ` (key: …${id.publicKeyFingerprint})` : ""}`);
    dim("Your local Ollama daemon will auto-authenticate cloud requests.");

    if (!id.hasApiKey) {
      warn("LLM_API_KEY is not set in .env.");
      dim("For direct API access (without local daemon), create a key at https://ollama.com/settings/keys then add it to .env as LLM_API_KEY=...");
    }
    return;
  }

  if (!id.hasBinary) {
    warn("Ollama binary not found on this machine.");
    dim("Install Ollama first: https://ollama.com/download — then run: quiver signin");
    dim("Alternatively, create an API key at https://ollama.com/settings/keys and add LLM_API_KEY=your_key to .env");
    return;
  }

  info("Opening browser for Ollama sign-in...");
  dim("Complete the sign-in in your browser, then return here.");

  const ok = startOllamaSignin(id.binaryPath!);

  if (ok) {
    const newId = detectOllamaIdentity();
    if (newId.hasSignedIn) {
      success(`Sign-in successful! Key: …${newId.publicKeyFingerprint}`);
      dim("Your local Ollama daemon will now auto-authenticate cloud requests.");
    } else {
      success("Sign-in flow completed. Run 'quiver signin' again to verify.");
    }
  } else {
    console.log(picocolors.red(`\n  ✗ Sign-in failed or was cancelled.\n`));
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
