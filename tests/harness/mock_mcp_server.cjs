#!/usr/bin/env node
/**
 * Tiny MCP stdio server for offline e2e.
 * Speaks JSON-RPC 2.0 over newline-delimited stdin/stdout.
 */
const tools = [
  {
    name: "echo",
    description: "Echo back the input text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

let nextHandled = 0;
const rl = require("readline").createInterface({ input: process.stdin });

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  nextHandled++;
  if (msg.method === "initialize") {
    reply(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "mock-mcp", version: "1.0.0" },
      instructions: "Mock MCP server for Quiver e2e.",
    });
    return;
  }
  if (msg.method === "notifications/initialized" || msg.method === "initialized") {
    return;
  }
  if (msg.method === "tools/list") {
    reply(msg.id, { tools });
    return;
  }
  if (msg.method === "tools/call") {
    const text = msg.params?.arguments?.text ?? "";
    reply(msg.id, {
      content: [{ type: "text", text: `echo:${text}` }],
    });
    return;
  }
  reply(msg.id, {});
});
