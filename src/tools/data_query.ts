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
import { globalConnectorRegistry, loadConnectors } from "../connectors/framework.js";
import { registerConnectorProvenance } from "./evidence.js";

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
    .describe("Entity identifier (for 'fetch' action, e.g., ticker, CIK, series ID)"),
  fields: z
    .array(z.string())
    .optional()
    .describe("Specific fields to fetch (optional, connector-specific)"),
  data_sensitivity: z
    .enum(["synthetic", "public", "internal", "confidential", "client-confidential", "mnpi"])
    .optional()
    .describe(
      "Sensitivity of the identifier/query being sent externally. Required as 'public' or 'synthetic' for connectors marked sendsIdentifiers.",
    ),
});

export const tool: Tool = {
  name: "data_query",
  description:
    "Query data connectors (SEC EDGAR, FRED, FMP, etc.) for structured financial data. " +
    "Actions: 'list' to see available connectors, 'search' to find entities, 'fetch' to get structured data. " +
    "Each result carries provenance metadata (vendor, dataset, timestamp, API ref) for lineage tracking. " +
    "When a connector sends identifiers externally, data_sensitivity must be explicitly public or synthetic and the engagement route must permit the call; confidential and unknown inputs are blocked.",
  parameters: dataQuerySchema,
  async execute(args: z.infer<typeof dataQuerySchema>) {
    await ensureConnectorsLoaded();

    const { action, connector, query, identifier, fields, data_sensitivity } = args;

    const blockedExternalCall = (
      connectors: Array<{ name: string; sendsIdentifiers: boolean }>,
    ) => {
      const blocked = connectors
        .filter((c) => c.sendsIdentifiers)
        .map((c) => c.name)
        .filter(() => data_sensitivity !== "public" && data_sensitivity !== "synthetic");
      return blocked.length > 0
        ? `External identifier/query blocked for connector(s): ${blocked.join(", ")}. Declare data_sensitivity as public or synthetic only after confirming the engagement permits sending it externally.`
        : null;
    };

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
        const connectorInstances = connector
          ? [globalConnectorRegistry.get(connector)].filter(
              (item): item is NonNullable<typeof item> => Boolean(item),
            )
          : globalConnectorRegistry.getAll();
        const blocked = blockedExternalCall(connectorInstances);
        if (blocked) return { content: `Error: ${blocked}` };
        const results = await globalConnectorRegistry.search(query, connector);
        if (results.length === 0) {
          return {
            content: `No results found${connector ? ` from connector '${connector}'` : ""} for query: "${query}"`,
          };
        }
        const lines = results.map((r) => {
          if ("error" in r) {
            return `  [${r.connector}] ERROR: ${r.error}`;
          }
          registerConnectorProvenance(r.provenance, data_sensitivity || "public");
          return `  [${r.connector}] ${r.identifier}: ${r.name}${r.description ? ` — ${r.description}` : ""} (${r.dataType})`;
        });
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
        const connectorInstance = globalConnectorRegistry.get(connector);
        if (!connectorInstance) {
          return { content: `Error fetching from '${connector}': connector is not registered.` };
        }
        const blocked = blockedExternalCall([connectorInstance]);
        if (blocked) return { content: `Error: ${blocked}` };
        try {
          const result = await globalConnectorRegistry.fetch(connector, identifier, fields);
          const provenance = `Source: ${result.provenance.vendor} / ${result.provenance.dataset} @ ${result.provenance.timestamp}${result.cachedAt ? " (cached)" : ""}`;
          const evidenceRegistered = registerConnectorProvenance(
            result.provenance,
            data_sensitivity || "public",
          );
          return {
            content: `${provenance}\n\n${JSON.stringify(result.data, null, 2)}`,
            structured: { ...result, evidenceRegistered },
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
