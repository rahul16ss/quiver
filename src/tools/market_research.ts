import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "market_research",
  description:
    "Retrieves pricing and feature details for a given product or service by performing web searches and scraping relevant pages. Returns structured information about pricing tiers, key features, and notable details.",
  parameters: z.object({
    product: z.string().describe("The name of the product or service to research (e.g., 'Supabase')."),
    category: z
      .string()
      .optional()
      .describe("Optional category or type of product (e.g., 'backend-as-a-service', 'database') to refine the search."),
  }),
  execute: async ({ product, category }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Please configure it to use market research.";
    }

    const categorySuffix = category ? ` ${category}` : "";
    const queries = [
      `${product}${categorySuffix} pricing plans 2024 2025`,
      `${product}${categorySuffix} features overview`,
      `${product}${categorySuffix} free tier limits cost per month`,
    ];

    const allResults: string[] = [];

    for (const query of queries) {
      try {
        const searchResponse = await fetch("https://api.parallel.ai/v1/search", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            objective: query,
            search_queries: [query],
            mode: "turbo",
          }),
        });

        if (!searchResponse.ok) {
          allResults.push(`[Search for "${query}" failed with status ${searchResponse.status}]`);
          continue;
        }

        const searchData: any = await searchResponse.json();
        const results = searchData.results || [];

        for (const item of results.slice(0, 3)) {
          const url = item.url;
          const title = item.title || "No Title";
          const excerpts = (item.excerpts || []).map((ex: string) => `- ${ex}`).join("\n");

          allResults.push(`### ${title}\nURL: ${url}\nExcerpts:\n${excerpts || "No excerpts available."}`);

          // Try to scrape the page for more detailed content (limit to official/pricing pages)
          if (url && (url.includes("pricing") || url.includes(product.toLowerCase().split(" ")[0]) || url.includes("docs"))) {
            try {
              const scrapeResponse = await fetch("https://api.parallel.ai/v1/extract", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-api-key": apiKey,
                },
                body: JSON.stringify({ url }),
              });

              if (scrapeResponse.ok) {
                const scrapeData: any = await scrapeResponse.json();
                const content = scrapeData.content || scrapeData.markdown || "";
                if (content) {
                  // Truncate to avoid overly long responses
                  const truncated = content.slice(0, 3000);
                  allResults.push(`--- Scraped content from ${url} ---\n${truncated}`);
                }
              }
            } catch {
              // Skip scraping errors silently
            }
          }
        }
      } catch (error: any) {
        allResults.push(`[Error searching for "${query}": ${error.message}]`);
      }
    }

    return allResults.length > 0
      ? `Market Research for "${product}"${categorySuffix ? ` (${categorySuffix.trim()})` : ""}:\n\n${allResults.join("\n\n")}`
      : "No market research results found.";
  },
};