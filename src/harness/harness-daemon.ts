/**
 * HarnessDaemon — Phase 8 (ADR-009).
 *
 * Wraps the loopback QuiverDaemon with a harness API that the browser UI drives
 * to run a real goal-seeking engagement: list the twelve workflow specs, start
 * a run (GoalContract + ExecutionEngine), inspect state, and approve/reject the
 * human gate. This is the experience-plane wiring that makes the browser UI a
 * real replacement for the Electron app's interactive surface.
 *
 * The model + tools are injectable so a real deployment wires the
 * QuiverOpenRouterProvider bridge + the existing tool registry, while tests use
 * mocks. No prompts/documents/excerpts leave the loopback boundary.
 */

import { QuiverDaemon } from "./daemon.js";
import type { ExecutionEngine, RunSnapshot, RunOutcome } from "./interfaces.js";
import type { GoalContract } from "./goal-contract.js";
import { TWELVE_WORKFLOW_SPECS, type WorkflowSpec } from "./workflow-spec.js";

export interface HarnessDaemonOptions {
  secret?: string;
  uiDir?: string;
  port?: number;
  engine: ExecutionEngine;
  /** Optional durable job/signal ambient runner (§14): scheduler + handler. */
  jobs?: {
    scheduler: import("./durable-job.js").DurableJobScheduler;
    /** Executes a due job; throw to mark the attempt failed / dead-letter. */
    handler: (job: import("./durable-job.js").JobRecord) => Promise<void> | void;
  };
  /** Optional browser-UI API handler (the chat/context/sessions surface). */
  browserApiHandler?: (req: { method: string; pathname: string; body: unknown }) => Promise<unknown>;
  /** Optional SSE handler + path (the agent event stream). */
  sseHandler?: (req: import("http").IncomingMessage, res: import("http").ServerResponse) => void;
  ssePath?: string;
}

export class HarnessDaemon {
  private daemon: QuiverDaemon;
  private engine: ExecutionEngine;
  private runs = new Map<string, { contract: GoalContract; outcome?: RunOutcome }>();

  constructor(private opts: HarnessDaemonOptions) {
    this.engine = opts.engine;
    const api = this.api();
    const browserApi = opts.browserApiHandler;
    this.daemon = new QuiverDaemon({
      secret: opts.secret,
      uiDir: opts.uiDir,
      apiHandler: async (req) => this.route(req, api, browserApi),
      sseHandler: opts.sseHandler,
      ssePath: opts.ssePath,
    });
  }

  private async route(req: { method: string; pathname: string; body: any }, api: ReturnType<HarnessDaemon["api"]>, browserApi?: (req: { method: string; pathname: string; body: unknown }) => Promise<unknown>): Promise<unknown> {
    if (req.method === "GET" && req.pathname === "/api/workflows") return api.listWorkflows();
    if (req.method === "POST" && req.pathname === "/api/run/start") return api.startRun(req.body ?? {});
    if (req.method === "POST" && req.pathname === "/api/run/state") return api.state((req.body as any)?.runId ?? "");
    if (req.method === "POST" && req.pathname === "/api/run/approve") return api.approve((req.body as any)?.runId ?? "");
    if (req.method === "POST" && req.pathname === "/api/run/reject") return api.reject((req.body as any)?.runId ?? "");
    // §14 ambient jobs: run due jobs / list / recover via the durable scheduler.
    if (this.opts.jobs && req.pathname.startsWith("/api/jobs")) {
      if (req.method === "POST" && req.pathname === "/api/jobs/tick") {
        const res = await this.opts.jobs.scheduler.runDue(this.opts.jobs.handler, "daemon", {});
        return { ok: "ran", summary: res };
      }
      if (req.method === "GET" && req.pathname === "/api/jobs/list") return { jobs: this.opts.jobs.scheduler.deadLettered() };
      if (req.method === "POST" && req.pathname === "/api/jobs/recover") {
        this.opts.jobs.scheduler.recover((req.body as any)?.jobId ?? "", Date.now());
        return { ok: "recovered" };
      }
    }
    // Fall through to the browser-UI API (chat/context/sessions/memory/…).
    if (browserApi) return browserApi(req);
    throw new Error(`unknown harness route: ${req.method} ${req.pathname}`);
  }

  listen(port = 0): Promise<{ port: number; origin: string }> {
    return this.daemon.listen(port);
  }

  close(): Promise<void> {
    return this.daemon.close();
  }

  /** The harness API the browser UI calls (over the loopback, secret-gated daemon). */
  api(): {
    listWorkflows: () => WorkflowSpec[];
    startRun: (req: { workflowId: string; reviewer?: string; sensitivity?: GoalContract["dataSensitivity"] }) => Promise<RunOutcome>;
    state: (runId: string) => Promise<RunSnapshot | null>;
    approve: (runId: string) => Promise<RunOutcome>;
    reject: (runId: string) => Promise<RunOutcome>;
  } {
    return {
      listWorkflows: () => TWELVE_WORKFLOW_SPECS,
      startRun: async (req) => {
        const spec = TWELVE_WORKFLOW_SPECS.find((s) => s.id === req.workflowId);
        if (!spec) throw new Error(`unknown workflow: ${req.workflowId}`);
        const runId = `RUN-${spec.id}-${Date.now()}`;
        const contract: GoalContract = {
          runId,
          objective: spec.name,
          requiredDeliverables: [{ type: spec.deliverable.type as any, mimeType: spec.deliverable.mimeType, sections: spec.deliverable.sections }],
          definitionOfDone: spec.acceptanceChecks.map((c) => c.id),
          requiredSourceCategories: spec.requiredSourceCategories,
          dataSensitivity: req.sensitivity ?? spec.dataSensitivity,
          reviewer: req.reviewer ?? spec.reviewer,
          budgets: { iterations: 6 },
          stopConditions: [],
          createdAt: new Date().toISOString(),
        };
        const outcome = await this.engine.run(contract, {});
        this.runs.set(runId, { contract, outcome });
        return outcome;
      },
      state: (runId) => this.engine.inspect(runId),
      approve: async (runId) => {
        const entry = this.runs.get(runId);
        if (!entry) throw new Error(`unknown run: ${runId}`);
        const outcome = await this.engine.resume(runId, { approved: true });
        entry.outcome = outcome;
        return outcome;
      },
      reject: async (runId) => {
        const entry = this.runs.get(runId);
        if (!entry) throw new Error(`unknown run: ${runId}`);
        const outcome = await this.engine.resume(runId, { approved: false });
        entry.outcome = outcome;
        return outcome;
      },
    };
  }
}