# Quiver Providers

## Overview

The Model Provider layer handles transport, auth, streaming, cancellation, rate limits, token counting, and provider-specific error handling. It is decoupled from the Harness Adapter layer.

## Provider Interface

```typescript
export interface ModelProvider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  getModelInfo(modelId: string): Promise<ModelInfo>;
  streamChat(request: ChatRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
  countTokens?(input: TokenCountInput): Promise<TokenCountResult>;
}
```

## Model Info

```typescript
export interface ModelInfo {
  id: string;
  displayName: string;
  providerId: string;
  contextWindowTokens: number;
  supportsTools: boolean;
  supportsParallelToolCalls: boolean;
  supportsImages: boolean;
  supportsStreaming: boolean;
  supportsReasoningSummaries: boolean;
  inputCostPerMillionTokens?: number;
  outputCostPerMillionTokens?: number;
}
```

## Built-in Provider

### OpenAICompatibleProvider
Works with any OpenAI-compatible API endpoint:
- Ollama (local)
- OpenRouter (cloud)
- OpenAI (cloud)
- Any `/v1/chat/completions` compatible endpoint

Configuration via `.env`:
- `LLM_API_BASE_URL` — Provider endpoint
- `LLM_MODEL_NAME` — Model name (source-controlled default; override only)
- `OLLAMA_API_KEY` — API key (optional for local; the single key for the LLM, Ollama, and vision adapters)

## Vision Provider

Separate provider for multimodal/vision routing. It reuses the single
`OLLAMA_API_KEY` (no separate vision key required):
- `VISION_MODEL_NAME` — Vision model name (source-controlled default; override only)
- `VISION_MODEL_BASE_URL` — Vision endpoint (default: `http://localhost:11434/v1`)

## Streaming Events

The provider emits `ModelEvent` objects via async iterable:
- `text_delta` — Incremental text content
- `tool_call_start` — Tool call begins
- `tool_call_delta` — Tool call arguments stream
- `tool_call_end` — Tool call completes
- `done` — Stream finished
- `error` — Error occurred
## Wiring

`getActiveProvider()` is the transport used by the real agent loop
(`src/agent.ts`); the loop no longer performs an inline `fetch()` to
`/chat/completions`. `ModelEvent` now carries `toolCallIndex` on
`tool_call_start`/`tool_call_delta` so the agent can accumulate multiple
parallel tool calls correctly (the first streaming delta carries the id and
name together on most OpenAI-compatible servers).
