import type { QuiverConfig } from "./config.ts";

export async function storedCredential(key: string): Promise<string> {
  try {
    const { getCredential } = await import("../../src/secrets/keychain.js");
    return (await getCredential(key)) || "";
  } catch {
    return "";
  }
}

export async function hydrateRuntimeConfig(input: QuiverConfig): Promise<QuiverConfig> {
  const llmKey =
    (await storedCredential("LLM_API_KEY")) ||
    process.env.LLM_API_KEY ||
    input.provider?.apiKey ||
    input.llmApiKey ||
    "";
  const parallelKey =
    (await storedCredential("PARALLEL_API_KEY")) ||
    process.env.PARALLEL_API_KEY ||
    input.parallelApiKey ||
    "";
  return {
    ...input,
    provider: { ...input.provider, apiKey: llmKey },
    llmApiKey: llmKey,
    parallelApiKey: parallelKey,
  };
}

export async function setStoredCredential(key: string, value: string): Promise<boolean> {
  try {
    const { setCredential, isKeychainAvailable } = await import("../../src/secrets/keychain.js");
    if (isKeychainAvailable() && (await setCredential(key, value))) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
