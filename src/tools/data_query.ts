/**
 * Data Query Tool — US-17.16 / Build Order #6.
 *
 * Unified tool for the agent to query data connectors.
 * The agent calls `data_query` with an action (search, fetch, list) and
 * the framework routes to the appropriate connector plugin.
 *
 * No vendor-specific UI — the agent sees one tool, not one per vendor.
 */

import { z } from "zod";
import type { Tool } from "../registry.js";
import {
  globalConnectorRegistry,
  loadConnectors,
  type ConnectorResult,
  type SearchResult,
} from "../connectors/framework.js";

let connectorsLoaded = false;

async function ensureConnectorsLoaded(): Promise<void> {
  if (!connectorsLoaded) {
    await loadConnectors();
    connectorsLoaded = true;
  }
}

const dataQuerySchema = z.object({
  action: z
    .enum(["search", "fetch", "list", "status"])
    .describe(
      "Action to perform: search for entities, fetch structured data, list connectors, or check status",
    ),
  connector: z
    .string()
    .optional()
    .describe(
      "Connector name (e.g., 'edgar', 'fred'). Required for 'fetch'. Optional for 'search' (searches all if omitted).",
    ),
  query: z.string().optional().describe("Search query (for 'search' action)"),
  identifier: z
    .string()
    .optional()
    .describe(
      "Entity identifier (for 'fetch' action, e.g., ticker, CIK, series ID)",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe("Specific fields to fetch (optional, connector-specific)"),
});

export const tool: Tool = {
  name: "data_query",
  description:
    "Query data connectors (SEC EDGAR, FRED, FMP, etc.) for structured financial data. " +
    "Actions: 'list' to see available connectors, 'search' to find entities, 'fetch' to get structured data. " +
    "Each result carries provenance metadata (vendor, dataset, timestamp, API ref) for lineage tracking.",
  parameters: dataQuerySchema,
  async execute(args: z.infer<typeof dataQuerySchema>) {
    await ensureConnectorsLoaded();

    const { action, connector, query, identifier, fields } = args;

    switch (action) {
      case "list": {
        const connectors = globalConnectorRegistry.list();
        if (connectors.length === 0) {
          return {
            content:
              "No data connectors registered. Place connector plugins in .quiver/connectors/ directory.",
          };
        }
        const lines = connectors.map(
          (c) =>
            `  ${c.name} (${c.label}) — types: ${c.dataTypes.join(", ")}${c.requiresAuth ? " [requires API key]" : ""}`,
        );
        return { content: `Available data connectors:\n${lines.join("\n")}` };
      }

      case "search": {
        if (!query) {
          return { content: "Error: 'query' is required for 'search' action." };
        }
        const results = await globalConnectorRegistry.search(query, connector);
        if (results.length === 0) {
          return {
            content: `No results found${connector ? ` from connector '${connector}'` : ""} for query: "${query}"`,
          };
        }
        const lines = results.map(
          (r: SearchResult & { connector: string }) =>
            `  [${r.connector}] ${r.identifier}: ${r.name}${r.description ? ` — ${r.description}` : ""} (${r.dataType})`,
        );
        return {
          content: `Found ${results.length} result(s):\n${lines.join("\n")}`,
          structured: results,
        };
      }

      case "fetch": {
        if (!connector) {
          return {
            content: "Error: 'connector' is required for 'fetch' action.",
          };
        }
        if (!identifier) {
          return {
            content: "Error: 'identifier' is required for 'fetch' action.",
          };
        }
        try {
          const result = await globalConnectorRegistry.fetch(
            connector,
            identifier,
            fields,
          );
          const provenance = `Source: ${result.provenance.vendor} / ${result.provenance.dataset} @ ${result.provenance.timestamp}${result.cachedAt ? " (cached)" : ""}`;
          return {
            content: `${provenance}\n\n${JSON.stringify(result.data, null, 2)}`,
            structured: result,
          };
        } catch (err: any) {
          return {
            content: `Error fetching from '${connector}': ${err.message}`,
          };
        }
      }

      case "status": {
        const connectors = globalConnectorRegistry.list();
        return {
          content: `Connector framework status:\n  Registered: ${connectors.length} connector(s)\n  Cache: ${globalConnectorRegistry["cacheDir"] || "~/.quiver/connector-cache"}\n  TTL: ${globalConnectorRegistry["cacheTTL"] || 3600}s`,
        };
      }

      default:
        return { content: `Unknown action: ${action}` };
    }
  },
};
