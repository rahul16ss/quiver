/**
 * IPC Contract — US-8.1
 *
 * Strict IPC channel allowlist with payload schema validation.
 * All IPC channels are strictly allowlisted and payloads are schema-validated.
 * The renderer process cannot directly access the local filesystem or environment.
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface IpcChannelDef {
  channel: string;
  direction: "renderer-to-main" | "main-to-renderer";
  payloadSchema: Record<string, string>;
  description: string;
}

// ─── Allowlisted Channels ────────────────────────────────────────────

/**
 * The complete list of allowed IPC channels.
 * Any channel not in this list is rejected.
 */
export const IPC_CHANNELS: IpcChannelDef[] = [
  // ── Session Management ──
  {
    channel: "session:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all sessions for the current project",
  },
  {
    channel: "session:load",
    direction: "renderer-to-main",
    payloadSchema: { sessionId: "string" },
    description: "Load a specific session by ID",
  },
  {
    channel: "session:delete",
    direction: "renderer-to-main",
    payloadSchema: { sessionId: "string", permanent: "boolean" },
    description: "Delete or archive a session",
  },
  {
    channel: "session:send-message",
    direction: "renderer-to-main",
    payloadSchema: { content: "string", images: "string[]" },
    description: "Send a user message to the agent",
  },
  {
    channel: "session:abort",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Abort the current agent execution",
  },

  // ── Context & Memory ──
  {
    channel: "context:manifest",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Get the current context manifest (memory files, tools, model info)",
  },
  {
    channel: "memory:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all memory files with sizes and previews",
  },
  {
    channel: "memory:update",
    direction: "renderer-to-main",
    payloadSchema: { filename: "string", content: "string" },
    description: "Update a memory file",
  },
  {
    channel: "memory:review:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List pending memory facts for review",
  },
  {
    channel: "memory:review:action",
    direction: "renderer-to-main",
    payloadSchema: { factId: "string", action: "string", content: "string" },
    description: "Process a memory review action (accept/edit/reject/pin/expire)",
  },

  // ── Tools ──
  {
    channel: "tools:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all registered tools",
  },
  {
    channel: "tools:approve",
    direction: "renderer-to-main",
    payloadSchema: { toolName: "string", approved: "boolean" },
    description: "Approve or reject a generated tool",
  },

  // ── Settings ──
  {
    channel: "settings:get",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Get the current configuration",
  },
  {
    channel: "settings:update",
    direction: "renderer-to-main",
    payloadSchema: { section: "string", values: "object" },
    description: "Update a configuration section",
  },
  {
    channel: "settings:set-credential",
    direction: "renderer-to-main",
    payloadSchema: { key: "string", value: "string" },
    description: "Store a credential in the OS keychain",
  },

  // ── Sync ──
  {
    channel: "sync:status",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Get cloud sync status",
  },
  {
    channel: "sync:enable",
    direction: "renderer-to-main",
    payloadSchema: { path: "string" },
    description: "Enable cloud sync with the given path",
  },
  {
    channel: "sync:disable",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Disable cloud sync",
  },

  // ── Agent Events (main → renderer) ──
  {
    channel: "agent:stream",
    direction: "main-to-renderer",
    payloadSchema: { type: "string", content: "string" },
    description: "Streaming text from the agent",
  },
  {
    channel: "agent:tool-call",
    direction: "main-to-renderer",
    payloadSchema: { toolName: "string", toolArgs: "object" },
    description: "Tool call event",
  },
  {
    channel: "agent:tool-result",
    direction: "main-to-renderer",
    payloadSchema: { toolName: "string", result: "string" },
    description: "Tool result event",
  },
  {
    channel: "agent:approval",
    direction: "main-to-renderer",
    payloadSchema: { toolName: "string", toolArgs: "object" },
    description: "Approval request event",
  },
  {
    channel: "agent:done",
    direction: "main-to-renderer",
    payloadSchema: {},
    description: "Agent execution complete",
  },
  {
    channel: "agent:error",
    direction: "main-to-renderer",
    payloadSchema: { error: "string" },
    description: "Agent error event",
  },

  // ── Diff Preview ──
  {
    channel: "diff:preview",
    direction: "renderer-to-main",
    payloadSchema: { filePath: "string", oldContent: "string", newContent: "string" },
    description: "Request a diff preview",
  },
  // ── Agent Approval (US-2.4) ──
  {
    channel: "agent:approve",
    direction: "renderer-to-main",
    payloadSchema: { approve: "boolean" },
    description: "Approve / reject / request-revision for a tool call",
  },
];

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Get the allowlist of channel names.
 */
export function getAllowedChannels(): string[] {
  return IPC_CHANNELS.map((c) => c.channel);
}

/**
 * Check if a channel is allowlisted.
 */
export function isChannelAllowed(channel: string): boolean {
  return IPC_CHANNELS.some((c) => c.channel === channel);
}

/**
 * Validate a payload against the channel's schema.
 *
 * @param channel - The IPC channel name
 * @param payload - The payload to validate
 * @returns { valid: boolean; errors: string[] }
 */
export function validateIpcPayload(channel: string, payload: any): { valid: boolean; errors: string[] } {
  const def = IPC_CHANNELS.find((c) => c.channel === channel);
  if (!def) {
    return { valid: false, errors: [`Channel '${channel}' is not allowlisted`] };
  }

  const errors: string[] = [];
  const schema = def.payloadSchema;

  for (const [key, type] of Object.entries(schema)) {
    if (payload === undefined || payload === null) {
      errors.push(`Payload is null or undefined`);
      break;
    }

    if (!(key in payload)) {
      errors.push(`Missing required field: '${key}'`);
      continue;
    }

    const value = payload[key];
    const expectedType = type as string;

    // Basic type checking
    if (expectedType === "string" && typeof value !== "string") {
      errors.push(`Field '${key}' must be a string, got ${typeof value}`);
    } else if (expectedType === "number" && typeof value !== "number") {
      errors.push(`Field '${key}' must be a number, got ${typeof value}`);
    } else if (expectedType === "boolean" && typeof value !== "boolean") {
      errors.push(`Field '${key}' must be a boolean, got ${typeof value}`);
    } else if (expectedType === "object" && (typeof value !== "object" || value === null)) {
      errors.push(`Field '${key}' must be an object, got ${typeof value}`);
    } else if (expectedType === "string[]" && !Array.isArray(value)) {
      errors.push(`Field '${key}' must be an array, got ${typeof value}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get a channel definition by name.
 */
export function getChannelDef(channel: string): IpcChannelDef | null {
  return IPC_CHANNELS.find((c) => c.channel === channel) || null;
}