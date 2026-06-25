import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "scrape_url",
  description: "Scrapes a web page URL using Parallel.ai Extract API and returns the full LLM-ready markdown content.",
  parameters: z.object({
    url: z.string().describe("The web page URL to scrape."),
  }),
  execute: async ({ url }) => {
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

      const content = result.full_content || (result.excerpts || []).join("\n\n");
      return content || "Webpage loaded successfully but returned no content.";
    } catch (error: any) {
      return `Error scraping URL: ${error.message}`;
    }
  },
};
