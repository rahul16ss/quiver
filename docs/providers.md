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
- **Vertex AI Gemini** (customer-owned GCP — recommended for native PDF/document parts)
- Ollama (local or cloud)
- OpenRouter (cloud)
- OpenAI (cloud)
- Any `/v1/chat/completions` compatible endpoint

Quiver is provider-agnostic — no model name, base URL, or API key is baked into
the source. Configure via `.env`.

### Vertex AI (Gemini) — customer BYOK

**Billing rule:** every customer pays Google Cloud from **their own GCP project**.
Quiver does **not** ship, share, or fall back to a Conviction Studio Google
account. Inference cost lands on the engagement’s Google Cloud bill.

| Variable | Purpose |
|---|---|
| `VERTEX_PROJECT_ID` | Customer’s GCP project id (required for Vertex) |
| `VERTEX_LOCATION` | `global` (default) or a region such as `us-central1` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Absolute path to the **customer’s** service-account JSON (or use ADC / `gcloud auth application-default login`) |
| `LLM_MODEL_NAME` | Model id from the customer's provider (set in `.env` / Settings — never baked into Quiver source) |
| `CHECKER_LLM_MODEL_NAME` | Optional different model for the checker (same rule: env/Settings only) |
| `QUIVER_CHECKER_REMOTE_APPROVED` | Set `1` for non-Vertex remotes; Vertex BYOK auto-approves |

When `VERTEX_PROJECT_ID` is set and `LLM_API_BASE_URL` is empty, Quiver builds:

`https://aiplatform.googleapis.com/v1/projects/{PROJECT}/locations/{LOCATION}/endpoints/openapi`

Auth uses short-lived OAuth access tokens (`cloud-platform` scope) via
`google-auth-library` — Vertex’s OpenAI-compat endpoint rejects static Gemini
API keys. Optionally paste a fresh `gcloud auth print-access-token` into
`LLM_API_KEY` as a last resort; that token is still the customer’s identity.

Native multimodal path (images + PDFs as `file` / `image_url` parts) works with
Gemini on Vertex. Memory stays in the local Quiver harness (`~/.quiver`), not
in Google.

### Other OpenAI-compat providers

- `LLM_API_BASE_URL` — Provider endpoint
- `LLM_MODEL_NAME` — Model name
- `LLM_API_KEY` — API key (stored in the OS keychain when available)

## Web research

`web_search` and `scrape_url` prefer **Parallel.ai** when `PARALLEL_API_KEY` is
set. Ollama Pro web APIs are used only when the model host is actually Ollama —
a Vertex / Gemini credential is never treated as an Ollama Pro key.

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
`/chat/completions`. When Vertex is configured, the provider refreshes OAuth
Bearer tokens before each call. `ModelEvent` carries `toolCallIndex` on
`tool_call_start`/`tool_call_delta` so the agent can accumulate multiple
parallel tool calls correctly.
