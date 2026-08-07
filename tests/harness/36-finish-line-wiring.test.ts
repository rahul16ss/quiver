/**
 * Finish-line wiring: shared ProductionRuntime binding, brokered tool path,
 * Parallel webhook HMAC + durable idempotency.
 */
import picocolors from "picocolors";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { createHash } from "crypto";
import { HarnessDaemon } from "../../src/harness/harness-daemon.js";
import { QuiverExecutionEngine, type ToolExecutor, type ToolResult } from "../../src/harness/execution-engine.js";
import { SqliteCheckpointSaver } from "../../src/harness/sqlite-checkpoint.js";
import { DurableIdempotencyLedger } from "../../src/harness/durable-job.js";
import { InMemoryCursorKV } from "../../src/harness/cursor-store.js";
import { verifyParallelWebhook } from "../../src/harness/research-gateway.js";
import {
  bindProductionRuntime,
  clearProductionRuntime,
  getBoundProductionRuntime,
  invokeUnderRuntime,
  BROKERED_TOOL_NAMES,
} from "../../src/harness/runtime-binding.js";
import type { ModelClient, ModelMessage, ModelResult, ModelProfileRef } from "../../src/harness/interfaces.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

class MockModel implements ModelClient {
  id = "mock"; kind = "local" as const;
  listProfiles(): ModelProfileRef[] {
    return [{ slug: "local-private-default", label: "local", providerOrder: ["Local"], zdrEligible: true, checkerEligible: true }];
  }
  async invoke(messages: ModelMessage[]): Promise<ModelResult> {
    const last = messages[messages.length - 1];
    const c = typeof last.content === "string" ? last.content : "";
    return { content: /checker/i.test(c) ? "OK all met" : "ack", modelProfile: "local-private-default", route: "local" };
  }
}
class MockTools implements ToolExecutor {
  available() { return ["office_doc"]; }
  async call(n: string, a: Record<string, unknown>): Promise<ToolResult> {
    return { ok: true, output: `${n}:${a.step}`, evidenceRefs: [`e-${a.step}`] };
  }
}

async function run() {
  clearProductionRuntime();
  check("FL-UNBOUND-INITIALLY", getBoundProductionRuntime() === null);

  // Brokered tool without runtime fails closed.
  const denied = await invokeUnderRuntime("web_search", { query: "x" }, async () => "should-not-run");
  check("FL-BROKERED-WITHOUT-RUNTIME-FAILS", !denied.ok && /ProductionRuntime/i.test(denied.error ?? ""));

  // Build a wiring-only runtime and prove binding.
  const dataDir = path.join(os.tmpdir(), "q-fl-" + Math.random().toString(36).slice(2));
  fs.mkdirSync(dataDir, { recursive: true });
  const { config } = await import("../../src/config.js");
  const saved = {
    or: config.openRouterApiKey,
    prof: config.openRouterModelProfile,
    url: config.llmBaseUrl,
    key: config.llmApiKey,
    parallel: config.parallelApiKey,
  };
  config.openRouterApiKey = "";
  config.openRouterModelProfile = "";
  config.llmBaseUrl = "";
  config.llmApiKey = "";
  config.parallelApiKey = "";
  process.env.QUIVER_DEPLOYMENT_PROFILE = "air-gapped";

  try {
    const { buildProductionRuntime } = await import("../../src/harness/production-runtime.js");
    const rt = await buildProductionRuntime({ dataDir, allowMissingModel: true });
    check("FL-RUNTIME-BOUND", getBoundProductionRuntime() === rt);
    check("FL-BROKERED-SET-HAS-WEB", BROKERED_TOOL_NAMES.has("web_search"));

    // Air-gap: web_search removed even via invokeUnderRuntime.
    const air = await invokeUnderRuntime("web_search", { query: "x" }, async () => "nope");
    check("FL-AIRGAP-BLOCKS-WEB-VIA-BINDING", !air.ok && /removed under deployment profile/i.test(air.error ?? ""));

    // Local tool still works.
    const local = await invokeUnderRuntime("office_doc", { step: 1 }, async () => "office-ok");
    check("FL-LOCAL-TOOL-OK", local.ok && local.output === "office-ok" && local.via === "local");

    // ── Parallel webhook HMAC + durable dedupe ───────────────────────
    const secret = "test-webhook-secret";
    const ledger = new DurableIdempotencyLedger(new InMemoryCursorKV());
    const saver = new SqliteCheckpointSaver(path.join(dataDir, "ckpt.db"));
    const engine = new QuiverExecutionEngine(saver, new MockModel(), new MockTools(), { maxIterations: 4 });
    const hd = new HarnessDaemon({
      engine,
      secret: "daemon-secret",
      uiDir: path.join(path.dirname(new URL(import.meta.url).pathname), "../../src/harness/ui"),
      idempotency: ledger,
      parallelWebhookSecret: secret,
    });
    const { origin } = await hd.listen();

    const body = Buffer.from(JSON.stringify({ event_id: "evt-1", type: "monitor.event" }));
    const goodSig = createHash("sha256").update(body).update(secret).digest("hex");
    check("FL-HMAC-HELPER-ACCEPTS", verifyParallelWebhook(body, goodSig, secret));
    check("FL-HMAC-HELPER-REJECTS", !verifyParallelWebhook(body, "deadbeef", secret));

    const bad = await fetch(`${origin}/api/webhooks/parallel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-parallel-signature": "nope" },
      body,
    });
    check("FL-WEBHOOK-BAD-SIG-401", bad.status === 401);

    const ok1 = await fetch(`${origin}/api/webhooks/parallel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-parallel-signature": goodSig },
      body,
    });
    const j1 = await ok1.json() as any;
    check("FL-WEBHOOK-ACCEPT-200", ok1.status === 200 && j1.accepted === true);

    const ok2 = await fetch(`${origin}/api/webhooks/parallel`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-parallel-signature": goodSig },
      body,
    });
    const j2 = await ok2.json() as any;
    check("FL-WEBHOOK-REPLAY-DEDUPED", ok2.status === 200 && j2.deduped === true);

    await hd.close();

    // Research-state harvest path: connected-zdr with a stub broker call is
    // covered by unit store; here prove asOf still excludes future leakage
    // after a recorded observation shape.
    const now = new Date().toISOString();
    rt.researchState.recordClaim({
      claimId: "c-finish",
      validTime: "2026-01-01",
      recordedTime: now,
      kind: "assumption",
      claim: "test",
      status: "unresolved",
      source: { category: "public-web-research", source: "t", locator: "x", retrievedAt: now },
      sensitivity: "public",
    });
    const known = rt.researchState.asOf("c-finish", "2025-12-01");
    check("FL-ASOF-NO-FUTURE-LEAK", known === null);
    const knownNow = rt.researchState.asOf("c-finish", now);
    check("FL-ASOF-SEES-RECORDED", knownNow !== null && knownNow.claimId === "c-finish");
  } finally {
    config.openRouterApiKey = saved.or;
    config.openRouterModelProfile = saved.prof;
    config.llmBaseUrl = saved.url;
    config.llmApiKey = saved.key;
    config.parallelApiKey = saved.parallel;
    delete process.env.QUIVER_DEPLOYMENT_PROFILE;
    clearProductionRuntime();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log();
  if (failed === 0) console.log(picocolors.green(`  ✔ ${passed} finish-line checks passed.`));
  else {
    console.log(picocolors.red(`  ✗ ${failed} failed, ${passed} passed.`));
    for (const f of failures) console.log(picocolors.red(`    - ${f}`));
    process.exit(1);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
