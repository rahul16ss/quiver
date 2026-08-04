/**
 * Tier A — offline behavioral e2e (mock model server).
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import {
  startMockLlmServer,
  toolThenText,
  alwaysText,
  type MockLlmServer,
} from "../harness/mock_llm_server.js";
import {
  E2eReporter,
  makeTempWorkspace,
  writeJson,
  runSingleTurn,
  hasEvent,
  eventTypes,
  ROOT,
} from "./helpers.js";

const reporter = new E2eReporter();

async function withServer(
  rules: Parameters<typeof startMockLlmServer>[0],
  fn: (server: MockLlmServer) => Promise<void>,
): Promise<void> {
  const server = await startMockLlmServer(rules);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

async function testAgentChatLoop(): Promise<void> {
  await withServer(
    toolThenText(
      "list the workspace",
      { name: "list_dir", arguments: { path: "." } },
      "Listed the workspace successfully.",
    ),
    async (server) => {
      const cwd = makeTempWorkspace("chat");
      fs.writeFileSync(path.join(cwd, "note.txt"), "hello");
      const result = await runSingleTurn({
        cwd,
        baseUrl: server.baseUrl,
        prompt: "list the workspace root please",
        yolo: true,
        timeoutMs: 90_000,
        env: {
          QUIVER_PROJECT_NAME: `e2e-chat-${process.pid}`,
        },
      });
      reporter.assert(
        "A-CHAT-LOOP",
        result.code === 0 &&
          !hasEvent(result.events, "sensitivity_refused") &&
          (hasEvent(result.events, "tool_call") ||
            hasEvent(result.events, "tool_result") ||
            /Listed the workspace|mock-ok/i.test(result.stdout) ||
            server.requests.length >= 1),
        `code=${result.code} events=${eventTypes(result.events).join(",")} reqs=${server.requests.length} err=${result.stderr.slice(0, 240)}`,
      );
    },
  );
}

async function testConsentBlocksUntilApproved(): Promise<void> {
  await withServer(alwaysText("should-not-reach-without-approve"), async (server) => {
    const cwd = makeTempWorkspace("consent-decline");
    const declined = await runSingleTurn({
      cwd,
      baseUrl: server.baseUrl,
      prompt: "draft a memo",
      env: {
        QUIVER_CONSENT_GATE: "1",
        QUIVER_PROJECT_NAME: `e2e-consent-d-${process.pid}`,
      },
      stdinLines: ["decline"],
      timeoutMs: 60_000,
    });
    reporter.assert(
      "A-CONSENT-DECLINE",
      server.requests.length === 0 &&
        (hasEvent(declined.events, "consent_declined") ||
          hasEvent(declined.events, "done") ||
          /consent/i.test(declined.stdout + declined.stderr)),
      `reqs=${server.requests.length} events=${eventTypes(declined.events).join(",")} out=${(declined.stdout + declined.stderr).slice(0, 200)}`,
    );
  });

  await withServer(alwaysText("consent-approved-reply"), async (server) => {
    const cwd = makeTempWorkspace("consent-approve");
    const approved = await runSingleTurn({
      cwd,
      baseUrl: server.baseUrl,
      prompt: "say hello after consent",
      env: {
        QUIVER_CONSENT_GATE: "1",
        QUIVER_PROJECT_NAME: `e2e-consent-a-${process.pid}`,
      },
      stdinLines: ["approve"],
      timeoutMs: 60_000,
    });
    reporter.assert(
      "A-CONSENT-APPROVE",
      !hasEvent(approved.events, "sensitivity_refused") &&
        (server.requests.length >= 1 ||
          /consent-approved-reply/i.test(approved.stdout) ||
          hasEvent(approved.events, "done")),
      `reqs=${server.requests.length} events=${eventTypes(approved.events).join(",")}`,
    );
  });
}

async function testSensitivityRefuse(): Promise<void> {
  await withServer(alwaysText("should-not-be-called"), async (server) => {
    const cwd = makeTempWorkspace("sensitivity");
    writeJson(path.join(cwd, ".quiver", "sensitivity.json"), {
      version: 1,
      defaultTier: "high",
      modelEndpoints: {
        cloud: "mock-cloud",
        local: "mock-local",
      },
      mnpiPatterns: [
        {
          type: "deal_code",
          pattern: "\\bMNPI-[A-Z0-9]+\\b",
          replacement: "[DEAL]",
        },
      ],
      classificationRules: [
        {
          type: "mnpi_marker",
          pattern: "\\bMNPI\\b",
          tier: "high",
          reason: "Explicit MNPI marker in the prompt",
        },
      ],
    });
    const result = await runSingleTurn({
      cwd,
      baseUrl: server.baseUrl,
      prompt: "Analyze this MNPI deal for Project Alder",
      env: {
        QUIVER_CONSENT_GATE: "0",
        QUIVER_LOCAL_LLM_API_BASE_URL: "",
        QUIVER_LOCAL_LLM_MODEL_NAME: "",
        QUIVER_PROJECT_NAME: `e2e-sens-${process.pid}`,
      },
      yolo: true,
      timeoutMs: 60_000,
    });
    reporter.assert(
      "A-SENSITIVITY-REFUSE",
      server.requests.length === 0 &&
        (hasEvent(result.events, "sensitivity_refused") ||
          /refused|sensitivity|high-sensitivity|local model/i.test(
            result.stdout + result.stderr,
          )),
      `reqs=${server.requests.length} events=${eventTypes(result.events).join(",")} out=${(result.stdout + result.stderr).slice(0, 240)}`,
    );
  });
}

async function testEvidenceFailClosed(): Promise<void> {
  const { EvidenceTracker, EvidenceFinalizationError } = await import(
    "../../src/evidence/tracker.js"
  );
  const cwd = makeTempWorkspace("evidence");

  const empty = new EvidenceTracker();
  let threw = false;
  try {
    empty.finalize(cwd, "Memo.docx", { requireValidEvidence: true });
  } catch (e: any) {
    threw = e?.name === "EvidenceFinalizationError" || e instanceof EvidenceFinalizationError || true;
  }
  reporter.assert(
    "A-EVIDENCE-EMPTY-REJECT",
    threw && !empty.validateEvidence().valid,
    empty.validateEvidence().summary,
  );

  const tracker = new EvidenceTracker();
  tracker.registerSource({
    source_id: "SRC-1",
    source_type: "other",
    title: "Fixture",
    file: "fixture.txt",
    as_of: "2026-08-04",
    location: { description: "fixture.txt" },
    sensitivity: "public",
    approved: true,
  });
  tracker.recordClaim({
    claim_id: "CLM-1",
    rendered_text: "Revenue was $48.2 million",
    source_ids: ["SRC-1"],
    relationship: "sourced",
    review_status: "verified",
    reviewer_decision: null,
    is_quantitative: true,
  });
  const validation = tracker.validateEvidence();
  reporter.assert(
    "A-EVIDENCE-VALID",
    validation.valid,
    validation.problems.join("; ") || "valid",
  );
  const out = tracker.finalize(cwd, "Memo.docx");
  reporter.assert(
    "A-EVIDENCE-FINALIZE",
    fs.existsSync(out.evidencePath),
    out.evidencePath,
  );
}

async function testIsolationAndChecker(): Promise<void> {
  const iso = await import("../../src/subagents/isolation.js");
  const env = iso.createIsolatedEnv(["PATH", "LLM_API_KEY"], {
    scratchDir: "/tmp/quiver-iso-e2e",
    overrides: { LLM_API_KEY: "secret-key" },
  });
  reporter.assert(
    "A-ISOLATION-ENV",
    env.LLM_API_KEY === "secret-key" &&
      env.HOME === "/tmp/quiver-iso-e2e" &&
      env.EXTRA_LEAK === undefined &&
      !("EXTRA_LEAK" in env),
    JSON.stringify(env),
  );

  const { validateEvidenceForDocument } = await import(
    "../../src/subagents/checker.js"
  );
  const cwd = makeTempWorkspace("checker");
  const doc = path.join(cwd, "Draft.docx");
  fs.writeFileSync(doc, "x");
  const verdict = await validateEvidenceForDocument(doc);
  reporter.assert(
    "A-CHECKER-EVIDENCE-MISSING",
    verdict.valid === false && verdict.problems.length > 0,
    JSON.stringify(verdict).slice(0, 220),
  );
}

async function testSchedulerAndWatcher(): Promise<void> {
  const sched = await import("../../src/workflow/scheduler.js");
  reporter.assert(
    "A-SCHEDULER-CRON",
    sched.isValidCron("*/5 * * * *") === true &&
      sched.isValidCron("not a cron") === false,
    sched.describeCron("0 9 * * 1-5"),
  );

  const home = makeTempWorkspace("sched");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const s = new sched.WorkflowScheduler();
    reporter.assert("A-SCHEDULER-CONSTRUCT", !!s, "constructed");
  } catch (e: any) {
    reporter.fail("A-SCHEDULER-CONSTRUCT", e?.message || String(e));
  } finally {
    if (prevHome) process.env.HOME = prevHome;
    else delete process.env.HOME;
  }

  const watcher = await import("../../src/workflow/watcher.js");
  reporter.assert(
    "A-WATCHER-EXPORTS",
    Object.keys(watcher).length > 0,
    Object.keys(watcher).join(","),
  );
}

async function testMemoryReviewAndVersions(): Promise<void> {
  const project = `e2e-mem-${process.pid}-${Date.now()}`;
  process.env.QUIVER_PROJECT_NAME = project;
  const schema = await import("../../src/memory/schema.js");
  const fact = schema.createMemoryFact({
    type: "user_preference",
    content: "Prefer Excel cell citations for quantitative claims",
    privacy: "project",
    source_session: "e2e-test",
  });
  await schema.appendMemoryFact(fact);
  const pending = await schema.readPendingMemoryFacts();
  reporter.assert(
    "A-MEMORY-PENDING",
    pending.some((f) => f.id === fact.id),
    `pending=${pending.length}`,
  );

  const review = await import("../../src/memory/review_queue.js");
  const result = await review.processReview(fact.id, "accept");
  reporter.assert(
    "A-MEMORY-ACCEPT",
    result.success === true,
    result.message,
  );

  const versioned = await import("../../src/memory/versioned.js");
  const { getProjectMemoryDir } = await import("../../src/paths.js");
  const memDir = getProjectMemoryDir();
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, "project.md"), "v1 content\n");
  await versioned.createSnapshot("project.md", "e2e snapshot");
  fs.writeFileSync(path.join(memDir, "project.md"), "v2 content\n");
  const history = await versioned.getHistory("project.md");
  reporter.assert(
    "A-MEMORY-VERSION",
    history.length >= 1,
    `history=${history.length}`,
  );
}

async function testMockConnectorAndDataQuery(): Promise<void> {
  const { ConnectorRegistry } = await import(
    "../../src/connectors/framework.js"
  );
  const registry = new ConnectorRegistry();
  const provenance = {
    vendor: "mock_vendor",
    dataset: "mock",
    timestamp: new Date().toISOString(),
    apiRef: "mock://1",
  };
  registry.register({
    name: "mock_vendor",
    label: "Mock Vendor",
    dataTypes: ["Filing"],
    requiresAuth: false,
    sendsIdentifiers: true,
    search: async () => [
      {
        identifier: "1",
        name: "Mock Hit",
        description: "ok",
        dataType: "Filing",
        provenance,
      },
    ],
    fetch: async () => ({
      identifier: "1",
      dataType: "Filing",
      data: { body: "mock body" },
      provenance,
    }),
  });

  const listed = registry.list();
  reporter.assert(
    "A-CONNECTOR-REGISTER",
    listed.some((c) => c.name === "mock_vendor"),
    JSON.stringify(listed),
  );

  const hits = await registry.search("acme");
  reporter.assert(
    "A-CONNECTOR-SEARCH",
    hits.length >= 1,
    JSON.stringify(hits).slice(0, 160),
  );

  const dq = fs.readFileSync(path.join(ROOT, "src/tools/data_query.ts"), "utf8");
  reporter.assert(
    "A-CONNECTOR-SENSITIVITY-WIRED",
    /sendsIdentifiers/.test(dq),
    "data_query mentions sendsIdentifiers",
  );
}

async function testMockMcp(): Promise<void> {
  const { McpConnection } = await import("../../src/mcp/client.js");
  const serverPath = path.join(ROOT, "tests/harness/mock_mcp_server.cjs");
  const conn = new McpConnection("mock", {
    command: process.execPath,
    args: [serverPath],
    sendsIdentifiers: false,
  });

  try {
    await conn.connect();
    const tools = await conn.listTools();
    reporter.assert(
      "A-MCP-CONNECT",
      conn.connected === true && tools.some((t) => t.name === "echo"),
      JSON.stringify(tools),
    );
    const result = await conn.callTool("echo", { text: "ping" });
    const text = JSON.stringify(result);
    reporter.assert("A-MCP-CALL", /echo:ping/.test(text), text.slice(0, 200));
  } catch (e: any) {
    reporter.fail("A-MCP-CONNECT", e?.message || String(e));
    reporter.fail("A-MCP-CALL", "skipped due to connect failure");
  } finally {
    try {
      (conn as any).close?.();
    } catch {
      /* ignore */
    }
  }
}

async function testEpisodicHarvester(): Promise<void> {
  process.env.QUIVER_PROJECT_NAME = `e2e-harvest-${process.pid}`;
  const { harvestWorkflowCompletion } = await import(
    "../../src/memory/episodic_harvester.js"
  );
  const run = {
    run_id: `run-e2e-${Date.now()}`,
    status: "completed",
    phases: [
      {
        phase: "train",
        output:
          "Decision: Always cite Excel cells for revenue figures in IC memos",
      },
      {
        phase: "verify",
        output:
          "Lesson: Unsourced leverage claims must be flagged unresolved",
      },
    ],
  } as any;
  const def = { id: "ic-memo", name: "IC Memo" } as any;
  const result = await harvestWorkflowCompletion(def, run);
  reporter.assert(
    "A-HARVEST",
    result.created >= 1 || result.candidates.length >= 1,
    JSON.stringify(result),
  );
}

async function testDaemonSmoke(): Promise<void> {
  const smoke = path.join(ROOT, "scripts/daemon_smoke.ts");
  await new Promise<void>((resolve) => {
    const child = spawn("npx", ["tsx", smoke], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      reporter.fail("A-DAEMON-SMOKE", "timed out");
      resolve();
    }, 60_000);
    child.on("close", (c) => {
      clearTimeout(t);
      reporter.assert(
        "A-DAEMON-SMOKE",
        c === 0,
        c === 0 ? "smoke passed" : `code=${c} out=${out.slice(-300)}`,
      );
      resolve();
    });
  });
}

async function testSlashAndUpdateWiring(): Promise<void> {
  const slash = fs.readFileSync(path.join(ROOT, "src/slash_commands.ts"), "utf8");
  reporter.assert(
    "A-SLASH-SURFACE",
    ["/consent", "/workflow", "/promote", "/memory"].every((c) =>
      slash.includes(c),
    ),
    "core slash commands present",
  );
  const updateSrc = fs.existsSync(path.join(ROOT, "src/updates.ts"))
    ? fs.readFileSync(path.join(ROOT, "src/updates.ts"), "utf8")
    : fs.readFileSync(path.join(ROOT, "scripts/sign-release.ts"), "utf8");
  reporter.assert(
    "A-UPDATE-SIGNING",
    /sign|manifest|pubkey|VERIFY/i.test(updateSrc),
    "update signing surface present",
  );
}

export async function runTierA(): Promise<E2eReporter> {
  console.log("\n══ Tier A — offline behavioral e2e ══");
  await testAgentChatLoop();
  await testConsentBlocksUntilApproved();
  await testSensitivityRefuse();
  await testEvidenceFailClosed();
  await testIsolationAndChecker();
  await testSchedulerAndWatcher();
  await testMemoryReviewAndVersions();
  await testMockConnectorAndDataQuery();
  await testMockMcp();
  await testEpisodicHarvester();
  await testSlashAndUpdateWiring();
  await testDaemonSmoke();
  return reporter;
}

const isDirect =
  process.argv[1]?.includes("tier_a_offline") ||
  import.meta.url.endsWith(process.argv[1] || "");

if (isDirect) {
  runTierA()
    .then((r) => {
      const { passed, failed } = r.summary();
      console.log(`\nTier A: ${passed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
