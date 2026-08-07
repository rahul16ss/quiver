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

### OpenRouter (sole cloud gateway)

OpenRouter is the only cloud model gateway. Quiver sends each request through
`QuiverOpenRouterClient`/`QuiverOpenRouterProvider`, which enforce the approved
profile, ZDR/provider policy, `data_collection=deny`, explicit provider order,
no automatic fallback, cancellation, retries, and native-document capability
certification.

Customer model roles are configured in the engagement pack. The current
reference lineup is:

- planner: `openai/gpt-5.6-sol`
- text maker: `openai/gpt-5.6-luna`
- text checker: `google/gemini-3.5-flash`
- native-document maker: `anthropic/claude-sonnet-5`
- native-document checker: `moonshotai/kimi-k3`
- reviewer/failsafe: `anthropic/claude-opus-5`

Configure the gateway with `OPENROUTER_API_KEY` in the OS credential store and
`OPENROUTER_MODEL_PROFILE=auto` (or an explicitly approved profile). Native
PDF/Office MIME types remain fail-closed until the exact route passes its
contract test.

### Local/private escape hatch

For air-gapped or restricted deployments, configure an OpenAI-compatible local
endpoint:

- `LLM_API_BASE_URL` — local/private provider endpoint
- `LLM_MODEL_NAME` — local model name
- `LLM_API_KEY` — optional local key (stored in the OS credential store when available)

Restricted/MNPI policy refuses cloud routing when no approved local route is
available. Quiver does not provide a separate Vertex or Ollama cloud path.

## Web research

`web_search` and `scrape_url` prefer **Parallel.ai** when `PARALLEL_API_KEY` is
set. There is no Ollama-cloud research path and no Vertex research path.

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
`/chat/completions`. OpenRouter requests enforce ZDR / `data_collection=deny`
per call via `QuiverOpenRouterProvider`. `ModelEvent` carries `toolCallIndex` on
`tool_call_start`/`tool_call_delta` so the agent can accumulate multiple
parallel tool calls correctly.
