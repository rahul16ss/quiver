/**
 * ProductionRuntime — the single composition root for browser, CLI and daemon.
 *
 * Every production entry point must construct Quiver through this module.
 * Demo/mock transports are not reachable from here. Missing credentials produce
 * honest configuration errors or explicit `unavailable` entries — never silent
 * substitutes.
 *
 * Wires: model gateway, policy, capability registry, research gateway (when
 * Parallel is configured and the deployment profile allows public internet),
 * integration broker, research-state store, durable jobs + idempotency ledger,
 * OfficeCLI engine (when binary present), artifact/trace sinks, and an
 * ExecutionContext that filters tools for air-gapped / private-network.
 */

import * as path from "path";
import * as os from "os";
import type { ExecutionEngine, ResearchGateway, PolicyEngine } from "./interfaces.js";
import type { CustomerPack } from "./customer-pack.js";
import type { ModelProfileRegistry } from "./model-profile.js";
import type { CapabilityRegistry } from "./capability-registry.js";
import type { QuiverIntegrationBroker } from "./integration-broker.js";
import type { ResearchStateStore } from "./research-state-store.js";
import type { DurableJobScheduler, DurableIdempotencyLedger } from "./durable-job.js";
import type { OfficeCliEngine } from "./office-engine.js";
import type { LocalArtifactRepository } from "./artifact-repository.js";
import type { LocalTraceSink } from "./trace-sink.js";
import type { DeploymentProfile, ExecutionContext } from "../security/execution_context.js";

export interface ProductionRuntime {
  engine: ExecutionEngine;
  pack?: CustomerPack;
  profiles: ModelProfileRegistry;
  policy: PolicyEngine;
  capabilities: CapabilityRegistry;
  research: ResearchGateway | null;
  broker: QuiverIntegrationBroker;
  researchState: ResearchStateStore;
  jobs: DurableJobScheduler;
  idempotency: DurableIdempotencyLedger;
  office: OfficeCliEngine | null;
  /** Per-engagement cost accounting (durable JSONL). */
  costs: import("./cost-ledger.js").CostLedger;
  artifacts: LocalArtifactRepository;
  traces: LocalTraceSink;
  executionContext: ExecutionContext;
  deploymentProfile: DeploymentProfile;
  /** Capabilities that could not be constructed — honest, not silent. */
  unavailable: string[];
  /**
   * Build a chat-mode ExecutionEngine on the SAME control plane (checkpointer,
   * model gateway, tool executor) as workflow runs. The conversational ReAct
   * loop is delegated to the supplied turn executor; the engine owns the
   * durable run record, trace spans, and honest outcome.
   */
  createChatEngine(turnExecutor: import("./execution-engine.js").TurnExecutor): ExecutionEngine;
}

export interface BuildProductionRuntimeOpts {
  pack?: CustomerPack;
  /** Override home data dir (tests). Default ~/.quiver */
  dataDir?: string;
  /** Skip throwing when no model is configured (tests that only inspect wiring). */
  allowMissingModel?: boolean;
}

/**
 * Resolve the production customer pack: QUIVER_PACK env path, or undefined
 * (shipped catalog) when unset.
 */
export async function resolveProductionPack(): Promise<CustomerPack | undefined> {
  const packPathArg = process.env.QUIVER_PACK;
  if (!packPathArg) return undefined;
  const { CustomerPackRegistry } = await import("./customer-pack.js");
  const reg = new CustomerPackRegistry();
  return reg.loadFromFile(packPathArg).pack;
}

/**
 * Build the full production runtime. Fails closed when no model provider is
 * configured (unless `allowMissingModel` is set for wiring-only inspection).
 */
export async function buildProductionRuntime(
  opts: BuildProductionRuntimeOpts = {},
): Promise<ProductionRuntime> {
  const { QuiverExecutionEngine } = await import("./execution-engine.js");
  const { SqliteCheckpointSaver } = await import("./sqlite-checkpoint.js");
  const { ModelProfileRegistry, starterCatalog, applyApprovedModels } =
    await import("./model-profile.js");
  const { QuiverOpenRouterClient, LocalModelClient, ChatOpenRouterTransport } =
    await import("./model-client.js");
  const { QuiverPolicyEngine } = await import("./policy-engine.js");
  const { emptyPack } = await import("./customer-pack.js");
  const { CapabilityRegistry } = await import("./capability-registry.js");
  const { QuiverIntegrationBroker } = await import("./integration-broker.js");
  const { ResearchStateStore } = await import("./research-state-store.js");
  const { DurableJobScheduler, DurableIdempotencyLedger } = await import("./durable-job.js");
  const { SqliteCursorKV } = await import("./cursor-store.js");
  const { LocalArtifactRepository } = await import("./artifact-repository.js");
  const { LocalTraceSink } = await import("./trace-sink.js");
  const {
    resolveDeploymentProfile,
    installNetworkGuard,
    buildExecutionContext,
    filterToolsByContext,
    profileConfig,
  } = await import("../security/execution_context.js");
  const { config } = await import("../config.js");
  const { globalRegistry } = await import("../registry.js");

  const unavailable: string[] = [];
  const dataDir = opts.dataDir ?? path.join(os.homedir(), ".quiver");
  const deploymentProfile = resolveDeploymentProfile();
  installNetworkGuard(deploymentProfile);

  await globalRegistry.loadAll();

  const resolvedPack = opts.pack ?? (await resolveProductionPack());
  const base = new ModelProfileRegistry();
  for (const pp of starterCatalog()) base.register(pp);
  const profiles = resolvedPack ? applyApprovedModels(base, resolvedPack.approvedModels) : base;
  const enginePack = resolvedPack ?? emptyPack();
  const policy = new QuiverPolicyEngine(enginePack);

  // Capability registry: seed from any profile certifications already recorded.
  // Profiles that have never been contract-tested contribute nothing for MIME —
  // native MIME requests fail closed until a live contract test records a pass.
  const capabilities = new CapabilityRegistry();
  seedCapabilitiesFromProfiles(capabilities, profiles);

  // Measured routing evidence (routing-eval harness). Absent/stale snapshots
  // change nothing — the router falls back to its static order.
  const { RoutingEvidenceStore } = await import("./routing-eval.js");
  const routingEvidence = new RoutingEvidenceStore(path.join(dataDir, "routing-evidence.json"));

  // Per-engagement cost ledger (§P1): usage recorded per model call; budget
  // caps enforced pre-invocation when a contract carries budgets.costUsd.
  const { CostLedger } = await import("./cost-ledger.js");
  const costLedger = new CostLedger(path.join(dataDir, "cost-ledger.jsonl"));

  // ── Model gateway ──────────────────────────────────────────────────
  let model: import("./interfaces.js").ModelClient | null = null;
  const siteUrl = "https://convictionstudio.com";
  const siteName = "Quiver";

  if (deploymentProfile === "air-gapped" && config.openRouterApiKey) {
    unavailable.push("openrouter-cloud (removed by air-gapped deployment profile)");
  }

  if (
    deploymentProfile !== "air-gapped" &&
    config.openRouterApiKey &&
    config.openRouterModelProfile
  ) {
    const transport = new ChatOpenRouterTransport(config.openRouterApiKey, { siteUrl, siteName });
    model = new QuiverOpenRouterClient(transport, profiles, policy, {
      siteUrl,
      siteName,
      capabilities,
      routingEvidence,
      costLedger,
    });
  } else if (config.llmBaseUrl) {
    const { OpenAICompatibleProvider } = await import("../providers/types.js");
    const provider = new OpenAICompatibleProvider("default", config.llmBaseUrl, config.llmApiKey);
    const localTransport = {
      async invoke(req: any) {
        const ev = await provider.streamChat(
          {
            model: req.model,
            messages: req.messages,
            tools: req.tools,
            temperature: req.temperature,
            topP: req.topP,
            maxTokens: req.maxTokens,
            signal: req.signal ?? new AbortController().signal,
          } as any,
          req.signal ?? new AbortController().signal,
        );
        let content = "";
        let usage: any;
        for await (const e of ev) {
          if (e.type === "text_delta") content += e.content ?? "";
          if (e.type === "done") usage = e.usage;
        }
        return { content, route: "local", usage };
      },
    };
    model = new LocalModelClient(localTransport as any, profiles, { capabilities });
  } else if (!opts.allowMissingModel) {
    throw new Error(
      "No model provider configured. Set OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE " +
        "for cloud inference (the sole cloud gateway), or LLM_API_BASE_URL for a local " +
        "OpenAI-compatible endpoint. Quiver refuses to run workflows against a mock.",
    );
  } else {
    unavailable.push("model-gateway (no OPENROUTER_* or LLM_API_BASE_URL configured)");
  }

  // ── Execution context + tool filtering ─────────────────────────────
  const allToolNames = globalRegistry.getAllTools().map((t) => t.name);
  const executionContext = buildExecutionContext({
    runId: `runtime-${Date.now()}`,
    customer: enginePack.id,
    actor: "local-operator",
    dataClassification: "confidential-internal",
    profile: deploymentProfile,
    allowedTools: allToolNames,
    traceId: `trace-runtime-${Date.now()}`,
  });
  const allowedTools = new Set(
    filterToolsByContext(
      globalRegistry.getAllTools().map((t) => ({ name: t.name })),
      executionContext,
    ).map((t) => t.name),
  );
  for (const removed of profileConfig(deploymentProfile).removedTools) {
    if (!allowedTools.has(removed)) {
      unavailable.push(`tool:${removed} (removed by ${deploymentProfile})`);
    }
  }

  const tools: import("./execution-engine.js").ToolExecutor = {
    available: () => [...allowedTools],
    async call(name: string, args: Record<string, unknown>) {
      if (!allowedTools.has(name)) {
        return {
          ok: false,
          error: `Tool '${name}' is not permitted under deployment profile '${deploymentProfile}'.`,
        };
      }
      const { invokeUnderRuntime } = await import("./runtime-binding.js");
      const tool = globalRegistry.getTool(name);
      if (
        !tool &&
        !["web_search", "scrape_url", "deep_research", "find_all", "entity_search"].includes(name)
      ) {
        return { ok: false, error: `Unknown tool: ${name}` };
      }
      const result = await invokeUnderRuntime(name, args, async () => {
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        return tool.execute(args);
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, output: result.output };
    },
  };

  // ── Research gateway (Parallel) — only when profile + key allow ────
  let research: ResearchGateway | null = null;
  if (deploymentProfile === "connected-zdr" && config.parallelApiKey) {
    const { ParallelResearchGateway, ParallelWebTransport } = await import("./research-gateway.js");
    research = new ParallelResearchGateway(new ParallelWebTransport(config.parallelApiKey), policy);
  } else if (deploymentProfile !== "connected-zdr") {
    unavailable.push("parallel-research (removed by deployment profile)");
  } else {
    unavailable.push("parallel-research (PARALLEL_API_KEY not configured)");
  }

  // ── Integration broker ─────────────────────────────────────────────
  const broker = new QuiverIntegrationBroker();
  if (research) {
    broker.register({
      declaration: {
        name: "parallel-research",
        label: "Parallel public-web research",
        capabilities: ["search", "extract", "research", "monitor"],
        authScopes: ["PARALLEL_API_KEY"],
        dataClassification: "public",
        readWrite: "read",
        requiredApprovals: [],
        licensedDataRestrictions: ["not-for-licensed-vendor-data"],
        networkZone: "public-internet",
        rights: {
          rights: ["internal-use", "llm-processing", "storage-caching"],
          cacheDurationHours: 24 * 7,
          retentionDays: 30,
        },
        timeoutMs: 60_000,
        maxOutputBytes: 2_000_000,
        health: "unknown",
      },
      invoke: async (input) => {
        const req = input as { op: string; args: any };
        const g = research!;
        switch (req.op) {
          case "search":
            return g.search(req.args.query, req.args.opts);
          case "extract":
            return g.extract(req.args.urls, req.args.opts);
          case "research":
            return g.research(req.args.input, req.args.opts);
          case "monitor":
            return g.monitor(req.args.spec);
          default:
            throw new Error(`unknown parallel op: ${req.op}`);
        }
      },
    });
  }

  // ── Durable state ──────────────────────────────────────────────────
  const researchState = new ResearchStateStore();
  const jobs = new DurableJobScheduler(path.join(dataDir, "durable-jobs.db"));
  const idempotency = new DurableIdempotencyLedger(
    new SqliteCursorKV(path.join(dataDir, "idempotency.db")),
  );
  const artifacts = new LocalArtifactRepository(path.join(dataDir, "artifacts"));
  const traces = new LocalTraceSink();

  // ── OfficeCLI (optional until binary + pin present) ────────────────
  let office: OfficeCliEngine | null = null;
  try {
    const { OfficeCliEngine, ShellOfficeCliRunner, OFFICECLI_PINS } =
      await import("./office-engine.js");
    const { findBinary } = await import("../utils/find_binary.js");
    const configured = process.env.QUIVER_OFFICECLI_PATH?.trim();
    const bin =
      configured && (await import("fs")).existsSync(configured)
        ? configured
        : findBinary(configured || "officecli");
    if (!bin) {
      unavailable.push("officecli (binary not found on PATH; set QUIVER_OFFICECLI_PATH)");
    } else {
      const pin = OFFICECLI_PINS[process.platform] ?? OFFICECLI_PINS.darwin;
      const eng = new OfficeCliEngine(new ShellOfficeCliRunner(bin, pin));
      const ver = await eng.verifyBinary();
      if (ver.ok) {
        office = eng;
        if (ver.reason?.includes("dev mode")) {
          unavailable.push("officecli-checksum-pin (empty pin — binary present but unverified)");
        }
      } else {
        unavailable.push(`officecli (${ver.reason ?? "unavailable"})`);
      }
    }
  } catch (err: any) {
    unavailable.push(`officecli (${String(err?.message || err)})`);
  }

  // ── Engine ─────────────────────────────────────────────────────────
  const saver = new SqliteCheckpointSaver(path.join(dataDir, "harness-checkpoints.db"));
  if (!model && opts.allowMissingModel) {
    model = {
      id: "unconfigured",
      kind: "local",
      listProfiles: () => [],
      invoke: async () => {
        throw new Error("No model provider configured.");
      },
    };
  }
  const engine = new QuiverExecutionEngine(saver, model!, tools, { maxIterations: 20 });
  const createChatEngine = (
    turnExecutor: import("./execution-engine.js").TurnExecutor,
  ): ExecutionEngine =>
    new QuiverExecutionEngine(saver, model!, tools, { maxIterations: 1, turnExecutor });

  const runtime: ProductionRuntime = {
    engine,
    pack: resolvedPack,
    profiles,
    policy,
    capabilities,
    research,
    broker,
    researchState,
    jobs,
    idempotency,
    office,
    costs: costLedger,
    artifacts,
    traces,
    executionContext,
    deploymentProfile,
    unavailable: [...new Set(unavailable)],
    createChatEngine,
  };
  // Bind for chat/Agent + any late tool invokes in this process.
  const { bindProductionRuntime } = await import("./runtime-binding.js");
  bindProductionRuntime(runtime);
  return runtime;
}

/** Convenience: engine-only for callers that already expect ExecutionEngine. */
export async function buildProductionEngine(pack?: CustomerPack): Promise<ExecutionEngine> {
  const runtime = await buildProductionRuntime({ pack });
  return runtime.engine;
}

function seedCapabilitiesFromProfiles(
  capabilities: CapabilityRegistry,
  profiles: ModelProfileRegistry,
): void {
  const runtimeVersion = "quiver-harness";
  for (const p of profiles.list()) {
    const isLocal = p.modelSlug.startsWith("local/") || p.providerOrder.includes("Local");
    const gateway = isLocal ? "local-private" : "openrouter";
    const endpoint = isLocal ? "local" : "https://openrouter.ai/api/v1";
    // Per-MIME records — never one mutable lastContractTest for all MIMEs.
    for (const mime of p.testedNativeMimeTypes) {
      capabilities.record({
        gateway: gateway as any,
        providerEndpoint: endpoint,
        model: p.modelSlug,
        role: p.checkerEligible ? "checker" : "maker",
        runtimeVersion,
        capability: "native-mime",
        mime: mime as any,
        maxFileBytes: p.maxFileBytes,
        lastContractTest: {
          date: p.lastContractTest.date || new Date(0).toISOString(),
          result:
            p.lastContractTest.result === "pass"
              ? "pass"
              : p.lastContractTest.result === "fail"
                ? "fail"
                : "not-run",
          runtimeVersion,
          evidence: `seeded from ModelProfile ${p.slug}`,
        },
      });
    }
    capabilities.record({
      gateway: gateway as any,
      providerEndpoint: endpoint,
      model: p.modelSlug,
      role: p.checkerEligible ? "checker" : "maker",
      runtimeVersion,
      capability: "zdr-security",
      zdrEligible: p.zdrEligible,
      lastContractTest: {
        date: p.lastContractTest.date || new Date(0).toISOString(),
        result: p.zdrEligible ? "pass" : "fail",
        runtimeVersion,
      },
    });
  }
}
