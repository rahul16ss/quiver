# Quiver Adapters

## Overview

The Harness Adapter layer handles prompting shapes, tool format mapping, tokenizer overrides, memory citation styling, and parsing. It solves the Model-Harness-Fit problem by decoupling the transport layer (Provider) from the configuration and alignment layer (Adapter).

## Adapter Contract

```typescript
export interface HarnessAdapter {
  id: string;
  displayName: string;
  supports(model: ModelInfo): boolean;
  getDefaults(model: ModelInfo): AdapterDefaults;
  buildSystemPrompt(input: PromptAssemblyInput): string;
  formatTools(tools: ToolDefinition[]): unknown;
  parseModelEvent(event: any): ParsedModelEvent;
  parseToolCall(raw: unknown): ParsedToolCall | ToolCallParseError;
  formatMemoryCitation(source: MemorySource): string;
  parseMemoryCitations(output: string): MemoryCitation[];
  estimateTokensFallback(input: string): number;
}
```

## Built-in Adapters

### DefaultAdapter
- **ID:** `default`
- **Compatibility:** All OpenAI-compatible models
- **Citation Style:** XML (`<memory-citation doc="file">`)
- **Edit Mode:** string_replace

### GLMAdapter
- **ID:** `glm`
- **Compatibility:** GLM-5.2 and GLM-family models
- **Context Window:** 128K tokens
- **Max Output:** 8192 tokens
- **Citation Style:** XML

### ClaudeAdapter
- **ID:** `claude`
- **Compatibility:** Anthropic Claude models
- **Context Window:** 200K tokens
- **Edit Mode:** patch (unified diffs)
- **Citation Style:** XML

## Adapter Defaults

```typescript
export interface AdapterDefaults {
  maxContextTokens: number;
  maxOutputTokens: number;
  connectionTimeoutMs: number;
  streamStallTimeoutMs: number;
  toolCallTimeoutMs: number;
  preferredEditMode: "patch" | "string_replace" | "whole_file";
  citationStyle: "xml" | "markdown" | "none";
}
```

## Registration

Custom adapters can be registered via `registerAdapter()`. The system automatically selects the best adapter for a given model via `getAdapterForModel()`.
## Selection & Wiring

`getAdapterForModel(model)` evaluates **specific adapters first** (Claude, GLM)
and falls back to `DefaultAdapter` last. `DefaultAdapter.supports()` returns
`true` for every model, so it must be evaluated last or it shadows the
model-specific adapters.

The real agent loop resolves the adapter once per session
(`getAdapterForModel(modelInfo)`), pulls `getDefaults()` (e.g. `maxOutputTokens`
for the request payload), and routes tool definitions through
`adapter.formatTools()`. Tool format stays OpenAI function-calling for all
adapters because the transport is OpenAI-compatible — even Claude reached via
OpenRouter uses OpenAI tool format, so `ClaudeAdapter` intentionally does not
override `formatTools()`.
