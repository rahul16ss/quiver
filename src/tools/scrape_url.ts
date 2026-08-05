import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";
import { isOllamaHost, resolveMakerBaseUrl } from "../providers/vertex_auth.js";
import { isPrivateUrl } from "../security/private_url.js";

function defaultScrapeProvider(): "ollama" | "parallel" | "direct" {
  if (config.parallelApiKey) return "parallel";
  const base = resolveMakerBaseUrl() || config.llmBaseUrl;
  if (config.llmApiKey && isOllamaHost(base)) return "ollama";
  return "direct";
}

export const tool: Tool = {
  name: "scrape_url",
  description:
    "Fetches a web page URL and returns the content as text. " +
    "Prefers Parallel.ai Extract when PARALLEL_API_KEY is set; uses Ollama Pro web fetch only when the model host is Ollama; " +
    "then falls back to a plain HTTP fetch with HTML tag stripping. " +
    "Use this to read any web page — articles, documentation, APIs, etc.",
  parameters: z.object({
    url: z.string().describe("The web page URL to scrape."),
    provider: z
      .enum(["ollama", "parallel", "direct"])
      .optional()
      .describe(
        "Optional provider override. 'direct' does a plain HTTP fetch (no API). Default: Parallel when keyed, else Ollama-only-on-Ollama, else direct.",
      ),
  }),
  execute: async ({ url, provider }) => {
    if (await isPrivateUrl(url)) {
      return `Error: URL '${url}' points to a private/internal network address. Blocked for security. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.`;
    }

    const selectedProvider = provider || defaultScrapeProvider();

    // ── Ollama Pro web fetch (only when host is Ollama) ──
    if (
      selectedProvider === "ollama" &&
      config.llmApiKey &&
      isOllamaHost(resolveMakerBaseUrl() || config.llmBaseUrl)
    ) {
      try {
        const response = await fetch("https://ollama.com/api/web_fetch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.llmApiKey}`,
          },
          body: JSON.stringify({ url }),
        });
        if (response.ok) {
          const data: any = await response.json();
          const content = data.content || "";
          const title = data.title ? `# ${data.title}\n\n` : "";
          if (content) return `${title}${content}`;
        }
        // Ollama API failed (e.g. 404 for SPA routes) — fall through to direct
      } catch {
        // Network error — fall through to direct
      }
    }

    // ── Parallel.ai Extract ──
    if (
      (selectedProvider === "parallel" || selectedProvider === "ollama") &&
      config.parallelApiKey
    ) {
      try {
        const response = await fetch("https://api.parallel.ai/v1/extract", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": config.parallelApiKey,
          },
          body: JSON.stringify({
            urls: [url],
            advanced_settings: {
              output_formats: ["markdown"],
              timeout: 30,
            },
          }),
        });
        if (response.ok) {
          const data: any = await response.json();
          const result = data?.results?.[0];
          if (result?.content) {
            return result.content;
          }
        }
        // Parallel failed — fail closed (no regex HTML-scraping fallback).
      } catch {
        // Network error — fail closed (no regex HTML-scraping fallback).
      }
    }

    // No silent regex/HTTP scraping fallback. Fail closed when Parallel is
    // unavailable and the Ollama Pro path is not applicable — the
    // ResearchGateway (Parallel) is the sole public-web fetch path. Direct
    // fetches for authenticated/interactive sites go through browser_control,
    // never this tool.
    if (!config.parallelApiKey) {
      return "Error: PARALLEL_API_KEY is not set. scrape_url uses Parallel Extract as the sole public-web fetch path (no regex fallback). Set PARALLEL_API_KEY or use browser_control for authenticated/interactive sites.";
    }
    return `Error: Parallel Extract failed for ${url} and no silent fallback is permitted. Retry, or use browser_control for authenticated/interactive sites.`;
  },
};
