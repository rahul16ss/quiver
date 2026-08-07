import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";
import { isPrivateUrl } from "../security/private_url.js";

/**
 * scrape_url — Parallel.ai Extract is the sole public-web fetch gateway
 * (ADR-003). The Ollama Cloud web-fetch route and the regex direct-HTTP
 * fallback were removed. Fails closed when PARALLEL_API_KEY is unset; for
 * authenticated/interactive sites, use browser_control (never a hidden
 * scraper fallback).
 */
export const tool: Tool = {
  name: "scrape_url",
  description:
    "Fetches a public web page URL and returns the content as Markdown via " +
    "Parallel.ai Extract — the sole public-web fetch gateway. No regex/HTTP " +
    "fallback. For authenticated or interactive sites, use browser_control.",
  parameters: z.object({
    url: z.string().describe("The public web page URL to fetch."),
  }),
  execute: async ({ url }) => {
    if (await isPrivateUrl(url)) {
      return `Error: URL '${url}' points to a private/internal network address. Blocked for security. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.`;
    }

    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set. scrape_url uses Parallel Extract as the sole public-web fetch path (no regex fallback). Set PARALLEL_API_KEY or use browser_control for authenticated/interactive sites.";
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
      return `Error: Parallel Extract failed with status ${response.status} for ${url}. No silent fallback is permitted; retry or use browser_control for authenticated/interactive sites.`;
    } catch (error: any) {
      return `Error: Parallel Extract failed for ${url}: ${error.message}. No silent fallback is permitted.`;
    }
  },
};
