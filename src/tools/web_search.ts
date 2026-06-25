import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "web_search",
  description: "Searches the web using Ollama Pro or Parallel.ai web search API and returns relevant excerpts.",
  parameters: z.object({
    query: z.string().describe("The search query string."),
    provider: z
      .enum(["ollama", "parallel"])
      .optional()
      .describe("Optional search provider override. Prioritizes Ollama Pro if not specified and OLLAMA_API_KEY is set."),
  }),
  execute: async ({ query, provider }) => {
    const selectedProvider = provider || (config.ollamaApiKey ? "ollama" : "parallel");

    if (selectedProvider === "ollama") {
      if (!config.ollamaApiKey) {
        return "Error: OLLAMA_API_KEY is not set in the configuration (.env). Please configure it to use Ollama web search.";
      }

      try {
        const response = await fetch("https://ollama.com/api/web_search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.ollamaApiKey}`,
          },
          body: JSON.stringify({
            query,
            max_results: 5,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          return `Error: Ollama web search failed with status ${response.status}: ${errorText}`;
        }

        const data: any = await response.json();
        const results = (data.results || []).map((item: any, idx: number) => {
          return `[Result ${idx + 1}]\nTitle: ${item.title || "No Title"}\nURL: ${item.url}\nExcerpts:\n- ${item.content || item.snippet || "No snippet available."}`;
        });

        return results.length > 0 ? results.join("\n\n") : "No search results found.";
      } catch (error: any) {
        return `Error performing Ollama web search: ${error.message}`;
      }
    } else {
      const apiKey = config.parallelApiKey;
      if (!apiKey) {
        return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Please configure it to use Parallel web search.";
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
        return `Error performing Parallel web search: ${error.message}`;
      }
    }
  },
};
