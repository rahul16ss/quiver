/**
 * Preload Script (compiled) — US-8.1
 *
 * Strict IPC allowlisting with channel validation.
 * The renderer process cannot directly access the filesystem or environment.
 * All communication goes through allowlisted, validated IPC channels.
 */
const { contextBridge, ipcRenderer } = require("electron");

// ─── IPC Channel Allowlist ───────────────────────────────────────────
// Mirrors ui/ipc_contract.ts. Every channel the renderer is allowed to
// invoke is listed here. Any channel not in this set is rejected.

const ALLOWED_CHANNELS = new Set([
  // Config
  "config:load",
  "config:save",
  "config:isConfigured",
  // Agent
  "agent:start",
  "agent:send",
  "agent:approve",
  "agent:stop",
  // Sessions
  "sessions:list",
  "sessions:load",
  "sessions:delete",
  "sessions:touch",
  // Memory
  "memory:list",
  "memory:save",
  "memory:delete",
  "memory:loadCore",
  "memory:saveCore",
  "memory:review:list",
  "memory:review:action",
  // Skills
  "skills:list",
  "skills:read",
  "skills:save",
  // Settings
  "settings:get",
  "settings:update",
  "settings:set-credential",
  // Sync
  "sync:status",
  "sync:enable",
  "sync:disable",
  // Workspace
  "workspace:runTests",
  "workspace:selectDir",
  // Navigation
  "nav:loadMain",
  "nav:loadSettings",
  "nav:loadOnboarding",
  // Preview
  "preview:file",
  // Agent events (main → renderer only, no invoke)
  "agent:event",
  "agent:raw",
  "agent:stderr",
  "agent:exit",
  "agent:error",
]);

/**
 * Validate that a channel is allowlisted before invoking.
 * Throws if the channel is not in the allowlist.
 */
function assertChannelAllowed(channel) {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(
      `IPC channel '${channel}' is not allowlisted. ` +
        `This may indicate a security issue — the renderer is trying to ` +
        `access a channel that was not explicitly permitted.`,
    );
  }
}

/**
 * Safe invoke: validates channel is allowlisted, then delegates to ipcRenderer.
 * Accepts positional arguments (matching the main process handler signatures).
 */
async function safeInvoke(channel, ...args) {
  assertChannelAllowed(channel);
  return ipcRenderer.invoke(channel, ...args);
}

/**
 * Safe send: validates channel is allowlisted, then delegates to ipcRenderer.
 */
function safeSend(channel, ...args) {
  assertChannelAllowed(channel);
  ipcRenderer.send(channel, ...args);
}

/**
 * Safe on: validates channel is allowlisted, then registers a listener.
 * Returns an unsubscribe function.
 */
function safeOn(channel, callback) {
  assertChannelAllowed(channel);
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ─── Exposed API ─────────────────────────────────────────────────────

contextBridge.exposeInMainWorld("quiver", {
  // Config
  loadConfig: () => safeInvoke("config:load"),
  saveConfig: (config) => safeInvoke("config:save", config),
  isConfigured: () => safeInvoke("config:isConfigured"),

  // Agent
  startAgent: (config, resumeLatest) =>
    safeInvoke("agent:start", config, resumeLatest),
  sendToAgent: (text) => safeInvoke("agent:send", text),
  approveToolCall: (approve, note) =>
    safeInvoke("agent:approve", { approve, note }),
  stopAgent: () => safeInvoke("agent:stop"),

  // Sessions
  listSessions: () => safeInvoke("sessions:list"),
  loadSession: (filePath) => safeInvoke("sessions:load", filePath),
  deleteSession: (filePath) => safeInvoke("sessions:delete", filePath),
  touchSession: (filePath) => safeInvoke("sessions:touch", filePath),

  // Memory
  listMemory: () => safeInvoke("memory:list"),
  saveMemory: (name, content) => safeInvoke("memory:save", name, content),
  deleteMemory: (name) => safeInvoke("memory:delete", name),
  loadCoreMemory: () => safeInvoke("memory:loadCore"),
  saveCoreMemory: (core) => safeInvoke("memory:saveCore", core),

  // Memory review
  memoryReviewList: () => safeInvoke("memory:review:list"),
  memoryReviewAction: (factId, action, content) =>
    safeInvoke("memory:review:action", { factId, action, content }),

  // Skills
  listSkills: () => safeInvoke("skills:list"),
  readSkill: (skillName) => safeInvoke("skills:read", skillName),
  saveSkill: (skillName, content) =>
    safeInvoke("skills:save", skillName, content),

  // Workspace / Verification
  runTests: () => safeInvoke("workspace:runTests"),
  selectWorkspaceDir: () => safeInvoke("workspace:selectDir"),

  // Preview
  previewFile: (filePath) => safeInvoke("preview:file", filePath),

  // Navigation
  loadMain: () => safeInvoke("nav:loadMain"),
  loadSettings: () => safeInvoke("nav:loadSettings"),
  loadOnboarding: () => safeInvoke("nav:loadOnboarding"),

  // Events (agent → renderer)
  onAgentEvent: (callback) => safeOn("agent:event", callback),
  onAgentRaw: (callback) => safeOn("agent:raw", callback),
  onAgentStderr: (callback) => safeOn("agent:stderr", callback),
  onAgentExit: (callback) => safeOn("agent:exit", callback),
  onAgentError: (callback) => safeOn("agent:error", callback),
});