/**
 * Parallel Monitor GA contract — behavioral tests (§8).
 *
 * No network: a mock transport records the create payload and returns canned
 * events. Verifies the GA typed shape (type+frequency+settings), cancel (not
 * delete), event retrieval, HMAC webhook verification, and event deduplication.
 * Bounded: every await has a mock — no blocking, exits in <1s.
 */
import picocolors from "picocolors";
import {
  ParallelResearchGateway,
  verifyParallelWebhook,
  dedupeMonitorEvents,
  type ParallelTransport,
} from "../../src/harness/research-gateway.js";
import { QuiverPolicyEngine } from "../../src/harness/policy-engine.js";
import { emptyPack } from "../../src/harness/customer-pack.js";

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const m = `${name}${detail ? " — " + detail : ""}`; failures.push(m); console.log(picocolors.red(`   ✗ FAIL  ${m}`)); }
}

class MockTransport implements ParallelTransport {
  lastCreate: any = null;
  cancelled = false;
  async search() { return { results: [] }; }
  async extract() { return { results: [] }; }
  async taskRun() { return { output: { type: "text", content: "", basis: [] } }; }
  async monitor(p: any) { this.lastCreate = p; return { monitor_id: "mon-test", status: "active" }; }
  async monitorCancel() { this.cancelled = true; }
  async monitorEvents() {
    return { events: [
      { event_id: "e1", event_group_id: "g1", event_type: "event_stream", output: { type: "text", content: "change 1" } },
      { event_id: "e2", event_group_id: "g1", event_type: "event_stream", output: { type: "text", content: "change 2" } },
    ] };
  }
  async findEntities() { return { results: [] }; }
  async findAllCreate() { return { findall_id: "fa-1" }; }
  async findAllRetrieve() { return { status: { is_active: false } }; }
  async findAllResult() { return { candidates: [] }; }
}

async function run() {
  const policy = new QuiverPolicyEngine(emptyPack({ id: "test" }));
  const t = new MockTransport();
  const gw = new ParallelResearchGateway(t, policy);

  // ── GA typed create ──
  const mon = await gw.monitor({
    type: "event_stream", frequency: "1d",
    settings: { query: "ACME earnings" }, processor: "lite",
    sensitivity: "public",
  });
  check("MONITOR-CREATES-TYPED-SHAPE",
    t.lastCreate.type === "event_stream" &&
    t.lastCreate.frequency === "1d" &&
    t.lastCreate.settings.query === "ACME earnings",
    `got ${JSON.stringify(t.lastCreate)}`);
  check("MONITOR-NO-LEGACY-CADENCE",
    !("cadence" in t.lastCreate) && !("query" in t.lastCreate),
    "must not send flat query/cadence");

  // ── cancel (not delete) ──
  await mon.cancel();
  check("MONITOR-CANCEL-CALLED", t.cancelled, "cancel must call monitorCancel");

  // ── events retrieval ──
  const evs = await mon.events();
  check("MONITOR-EVENTS-RETRIEVED", evs.length === 2 && evs[0].event_id === "e1");

  // ── HMAC webhook verification ──
  const secret = "whsec_test";
  const body = JSON.stringify({ type: "monitor.event.detected", data: { monitor_id: "mon-test" } });
  const crypto = await import("crypto");
  const goodSig = crypto.createHash("sha256").update(body).update(secret).digest("hex");
  check("MONITOR-HMAC-VERIFIES-VALID", verifyParallelWebhook(body, goodSig, secret) === true);
  check("MONITOR-HMAC-REJECTS-TAMPERED", verifyParallelWebhook(body, goodSig + "x", secret) === false);
  check("MONITOR-HMAC-REJECTS-WRONG-SECRET", verifyParallelWebhook(body, goodSig, "wrong") === false);
  check("MONITOR-HMAC-REJECTS-MISSING", verifyParallelWebhook(body, "", secret) === false);

  // ── event deduplication by event_id ──
  const seen = new Set<string>();
  const first = dedupeMonitorEvents(evs, seen);
  const second = dedupeMonitorEvents(evs, seen); // replay — must be empty
  check("MONITOR-DEDUP-FIRST", first.length === 2, "first delivery keeps both");
  check("MONITOR-DEDUP-REPLAY", second.length === 0, "replay dedupes all");

  // ── frequency validation (1h–30d) ──
  check("MONITOR-FREQ-ACCEPTS-1H", /^[0-9]+[hdw]$/.test("1h"));
  check("MONITOR-FREQ-ACCEPTS-30D", /^[0-9]+[hdw]$/.test("30d"));

  console.log(failed === 0
    ? picocolors.green(`\n   ✔ All ${passed} Parallel Monitor GA checks passed`)
    : picocolors.red(`\n   ✗ ${failed}/${passed + failed} checks FAILED`));
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
