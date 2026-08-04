/**
 * Minimal live stress suite — smallest checks that prove the critical path
 * works with the currently configured provider (env-driven; no baked models).
 *
 * Run: npx tsx scripts/stress_min_live.ts
 */
import "dotenv/config";
import { config, validateRuntimeConfig } from "../src/config.js";
import {
  extractToolCallPassthrough,
  mergeToolCallPassthrough,
  shapeOutboundToolCall,
  toolCallHasPassthrough,
} from "../src/providers/tool_call_passthrough.js";
import {
  isVertexConfigured,
  resolveCheckerBaseUrl,
  resolveLlmBearerToken,
  resolveMakerBaseUrl,
} from "../src/providers/vertex_auth.js";
import { getActiveProvider } from "../src/providers/index.js";
import {
  getSensitivityConfig,
  resetSensitivityConfigCache,
  applySensitivityRouting,
} from "../src/security/sensitivity.js";
import { isOllamaHost } from "../src/providers/vertex_auth.js";

type Result = { name: string; ok: boolean; detail: string };

const results: Result[] = [];

function pass(name: string, detail = "ok") {
  results.push({ name, ok: true, detail });
  console.log(`  ✔ ${name} — ${detail}`);
}
function fail(name: string, detail: string) {
  results.push({ name, ok: false, detail });
  console.log(`  ✗ ${name} — ${detail}`);
}

async function main() {
  console.log("\n══ Quiver minimal live stress ══\n");

  // 1. Config / BYOK preflight
  const pf = validateRuntimeConfig();
  if (!pf.valid) fail("preflight", pf.errors.join("; "));
  else pass("preflight", `model=${config.llmModelName} warnings=${pf.warnings.length}`);

  if (pf.warnings.some((w) => /Conviction Studio/i.test(w))) {
    fail("preflight-quiet", "vendor legal copy must not appear at startup");
  } else {
    pass("preflight-quiet", "no vendor scare copy");
  }

  // 2. Opaque tool-call pass-through (unit, no network)
  const raw = {
    id: "c1",
    type: "function",
    function: { name: "ping", arguments: "{}" },
    extra_content: { google: { thought_signature: "SIG" } },
    vendor_future: 1,
  };
  const bag = extractToolCallPassthrough(raw);
  const shaped = shapeOutboundToolCall({
    id: "c1",
    function: { name: "ping", arguments: "{}" },
    passthrough: bag,
  });
  if (
    bag?.extra_content &&
    bag?.vendor_future === 1 &&
    shaped.extra_content &&
    shaped.vendor_future === 1 &&
    toolCallHasPassthrough({ passthrough: bag })
  ) {
    pass("passthrough-unit", "unknown tool_call fields preserved");
  } else {
    fail("passthrough-unit", JSON.stringify({ bag, shaped }));
  }
  const merged = mergeToolCallPassthrough({ a: 1 }, { b: 2, a: 3 });
  if (merged?.a === 3 && merged?.b === 2) pass("passthrough-merge", "later wins");
  else fail("passthrough-merge", JSON.stringify(merged));

  // 3. Sensitivity engagement config
  try {
    resetSensitivityConfigCache();
    const sens = getSensitivityConfig(process.cwd());
    const route = applySensitivityRouting("hello health check");
    pass(
      "sensitivity",
      `default=${sens.defaultTier} route=${route.route}`,
    );
  } catch (e: any) {
    fail("sensitivity", e.message);
  }

  // 4. Auth + base URL
  const base = resolveMakerBaseUrl();
  if (!base) fail("maker-url", "empty base URL");
  else pass("maker-url", base.replace(/projects\/[^/]+/, "projects/***"));

  let token = "";
  try {
    token = await resolveLlmBearerToken({
      forceVertex: isVertexConfigured(),
    });
    if (!token || token.length < 10) fail("auth", "empty token");
    else pass("auth", `token_len=${token.length} vertex=${isVertexConfigured()}`);
  } catch (e: any) {
    fail("auth", e.message);
  }

  const checker = resolveCheckerBaseUrl();
  pass(
    "checker-url",
    checker
      ? checker.replace(/projects\/[^/]+/, "projects/***")
      : "(same as maker / unset)",
  );

  // 5–8 live model probes (only if auth ok)
  if (token && base && config.llmModelName) {
    const url = `${base.replace(/\/$/, "")}/chat/completions`;
    const model = config.llmModelName;

    // 5. Plain chat (generous max_tokens — some hosts spend budget on internal tokens)
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: "Reply with exactly the four characters: PONG",
            },
          ],
          max_tokens: 1024,
          stream: false,
        }),
      });
      const body: any = await r.json();
      const text = String(body?.choices?.[0]?.message?.content || "");
      const errMsg =
        body?.[0]?.error?.message ||
        body?.error?.message ||
        (!r.ok ? JSON.stringify(body).slice(0, 160) : "");
      if (r.ok && body?.choices?.[0] && /PONG/i.test(text)) {
        pass("live-chat", text.slice(0, 40));
      } else if (r.ok && body?.choices?.[0] && text.trim()) {
        // Chat path works; model paraphrased — still a pass for connectivity
        pass("live-chat", `ok paraphrase=${text.slice(0, 40)}`);
      } else {
        fail(
          "live-chat",
          `HTTP ${r.status} ${errMsg || text || JSON.stringify(body).slice(0, 120)}`,
        );
      }
    } catch (e: any) {
      fail("live-chat", e.message);
    }

    // 6. Tool call + echo passthrough round-trip via provider stream
    try {
      const provider = getActiveProvider();
      const tools = [
        {
          type: "function",
          function: {
            name: "ping",
            description: "ping",
            parameters: {
              type: "object",
              properties: { n: { type: "number" } },
            },
          },
        },
      ];
      let passthrough: Record<string, unknown> | undefined;
      let callId = "";
      let args = "";
      for await (const ev of provider.streamChat(
        {
          model,
          messages: [
            {
              role: "user",
              content: "Call the ping tool with n=1. Do not reply in text.",
            },
          ],
          tools,
          temperature: 0,
          maxTokens: 256,
          stream: true,
        },
        new AbortController().signal,
      )) {
        if (ev.type === "tool_call_start") {
          if (ev.toolCallId) callId = ev.toolCallId;
          const bag = ev.toolCallPassthrough || ev.toolCallExtraContent;
          if (bag) passthrough = mergeToolCallPassthrough(passthrough, bag);
        }
        if (ev.type === "tool_call_delta") {
          if (ev.toolCallId && !callId) callId = ev.toolCallId;
          if (ev.toolCallArguments) args += ev.toolCallArguments;
          const bag = ev.toolCallPassthrough || ev.toolCallExtraContent;
          if (bag) passthrough = mergeToolCallPassthrough(passthrough, bag);
        }
        if (ev.type === "error") throw new Error(ev.error);
      }
      if (!callId) {
        fail("live-tool-capture", "provider did not emit a tool call");
      } else {
        pass(
          "live-tool-capture",
          `id=${callId} passthrough_keys=${Object.keys(passthrough || {}).join(",") || "(none)"}`,
        );

        // Round-trip: echo tool history with captured passthrough
        const outbound = shapeOutboundToolCall({
          id: callId,
          function: { name: "ping", arguments: args || '{"n":1}' },
          passthrough,
        });
        const r2 = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              {
                role: "user",
                content: "Call the ping tool with n=1. Do not reply in text.",
              },
              { role: "assistant", tool_calls: [outbound], content: null },
              {
                role: "tool",
                tool_call_id: callId,
                content: "pong",
              },
            ],
            tools,
            max_tokens: 128,
            stream: false,
          }),
        });
        const body2: any = await r2.json();
        if (r2.ok) {
          pass("live-tool-echo", `HTTP 200 finish=${body2?.choices?.[0]?.finish_reason}`);
        } else {
          const err =
            body2?.[0]?.error?.message ||
            body2?.error?.message ||
            JSON.stringify(body2).slice(0, 200);
          fail("live-tool-echo", `HTTP ${r2.status} ${err}`);
        }

        // Negative: bare tool history should 400 on hosts that require echo fields
        const r3 = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "user", content: "Call ping" },
              {
                role: "assistant",
                tool_calls: [
                  {
                    id: callId,
                    type: "function",
                    function: { name: "ping", arguments: '{"n":1}' },
                  },
                ],
              },
              { role: "tool", tool_call_id: callId, content: "pong" },
            ],
            tools,
            max_tokens: 64,
            stream: false,
          }),
        });
        if (!r3.ok) {
          pass("live-tool-bare-rejected", `HTTP ${r3.status} (heal path needed)`);
        } else {
          pass("live-tool-bare-ok", "provider accepts bare history (no echo required)");
        }
      }
    } catch (e: any) {
      fail("live-tool", e.message);
    }
  } else {
    fail("live-skipped", "auth/base/model missing — cannot probe live");
  }

  // 9. Web tool default must not treat Vertex as Ollama
  const baseHost = resolveMakerBaseUrl() || config.llmBaseUrl;
  if (config.parallelApiKey && !isOllamaHost(baseHost)) {
    pass("web-parallel-first", "Parallel key set; host is not Ollama");
  } else if (isOllamaHost(baseHost)) {
    pass("web-ollama-host", "Ollama host — Ollama web APIs allowed");
  } else {
    fail("web-default", "no PARALLEL_API_KEY and not on Ollama");
  }

  // Summary
  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n══ ${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, ${failed.length} failed` : "") +
      " ══\n",
  );
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
