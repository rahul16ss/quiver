/**
 * LLM Stream — fetch + SSE stream reading with timeout/abort safety.
 *
 * Extracted from agent.ts for modularity and testability.
 *
 * Key safety features:
 *   - AbortController persists through fetch AND stream reading
 *   - Connection timeout (45s primary, 20s vision) aborts stalled connections
 *   - Stream read timeout (30s) aborts stalled streams
 *   - reader.cancel() called on all error paths to release TCP connections
 *   - Empty stream detection (no [DONE], no content, no tool calls)
 *   - Stream error parsing (server-side error messages)
 *   - finish_reason handling (length, content_filter)
 */

import picocolors from "picocolors";
import { config } from "./config.js";
import type { Message, ToolCall } from "./types.js";
import type { SessionLogger } from "./session_logger.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface StreamResult {
  content: string;
  toolCalls: Record<number, { id?: string; name?: string; arguments: string }>;
  finishReason: string | null;
  streamDone: boolean;
}

export interface FetchOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: Message[];
  tools?: any[];
  isOllama: boolean;
  isVision: boolean;
  maxTokens?: number;
}

export interface FetchResult {
  response: Response | null;
  error: Error | null;
  visionFallbackTriggered: boolean;
}

// ─── Spinner interface (agent.ts provides the branded implementation) ─

export interface ISpinner {
  start(): void;
  stop(): void;
}

// ─── LLM Fetch with Retry ────────────────────────────────────────────

/**
 * Fetch from the LLM API with retry, timeout, and vision fallback.
 *
 * Returns the Response on success, or triggers vision fallback if the
 * vision model is unreachable.
 */
export async function fetchLLM(
  opts: FetchOptions,
  logger: SessionLogger,
  spinner: ISpinner,
): Promise<FetchResult> {
  const maxRetries = opts.isVision ? 1 : 3;
  const connectionTimeout = opts.isVision ? 20000 : 45000;
  let visionFallbackTriggered = false;

  const effectiveMaxTokens = opts.isVision
    ? Math.min(config.maxContextTokens, 8192)
    : config.maxContextTokens;

  const payload: any = {
    model: opts.model,
    messages: opts.messages,
    temperature: 0.2,
    max_tokens: 8192,
  };

  if (opts.isOllama) {
    payload.num_ctx = effectiveMaxTokens;
    payload.options = { num_ctx: effectiveMaxTokens };
  }

  if (opts.tools && opts.tools.length > 0) {
    payload.tools = opts.tools;
    payload.tool_choice = "auto";
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  payload.stream = true;

  let response: Response | null = null;
  let retries = 0;
  let streamController: AbortController | null = null;
  let connectionTimeoutId: ReturnType<typeof setTimeout> | null = null;

  while (retries <= maxRetries) {
    streamController = new AbortController();
    connectionTimeoutId = setTimeout(() => {
      try {
        streamController!.abort();
      } catch {}
    }, connectionTimeout);

    try {
      response = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: streamController.signal,
      });
      break;
    } catch (err: any) {
      if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
      streamController = null;
      retries++;
      if (retries > maxRetries) {
        spinner.stop();
        if (opts.isVision) {
          console.error(
            picocolors.yellow(
              `\n⚠️  Vision model '${opts.model}' unreachable after ${maxRetries + 1} attempts. Falling back to primary model (images will be described as text).`,
            ),
          );
          await logger.logEvent("api_error", {
            error: `Vision model unreachable: ${err.message}`,
            retries,
            fallback: "primary_model",
          });
          visionFallbackTriggered = true;
          break;
        }
        console.error(
          picocolors.red(
            `\n❌ Failed to connect to LLM server after ${maxRetries + 1} attempts: ${err.message}`,
          ),
        );
        await logger.logEvent("api_error", {
          error: err.message,
          retries,
        });
        return {
          response: null,
          error: err,
          visionFallbackTriggered: false,
        };
      }
      const delay = Math.min(1000 * Math.pow(2, retries), 8000);
      spinner.stop();
      console.log(
        picocolors.yellow(
          `   ⚠️  Connection failed (attempt ${retries}/${maxRetries}), retrying in ${delay}ms...`,
        ),
      );
      spinner.start();
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  spinner.stop();

  if (visionFallbackTriggered) {
    return {
      response: null,
      error: null,
      visionFallbackTriggered: true,
    };
  }

  if (!response) {
    return {
      response: null,
      error: new Error("Failed to get response from LLM server."),
      visionFallbackTriggered: false,
    };
  }

  if (!response.ok) {
    const errorText = await response.text();
    const msg = `LLM Server returned error (${response.status}): ${errorText}`;
    console.error(picocolors.red(`\n❌ ${msg}`));
    await logger.logEvent("api_error", {
      status: response.status,
      response: errorText,
    });
    return {
      response: null,
      error: new Error(msg),
      visionFallbackTriggered: false,
    };
  }

  // Return the response and the streamController/timeoutId for the caller
  // to use during stream reading. We store them on the response object.
  (response as any)._streamController = streamController;
  (response as any)._connectionTimeoutId = connectionTimeoutId;

  return { response, error: null, visionFallbackTriggered: false };
}

// ─── SSE Stream Reader ───────────────────────────────────────────────

/**
 * Read an SSE stream from the LLM API response.
 *
 * Returns accumulated content, tool calls, and finish reason.
 * Throws on timeout, stream error, empty stream, or truncation.
 *
 * @param response The fetch Response object
 * @param logger SessionLogger for error logging
 * @param spinner Spinner for UX
 * @param onToken Callback for each content token
 * @param onEvent Optional callback for events
 * @param estimateTokens Function to estimate token count
 */
export async function readLLMStream(
  response: Response,
  logger: SessionLogger,
  spinner: ISpinner,
  onToken: (token: string) => void,
  estimateTokens: (text: string) => number,
): Promise<StreamResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("LLM response body is not readable.");
  }

  const streamController: AbortController | null = (response as any)
    ._streamController;
  const connectionTimeoutId: ReturnType<typeof setTimeout> | null = (
    response as any
  )._connectionTimeoutId;

  let assistantContent = "";
  let accumulatedToolCalls: Record<
    number,
    { id?: string; name?: string; arguments: string }
  > = {};
  const decoder = new TextDecoder();
  let buffer = "";
  let streamDone = false;
  let finishReason: string | null = null;

  while (true) {
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<any>((_, reject) => {
      timer = setTimeout(() => {
        if (streamController) {
          try {
            streamController.abort();
          } catch {}
        }
        reject(
          new Error("LLM stream stalled: No data received for 30 seconds."),
        );
      }, 30000);
    });

    let done = false;
    let value: Uint8Array | undefined;

    try {
      const readPromise = reader.read();
      // Swallow the losing rejection so an abort-triggered AbortError does
      // not surface as an unhandledRejection (see agent.ts for details).
      readPromise.catch(() => {});
      const res = await Promise.race([readPromise, timeoutPromise]);
      if (timer) clearTimeout(timer);
      done = res.done;
      value = res.value;
    } catch (err: any) {
      if (timer) clearTimeout(timer);
      try {
        reader.cancel();
      } catch {}
      spinner.stop();
      console.error(picocolors.red(`\n❌ Stream error: ${err.message}`));
      // Re-throw — callers should handle retry logic.
      // The inline code in agent.ts has a unified retry loop; if this module
      // is wired in, it should wrap readLLMStream with the same retry pattern.
      throw err;
    }

    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    streamDone = false;
    for (const line of lines) {
      const cleanLine = line.trim();
      if (!cleanLine || !cleanLine.startsWith("data: ")) continue;
      if (cleanLine === "data: [DONE]") {
        streamDone = true;
        break;
      }

      let parsed: any;
      try {
        parsed = JSON.parse(cleanLine.substring(6));
      } catch {
        continue;
      }

      if (parsed.error) {
        const errMsg = parsed.error.message || JSON.stringify(parsed.error);
        try {
          reader.cancel();
        } catch {}
        if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
        spinner.stop();
        console.error(
          picocolors.red(`\n❌ Stream error from LLM server: ${errMsg}`),
        );
        await logger.logEvent("api_error", { error: errMsg });
        throw new Error(`LLM Stream Error: ${errMsg}`);
      }

      const choice = parsed.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (choice.finish_reason === "length") {
        try {
          reader.cancel();
        } catch {}
        if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
        spinner.stop();
        const errMsg =
          "Model output was truncated (reached max token limit or context limit). Try running `/compact` to shrink conversation history.";
        console.error(picocolors.red(`\n❌ Truncated: ${errMsg}`));
        await logger.logEvent("api_error", {
          error: "length_limit_reached",
        });
        throw new Error(errMsg);
      }

      if (choice.finish_reason === "content_filter") {
        try {
          reader.cancel();
        } catch {}
        if (connectionTimeoutId) clearTimeout(connectionTimeoutId);
        spinner.stop();
        const errMsg =
          "Model response was blocked by the safety content filter.";
        console.error(picocolors.red(`\n❌ Blocked: ${errMsg}`));
        await logger.logEvent("api_error", {
          error: "content_filter_blocked",
        });
        throw new Error(errMsg);
      }

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.content) {
        assistantContent += delta.content;
        onToken(delta.content);
      }

      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const index = tcDelta.index;
          if (index === undefined) continue;

          if (!accumulatedToolCalls[index]) {
            accumulatedToolCalls[index] = { arguments: "" };
          }

          if (tcDelta.id) {
            accumulatedToolCalls[index].id = tcDelta.id;
          }
          if (tcDelta.function?.name) {
            accumulatedToolCalls[index].name = tcDelta.function.name;
          }
          if (tcDelta.function?.arguments) {
            accumulatedToolCalls[index].arguments += tcDelta.function.arguments;
          }
        }
      }
    }
    if (streamDone) break;
  }

  // Stream reading complete — clear the connection timeout
  if (connectionTimeoutId) clearTimeout(connectionTimeoutId);

  // Check for empty stream
  if (!streamDone) {
    const hasContent =
      assistantContent.length > 0 ||
      Object.keys(accumulatedToolCalls).length > 0;
    if (!hasContent) {
      const errMsg =
        "Stream closed by server with empty response (no [DONE] marker, no content, no tool calls). This usually indicates an API key issue, rate limit, model crash, or context length overflow. Try running `/compact` to shrink conversation history.";
      spinner.stop();
      console.error(picocolors.red(`\n❌ ${errMsg}`));
      await logger.logEvent("api_error", {
        error: "empty_stream_no_done",
      });
      throw new Error(errMsg);
    }
  }

  return {
    content: assistantContent,
    toolCalls: accumulatedToolCalls,
    finishReason,
    streamDone,
  };
}
