import { promises as fs } from "fs";
import * as path from "path";
import { ToolRegistry } from "./registry.js";

export interface AgentCard {
  name: string;
  description: string;
  protocolVersion: string;
  schemaVersion: string;
  capabilities: {
    name: string;
    description: string;
    parameters: any;
  }[];
  endpoints: {
    type: string;
    url: string;
  }[];
}

/**
 * Generates an A2A Agent Card detailing the agent's identity,
 * protocols, tools, and available communication endpoints.
 */
export function generateAgentCard(registry: ToolRegistry): AgentCard {
  const tools = registry.getAllTools();
  const capabilities = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters:
      ToolRegistry.getOpenAIToolDefinition(t).function.parameters || {},
  }));

  return {
    name: "Quiver-Agent",
    description:
      "Self-evolving autonomous agent harness for coding and research in the terminal.",
    protocolVersion: "2026.06.25", // A2A standard representation
    schemaVersion: "draft-01",
    capabilities,
    endpoints: [
      {
        type: "stdio-jsonrpc",
        url: "ipc://quiver-stdin-stdout",
      },
      {
        type: "http-rest",
        url: "http://localhost:3000/v1/agent",
      },
    ],
  };
}

/**
 * Saves the generated Agent Card to the workspace root for compliance reporting.
 */
export async function exportAgentCard(registry: ToolRegistry): Promise<string> {
  const card = generateAgentCard(registry);
  const cardPath = path.resolve("agent_card.json");
  await fs.writeFile(cardPath, JSON.stringify(card, null, 2), "utf8");
  return cardPath;
}
