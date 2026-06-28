/**
 * Preload Script — US-8.1
 *
 * TypeScript preload with allowlisted IPC bindings.
 * The renderer process cannot directly access the filesystem or environment.
 * All communication goes through validated IPC channels.
 */

import { contextBridge, ipcRenderer } from "electron";
import { getAllowedChannels, validateIpcPayload } from "./ipc_contract.js";

// ─── Safe IPC Wrapper ────────────────────────────────────────────────

/**
 * Send a message on an allowlisted IPC channel with payload validation.
 * Throws if the channel is not allowlisted or the payload is invalid.
 */
function safeSend(channel: string, payload: any): void {
  const validation = validateIpcPayload(channel, payload);
  if (!validation.valid) {
    throw new Error(`IPC payload validation failed for '${channel}': ${validation.errors.join(", ")}`);
  }
  ipcRenderer.send(channel, payload);
}

/**
 * Invoke an allowlisted IPC channel and wait for the response.
 */
async function safeInvoke<T = any>(channel: string, payload?: any): Promise<T> {
  const validation = validateIpcPayload(channel, payload || {});
  if (!validation.valid) {
    throw new Error(`IPC payload validation failed for '${channel}': ${validation.errors.join(", ")}`);
  }
  return ipcRenderer.invoke(channel, payload);
}

/**
 * Listen for events from the main process on an allowlisted channel.
 */
function safeOn(channel: string, callback: (data: any) => void): () => void {
  const handler = (_event: any, data: any) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// ─── Exposed API ─────────────────────────────────────────────────────

/**
 * The API exposed to the renderer process via contextBridge.
 * Only these methods are available — no direct filesystem, env, or IPC access.
 */
const exposedApi = {
  // Session management
  session: {
    list: () => safeInvoke("session:list"),
    load: (sessionId: string) => safeInvoke("session:load", { sessionId }),
    delete: (sessionId: string, permanent: boolean = false) =>
      safeInvoke("session:delete", { sessionId, permanent }),
    sendMessage: (content: string, images: string[] = []) =>
      safeInvoke("session:send-message", { content, images }),
    abort: () => safeInvoke("session:abort"),
  },

  // Context & memory
  context: {
    manifest: () => safeInvoke("context:manifest"),
  },
  memory: {
    list: () => safeInvoke("memory:list"),
    update: (filename: string, content: string) =>
      safeInvoke("memory:update", { filename, content }),
    reviewList: () => safeInvoke("memory:review:list"),
    reviewAction: (factId: string, action: string, content: string = "") =>
      safeInvoke("memory:review:action", { factId, action, content }),
  },

  // Tools
  tools: {
    list: () => safeInvoke("tools:list"),
    approve: (toolName: string, approved: boolean) =>
      safeInvoke("tools:approve", { toolName, approved }),
  },

  // Settings
  settings: {
    get: () => safeInvoke("settings:get"),
    update: (section: string, values: any) =>
      safeInvoke("settings:update", { section, values }),
    setCredential: (key: string, value: string) =>
      safeInvoke("settings:set-credential", { key, value }),
  },

  // Sync
  sync: {
    status: () => safeInvoke("sync:status"),
    enable: (syncPath: string) => safeInvoke("sync:enable", { path: syncPath }),
    disable: () => safeInvoke("sync:disable"),
  },

  // Diff preview
  diff: {
    preview: (filePath: string, oldContent: string, newContent: string) =>
      safeInvoke("diff:preview", { filePath, oldContent, newContent }),
  },

  // Agent approval (US-2.4): approve / reject / request-revision (with note)
  approveToolCall: (approve: boolean, note?: string) =>
    safeInvoke("agent:approve", { approve, note }),

  // Agent events (main → renderer)
  on: {
    stream: (cb: (data: { type: string; content: string }) => void) => safeOn("agent:stream", cb),
    toolCall: (cb: (data: { toolName: string; toolArgs: any }) => void) => safeOn("agent:tool-call", cb),
    toolResult: (cb: (data: { toolName: string; result: string }) => void) => safeOn("agent:tool-result", cb),
    approval: (cb: (data: { toolName: string; toolArgs: any }) => void) => safeOn("agent:approval", cb),
    done: (cb: () => void) => safeOn("agent:done", cb),
    error: (cb: (data: { error: string }) => void) => safeOn("agent:error", cb),
  },
};

// ─── Context Bridge ──────────────────────────────────────────────────

/**
 * Expose the API to the renderer process.
 * contextIsolation: true ensures the renderer cannot access Node.js APIs directly.
 */
contextBridge.exposeInMainWorld("quiver", exposedApi);

// Export for type checking (this file is compiled to preload.js)
export type QuiverApi = typeof exposedApi;