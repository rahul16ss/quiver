import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

/**
 * web_search — Parallel.ai is the sole public-web search gateway (ADR-003).
 * The Ollama Cloud web-search route was removed; there is no separate cloud
 * search route and no silent fallback. Fails closed when PARALLEL_API_KEY is
 * unset.
 */
export const tool: Tool = {
  name: "web_search",
  description:
    "Searches the public web using Parallel.ai and returns relevant excerpts. " +
    "Parallel is the sole public-web research gateway; no other cloud search route is used.",
  parameters: z.object({
    query: z.string().describe("The search query string."),
  }),
  execute: async ({ query }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Parallel is the sole public-web search gateway.";
    }

    try {
      const response = await fetch("https://api.parallel.ai/v1/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          objective: query,
          search_queries: [query],
          mode: "basic", // Lower latency for interactive agent loops
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return `Error: Parallel search failed with status ${response.status}: ${errorText}`;
      }

      const data: any = await response.json();
      const results = (data.results || []).map((item: any, idx: number) => {
        const excerpts = (item.excerpts || []).map((ex: string) => `- ${ex}`).join("\n");
        return `[Result ${idx + 1}]\nTitle: ${item.title || "No Title"}\nURL: ${item.url}\nExcerpts:\n${excerpts || "No excerpts available."}`;
      });

      return results.length > 0 ? results.join("\n\n") : "No search results found.";
    } catch (error: any) {
      return `Error performing Parallel web search: ${error.message}`;
    }
  },
};
