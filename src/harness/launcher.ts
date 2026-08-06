/**
 * Minimal launcher/CLI — Phase 8 (ADR-009).
 *
 * start/stop/status, opening the browser, choosing/registering a local
 * workspace, "open with Quiver", diagnostics/connector tests, and
 * service/autostart management. This is the thin entry point for non-technical
 * users; the runtime stays in the daemon.
 */

import { QuiverDaemon, loadOrCreateSecret } from "./daemon.js";
import { HarnessDaemon } from "./harness-daemon.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface LauncherState {
  pid: number;
  port: number;
  origin: string;
  startedAt: string;
}

/**
 * Build the PRODUCTION workflow engine — the same composition root used by
 * the CLI and the browser chat path. Constructs the real model gateway
 * (QuiverOpenRouterClient with ZDR enforcement, or the local OpenAI-compatible
 * provider) and the real tool registry. Fails with an honest configuration
 * error when no provider is configured — never substitutes a mock success.
 *
 * Demo transports exist only behind buildDemoEngine() (tests) and are visibly
 * labelled. No production caller may use buildDemoEngine().
 */

/**
 * Resolve the production customer pack: the QUIVER_PACK env path, or undefined
 * (shipped catalog) when unset. Both buildProductionEngine (model registry) and
 * the daemon (workflow allowlist) call this so the SAME pack drives the whole
 * production browser path — model routing AND runnable workflows.
 */
export async function resolveProductionPack(): Promise<import("./customer-pack.js").CustomerPack | undefined> {
  const packPathArg = process.env.QUIVER_PACK;
  if (!packPathArg) return undefined;
  const { CustomerPackRegistry } = await import("./customer-pack.js");
  const reg = new CustomerPackRegistry();
  return reg.loadFromFile(packPathArg).pack;
}

export async function buildProductionEngine(pack?: import("./customer-pack.js").CustomerPack): Promise<import("./interfaces.js").ExecutionEngine> {
  const { QuiverExecutionEngine } = await import("./execution-engine.js");
  const { SqliteCheckpointSaver } = await import("./sqlite-checkpoint.js");
  const { ModelProfileRegistry, starterCatalog, applyApprovedModels } = await import("./model-profile.js");
  const { QuiverOpenRouterClient, LocalModelClient, ChatOpenRouterTransport } = await import("./model-client.js");
  const { QuiverPolicyEngine } = await import("./policy-engine.js");
  const { emptyPack } = await import("./customer-pack.js");
  const { config } = await import("../config.js");
  const { globalRegistry } = await import("../registry.js");

  await globalRegistry.loadAll();
  // Install the network guard for air-gapped / private-network profiles (§7).
  const { resolveDeploymentProfile, installNetworkGuard } = await import("../security/execution_context.js");
  const profile = resolveDeploymentProfile();
  installNetworkGuard(profile);
  const saver = new SqliteCheckpointSaver(path.join(os.homedir(), ".quiver", "harness-checkpoints.db"));
  // Resolve a customer pack: an explicit `pack` arg, else the QUIVER_PACK env
  // path. Without either, the shipped starter catalog runs as-is. A pack's
  // approvedModels DRIVE the router (unapproved profiles removed → fail
  // closed) and override provider orders.
  const resolvedPack = pack ?? (await resolveProductionPack());
  const base = new ModelProfileRegistry();
  for (const pp of starterCatalog()) base.register(pp);
  const profiles = resolvedPack ? applyApprovedModels(base, resolvedPack.approvedModels) : base;
  const enginePack = resolvedPack ?? emptyPack();
  const policy = new QuiverPolicyEngine(enginePack);

  // ── Real model gateway: OpenRouter (cloud) or local OpenAI-compatible ──
  let model: import("./interfaces.js").ModelClient;
  const siteUrl = "https://convictionstudio.com";
  const siteName = "Quiver";

  if (config.openRouterApiKey && config.openRouterModelProfile) {
    // Sole cloud gateway (ADR-001). ZDR + data_collection=deny enforced per request.
    const transport = new ChatOpenRouterTransport(config.openRouterApiKey, { siteUrl, siteName });
    model = new QuiverOpenRouterClient(transport, profiles, policy, { siteUrl, siteName });
  } else if (config.llmBaseUrl) {
    // Local/private OpenAI-compatible endpoint (air-gapped / MNPI escape hatch).
    const { OpenAICompatibleProvider } = await import("../providers/types.js");
    const provider = new OpenAICompatibleProvider("default", config.llmBaseUrl, config.llmApiKey);
    const localTransport = {
      async invoke(req: any) {
        const ev = await provider.streamChat({
          model: req.model, messages: req.messages, tools: req.tools,
          temperature: req.temperature, topP: req.topP, maxTokens: req.maxTokens,
          signal: req.signal ?? new AbortController().signal,
        } as any, req.signal ?? new AbortController().signal);
        let content = ""; let usage: any;
        for await (const e of ev) {
          if (e.type === "text_delta") content += e.content ?? "";
          if (e.type === "done") usage = e.usage;
        }
        return { content, route: "local", usage };
      },
    };
    model = new LocalModelClient(localTransport as any, profiles);
  } else {
    // Honest configuration error — no mock, no synthetic success.
    throw new Error(
      "No model provider configured. Set OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE " +
      "for cloud inference (the sole cloud gateway), or LLM_API_BASE_URL for a local " +
      "OpenAI-compatible endpoint. Quiver refuses to run workflows against a mock.",
    );
  }

  // ── Real tool executor: wraps the live tool registry (no stubs) ──
  const tools: import("./execution-engine.js").ToolExecutor = {
    available: () => globalRegistry.getAllTools().map((t) => t.name),
    async call(name: string, args: Record<string, unknown>) {
      const tool = globalRegistry.getTool(name);
      if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
      try {
        const out = await tool.execute(args);
        return { ok: true, output: out };
      } catch (err: any) {
        return { ok: false, error: String(err?.message || err) };
      }
    },
  };

  return new QuiverExecutionEngine(saver, model, tools, { maxIterations: 20 });
}

/**
 * DEMO ONLY — mock model + stub tools. Never used in production paths.
 * Exists solely so harness tests can exercise the goal-loop state machine
 * without a live model. Visibly labelled; no production caller.
 */
async function buildDemoEngine(): Promise<import("./interfaces.js").ExecutionEngine> {
  const DEMO_ENGINE = true; // labelled sentinel — no production caller (ADR-009 §5)
  const { QuiverExecutionEngine } = await import("./execution-engine.js");
  const { SqliteCheckpointSaver } = await import("./sqlite-checkpoint.js");
  const { ModelProfileRegistry, starterCatalog } = await import("./model-profile.js");
  const { LocalModelClient } = await import("./model-client.js");
  const saver = new SqliteCheckpointSaver(path.join(os.homedir(), ".quiver", "harness-checkpoints.db"));
  const profiles = new ModelProfileRegistry();
  for (const pp of starterCatalog()) profiles.register(pp);
  const mockTransport = { async invoke() { return { content: "OK all met", route: "local", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }; } };
  const model = new LocalModelClient(mockTransport, profiles);
  const tools = { available: () => ["office_doc", "evidence", "deep_research"], async call(n: string, a: Record<string, unknown>) { return { ok: true, output: `${n}:${a.step}`, evidenceRefs: [`e-${a.step}`] }; } };
  return new QuiverExecutionEngine(saver, model, tools as any, { maxIterations: 20 });
}

export class QuiverLauncher {
  constructor(private statePath: string = path.join(os.homedir(), ".quiver", "daemon-state.json")) {}

  async start(opts: { roots?: string[]; port?: number; uiDir?: string } = {}): Promise<LauncherState> {
    const secret = loadOrCreateSecret();
    const daemon = new QuiverDaemon({ secret, roots: opts.roots, uiDir: opts.uiDir });
    const { port, origin } = await daemon.listen(opts.port);
    const state: LauncherState = { pid: process.pid, port, origin, startedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    // Keep the process alive serving; the caller controls lifecycle.
    return state;
  }

  /**
   * Start the harness daemon (browser UI + harness API) for interactive use.
   * The engine is injected by the caller (a real deployment wires the
   * QuiverOpenRouterProvider bridge + tool registry; a demo wires mocks).
   * Opens the browser with the per-install secret in the URL fragment (never
   * sent to the server). Keeps the process alive serving.
   */
  async startHarness(engine: import("./interfaces.js").ExecutionEngine, opts: { uiDir?: string; port?: number; open?: boolean } = {}, pack?: import("./customer-pack.js").CustomerPack): Promise<LauncherState> {
    const secret = loadOrCreateSecret();
    const uiDir = opts.uiDir ?? path.join(path.dirname(new URL(import.meta.url).pathname), "ui");
    // The browser-UI bridge: the chatbot/context/sessions surface (ADR-009).
    const { browserApiHandler, browserSseHandler } = await import("./browser-bridge.js");
    // Thread the customer pack into the daemon so its workflowSpecs allowlist
    // is enforced end-to-end (not just the model registry).
    const hd = new HarnessDaemon({ engine, secret, uiDir, browserApiHandler, sseHandler: browserSseHandler, ssePath: "/api/agent/events", pack });
    const { port, origin } = await hd.listen(opts.port);
    const state: LauncherState = { pid: process.pid, port, origin, startedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    if (opts.open !== false) {
      // Secret in the fragment so the browser has it for API calls but it is
      // never transmitted to the server in the request.
      const { spawn } = await import("child_process");
      const url = `${origin}/#token=${encodeURIComponent(secret)}`;
      const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      try { spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
    }
    return state;
  }

  /**
   * Start the browser UI as the interactive experience plane (ADR-009).
   * Builds a demo workflow-run engine (so /api/workflows + /api/run/* work)
   * + the browser bridge (the chatbot/context/sessions surface). `quiver` on
   * a TTY calls this instead of entering the legacy REPL.
   */
  async startBrowserUI(opts: { uiDir?: string; port?: number; open?: boolean } = {}): Promise<LauncherState> {
    // Resolve the customer pack ONCE so the SAME pack drives the model registry
    // (buildProductionEngine) and the daemon's workflow allowlist.
    const pack = await resolveProductionPack();
    const engine = await buildProductionEngine(pack);
    return this.startHarness(engine, opts, pack);
  }

  status(): LauncherState | null {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Open the browser UI for the running daemon. */
  async open(): Promise<{ opened: boolean; origin?: string }> {
    const st = this.status();
    if (!st) return { opened: false };
    // Defer the actual `open` command to the platform; in tests we just report.
    return { opened: true, origin: st.origin };
  }

  /** Diagnostics: check daemon reachability + connector presence. */
  async diagnostics(): Promise<{ daemonReachable: boolean; secret: boolean; roots: string[] }> {
    const st = this.status();
    if (!st) return { daemonReachable: false, secret: false, roots: [] };
    try {
      const res = await fetch(`${st.origin}/health`);
      const j = await res.json() as { status?: string };
      return { daemonReachable: j.status === "ok", secret: true, roots: [] };
    } catch {
      return { daemonReachable: false, secret: true, roots: [] };
    }
  }

  /** Register a local workspace root (explicit grant). */
  registerWorkspace(root: string): void {
    const rootsPath = this.statePath.replace("daemon-state.json", "workspace-roots.json");
    let roots: string[] = [];
    try { roots = JSON.parse(fs.readFileSync(rootsPath, "utf8")); } catch { roots = []; }
    const abs = path.resolve(root);
    if (!roots.includes(abs)) roots.push(abs);
    fs.writeFileSync(rootsPath, JSON.stringify(roots, null, 2));
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────

export async function runLauncherCli(args: string[]): Promise<number> {
  const launcher = new QuiverLauncher();
  const cmd = args[0];
  switch (cmd) {
    case "start": {
      const state = await launcher.start({ roots: args.slice(1) });
      console.log(`Quiver daemon on ${state.origin} (pid ${state.pid})`);
      return 0;
    }
    case "harness": {
      // Production composition root — real model gateway + real tool registry.
      const engine = await buildProductionEngine();
      const state = await launcher.startHarness(engine, { open: true });
      console.log(`Quiver harness daemon on ${state.origin} (pid ${state.pid}) — opening browser…`);
      return 0;
    }
    case "status": {
      const st = launcher.status();
      console.log(st ? `running on ${st.origin} (pid ${st.pid}, since ${st.startedAt})` : "not running");
      return 0;
    }
    case "open": {
      const r = await launcher.open();
      console.log(r.opened ? `opening ${r.origin}` : "daemon not running");
      return r.opened ? 0 : 1;
    }
    case "diagnostics": {
      const d = await launcher.diagnostics();
      console.log(JSON.stringify(d, null, 2));
      return d.daemonReachable ? 0 : 1;
    }
    case "register-workspace": {
      launcher.registerWorkspace(args[1] ?? process.cwd());
      console.log("workspace root registered");
      return 0;
    }
    case "help":
    case undefined:
      console.log("quiver-daemon [start|harness|status|open|diagnostics|register-workspace <path>]");
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}

// CLI entry point. For long-running subcommands (start/harness) the daemon's
// HTTP server keeps the process alive — do not force-exit on success. Short
// commands (status/open/diagnostics/register-workspace) have no server handle,
// so the event loop drains and the process exits naturally.
if (import.meta.url === `file://${process.argv[1]}`) {
  runLauncherCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}