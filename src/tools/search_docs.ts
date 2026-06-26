import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "search_docs",
  description:
    "Queries Context7 to retrieve real-time, accurate, and up-to-date documentation context for a software library (e.g., next.js, react, supabase).",
  parameters: z.object({
    libraryName: z
      .string()
      .describe(
        "The name of the library (e.g., 'next.js', 'react', 'supabase').",
      ),
    query: z
      .string()
      .describe("The documentation topic or API signature you want to lookup."),
  }),
  execute: async ({ libraryName, query }) => {
    const apiKey = config.context7ApiKey;
    const headers: Record<string, string> = {};

    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    try {
      // Step 1: Search for libraryId
      const searchRes = await fetch(
        `https://context7.com/api/v2/libs/search?libraryName=${encodeURIComponent(libraryName)}`,
        {
          headers,
        },
      );

      if (!searchRes.ok) {
        return `Error searching for library '${libraryName}': Context7 returned ${searchRes.status} (${searchRes.statusText})`;
      }

      const searchData = (await searchRes.json()) as any;
      const libs = searchData.libraries || searchData.results || [];
      if (libs.length === 0) {
        return `Error: No library matching '${libraryName}' was found on Context7.`;
      }

      // Best match
      const libraryId = libs[0].libraryId || libs[0].id;
      if (!libraryId) {
        return `Error: Failed to resolve library ID for '${libraryName}'.`;
      }

      // Step 2: Fetch context snippets
      const contextRes = await fetch(
        `https://context7.com/api/v2/context?libraryId=${encodeURIComponent(libraryId)}&query=${encodeURIComponent(query)}&type=json`,
        {
          headers,
        },
      );

      if (!contextRes.ok) {
        return `Error fetching context from library '${libraryId}': Context7 returned ${contextRes.status}`;
      }

      const contextData = (await contextRes.json()) as any;
      const snippets = contextData.snippets || contextData.results || [];
      if (snippets.length === 0) {
        return `No documentation snippets found in library '${libraryId}' matching query '${query}'.`;
      }

      const formatted = snippets
        .map((snip: any, idx: number) => {
          return `[Snippet ${idx + 1}] (${snip.title || "Untitled"})\nURL: ${snip.url || "N/A"}\n\n${snip.content || snip.text || ""}`;
        })
        .join("\n\n---\n\n");

      return `### Documentation snippets for ${libraryId} matching "${query}":\n\n${formatted}`;
    } catch (err: any) {
      return `Error querying Context7 documentation: ${err.message}`;
    }
  },
};
