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
    "Scrapes a web page URL using Ollama Pro or Parallel.ai Extract API and returns the full markdown content.",
  parameters: z.object({
    url: z.string().describe("The web page URL to scrape."),
    provider: z
      .enum(["ollama", "parallel"])
      .optional()
      .describe(
        "Optional extraction provider override. Prioritizes Ollama Pro if not specified and OLLAMA_API_KEY is set.",
      ),
  }),
  execute: async ({ url, provider }) => {
    // SSRF protection
    if (isPrivateUrl(url)) {
      return `Error: URL '${url}' points to a private/internal network address. Blocked for security. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.`;
    }

    const selectedProvider =
      provider || (config.ollamaApiKey ? "ollama" : "parallel");

    if (selectedProvider === "ollama") {
      if (!config.ollamaApiKey) {
        return "Error: OLLAMA_API_KEY is not set in the configuration (.env). Please configure it to use Ollama web fetch.";
      }

      try {
        const response = await fetch("https://ollama.com/api/web_fetch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.ollamaApiKey}`,
          },
          body: JSON.stringify({ url }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return `Error: Ollama web fetch failed with status ${response.status}: ${errorText}`;
        }

        const data: any = await response.json();
        const content = data.content || "";
        const title = data.title ? `# ${data.title}\n\n` : "";
        return content
          ? `${title}${content}`
          : "Webpage loaded successfully but returned no content.";
      } catch (error: any) {
        return `Error performing Ollama web fetch: ${error.message}`;
      }
    } else {
      const apiKey = config.parallelApiKey;
      if (!apiKey) {
        return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Please configure it to use scrape_url.";
      }

      try {
        const response = await fetch("https://api.parallel.ai/v1/extract", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            urls: [url],
            advanced_settings: {
              full_content: true, // Tells Parallel to return full page markdown rather than just excerpts
            },
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return `Error: Parallel extract failed with status ${response.status}: ${errorText}`;
        }

        const data: any = await response.json();

        // Check for extraction errors
        if (data.errors && data.errors.length > 0) {
          return `Error extracting URL content: ${data.errors[0].content || "Failed to fetch webpage."}`;
        }

        const result = data.results?.[0];
        if (!result) {
          return "Error: Parallel extract did not return any results for the URL.";
        }

        const content =
          result.full_content || (result.excerpts || []).join("\n\n");
        return (
          content || "Webpage loaded successfully but returned no content."
        );
      } catch (error: any) {
        return `Error scraping URL: ${error.message}`;
      }
    }
  },
};
