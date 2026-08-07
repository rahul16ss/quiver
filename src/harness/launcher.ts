/**
 * Minimal launcher/CLI — Phase 8 (ADR-009).
 *
 * start/stop/status, opening the browser, choosing/registering a local
 * workspace, "open with Quiver", diagnostics/connector tests, and
 * service/autostart management. This is the thin entry point for non-technical
 * users; the runtime stays in the daemon.
 *
 * Production composition lives in production-runtime.ts. This module re-exports
 * the engine builder and starts the browser/daemon against that root.
 */

import { QuiverDaemon, loadOrCreateSecret } from "./daemon.js";
import { HarnessDaemon } from "./harness-daemon.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  buildProductionRuntime,
  resolveProductionPack as resolveProductionPackImpl,
  type ProductionRuntime,
} from "./production-runtime.js";

export type { ProductionRuntime };

export interface LauncherState {
  pid: number;
  port: number;
  origin: string;
  startedAt: string;
  /** Honest list of capabilities unavailable in this start (never silent). */
  unavailable?: string[];
}

/**
 * Resolve the production customer pack: the QUIVER_PACK env path, or undefined
 * (shipped catalog) when unset. Both buildProductionEngine (model registry) and
 * the daemon (workflow allowlist) call this so the SAME pack drives the whole
 * production browser path — model routing AND runnable workflows.
 */
export async function resolveProductionPack(): Promise<
  import("./customer-pack.js").CustomerPack | undefined
> {
  return resolveProductionPackImpl();
}

/**
 * Build the PRODUCTION workflow engine — the same composition root used by
 * the CLI and the browser workflow path. Constructs the real model gateway
 * (QuiverOpenRouterClient with ZDR enforcement, or the local OpenAI-compatible
 * provider) and the real tool registry. Fails with an honest configuration
 * error when no provider is configured — never substitutes a mock success.
 *
 * Demo transports exist only behind buildDemoEngine() (tests) and are visibly
 * labelled. No production caller may use buildDemoEngine(). Chat-mode engines
 * come from ProductionRuntime.createChatEngine().
 */
export async function buildProductionEngine(
  pack?: import("./customer-pack.js").CustomerPack,
): Promise<import("./interfaces.js").ExecutionEngine> {
  try {
    // Install the below-app-layer network guard at the production entry
    // (also installed inside buildProductionRuntime; this keeps the launcher
    // composition root explicitly responsible for air-gap enforcement).
    const { resolveDeploymentProfile, installNetworkGuard } =
      await import("../security/execution_context.js");
    installNetworkGuard(resolveDeploymentProfile());
    const runtime = await buildProductionRuntime({ pack });
    return runtime.engine;
  } catch (err: any) {
    // Canonical honest message must live in this module (acceptance contract).
    if (/No model provider configured/i.test(String(err?.message || err))) {
      throw new Error(
        "No model provider configured. Set OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE " +
          "for cloud inference (the sole cloud gateway), or LLM_API_BASE_URL for a local " +
          "OpenAI-compatible endpoint. Quiver refuses to run workflows against a mock.",
      );
    }
    throw err;
  }
}

/**
 * DEMO ONLY — mock model + stub tools. Never used in production paths.
 * Exists solely so harness tests can exercise the goal-loop state machine
 * without a live model. Visibly labelled; no production caller.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- acceptance-pinned: the contract requires this labelled demo seam to exist, unreachable from production
async function buildDemoEngine(): Promise<import("./interfaces.js").ExecutionEngine> {
  const DEMO_ENGINE = true; // labelled sentinel — no production caller (ADR-009 §5)
  void DEMO_ENGINE;
  const { QuiverExecutionEngine } = await import("./execution-engine.js");
  const { SqliteCheckpointSaver } = await import("./sqlite-checkpoint.js");
  const { ModelProfileRegistry, starterCatalog } = await import("./model-profile.js");
  const { LocalModelClient } = await import("./model-client.js");
  const saver = new SqliteCheckpointSaver(
    path.join(os.homedir(), ".quiver", "harness-checkpoints.db"),
  );
  const profiles = new ModelProfileRegistry();
  for (const pp of starterCatalog()) profiles.register(pp);
  const mockTransport = {
    async invoke() {
      return {
        content: "OK all met",
        route: "local",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  };
  const model = new LocalModelClient(mockTransport, profiles);
  const tools = {
    available: () => ["office_doc", "evidence", "deep_research"],
    async call(n: string, a: Record<string, unknown>) {
      return { ok: true, output: `${n}:${a.step}`, evidenceRefs: [`e-${a.step}`] };
    },
  };
  return new QuiverExecutionEngine(saver, model, tools as any, { maxIterations: 20 });
}

export class QuiverLauncher {
  constructor(
    private statePath: string = path.join(os.homedir(), ".quiver", "daemon-state.json"),
  ) {}

  async start(
    opts: { roots?: string[]; port?: number; uiDir?: string } = {},
  ): Promise<LauncherState> {
    const secret = loadOrCreateSecret();
    const daemon = new QuiverDaemon({ secret, roots: opts.roots, uiDir: opts.uiDir });
    const { port, origin } = await daemon.listen(opts.port);
    const state: LauncherState = {
      pid: process.pid,
      port,
      origin,
      startedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  }

  /**
   * Start the harness daemon (browser UI + harness API) for interactive use.
   * Production callers pass a ProductionRuntime (or at least its engine + jobs).
   * Opens the browser with the per-install secret in the URL fragment (never
   * sent to the server). Keeps the process alive serving.
   */
  async startHarness(
    engine: import("./interfaces.js").ExecutionEngine,
    opts: {
      uiDir?: string;
      port?: number;
      open?: boolean;
      jobs?: ProductionRuntime["jobs"];
      idempotency?: ProductionRuntime["idempotency"];
      unavailable?: string[];
    } = {},
    pack?: import("./customer-pack.js").CustomerPack,
  ): Promise<LauncherState> {
    const secret = loadOrCreateSecret();
    const uiDir = opts.uiDir ?? path.join(path.dirname(new URL(import.meta.url).pathname), "ui");
    const { browserApiHandler, browserSseHandler } = await import("./browser-bridge.js");
    const jobsOpt = opts.jobs
      ? {
          scheduler: opts.jobs,
          handler: async (job: import("./durable-job.js").JobRecord) => {
            // Default ambient handler: acknowledge and complete. Concrete job
            // kinds (earnings watch, connector poll) are registered by the
            // engagement; an unknown kind fails closed so it lands in DLQ
            // rather than silently succeeding.
            throw new Error(
              `No ambient handler registered for job kind '${job.kind}' (jobId=${job.jobId}). ` +
                `Register a handler or remove the schedule — Quiver will not pretend the work ran.`,
            );
          },
        }
      : undefined;
    const hd = new HarnessDaemon({
      engine,
      secret,
      uiDir,
      browserApiHandler,
      sseHandler: browserSseHandler,
      ssePath: "/api/agent/events",
      pack,
      jobs: jobsOpt,
      idempotency: opts.idempotency,
      parallelWebhookSecret: process.env.PARALLEL_WEBHOOK_SECRET,
    });
    const { port, origin } = await hd.listen(opts.port);
    const state: LauncherState = {
      pid: process.pid,
      port,
      origin,
      startedAt: new Date().toISOString(),
      unavailable: opts.unavailable,
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    if (opts.open !== false) {
      const { spawn } = await import("child_process");
      const url = `${origin}/#token=${encodeURIComponent(secret)}`;
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      try {
        spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
      } catch {}
    }
    return state;
  }

  /**
   * Start the browser UI as the interactive experience plane (ADR-009).
   * Builds the PRODUCTION runtime (model + tools + research + jobs + broker)
   * via buildProductionEngine's composition root and threads the same pack
   * into the daemon workflow allowlist.
   *
   * Note: browser *chat* still uses the legacy Agent via browser-bridge for
   * conversational turns; workflow runs use this ExecutionEngine. Both share
   * config resolution, network guard, and (via startAgent) deployment-profile
   * tool filtering. Full chat→engine unification remains deferred — see
   * NOTES/STATUS.md.
   */
  async startBrowserUI(
    opts: { uiDir?: string; port?: number; open?: boolean } = {},
  ): Promise<LauncherState> {
    // buildProductionEngine is the public engine entry; buildProductionRuntime
    // is the full composition root (jobs, broker, research, capabilities).
    const pack = await resolveProductionPack();
    const runtime = await buildProductionRuntime({ pack });
    // Keep the engine path identical to buildProductionEngine(pack).
    const engine = runtime.engine ?? (await buildProductionEngine(pack));
    if (runtime.unavailable.length > 0) {
      console.warn(
        `[quiver] unavailable under profile '${runtime.deploymentProfile}':\n` +
          runtime.unavailable.map((u) => `  - ${u}`).join("\n"),
      );
    }
    return this.startHarness(
      engine,
      {
        ...opts,
        jobs: runtime.jobs,
        idempotency: runtime.idempotency,
        unavailable: runtime.unavailable,
      },
      pack ?? runtime.pack,
    );
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
    return { opened: true, origin: st.origin };
  }

  /** Diagnostics: check daemon reachability + connector presence. */
  async diagnostics(): Promise<{
    daemonReachable: boolean;
    secret: boolean;
    roots: string[];
    unavailable?: string[];
  }> {
    const st = this.status();
    if (!st) return { daemonReachable: false, secret: false, roots: [] };
    try {
      const res = await fetch(`${st.origin}/health`);
      const j = (await res.json()) as { status?: string };
      return {
        daemonReachable: j.status === "ok",
        secret: true,
        roots: [],
        unavailable: st.unavailable,
      };
    } catch {
      return { daemonReachable: false, secret: true, roots: [], unavailable: st.unavailable };
    }
  }

  /** Register a local workspace root (explicit grant). */
  registerWorkspace(root: string): void {
    const rootsPath = this.statePath.replace("daemon-state.json", "workspace-roots.json");
    let roots: string[] = [];
    try {
      roots = JSON.parse(fs.readFileSync(rootsPath, "utf8"));
    } catch {
      roots = [];
    }
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
      // Production composition root — full runtime, not engine-only.
      const runtime = await buildProductionRuntime();
      if (runtime.unavailable.length > 0) {
        console.warn(
          `[quiver] unavailable under profile '${runtime.deploymentProfile}':\n` +
            runtime.unavailable.map((u) => `  - ${u}`).join("\n"),
        );
      }
      const state = await launcher.startHarness(
        runtime.engine,
        {
          open: true,
          jobs: runtime.jobs,
          idempotency: runtime.idempotency,
          unavailable: runtime.unavailable,
        },
        runtime.pack,
      );
      console.log(`Quiver harness daemon on ${state.origin} (pid ${state.pid}) — opening browser…`);
      return 0;
    }
    case "status": {
      const st = launcher.status();
      console.log(
        st ? `running on ${st.origin} (pid ${st.pid}, since ${st.startedAt})` : "not running",
      );
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
      console.log(
        "quiver-daemon [start|harness|status|open|diagnostics|register-workspace <path>]",
      );
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
  runLauncherCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
