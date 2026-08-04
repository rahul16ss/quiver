/**
 * Mock OpenAI-compatible chat completions server for deterministic e2e tests.
 *
 * Speaks the same SSE stream format Quiver's DefaultProvider expects:
 *   POST /v1/chat/completions  (also accepts /chat/completions)
 *   data: {"choices":[{"delta":{...}}]}
 *   data: [DONE]
 *
 * Scripts are selected by matching the latest user message content against
 * ordered ScriptRule patterns. Each rule returns either plain text or one or
 * more tool calls. After tools run, the next user/tool round can match a
 * different rule (or the same rule's `followUp` text).
 */
import * as http from "http";
import { AddressInfo } from "net";

export interface ToolCallScript {
  id?: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface ScriptReply {
  /** Plain assistant text (no tools). */
  text?: string;
  /** One or more tool calls. */
  toolCalls?: ToolCallScript[];
  /** Optional finish_reason override (default stop / tool_calls). */
  finishReason?: string;
  /** Optional HTTP status to force an error response. */
  status?: number;
  /** Optional error body when status >= 400. */
  errorBody?: string;
}

export interface ScriptRule {
  /** Substring or RegExp matched against the latest user / tool message blob. */
  match: string | RegExp;
  /** Reply for the matching request. May be a function of the request body. */
  reply: ScriptReply | ((body: any) => ScriptReply);
  /** If true, this rule is removed after one successful match. */
  once?: boolean;
}

export interface MockLlmServer {
  baseUrl: string;
  port: number;
  requests: any[];
  close: () => Promise<void>;
  reset: (rules?: ScriptRule[]) => void;
  setRules: (rules: ScriptRule[]) => void;
}

function latestUserBlob(body: any): string {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  const parts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" || m?.role === "tool") {
      const c =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? "");
      parts.push(c);
      // Keep walking a short way so tool-result rounds still match.
      if (parts.length >= 3) break;
    }
  }
  return parts.join("\n");
}

function resolveReply(rules: ScriptRule[], body: any): ScriptReply {
  const blob = latestUserBlob(body);
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const ok =
      typeof rule.match === "string"
        ? blob.includes(rule.match)
        : rule.match.test(blob);
    if (!ok) continue;
    const reply =
      typeof rule.reply === "function" ? rule.reply(body) : rule.reply;
    if (rule.once) rules.splice(i, 1);
    return reply;
  }
  // Default: echo a short acknowledgement so the agent can finish.
  return {
    text: `mock-ok: received ${blob.slice(0, 80) || "(empty)"}`,
  };
}

function writeSse(res: http.ServerResponse, reply: ScriptReply): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const model = "mock-model";
  const id = `chatcmpl-mock-${Date.now()}`;

  if (reply.toolCalls && reply.toolCalls.length > 0) {
    reply.toolCalls.forEach((tc, index) => {
      const callId = tc.id || `call_${index}_${Date.now()}`;
      const args =
        typeof tc.arguments === "string"
          ? tc.arguments
          : JSON.stringify(tc.arguments);
      // Name chunk
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: callId,
                    type: "function",
                    function: { name: tc.name, arguments: "" },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      // Arguments chunk
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index,
                    id: callId,
                    function: { arguments: args },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    });
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: reply.finishReason || "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      })}\n\n`,
    );
  } else {
    const text = reply.text ?? "mock-ok";
    // Stream character-ish chunks so the agent's text_delta path is exercised.
    const chunkSize = Math.max(1, Math.ceil(text.length / 4));
    for (let i = 0; i < text.length; i += chunkSize) {
      const slice = text.slice(i, i + chunkSize);
      res.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          model,
          choices: [{ index: 0, delta: { content: slice } }],
        })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: reply.finishReason || "stop",
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: Math.ceil(text.length / 4),
          total_tokens: 10 + Math.ceil(text.length / 4),
        },
      })}\n\n`,
    );
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

export async function startMockLlmServer(
  initialRules: ScriptRule[] = [],
): Promise<MockLlmServer> {
  let rules = [...initialRules];
  const requests: any[] = [];

  const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model" }] }));
      return;
    }

    const isChat =
      req.method === "POST" &&
      (req.url === "/v1/chat/completions" ||
        req.url === "/chat/completions" ||
        req.url?.endsWith("/chat/completions"));
    if (!isChat) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `unknown ${req.method} ${req.url}` } }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: any = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }
    requests.push(body);

    const reply = resolveReply(rules, body);
    if (reply.status && reply.status >= 400) {
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(
        reply.errorBody ||
          JSON.stringify({ error: { message: "mock forced error", type: "mock_error" } }),
      );
      return;
    }
    writeSse(res, reply);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
    reset: (next?: ScriptRule[]) => {
      requests.length = 0;
      rules = next ? [...next] : [];
    },
    setRules: (next: ScriptRule[]) => {
      rules = [...next];
    },
  };
}

/** Convenience: a one-shot text reply for any prompt. */
export function alwaysText(text: string): ScriptRule[] {
  return [{ match: /.*/, reply: { text } }];
}

/** Convenience: call a tool once, then reply with text on the follow-up. */
export function toolThenText(
  match: string | RegExp,
  tool: ToolCallScript,
  followUpText: string,
): ScriptRule[] {
  return [
    {
      match,
      once: true,
      reply: { toolCalls: [tool] },
    },
    {
      match: /.*/,
      reply: { text: followUpText },
    },
  ];
}
