/**
 * Chat-path QoS routing regression.
 *
 * The browser chat uses the legacy ModelProvider bridge, so this proves the
 * bridge itself routes `profileSlug: "auto"` per request: text → text maker,
 * native file/image → native-document maker. The factory records the concrete
 * profile it was asked to construct; no network.
 */
import picocolors from "picocolors";
import { ModelProfileRegistry, starterCatalog } from "../../src/harness/model-profile.js";
import { QuiverOpenRouterProvider, type ChatModelLike, type ProviderBridgeOptions } from "../../src/harness/provider-bridge.js";
import type { ChatRequest } from "../../src/providers/types.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const msg = `${name}${detail ? ` — ${detail}` : ""}`; failures.push(msg); console.log(picocolors.red(`   ✗ FAIL  ${msg}`)); }
}

async function collect(stream: AsyncIterable<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

function mockModel(): ChatModelLike {
  return {
    async *stream() {
      yield { content: "ok" };
    },
  };
}

async function run() {
  const profiles = new ModelProfileRegistry();
  for (const profile of starterCatalog()) profiles.register(profile);
  const created: string[] = [];
  const factory = async (opts: ProviderBridgeOptions): Promise<ChatModelLike> => {
    created.push(opts.profileSlug);
    return mockModel();
  };
  const provider = new QuiverOpenRouterProvider({ apiKey: "test", profiles, profileSlug: "auto" }, factory);
  const signal = new AbortController().signal;

  const textRequest: ChatRequest = { model: "auto", messages: [{ role: "user", content: "Analyze this thesis." }] };
  await collect(provider.streamChat(textRequest, signal));
  check("CHAT-TEXT-USES-MAKER", created[0] === "text-maker", JSON.stringify(created));

  const fileRequest: ChatRequest = {
    model: "auto",
    messages: [{ role: "user", content: [
      { type: "text", text: "Review this memo." },
      { type: "file", mimeType: "application/pdf", file: { filename: "memo.pdf", file_data: "data:application/pdf;base64,AA==" } },
    ] }],
  };
  await collect(provider.streamChat(fileRequest, signal));
  check("CHAT-FILE-USES-NATIVE-DOC-MAKER", created[1] === "native-doc-primary", JSON.stringify(created));
  check("CHAT-USES-DISTINCT-MODEL-INSTANCES", created.length === 2 && created[0] !== created[1], JSON.stringify(created));
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} chat-router check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} chat-router checks passed.`));
