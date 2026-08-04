import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";
import { isOllamaHost, resolveMakerBaseUrl } from "../providers/vertex_auth.js";
import { isPrivateUrl, fetchPublicUrl } from "../security/private_url.js";

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
        // Parallel failed — fall through to direct
      } catch {
        // Network error — fall through to direct
      }
    }

    // ── Direct HTTP fetch (fallback) ──
    // Works for any URL — fetches HTML and strips tags. No API key needed.
    // This handles SPA/Next.js routes that the Ollama API can't fetch.
    // Redirect hops are re-checked against the SSRF guard (no open redirect
    // into private/internal addresses).
    try {
      const response = await fetchPublicUrl(url, {
        headers: {
          "User-Agent": "Quiver/1.0 (AI document workflow agent)",
          "Accept": "text/html,application/xhtml+xml,text/plain,*/*",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        return `Error: HTTP ${response.status} fetching ${url}`;
      }
      const contentType = response.headers.get("content-type") || "";
      const html = await response.text();

      // If it's plain text or JSON, return as-is
      if (contentType.includes("text/plain") || contentType.includes("application/json")) {
        return html;
      }

      // Strip HTML tags for a readable text version
      const text = htmlToText(html);
      return text || `Webpage fetched but no readable content found at ${url}`;
    } catch (error: any) {
      return `Error fetching ${url}: ${error.message}`;
    }
  },
};

/**
 * Minimal HTML-to-text converter (no dependencies).
 * Strips tags, decodes entities, preserves line breaks.
 */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    // Convert block elements to line breaks
    .replace(/<\/(p|div|h[1-6]|li|tr|br|hr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/^[ \t]+/gm, "")
    .trim();
}
