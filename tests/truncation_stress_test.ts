/**
 * Output Truncation Recovery Stress Test
 *
 * Exercises every code path in the finish_reason: "length" handling:
 *   1. Mid-text truncation → continuation prompt injected, model resumes
 *   2. Mid-tool-call truncation → retry with doubled maxOutputTokens
 *   3. Exhausted retries → proceeds with partial response + warning
 *   4. Normal completion (finish_reason: "stop") → no truncation handling
 *   5. Content filter (finish_reason: "content_filter") → no truncation handling
 *   6. Multiple consecutive truncations → continuation chain works
 *   7. Truncation after tool call started but before args → retry path
 *   8. Truncation with empty content → still handled
 *
 * Also validates source-code-level wiring:
 *   - streamFinishReason variable is captured from done event
 *   - finish_reason === "length" branch exists
 *   - truncationRetries counter with maxTruncationRetries guard
 *   - "Continue from where you left off" continuation prompt
 *   - Doubled maxOutputTokens (capped at 16384)
 *   - truncation_recovery and truncation_recovery_exhausted log events
 */

import picocolors from "picocolors";
import { existsSync, readFileSync } from "fs";
import * as path from "path";

// ─── Test framework (minimal, self-contained) ────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(picocolors.green(`  ✔ ${message}`));
  } else {
    failed++;
    failures.push(message);
    console.log(picocolors.red(`  ✗ ${message}`));
  }
}

function assertEqual(actual: any, expected: any, message: string) {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(picocolors.green(`  ✔ ${message}`));
  } else {
    failed++;
    failures.push(
      `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    console.log(picocolors.red(`  ✗ ${message}`));
    console.log(picocolors.gray(`    expected: ${JSON.stringify(expected)}`));
    console.log(picocolors.gray(`    actual:   ${JSON.stringify(actual)}`));
  }
}

// ─── Source code wiring checks ───────────────────────────────────────

const ROOT = path.resolve(".");
function srcText(rel: string): string {
  const p = path.join(ROOT, rel);
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf8");
}

function codeOnly(rel: string): string {
  let t = srcText(rel);
  t = t.replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
  t = t.replace(/^\s*\/\/.*$/gm, " "); // full-line // comments
  return t;
}

// ─── Mock Provider ───────────────────────────────────────────────────

import type { ModelEvent, ChatRequest } from "../src/providers/types.js";

interface MockScenario {
  events: ModelEvent[];
  description: string;
}

class MockProvider {
  scenarios: MockScenario[] = [];
  callIndex = 0;
  calls: ChatRequest[] = [];

  constructor(scenarios: MockScenario[]) {
    this.scenarios = scenarios;
  }

  async *streamChat(
    request: ChatRequest,
    _signal?: AbortSignal,
  ): AsyncGenerator<ModelEvent> {
    this.calls.push(request);
    const scenario =
      this.scenarios[this.callIndex] ||
      this.scenarios[this.scenarios.length - 1];
    this.callIndex++;
    for (const ev of scenario.events) {
      yield ev;
    }
  }
}

// ─── Simulate the agent loop's truncation handling ───────────────────
// This mirrors the exact logic in src/agent.ts:1797-1960 to verify
// the recovery behavior without needing a full Agent instance.

interface TruncationResult {
  finalContent: string;
  messages: { role: string; content: string }[];
  maxTokensUsed: number;
  truncationEvents: { mode: string; oldMax?: number; newMax?: number }[];
  exhaustedRetries: boolean;
}

async function simulateAgentLoop(
  provider: MockProvider,
  initialMaxTokens: number = 8192,
  maxTruncationRetries: number = 2,
): Promise<TruncationResult> {
  let messages: { role: string; content: string }[] = [
    { role: "user", content: "Build a landing page" },
  ];

  let maxTokens = initialMaxTokens;
  let truncationRetries = 0;
  let finalContent = "";
  let loopCount = 0;
  const maxLoops = 20; // safety valve
  const truncationEvents: { mode: string; oldMax?: number; newMax?: number }[] =
    [];
  let exhaustedRetries = false;

  while (loopCount < maxLoops) {
    loopCount++;
    let assistantContent = "";
    let accumulatedToolCalls: Record<
      number,
      { id?: string; name?: string; arguments: string }
    > = {};
    let streamFinishReason: string | undefined;

    // Simulate stream consumption
    for await (const ev of provider.streamChat({
      model: "test-model",
      messages,
      maxTokens,
      stream: true,
    })) {
      if (ev.type === "text_delta" && ev.content) {
        assistantContent += ev.content;
      } else if (ev.type === "tool_call_start") {
        const idx = ev.toolCallIndex ?? 0;
        if (!accumulatedToolCalls[idx])
          accumulatedToolCalls[idx] = { arguments: "" };
        if (ev.toolCallId) accumulatedToolCalls[idx].id = ev.toolCallId;
        if (ev.toolCallName) accumulatedToolCalls[idx].name = ev.toolCallName;
      } else if (ev.type === "tool_call_delta") {
        const idx = ev.toolCallIndex ?? 0;
        if (!accumulatedToolCalls[idx])
          accumulatedToolCalls[idx] = { arguments: "" };
        if (ev.toolCallArguments)
          accumulatedToolCalls[idx].arguments += ev.toolCallArguments;
      } else if (ev.type === "done") {
        streamFinishReason = ev.finishReason;
      }
    }

    // ── Truncation recovery (mirrors agent.ts logic) ──
    if (
      streamFinishReason === "length" &&
      truncationRetries < maxTruncationRetries
    ) {
      truncationRetries++;
      const hasPartialToolCalls = Object.keys(accumulatedToolCalls).length > 0;

      if (hasPartialToolCalls) {
        // Case 2: retry with doubled maxTokens
        const newMax = Math.min(maxTokens * 2, 16384);
        truncationEvents.push({
          mode: "retry_with_doubled_max_tokens",
          oldMax: maxTokens,
          newMax,
        });
        maxTokens = newMax;
        // Reset and re-run (stay in loop, don't push messages)
        continue;
      } else {
        // Case 1: continuation prompt
        truncationEvents.push({ mode: "continue_prompt" });
        messages.push({ role: "assistant", content: assistantContent });
        messages.push({
          role: "user",
          content:
            "Continue from where you left off. Do not repeat what you already wrote.",
        });
        finalContent = assistantContent;
        continue;
      }
    } else if (
      streamFinishReason === "length" &&
      truncationRetries >= maxTruncationRetries
    ) {
      // Exhausted retries
      exhaustedRetries = true;
      truncationEvents.push({ mode: "exhausted" });
      finalContent = assistantContent;
      messages.push({ role: "assistant", content: assistantContent });
      break;
    }

    // Normal completion
    finalContent = assistantContent;
    messages.push({ role: "assistant", content: assistantContent });
    break;
  }

  return {
    finalContent,
    messages,
    maxTokensUsed: maxTokens,
    truncationEvents,
    exhaustedRetries,
  };
}

// ─── Test scenarios ──────────────────────────────────────────────────

async function main() {
  console.log("\n🧪 Output Truncation Recovery — Stress Test\n");

  // ── Layer 1: Source code wiring checks ──────────────────────────

  console.log(picocolors.cyan("━━━ Layer 1: Source Code Wiring ━━━\n"));

  const agent = codeOnly("src/agent.ts");

  assert(
    /streamFinishReason\s*=\s*ev\.finishReason/.test(agent),
    "streamFinishReason is captured from done event's finishReason",
  );

  assert(
    /streamFinishReason\s*===\s*"length"/.test(agent),
    "finish_reason === 'length' branch exists",
  );

  assert(
    /truncationRetries\s*=\s*0/.test(agent) &&
      /maxTruncationRetries\s*=\s*\d/.test(agent),
    "truncationRetries counter with maxTruncationRetries guard exists",
  );

  assert(
    /Continue from where you left off/.test(agent),
    "Continuation prompt 'Continue from where you left off' is injected",
  );

  assert(
    /Math\.min\(\s*adapterDefaults\.maxOutputTokens\s*\*\s*2\s*,\s*16384\s*\)/.test(
      agent,
    ),
    "Doubled maxOutputTokens capped at 16384",
  );

  assert(
    /truncation_recovery/.test(agent),
    "truncation_recovery log event is emitted",
  );

  assert(
    /truncation_recovery_exhausted/.test(agent),
    "truncation_recovery_exhausted log event is emitted",
  );

  assert(
    /hasPartialToolCalls\s*=\s*Object\.keys\(accumulatedToolCalls\)\.length\s*>\s*0/.test(
      agent,
    ),
    "hasPartialToolCalls check distinguishes mid-text vs mid-tool-call truncation",
  );

  assert(
    /adapterDefaults\.maxOutputTokens\s*=\s*newMax/.test(agent),
    "maxOutputTokens is raised for retry (not just a local variable)",
  );

  assert(
    /assistantContent\s*=\s*""\s*;.*firstStreamingToken\s*=\s*true\s*;.*accumulatedToolCalls\s*=\s*\{\s*\}/s.test(
      agent,
    ),
    "Accumulators are reset before retry",
  );

  // ── Layer 2: Behavioral simulation tests ─────────────────────────

  console.log(
    "\n" + picocolors.cyan("━━━ Layer 2: Behavioral Simulation ━━━\n"),
  );

  // Test 1: Normal completion (no truncation)
  {
    const provider = new MockProvider([
      {
        description: "Normal completion",
        events: [
          { type: "text_delta", content: "Hello! I can help with that." },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(
      result.finalContent,
      "Hello! I can help with that.",
      "T1: Normal completion preserves content",
    );
    assertEqual(
      result.truncationEvents.length,
      0,
      "T1: No truncation events on normal completion",
    );
    assertEqual(
      result.exhaustedRetries,
      false,
      "T1: No exhausted retries flag",
    );
    assertEqual(result.maxTokensUsed, 8192, "T1: maxTokens unchanged");
  }

  // Test 2: Mid-text truncation → continuation prompt
  {
    const provider = new MockProvider([
      {
        description: "Truncated mid-text",
        events: [
          { type: "text_delta", content: "I will analyze the " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Continuation completes",
        events: [
          { type: "text_delta", content: "landing page and redesign it." },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    // After continuation, finalContent is the continuation's content
    // (the partial was pushed as a separate assistant message)
    assert(
      result.finalContent.includes("landing page and redesign it."),
      "T2: Mid-text truncation continuation produces complete content",
    );
    assert(
      result.messages.some(
        (m) => m.role === "assistant" && m.content.includes("I will analyze the"),
      ),
      "T2: Partial content preserved in message history",
    );
    assertEqual(
      result.truncationEvents.length,
      1,
      "T2: One truncation event recorded",
    );
    assertEqual(
      result.truncationEvents[0].mode,
      "continue_prompt",
      "T2: Truncation mode is continue_prompt",
    );
    assertEqual(result.exhaustedRetries, false, "T2: Not exhausted");
    assert(
      result.messages.some(
        (m) =>
          m.content ===
          "Continue from where you left off. Do not repeat what you already wrote.",
      ),
      "T2: Continuation prompt injected into messages",
    );
    assert(
      result.messages.filter((m) => m.role === "assistant").length >= 2,
      "T2: Two assistant messages (partial + continuation)",
    );
  }

  // Test 3: Mid-tool-call truncation → retry with doubled maxTokens
  {
    const provider = new MockProvider([
      {
        description: "Truncated mid-tool-call (partial args)",
        events: [
          { type: "text_delta", content: "Let me read the file." },
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePa',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Retry with larger budget completes tool call",
        events: [
          { type: "text_delta", content: "Let me read the file." },
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath":"/src/index.ts"}',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(result.truncationEvents.length, 1, "T3: One truncation event");
    assertEqual(
      result.truncationEvents[0].mode,
      "retry_with_doubled_max_tokens",
      "T3: Mode is retry_with_doubled_max_tokens",
    );
    assertEqual(
      result.truncationEvents[0].oldMax,
      8192,
      "T3: Old max was 8192",
    );
    assertEqual(
      result.truncationEvents[0].newMax,
      16384,
      "T3: New max is 16384 (doubled, capped)",
    );
    assertEqual(
      result.maxTokensUsed,
      16384,
      "T3: maxTokens was raised to 16384",
    );
    assertEqual(result.exhaustedRetries, false, "T3: Not exhausted");
  }

  // Test 4: Exhausted retries after repeated mid-text truncation
  {
    const provider = new MockProvider([
      {
        description: "Truncated mid-text (attempt 1)",
        events: [
          { type: "text_delta", content: "Part 1 " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Truncated mid-text (attempt 2)",
        events: [
          { type: "text_delta", content: "Part 2 " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Truncated mid-text (attempt 3 - exhausted)",
        events: [
          { type: "text_delta", content: "Part 3" },
          { type: "done", finishReason: "length" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 8192, 2);
    assertEqual(
      result.exhaustedRetries,
      true,
      "T4: Exhausted retries flag set",
    );
    assert(
      result.truncationEvents.some((e) => e.mode === "exhausted"),
      "T4: Exhausted event recorded",
    );
    assert(
      result.truncationEvents.filter((e) => e.mode === "continue_prompt")
        .length === 2,
      "T4: Two continuation attempts before exhaustion",
    );
  }

  // Test 5: Content filter is NOT treated as truncation
  {
    const provider = new MockProvider([
      {
        description: "Content filter blocked",
        events: [
          { type: "text_delta", content: "Here is some " },
          { type: "done", finishReason: "content_filter" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(
      result.truncationEvents.length,
      0,
      "T5: No truncation events for content_filter",
    );
    assertEqual(
      result.exhaustedRetries,
      false,
      "T5: Not exhausted for content_filter",
    );
    assert(
      result.finalContent.includes("Here is some"),
      "T5: Content preserved (not treated as truncation)",
    );
  }

  // Test 6: Multiple consecutive mid-text truncations → continuation chain
  {
    const provider = new MockProvider([
      {
        description: "Truncated (1st)",
        events: [
          { type: "text_delta", content: "Section A: " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Truncated (2nd)",
        events: [
          { type: "text_delta", content: "Section B: " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Completes (3rd)",
        events: [
          { type: "text_delta", content: "Section C done." },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 8192, 5);
    assertEqual(
      result.truncationEvents.length,
      2,
      "T6: Two truncation events before completion",
    );
    assert(
      result.truncationEvents.every((e) => e.mode === "continue_prompt"),
      "T6: All truncation events are continue_prompt",
    );
    assertEqual(
      result.exhaustedRetries,
      false,
      "T6: Not exhausted (completed on 3rd attempt)",
    );
    assert(
      result.messages.filter((m) => m.role === "assistant").length >= 3,
      "T6: Three assistant messages (two partial + final)",
    );
  }

  // Test 7: Mid-tool-call truncation → retry also truncated → exhausted
  {
    const provider = new MockProvider([
      {
        description: "Truncated mid-tool-call (1st)",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "write_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"file',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Truncated mid-tool-call (2nd - still too long)",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "write_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath":"/src/very',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Truncated mid-tool-call (3rd - exhausted)",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "write_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath"',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 4096, 2);
    assertEqual(
      result.exhaustedRetries,
      true,
      "T7: Exhausted after repeated mid-tool-call truncation",
    );
    assert(
      result.truncationEvents.filter(
        (e) => e.mode === "retry_with_doubled_max_tokens",
      ).length === 2,
      "T7: Two retry attempts before exhaustion",
    );
    assert(
      result.truncationEvents.some((e) => e.mode === "exhausted"),
      "T7: Exhausted event recorded",
    );
  }

  // Test 8: Empty content truncation (model outputs nothing, hits length limit)
  {
    const provider = new MockProvider([
      {
        description: "Empty content truncated",
        events: [{ type: "done", finishReason: "length" }],
      },
      {
        description: "Continuation produces content",
        events: [
          { type: "text_delta", content: "Now I have content." },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(
      result.truncationEvents.length,
      1,
      "T8: One truncation event for empty content",
    );
    assertEqual(
      result.truncationEvents[0].mode,
      "continue_prompt",
      "T8: Empty content goes to continue path",
    );
    assert(
      result.finalContent === "" ||
        result.finalContent === "Now I have content.",
      "T8: Empty content handled gracefully",
    );
  }

  // Test 9: Truncation with tool_call_start but no tool_call_delta (no args at all)
  {
    const provider = new MockProvider([
      {
        description: "Tool call started but no args, truncated",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "run_command",
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Retry completes",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "run_command",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"command":"ls -la"}',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 4096, 2);
    assertEqual(
      result.truncationEvents[0].mode,
      "retry_with_doubled_max_tokens",
      "T9: Tool call with no args goes to retry path",
    );
    assertEqual(
      result.truncationEvents[0].oldMax,
      4096,
      "T9: Old max was 4096",
    );
    assertEqual(
      result.truncationEvents[0].newMax,
      8192,
      "T9: New max is 8192 (doubled)",
    );
  }

  // Test 10: maxTokens cap at 16384 even with high initial value
  {
    const provider = new MockProvider([
      {
        description: "Truncated mid-tool-call with high initial maxTokens",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "write_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"file',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Retry completes",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "write_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath":"/src/index.ts","content":"hello"}',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 10000, 2);
    assertEqual(
      result.truncationEvents[0].newMax,
      16384,
      "T10: Capped at 16384 even when initial is 10000",
    );
    assertEqual(
      result.maxTokensUsed,
      16384,
      "T10: maxTokensUsed is 16384 (capped)",
    );
  }

  // ── Layer 3: Edge cases & adversarial inputs ─────────────────────

  console.log(
    "\n" + picocolors.cyan("━━━ Layer 3: Edge Cases & Adversarial ━━━\n"),
  );

  // Test 11: finish_reason is undefined (provider doesn't send it)
  {
    const provider = new MockProvider([
      {
        description: "No finish_reason",
        events: [
          { type: "text_delta", content: "Some content" },
          { type: "done" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(
      result.truncationEvents.length,
      0,
      "T11: No truncation when finishReason is undefined",
    );
    assertEqual(result.finalContent, "Some content", "T11: Content preserved");
  }

  // Test 12: finish_reason is "stop" (normal, explicit)
  {
    const provider = new MockProvider([
      {
        description: "Explicit stop",
        events: [
          { type: "text_delta", content: "Done!" },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider);
    assertEqual(
      result.truncationEvents.length,
      0,
      "T12: No truncation for finish_reason: stop",
    );
  }

  // Test 13: Multiple tool calls, only first is truncated
  {
    const provider = new MockProvider([
      {
        description: "First tool call truncated, second not started",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"file',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Retry: both tool calls complete",
        events: [
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath":"/src/a.ts"}',
            toolCallIndex: 0,
          },
          {
            type: "tool_call_start",
            toolCallId: "call_2",
            toolCallName: "view_file",
            toolCallIndex: 1,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_2",
            toolCallArguments: '{"filePath":"/src/b.ts"}',
            toolCallIndex: 1,
          },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 4096, 2);
    assertEqual(
      result.truncationEvents[0].mode,
      "retry_with_doubled_max_tokens",
      "T13: Multi-tool-call truncation goes to retry path",
    );
    assertEqual(result.exhaustedRetries, false, "T13: Retry succeeds");
  }

  // Test 14: Infinite truncation loop prevention (maxLoops safety)
  {
    const alwaysTruncate: MockScenario = {
      description: "Always truncated",
      events: [
        { type: "text_delta", content: "x" },
        { type: "done", finishReason: "length" },
      ],
    };
    const provider = new MockProvider([alwaysTruncate]);
    const result = await simulateAgentLoop(provider, 8192, 100);
    assert(
      result.exhaustedRetries === true,
      "T14: Eventually exhausts retries even with high limit",
    );
    assert(
      result.truncationEvents.length <= 101,
      "T14: Does not loop infinitely (bounded by retry counter)",
    );
  }

  // Test 15: Mixed truncation — first mid-text, then mid-tool-call on continuation
  {
    const provider = new MockProvider([
      {
        description: "Mid-text truncation",
        events: [
          { type: "text_delta", content: "Let me help. " },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Continuation hits mid-tool-call truncation",
        events: [
          { type: "text_delta", content: "I'll read the file. " },
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"file',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "length" },
        ],
      },
      {
        description: "Retry with doubled maxTokens succeeds",
        events: [
          { type: "text_delta", content: "I'll read the file. " },
          {
            type: "tool_call_start",
            toolCallId: "call_1",
            toolCallName: "view_file",
            toolCallIndex: 0,
          },
          {
            type: "tool_call_delta",
            toolCallId: "call_1",
            toolCallArguments: '{"filePath":"/src/index.ts"}',
            toolCallIndex: 0,
          },
          { type: "done", finishReason: "stop" },
        ],
      },
    ]);
    const result = await simulateAgentLoop(provider, 4096, 5);
    assertEqual(
      result.truncationEvents.length,
      2,
      "T15: Two truncation events (text + tool-call)",
    );
    assertEqual(
      result.truncationEvents[0].mode,
      "continue_prompt",
      "T15: First is continue_prompt",
    );
    assertEqual(
      result.truncationEvents[1].mode,
      "retry_with_doubled_max_tokens",
      "T15: Second is retry_with_doubled_max_tokens",
    );
    assertEqual(
      result.exhaustedRetries,
      false,
      "T15: Not exhausted (recovered)",
    );
  }

  // ── Summary ──────────────────────────────────────────────────────

  console.log("\n" + "━".repeat(50));
  const total = passed + failed;
  if (failed === 0) {
    console.log(
      picocolors.green(`  ✔ All ${total} truncation stress tests passed.\n`),
    );
  } else {
    console.log(picocolors.red(`  ✗ ${failed}/${total} tests FAILED:\n`));
    for (const f of failures) {
      console.log(picocolors.red(`    • ${f}`));
    }
    console.log("");
  }

  if (failed > 0) process.exitCode = 1;
  return failed;
}

main().catch((err) => {
  console.error(picocolors.red(`\nFatal error: ${err.message}`));
  process.exitCode = 1;
});
