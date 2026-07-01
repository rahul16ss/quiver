/**
 * MCP Config — loads MCP server definitions from .quiver/mcp.json
 * Format matches the standard MCP config used by Claude Desktop, goose, etc.
 *
 * Example .quiver/mcp.json:
 * {
 *   "mcpServers": {
 *     "filesystem": {
 *       "command": "npx",
 *       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
 *       "env": {}
 *     },
 *     "remote": {
 *       "url": "https://example.com/mcp"
 *     }
 *   }
 * }
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

function isHttpConfig(c: McpServerConfig): c is HttpServerConfig {
  return "url" in c;
}

export { isHttpConfig };

export function loadMcpConfig(): McpConfig | null {
  // Look for .quiver/mcp.json in the workspace, then ~/.quiver/mcp.json
  const localPath = path.join(process.cwd(), ".quiver", "mcp.json");
  const globalPath = path.join(os.homedir(), ".quiver", "mcp.json");

  for (const p of [localPath, globalPath]) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
          return parsed as McpConfig;
        }
        console.warn(`⚠️  MCP config at ${p} is missing "mcpServers" key.`);
      } catch (err: any) {
        console.warn(`⚠️  Failed to parse MCP config at ${p}: ${err.message}`);
      }
    }
  }

  return null;
}
