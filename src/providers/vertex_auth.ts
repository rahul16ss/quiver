/**
 * Vertex AI (Gemini) auth — customer-owned GCP projects only.
 *
 * Quiver never ships a shared Conviction Studio Google Cloud project.
 * Each engagement / customer brings:
 *   - their own GCP project (billing stays on their account)
 *   - a service account JSON (or ADC) with Vertex AI User rights
 *   - optional project/location so Quiver can build the OpenAI-compat URL
 *
 * Vertex OpenAI-compat rejects static Gemini API keys. It expects a short-lived
 * OAuth2 access token (cloud-platform scope) as Bearer auth.
 */

import { GoogleAuth } from "google-auth-library";
import { config } from "../config.js";

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Cached access token (Vertex tokens last ~1h). */
let cachedToken: { value: string; expiresAtMs: number } | null = null;

export function isVertexHost(url: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "aiplatform.googleapis.com" ||
      host.endsWith("-aiplatform.googleapis.com") ||
      host === "us-central1-aiplatform.googleapis.com"
    );
  } catch {
    return /aiplatform\.googleapis\.com/i.test(url);
  }
}

/**
 * Build the Vertex OpenAI-compatible base URL (no trailing /chat/completions).
 * location "global" uses the global host; regional uses `{loc}-aiplatform…`.
 */
export function buildVertexOpenAiBaseUrl(
  projectId: string,
  location: string = "global",
): string {
  const project = projectId.trim();
  const loc = (location || "global").trim() || "global";
  if (!project) {
    throw new Error("VERTEX_PROJECT_ID is required to build the Vertex endpoint");
  }
  if (loc.toLowerCase() === "global") {
    return `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/endpoints/openapi`;
  }
  return `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}/locations/${loc}/endpoints/openapi`;
}

/** True when the active maker/checker transport is Vertex (customer GCP). */
export function isVertexConfigured(): boolean {
  if (config.llmApiKey && (config.llmApiKey.startsWith("AIzaSy") || config.llmApiKey.startsWith("sk-"))) return false;
  const maker = resolveMakerBaseUrl();
  if (maker && isVertexHost(maker)) return true;
  if (config.checkerBaseUrl && isVertexHost(config.checkerBaseUrl)) return true;
  // Project id alone counts only when no overriding non-Vertex base URL is set.
  if (config.vertexProjectId && !config.llmBaseUrl && !config.llmApiKey) return true;
  return false;
}

/**
 * Resolve the effective OpenAI-compat base URL for the maker.
 * Prefer an explicit LLM_API_BASE_URL; otherwise build from VERTEX_PROJECT_ID.
 */
export function resolveMakerBaseUrl(): string {
  if (config.llmBaseUrl) return config.llmBaseUrl.replace(/\/$/, "");
  if (config.llmApiKey && config.llmApiKey.startsWith("AIzaSy")) {
    return "https://generativelanguage.googleapis.com/v1beta/openai";
  }
  if (config.vertexProjectId) {
    return buildVertexOpenAiBaseUrl(
      config.vertexProjectId,
      config.vertexLocation || "global",
    );
  }
  return "";
}

/**
 * Resolve the checker base URL. Falls back to maker Vertex URL when the
 * checker model is set but the checker URL is empty.
 */
export function resolveCheckerBaseUrl(): string {
  if (config.checkerBaseUrl) return config.checkerBaseUrl.replace(/\/$/, "");
  if (config.checkerModelName && config.vertexProjectId) {
    return buildVertexOpenAiBaseUrl(
      config.vertexProjectId,
      config.vertexLocation || "global",
    );
  }
  if (config.checkerModelName && config.llmBaseUrl && isVertexHost(config.llmBaseUrl)) {
    return config.llmBaseUrl.replace(/\/$/, "");
  }
  return "";
}

/**
 * Obtain a Bearer token for Vertex (or return the static LLM_API_KEY for
 * non-Vertex OpenAI-compat providers).
 *
 * For Vertex: uses GOOGLE_APPLICATION_CREDENTIALS / ADC via google-auth-library.
 * Never falls back to a Conviction Studio project — credentials must come from
 * the customer's environment.
 */
export async function resolveLlmBearerToken(opts?: {
  forceVertex?: boolean;
}): Promise<string> {
  const needsVertex =
    opts?.forceVertex ||
    isVertexConfigured() ||
    isVertexHost(resolveMakerBaseUrl());

  if (!needsVertex) {
    return config.llmApiKey || "";
  }

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAtMs > now + 60_000) {
    return cachedToken.value;
  }

  const keyFile =
    config.googleApplicationCredentials ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    undefined;

  try {
    const auth = new GoogleAuth({
      scopes: [CLOUD_PLATFORM_SCOPE],
      ...(keyFile ? { keyFilename: keyFile } : {}),
      ...(config.vertexProjectId ? { projectId: config.vertexProjectId } : {}),
    });
    const client = await auth.getClient();
    const access = await client.getAccessToken();
    const token =
      typeof access === "string"
        ? access
        : access?.token || (client as { credentials?: { access_token?: string } }).credentials?.access_token;

    if (!token) {
      throw new Error("Vertex auth returned an empty access token");
    }

    // Default Google access tokens are ~3600s; refresh 2 minutes early.
    const expiresAtMs =
      (client as { credentials?: { expiry_date?: number } }).credentials
        ?.expiry_date || now + 50 * 60 * 1000;
    cachedToken = { value: token, expiresAtMs };
    return token;
  } catch (err: any) {
    // Fallback: try gcloud CLI if installed and authenticated
    try {
      const { execSync } = await import("child_process");
      const token = execSync(
        "gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null",
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      if (token && token.length > 20 && !token.includes(" ")) {
        cachedToken = { value: token, expiresAtMs: now + 45 * 60 * 1000 };
        return token;
      }
    } catch {}

    cachedToken = null;
    if (config.llmApiKey && config.llmApiKey.length > 20) {
      return config.llmApiKey;
    }
    throw new Error(
      `Vertex AI authentication failed (${err?.message || String(err)}). ` +
        `Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON from the ` +
        `customer's own GCP project (billing stays on their account), or run ` +
        `gcloud auth application-default login against that project. ` +
        `Quiver does not provide a shared Google Cloud project.`,
    );
  }
}

/** Test helper — clear the in-memory token cache. */
export function clearVertexTokenCache(): void {
  cachedToken = null;
}

/**
 * True when the configured LLM host is Ollama Cloud/local — used so web
 * tools only call Ollama Pro APIs when the model provider is actually Ollama.
 */
export function isOllamaHost(url: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "ollama.com" || host === "localhost" || host === "127.0.0.1";
  } catch {
    return /ollama/i.test(url);
  }
}
