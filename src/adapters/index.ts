/**
 * Adapters Index — Re-exports the harness adapter contract
 */

export * from "./types.js";
export { getAdapter, getAdapterForModel, registerAdapter, listAdapters } from "./types.js";
export { DefaultAdapter, GLMAdapter, ClaudeAdapter } from "./types.js";