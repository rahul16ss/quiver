/**
 * Preload Script — US-8.1
 *
 * TypeScript preload with allowlisted IPC bindings.
 * The renderer process cannot directly access the filesystem or environment.
 * All communication goes through validated IPC channels.
 *
 * NOTE: This file is the TypeScript source for ui/preload.js.
 * Electron loads preload.js (CommonJS) at runtime. Both files must stay
 * in sync. The .js file includes the channel allowlist inline so it
 * works without a build step.
 */

import { contextBridge, ipcRenderer } from "electron";

// ─── IPC Channel Allowlist ───────────────────────────────────────────

const ALLOWED_CHANNELS = new Set<string>([
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
  // Agent events (main → renderer only)
  "agent:event",
  "agent:raw",
  "agent:stderr",
  "agent:exit",
  "agent:error",
]);

// ─── Safe IPC Wrappers ───────────────────────────────────────────────

function assertChannelAllowed(channel: string): void {
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(
      `IPC channel '${channel}' is not allowlisted. ` +
        `This may indicate a security issue — the renderer is trying to ` +
        `access a channel that was not explicitly permitted.`,
    );
  }
}

async function safeInvoke<T = any>(channel: string, ...args: any[]): Promise<T> {
  assertChannelAllowed(channel);
  return ipcRenderer.invoke(channel, ...args);
}

function safeSend(channel: string, ...args: any[]): void {
  assertChannelAllowed(channel);
  ipcRenderer.send(channel, ...args);
}

function safeOn(channel: string, callback: (data: any) => void): () => void {
  assertChannelAllowed(channel);
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ─── Exposed API ─────────────────────────────────────────────────────
//
// Flat API matching what app.js calls. Every method validates the channel
// is allowlisted before delegating to ipcRenderer.

const exposedApi = {
  // Config
  loadConfig: () => safeInvoke("config:load"),
  saveConfig: (config: any) => safeInvoke("config:save", config),
  isConfigured: () => safeInvoke("config:isConfigured"),

  // Agent
  startAgent: (config: any, resumeLatest: boolean) =>
    safeInvoke("agent:start", config, resumeLatest),
  sendToAgent: (text: string) => safeInvoke("agent:send", text),
  approveToolCall: (approve: boolean, note?: string) =>
    safeInvoke("agent:approve", { approve, note }),
  stopAgent: () => safeInvoke("agent:stop"),

  // Sessions
  listSessions: () => safeInvoke("sessions:list"),
  loadSession: (filePath: string) => safeInvoke("sessions:load", filePath),
  deleteSession: (filePath: string) => safeInvoke("sessions:delete", filePath),
  touchSession: (filePath: string) => safeInvoke("sessions:touch", filePath),

  // Memory
  listMemory: () => safeInvoke("memory:list"),
  saveMemory: (name: string, content: string) =>
    safeInvoke("memory:save", name, content),
  deleteMemory: (name: string) => safeInvoke("memory:delete", name),
  loadCoreMemory: () => safeInvoke("memory:loadCore"),
  saveCoreMemory: (core: any) => safeInvoke("memory:saveCore", core),

  // Memory review
  memoryReviewList: () => safeInvoke("memory:review:list"),
  memoryReviewAction: (factId: string, action: string, content: string) =>
    safeInvoke("memory:review:action", { factId, action, content }),

  // Skills
  listSkills: () => safeInvoke("skills:list"),
  readSkill: (skillName: string) => safeInvoke("skills:read", skillName),
  saveSkill: (skillName: string, content: string) =>
    safeInvoke("skills:save", skillName, content),

  // Workspace / Verification
  runTests: () => safeInvoke("workspace:runTests"),
  selectWorkspaceDir: () => safeInvoke("workspace:selectDir"),

  // Preview
  previewFile: (filePath: string) => safeInvoke("preview:file", filePath),

  // Navigation
  loadMain: () => safeInvoke("nav:loadMain"),
  loadSettings: () => safeInvoke("nav:loadSettings"),
  loadOnboarding: () => safeInvoke("nav:loadOnboarding"),

  // Events (agent → renderer)
  onAgentEvent: (callback: (data: any) => void) => safeOn("agent:event", callback),
  onAgentRaw: (callback: (data: any) => void) => safeOn("agent:raw", callback),
  onAgentStderr: (callback: (data: any) => void) => safeOn("agent:stderr", callback),
  onAgentExit: (callback: (data: any) => void) => safeOn("agent:exit", callback),
  onAgentError: (callback: (data: any) => void) => safeOn("agent:error", callback),
};

contextBridge.exposeInMainWorld("quiver", exposedApi);

export type QuiverApi = typeof exposedApi;