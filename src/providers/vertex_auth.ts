/**
 * Provider URL / auth helpers — local OpenAI-compatible endpoints only.
 *
 * OpenRouter is the sole cloud model gateway (ADR-001). When
 * OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE are configured, the
 * QuiverOpenRouterProvider bridge handles transport + ZDR enforcement. The
 * functions below serve the *local/private* escape hatch (LLM_API_BASE_URL
 * pointing at Ollama, vLLM, llama.cpp, LM Studio, etc.) for air-gapped or
 * high-sensitivity work.
 *
 * Vertex AI was removed — OpenRouter already routes to Gemini with ZDR.
 * The Ollama identity / sign-in flow was removed — OpenRouter auth is a
 * plain API key in .env; the local endpoint needs no binary/daemon/keypair.
 */

import { config } from "../config.js";

/**
 * Resolve the effective OpenAI-compat base URL for the maker (local endpoint).
 * Returns "" when no local endpoint is configured — the caller should then
 * require an OpenRouter key instead.
 */
export function resolveMakerBaseUrl(): string {
  if (config.llmBaseUrl) return config.llmBaseUrl.replace(/\/$/, "");
  return "";
}

/**
 * Resolve the checker base URL. Falls back to the maker URL when the checker
 * model is set but the checker URL is empty.
 */
export function resolveCheckerBaseUrl(): string {
  if (config.checkerBaseUrl) return config.checkerBaseUrl.replace(/\/$/, "");
  if (config.checkerModelName && config.llmBaseUrl) {
    return config.llmBaseUrl.replace(/\/$/, "");
  }
  return "";
}

/**
 * Resolve the Bearer token for an OpenAI-compatible endpoint. With Vertex gone,
 * this is simply the static LLM_API_KEY (local endpoints typically ignore it).
 */
export async function resolveLlmBearerToken(_opts?: { forceVertex?: boolean }): Promise<string> {
  return config.llmApiKey || "";
}
