/**
 * IPC Contract — US-8.1
 *
 * The single source of truth for the Electron IPC channel surface. This file
 * is a *reflection* of the real implementation in `ui/preload.ts` (the
 * renderer-side allowlist) and `ui/main.ts` (the main-side handlers). It must
 * never diverge; the `IPC-CONTRACT-IN-SYNC` acceptance check enforces that the
 * channels listed below exactly match the `ALLOWED_CHANNELS` set in preload.
 *
 * The renderer process cannot directly access the local filesystem or
 * environment. All communication goes through these strictly allowlisted,
 * validated IPC channels.
 *
 * Direction:
 *   "renderer-to-main" — the renderer invokes (ipcRenderer.invoke).
 *   "main-to-renderer" — the main process pushes events (webContents.send),
 *                          the renderer listens (ipcRenderer.on).
 */

// ─── Types ───────────────────────────────────────────────────────────

export interface IpcChannelDef {
  channel: string;
  direction: "renderer-to-main" | "main-to-renderer";
  payloadSchema: Record<string, string>;
  description: string;
}

// ─── Renderer → Main (invoke) ────────────────────────────────────────

export const IPC_CHANNELS: IpcChannelDef[] = [
  // ── Config ──
  {
    channel: "config:load",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Load the current Quiver configuration",
  },
  {
    channel: "config:save",
    direction: "renderer-to-main",
    payloadSchema: { config: "object" },
    description: "Persist a full configuration object",
  },
  {
    channel: "config:isConfigured",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Return whether onboarding is complete (credentials present)",
  },

  // ── Agent ──
  {
    channel: "agent:start",
    direction: "renderer-to-main",
    payloadSchema: { config: "object", resumeLatest: "boolean" },
    description: "Spawn the Quiver CLI agent process",
  },
  {
    channel: "agent:send",
    direction: "renderer-to-main",
    payloadSchema: { text: "string" },
    description: "Send a user message to the running agent",
  },
  {
    channel: "agent:approve",
    direction: "renderer-to-main",
    payloadSchema: { approve: "boolean", note: "string" },
    description: "Approve or reject a pending tool-call / approval gate",
  },
  {
    channel: "agent:stop",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Terminate the running agent process",
  },

  // ── Sessions ──
  {
    channel: "sessions:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all sessions for the current project",
  },
  {
    channel: "sessions:load",
    direction: "renderer-to-main",
    payloadSchema: { filePath: "string" },
    description: "Load a session log file for replay",
  },
  {
    channel: "sessions:delete",
    direction: "renderer-to-main",
    payloadSchema: { filePath: "string" },
    description: "Delete a session log file",
  },
  {
    channel: "sessions:touch",
    direction: "renderer-to-main",
    payloadSchema: { filePath: "string" },
    description: "Mark a session as most-recently-used",
  },

  // ── Memory ──
  {
    channel: "memory:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all memory files with sizes and previews",
  },
  {
    channel: "memory:save",
    direction: "renderer-to-main",
    payloadSchema: { name: "string", content: "string" },
    description: "Create or overwrite a named memory file",
  },
  {
    channel: "memory:delete",
    direction: "renderer-to-main",
    payloadSchema: { name: "string" },
    description: "Delete a named memory file",
  },
  {
    channel: "memory:loadCore",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Load the core memory (persona/system identity)",
  },
  {
    channel: "memory:saveCore",
    direction: "renderer-to-main",
    payloadSchema: { core: "object" },
    description: "Persist the core memory (persona/system identity)",
  },
  {
    channel: "memory:review:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List pending memory facts awaiting review",
  },
  {
    channel: "memory:review:action",
    direction: "renderer-to-main",
    payloadSchema: { factId: "string", action: "string", content: "string" },
    description: "Process a memory review action (accept/edit/reject/pin/expire)",
  },

  // ── Skills ──
  {
    channel: "skills:list",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "List all installed skills",
  },
  {
    channel: "skills:read",
    direction: "renderer-to-main",
    payloadSchema: { skillName: "string" },
    description: "Read a skill's SKILL.md content",
  },
  {
    channel: "skills:save",
    direction: "renderer-to-main",
    payloadSchema: { skillName: "string", content: "string" },
    description: "Create or overwrite a skill's SKILL.md",
  },

  // ── Settings ──
  {
    channel: "settings:get",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Get the current configuration view for the settings panel",
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
    description: "Report cloud-sync status",
  },
  {
    channel: "sync:enable",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Enable cloud sync",
  },
  {
    channel: "sync:disable",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Disable cloud sync",
  },

  // ── Workspace ──
  {
    channel: "workspace:runTests",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Run the project's acceptance gate and report the result",
  },
  {
    channel: "workspace:selectDir",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Open a directory picker and switch the active workspace",
  },

  // ── Navigation ──
  {
    channel: "nav:loadMain",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Load the main chat view",
  },
  {
    channel: "nav:loadSettings",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Load the settings view",
  },
  {
    channel: "nav:loadOnboarding",
    direction: "renderer-to-main",
    payloadSchema: {},
    description: "Load the onboarding view",
  },

  // ── Preview ──
  {
    channel: "preview:file",
    direction: "renderer-to-main",
    payloadSchema: { filePath: "string" },
    description: "Open a file in the preview panel",
  },
];

// ─── Main → Renderer (events) ─────────────────────────────────────────
//
// These are pushed from the main process to the renderer via
// `webContents.send`. The renderer subscribes with `ipcRenderer.on`
// (exposed as the `on*` methods on the preload API). They are part of the
// allowlist in `ui/preload.ts` so the preload validates them before
// registering listeners.

export const IPC_EVENTS: IpcChannelDef[] = [
  {
    channel: "agent:event",
    direction: "main-to-renderer",
    payloadSchema: { message: "object" },
    description: "A structured agent event (tool-call, tool-result, verdict, …)",
  },
  {
    channel: "agent:raw",
    direction: "main-to-renderer",
    payloadSchema: { line: "string" },
    description: "A raw stdout line from the agent process",
  },
  {
    channel: "agent:stderr",
    direction: "main-to-renderer",
    payloadSchema: { data: "string" },
    description: "A chunk of stderr from the agent process",
  },
  {
    channel: "agent:exit",
    direction: "main-to-renderer",
    payloadSchema: { code: "number" },
    description: "The agent process exited with the given code",
  },
  {
    channel: "agent:error",
    direction: "main-to-renderer",
    payloadSchema: { error: "string" },
    description: "The agent process emitted a fatal error",
  },
];

// Convenience: every channel name known to the contract.
export const ALL_CONTRACT_CHANNELS: string[] = [
  ...IPC_CHANNELS.map((c) => c.channel),
  ...IPC_EVENTS.map((c) => c.channel),
];

// ─── Helpers (used by the GUI acceptance gate) ──────────────────────

/**
 * The allowlist of every channel name known to the contract
 * (renderer→main invokes *and* main→renderer events). Mirrors the
 * `ALLOWED_CHANNELS` set in `ui/preload.ts`.
 */
export function getAllowedChannels(): string[] {
  return ALL_CONTRACT_CHANNELS.slice();
}

/**
 * Whether a channel is part of the allowlisted contract surface.
 */
export function isChannelAllowed(channel: string): boolean {
  return ALL_CONTRACT_CHANNELS.includes(channel);
}

/**
 * Validate a payload against a channel's declared schema.
 */
export function validateIpcPayload(
  channel: string,
  payload: any,
): { valid: boolean; errors: string[] } {
  const def = [...IPC_CHANNELS, ...IPC_EVENTS].find((c) => c.channel === channel);
  if (!def) {
    return { valid: false, errors: [`Channel '${channel}' is not allowlisted`] };
  }
  const errors: string[] = [];
  const schema = def.payloadSchema;
  if (Object.keys(schema).length === 0) {
    return { valid: true, errors };
  }
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
    const expected = type as string;
    if (expected === "string" && typeof value !== "string") {
      errors.push(`Field '${key}' must be a string, got ${typeof value}`);
    } else if (expected === "number" && typeof value !== "number") {
      errors.push(`Field '${key}' must be a number, got ${typeof value}`);
    } else if (expected === "boolean" && typeof value !== "boolean") {
      errors.push(`Field '${key}' must be a boolean, got ${typeof value}`);
    } else if (expected === "object" && (typeof value !== "object" || value === null)) {
      errors.push(`Field '${key}' must be an object, got ${typeof value}`);
    } else if (expected === "string[]" && !Array.isArray(value)) {
      errors.push(`Field '${key}' must be an array, got ${typeof value}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Look up a channel definition by name.
 */
export function getChannelDef(channel: string): IpcChannelDef | null {
  return [...IPC_CHANNELS, ...IPC_EVENTS].find((c) => c.channel === channel) || null;
}
