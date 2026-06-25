import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "web_search",
  description: "Searches the web using Parallel.ai web intelligence API and returns relevant excerpts.",
  parameters: z.object({
    query: z.string().describe("The search query string."),
  }),
  execute: async ({ query }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Please configure it to use web search.";
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
          mode: "turbo", // Optimized for fast response times in chat/command loops
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
      return `Error performing web search: ${error.message}`;
    }
  },
};
