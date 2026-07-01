/**
 * MCP Client — connects to MCP servers (stdio + HTTP), discovers tools,
 * and registers them as Quiver tools.
 *
 * Implements the MCP protocol (JSON-RPC 2.0) natively without external SDK
 * dependencies. Supports:
 * - stdio transport (spawns server process, communicates over stdin/stdout)
 * - Streamable HTTP transport (POST requests with JSON-RPC body)
 * - Tool discovery (tools/list)
 * - Tool invocation (tools/call)
 * - Server instructions (returned during initialize)
 *
 * Protocol reference: https://modelcontextprotocol.io/specification/latest
 */

import { ChildProcess, spawn } from "child_process";
import { Tool } from "../registry.js";
import {
  McpServerConfig,
  StdioServerConfig,
  HttpServerConfig,
  isHttpConfig,
} from "./config.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: any;
}

interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export class McpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: any) => void }
  >();
  private buffer = "";
  public instructions: string | undefined;
  public serverName: string;
  public serverVersion: string | undefined;
  public connected = false;

  constructor(
    public name: string,
    private config: McpServerConfig,
  ) {
    this.serverName = name;
  }

  async connect(): Promise<void> {
    if (isHttpConfig(this.config)) {
      await this.connectHttp(this.config);
    } else {
      await this.connectStdio(this.config);
    }
    this.connected = true;
  }

  // ── stdio transport ──────────────────────────────────────────────

  private async connectStdio(cfg: StdioServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const env = { ...process.env, ...cfg.env };
      this.proc = spawn(cfg.command, cfg.args || [], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.on("error", (err) => {
        reject(
          new Error(
            `Failed to spawn MCP server "${this.name}": ${err.message}`,
          ),
        );
      });

      this.proc.on("exit", (code) => {
        this.connected = false;
        // Reject any pending requests
        for (const [, { reject }] of this.pending) {
          reject(
            new Error(`MCP server "${this.name}" exited with code ${code}`),
          );
        }
        this.pending.clear();
      });

      this.proc.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString();
        this.processBuffer();
      });

      this.proc.stderr?.on("data", (chunk: Buffer) => {
        // MCP servers log to stderr — pass through silently
        const text = chunk.toString().trim();
        if (text) {
          console.log(`  [mcp:${this.name}] ${text}`);
        }
      });

      // Send initialize request
      this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "quiver", version: "1.0.0" },
      })
        .then((result) => {
          this.serverName = result?.serverInfo?.name || this.name;
          this.serverVersion = result?.serverInfo?.version;
          this.instructions = result?.instructions;
          // Send initialized notification
          this.notify("notifications/initialized", {});
          resolve();
        })
        .catch(reject);
    });
  }

  private processBuffer(): void {
    while (true) {
      const newlineIdx = this.buffer.indexOf("\n");
      if (newlineIdx === -1) break;
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.handleMessage(msg);
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  private handleMessage(msg: any): void {
    if (
      msg.id !== undefined &&
      (msg.result !== undefined || msg.error !== undefined)
    ) {
      // Response to a request
      const handler = this.pending.get(msg.id);
      if (handler) {
        this.pending.delete(msg.id);
        if (msg.error) {
          handler.reject(
            new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`),
          );
        } else {
          handler.resolve(msg.result);
        }
      }
    }
    // Notifications from server (no id) — we don't handle these yet
  }

  private rpc(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin) {
        reject(new Error(`MCP server "${this.name}" is not connected (stdio)`));
        return;
      }
      const id = this.nextId++;
      const req: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify(req) + "\n");
      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(
            new Error(
              `MCP request "${method}" to "${this.name}" timed out (30s)`,
            ),
          );
        }
      }, 30000);
    });
  }

  private notify(method: string, params?: any): void {
    if (!this.proc || !this.proc.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.proc.stdin.write(msg + "\n");
  }

  // ── HTTP transport ──────────────────────────────────────────────

  private httpUrl: string = "";
  private httpHeaders: Record<string, string> = {};

  private async connectHttp(cfg: HttpServerConfig): Promise<void> {
    this.httpUrl = cfg.url;
    this.httpHeaders = cfg.headers || {};

    const result = await this.httpRpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "quiver", version: "1.0.0" },
    });

    this.serverName = result?.serverInfo?.name || this.name;
    this.serverVersion = result?.serverInfo?.version;
    this.instructions = result?.instructions;

    // Send initialized notification
    await this.httpNotify("notifications/initialized", {});
  }

  private async httpRpc(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    const response = await fetch(this.httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.httpHeaders },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `MCP HTTP request to "${this.name}" failed: ${response.status} ${response.statusText}`,
      );
    }

    const msg: JsonRpcResponse = await response.json();
    if (msg.error) {
      throw new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`);
    }
    return msg.result;
  }

  private async httpNotify(method: string, params?: any): Promise<void> {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    await fetch(this.httpUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.httpHeaders },
      body,
    }).catch(() => {
      // Notifications are fire-and-forget
    });
  }

  // ── Public API ──────────────────────────────────────────────────

  async listTools(): Promise<McpToolDef[]> {
    if (isHttpConfig(this.config)) {
      const result = await this.httpRpc("tools/list", {});
      return result?.tools || [];
    } else {
      return this.rpc("tools/list", {});
    }
  }

  async callTool(
    name: string,
    args: Record<string, any>,
  ): Promise<McpToolResult> {
    if (isHttpConfig(this.config)) {
      return this.httpRpc("tools/call", { name, arguments: args });
    } else {
      return this.rpc("tools/call", { name, arguments: args });
    }
  }

  async close(): Promise<void> {
    this.connected = false;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.pending.clear();
  }
}

export class McpManager {
  private connections: Map<string, McpConnection> = new Map();
  private toolToServer: Map<string, string> = new Map(); // tool name → server name

  /**
   * Connect to all configured MCP servers and return Quiver Tool wrappers
   * for all discovered tools.
   */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<Tool[]> {
    const tools: Tool[] = [];
    const connectionPromises = Object.entries(servers).map(
      async ([name, cfg]) => {
        try {
          const conn = new McpConnection(name, cfg);
          await conn.connect();
          this.connections.set(name, conn);

          const mcpTools = await conn.listTools();

          if (conn.instructions) {
            console.log(`  [mcp:${name}] ${mcpTools.length} tools available`);
          } else {
            console.log(`  [mcp:${name}] ${mcpTools.length} tools available`);
          }

          for (const mcpTool of mcpTools) {
            // Prefix tool name with server name to avoid collisions
            const quiverToolName = `mcp_${name}_${mcpTool.name}`;
            this.toolToServer.set(quiverToolName, name);

            tools.push(this.wrapMcpTool(quiverToolName, name, mcpTool, conn));
          }
        } catch (err: any) {
          console.warn(
            `  ⚠️  MCP server "${name}" failed to connect: ${err.message}`,
          );
        }
      },
    );

    await Promise.all(connectionPromises);
    return tools;
  }

  /**
   * Wrap an MCP tool definition as a Quiver Tool.
   * We use a permissive Zod schema (all params optional strings) since MCP
   * tools provide their own JSON Schema that the LLM uses directly.
   */
  private wrapMcpTool(
    quiverName: string,
    serverName: string,
    mcpTool: McpToolDef,
    conn: McpConnection,
  ): Tool {
    // Build a permissive Zod schema from the MCP inputSchema
    const { z } = require("zod");

    // Create a schema that accepts any object — the MCP server validates
    const schema = z
      .object({})
      .passthrough()
      .describe(
        mcpTool.description || `MCP tool: ${mcpTool.name} (from ${serverName})`,
      );

    return {
      name: quiverName,
      description: mcpTool.description
        ? `[MCP:${serverName}] ${mcpTool.description}`
        : `[MCP:${serverName}] ${mcpTool.name}`,
      parameters: schema,
      execute: async (args: any) => {
        try {
          const result = await conn.callTool(mcpTool.name, args || {});

          if (result.isError) {
            const errorText = result.content
              ?.map((c) => c.text || "")
              .join("\n");
            return `MCP tool "${mcpTool.name}" returned an error: ${errorText || "Unknown error"}`;
          }

          // Extract text content from the MCP result
          const parts =
            result.content?.map((c) => {
              if (c.type === "text") return c.text || "";
              if (c.type === "image")
                return `[Image data: ${c.mimeType || "unknown"}]`;
              if (c.type === "resource") return `[Resource: ${c.data || ""}]`;
              return c.text || JSON.stringify(c);
            }) || [];

          return parts.join("\n") || "(no output)";
        } catch (err: any) {
          return `MCP tool "${mcpTool.name}" failed: ${err.message}`;
        }
      },
    };
  }

  /**
   * Get server instructions for inclusion in the system prompt.
   */
  getInstructions(): string {
    const parts: string[] = [];
    for (const [name, conn] of this.connections) {
      if (conn.instructions) {
        parts.push(`## MCP Server: ${name}\n${conn.instructions}`);
      }
    }
    return parts.join("\n\n");
  }

  /**
   * Get a summary of connected servers for display.
   */
  getStatus(): Array<{ name: string; tools: number; connected: boolean }> {
    return Array.from(this.connections.entries()).map(([name, conn]) => ({
      name,
      tools: Array.from(this.toolToServer.values()).filter((s) => s === name)
        .length,
      connected: conn.connected,
    }));
  }

  /**
   * Close all MCP connections.
   */
  async closeAll(): Promise<void> {
    const closePromises = Array.from(this.connections.values()).map((c) =>
      c.close(),
    );
    await Promise.all(closePromises);
    this.connections.clear();
    this.toolToServer.clear();
  }
}

// Singleton instance
export const mcpManager = new McpManager();
