import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

/**
 * SSRF protection: blocks requests to private/internal IP ranges.
 * Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable (default: enabled).
 */
function isPrivateUrl(urlStr: string): boolean {
  if (process.env.QUIVER_BLOCK_PRIVATE_IPS === "0") return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    // Block localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x (link-local), ::1, fc00::/7
    if (
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const tool: Tool = {
  name: "scrape_url",
  description:
    "Fetches a web page URL and returns the content as text. " +
    "Tries Ollama Pro web fetch first (if LLM_API_KEY is set), then Parallel.ai Extract (if PARALLEL_API_KEY is set), " +
    "then falls back to a plain HTTP fetch with HTML tag stripping. " +
    "Use this to read any web page — articles, documentation, APIs, etc.",
  parameters: z.object({
    url: z.string().describe("The web page URL to scrape."),
    provider: z
      .enum(["ollama", "parallel", "direct"])
      .optional()
      .describe(
        "Optional provider override. 'direct' does a plain HTTP fetch (no API). Default: auto-select.",
      ),
  }),
  execute: async ({ url, provider }) => {
    if (isPrivateUrl(url)) {
      return `Error: URL '${url}' points to a private/internal network address. Blocked for security. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.`;
    }

    const selectedProvider =
      provider || (config.llmApiKey ? "ollama" : config.parallelApiKey ? "parallel" : "direct");

    // ── Ollama Pro web fetch ──
    if (selectedProvider === "ollama" && config.llmApiKey) {
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
    if ((selectedProvider === "parallel" || selectedProvider === "ollama") && config.parallelApiKey) {
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
    try {
      const response = await fetch(url, {
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
