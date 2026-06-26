const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quiver", {
  // Config
  loadConfig: () => ipcRenderer.invoke("config:load"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  isConfigured: () => ipcRenderer.invoke("config:isConfigured"),

  // Agent
  startAgent: (config) => ipcRenderer.invoke("agent:start", config),
  sendToAgent: (text) => ipcRenderer.invoke("agent:send", text),
  approveToolCall: (approve) => ipcRenderer.invoke("agent:approve", approve),
  stopAgent: () => ipcRenderer.invoke("agent:stop"),

  // Memory
  listMemory: () => ipcRenderer.invoke("memory:list"),
  saveMemory: (name, content) => ipcRenderer.invoke("memory:save", name, content),

  // Navigation
  loadMain: () => ipcRenderer.invoke("nav:loadMain"),
  loadSettings: () => ipcRenderer.invoke("nav:loadSettings"),
  loadOnboarding: () => ipcRenderer.invoke("nav:loadOnboarding"),

  // Events (agent -> renderer)
  onAgentEvent: (callback) => ipcRenderer.on("agent:event", (_e, data) => callback(data)),
  onAgentRaw: (callback) => ipcRenderer.on("agent:raw", (_e, data) => callback(data)),
  onAgentStderr: (callback) => ipcRenderer.on("agent:stderr", (_e, data) => callback(data)),
  onAgentExit: (callback) => ipcRenderer.on("agent:exit", (_e, data) => callback(data)),
  onAgentError: (callback) => ipcRenderer.on("agent:error", (_e, data) => callback(data)),
});
