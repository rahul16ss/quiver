import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

const PARALLEL_BASE = "https://api.parallel.ai";

/**
 * Parallel Entity Search — fast, synchronous people/company search.
 * POST /v1beta/findall/entity-search
 * Returns immediately with ranked results. No polling needed.
 */

export const tool: Tool = {
  name: "entity_search",
  description:
    "Fast, synchronous people and company search via the Parallel Entity Search API. " +
    "Describe the people or companies you want in natural language and get back ranked results in seconds. " +
    "Optimized for speed and recall — some results may not perfectly match every requirement, so filter downstream. " +
    "For verified, enriched, cited list building with match conditions, use find_all instead. " +
    "Use for latency-sensitive workflows: getting a starting set of people/companies to evaluate or enrich.",
  parameters: z.object({
    entity_type: z
      .enum(["people", "companies"])
      .describe("Type of entity to search for."),
    objective: z
      .string()
      .describe(
        "Natural-language description of the people or companies you want. E.g. 'AI startups that raised Series A in 2024' or 'CTOs of fintech companies in San Francisco'.",
      ),
    match_limit: z
      .number()
      .int()
      .min(5)
      .max(1000)
      .optional()
      .describe(
        "Maximum number of entities to return (5-1000). Defaults to 100.",
      ),
  }),
  execute: async ({ entity_type, objective, match_limit }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Entity search requires a Parallel.ai API key.";
    }

    try {
      const response = await fetch(
        `${PARALLEL_BASE}/v1beta/findall/entity-search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            entity_type,
            objective,
            match_limit: match_limit || 100,
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        return `Error: Parallel Entity Search failed with status ${response.status}: ${errorText}`;
      }

      const data: any = await response.json();
      const entities = data.entities || [];

      if (entities.length === 0) {
        return "No entities found matching the objective.";
      }

      const lines: string[] = [];
      lines.push(`## Entity Search Results (${entities.length} found)\n`);
      lines.push(`Entity set ID: ${data.entity_set_id || "N/A"}\n`);

      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        lines.push(`${i + 1}. **${e.name}** — ${e.url}`);
        if (e.description) {
          lines.push(`   ${e.description}`);
        }
      }

      return lines.join("\n");
    } catch (error: any) {
      return `Error performing entity search: ${error.message}`;
    }
  },
};
