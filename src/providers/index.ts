/**
 * Provider Index — Re-exports for clean imports
 */

export * from "./types.js";
export { getActiveProvider, getLocalProvider, OpenAICompatibleProvider } from "./types.js";
export {
  buildVertexOpenAiBaseUrl,
  isOllamaHost,
  isVertexConfigured,
  isVertexHost,
  resolveCheckerBaseUrl,
  resolveLlmBearerToken,
  resolveMakerBaseUrl,
} from "./vertex_auth.js";
export {
  extractToolCallPassthrough,
  mergeToolCallPassthrough,
  shapeOutboundToolCall,
  toolCallHasPassthrough,
  type ToolCallPassthrough,
} from "./tool_call_passthrough.js";