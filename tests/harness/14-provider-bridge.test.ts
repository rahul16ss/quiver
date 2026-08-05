/**
 * QuiverOpenRouterProvider bridge tests — Phase 2 caller migration (ADR-001).
 *
 * Mock-chat-model tests: the bridge enforces ZDR/data_collection=deny/
 * require_parameters/no-fallback/explicit-order on every stream, translates
 * ChatOpenRouter-style chunks to legacy ModelEvents (text_delta, tool_call,
 * reasoning_delta, done/error), and refuses a non-ZDR-eligible profile.
 */
import picocolors from "picocolors";
import { ModelProfileRegistry, starterCatalog } from "../../src/harness/model-profile.js";
import { QuiverOpenRouterProvider, type ChatModelLike } from "../../src/harness/provider-bridge.js";
import type { ChatRequest } from "../../src/providers/types.js";
import { getOpenRouterProvider } from "../../src/providers/types.js";
import { config } from "../../src/config.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

async function collect(it: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = []; for await (const e of it) out.push(e); return out;
}

async function run() {
  const profiles = new ModelProfileRegistry();
  for (const p of starterCatalog()) profiles.register(p);

  // A mock chat model that records the invocation options and yields chunks.
  let lastOpts: Record<string, unknown> | null = null;
  const mock: ChatModelLike = {
    async *stream(_messages: unknown[], options: Record<string, unknown>): AsyncIterable<unknown> {
      lastOpts = options;
      yield { content: "Hello " };
      yield { content: "world", tool_call_chunks: [{ id: "tc1", name: "web_search", args: '{"query":', index: 0 }] };
      yield { tool_call_chunks: [{ id: "tc1", args: '"x"}', index: 0 }] };
      yield { reasoning: "thinking..." };
    },
  };

  const provider = new QuiverOpenRouterProvider(
    { apiKey: "sk-or-test", profiles, profileSlug: "openai-gpt-4o" },
    async () => mock,
  );

  // ── ZDR policy enforced on every stream ─────────────────────────────
  const req: ChatRequest = { model: "openai/gpt-4o", messages: [{ role: "user", content: "hi" }], temperature: 0.3 };
  const events = await collect(provider.streamChat(req, new AbortController().signal));
  const prefs = lastOpts!.provider as Record<string, unknown>;
  check("BRIDGE-ZDR", prefs.zdr === true);
  check("BRIDGE-DATA-COLLECTION-DENY", prefs.data_collection === "deny");
  check("BRIDGE-REQUIRE-PARAMETERS", prefs.require_parameters === true);
  check("BRIDGE-NO-FALLBACK", prefs.allow_fallbacks === false);
  check("BRIDGE-EXPLICIT-ORDER", Array.isArray(prefs.order) && prefs.order.length > 0);
  check("BRIDGE-TEMPERATURE-PASSED", lastOpts!.temperature === 0.3);

  // ── Streaming translation ───────────────────────────────────────────
  const textDeltas = events.filter((e) => e.type === "text_delta");
  check("BRIDGE-TEXT-DELTAS", textDeltas.length === 2 && textDeltas.map((e) => e.content).join("") === "Hello world");
  const tcStart = events.find((e) => e.type === "tool_call_start");
  check("BRIDGE-TOOL-CALL-START", !!tcStart && tcStart.toolCallName === "web_search");
  const tcDeltas = events.filter((e) => e.type === "tool_call_delta").map((e) => e.toolCallArguments).join("");
  check("BRIDGE-TOOL-CALL-ARGS-STREAMED", tcDeltas === '{"query":"x"}');
  const reasoning = events.find((e) => e.type === "reasoning_delta");
  check("BRIDGE-REASONING-DELTA", !!reasoning && reasoning.reasoning === "thinking...");
  const done = events.find((e) => e.type === "done");
  check("BRIDGE-DONE-EMITTED", !!done);

  // ── Tools passed through when present ───────────────────────────────
  lastOpts = null;
  await collect(provider.streamChat({ ...req, tools: [{ type: "function", function: { name: "x", parameters: {} } }] }, new AbortController().signal));
  check("BRIDGE-TOOLS-PASSED", Array.isArray(lastOpts!.tools));

  // ── Non-ZDR profile refused at construction ─────────────────────────
  const noZdrProfiles = new ModelProfileRegistry();
  noZdrProfiles.register({ ...starterCatalog()[0], slug: "no-zdr", zdrEligible: false });
  let refused = false;
  try { new QuiverOpenRouterProvider({ apiKey: "k", profiles: noZdrProfiles, profileSlug: "no-zdr" }, async () => mock); }
  catch { refused = true; }
  check("BRIDGE-NON-ZDR-PROFILE-REFUSED", refused);

  // ── Stream error is surfaced as an error event (not a throw) ────────
  const errMock: ChatModelLike = { async *stream() { throw new Error("boom"); } };
  const errProvider = new QuiverOpenRouterProvider({ apiKey: "k", profiles, profileSlug: "openai-gpt-4o" }, async () => errMock);
  const errEvents = await collect(errProvider.streamChat(req, new AbortController().signal));
  check("BRIDGE-STREAM-ERROR-SURFACED", errEvents.some((e) => e.type === "error" && /boom/.test(e.error)));

  // ── getOpenRouterProvider accessor ────────────────────────────────────
  const savedKey = config.openRouterApiKey;
  const savedProfile = config.openRouterModelProfile;
  config.openRouterApiKey = "";
  config.openRouterModelProfile = "";
  check("ACCESSOR-NULL-WHEN-UNCONFIGURED", (await getOpenRouterProvider()) === null);
  config.openRouterApiKey = "sk-or-test";
  config.openRouterModelProfile = "openai-gpt-4o";
  const orProv = await getOpenRouterProvider();
  check("ACCESSOR-RETURNS-BRIDGE-WHEN-CONFIGURED", !!orProv && orProv.id === "openrouter");
  config.openRouterModelProfile = "nonexistent-profile";
  check("ACCESSOR-NULL-FOR-UNKNOWN-PROFILE", (await getOpenRouterProvider()) === null);
  config.openRouterApiKey = savedKey;
  config.openRouterModelProfile = savedProfile;
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} bridge check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} bridge checks passed.`));
