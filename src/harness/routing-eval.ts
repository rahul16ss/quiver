/**
 * Routing evidence harness — task-level evals for model routing.
 *
 * The modality router ships a static, hand-chosen profile order. That order is
 * a *policy default*, not measured economics. This harness turns routing into
 * evidence:
 *
 *   1. A versioned suite of capital-markets tasks (extraction, drafting,
 *      review, reconciliation; text and native-file modalities), each with
 *      deterministic rubric predicates — no LLM-as-judge on the default path.
 *   2. `runEvalSuite` executes tasks per profile and records quality (rubric
 *      pass rate), cost (usage.costUsd when the provider reports it), and
 *      latency.
 *   3. `computeParetoFrontier` marks non-dominated profiles on
 *      (quality ↓, cost ↑) per (role, modality).
 *   4. Results persist to a versioned evidence store; the ModalityRouter can
 *      OPTIONALLY prefer measured Pareto winners. With no evidence — or
 *      evidence for a different modality — routing falls back to the static
 *      order. Measured routing is always recorded, never silent.
 *
 * Offline by default: the suite runs against an injectable ModelClient, so CI
 * uses a scripted mock. Live evals are opt-in (QUIVER_LIVE_EVAL=1) and use the
 * production OpenRouter client.
 */

import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { ModelClient, ModelMessage } from "./interfaces.js";
import type { ModelRole } from "./model-router.js";

// ─── Tasks ────────────────────────────────────────────────────────────

export type EvalFamily = "extraction" | "drafting" | "review" | "reconciliation";
export type EvalModality = "text-only" | "native-file";

export interface EvalTask {
  id: string;
  family: EvalFamily;
  /** Router role this task exercises. */
  role: ModelRole;
  modality: EvalModality;
  /** The user-facing task text. */
  prompt: string;
  /** Optional native-file fixture (base64) for native-file tasks. */
  fixture?: { mimeType: string; filename: string; dataBase64: string };
  /**
   * Deterministic rubric predicates over the model's output text. Each entry
   * is a named must-pass condition; the task score is the fraction passing.
   */
  rubric: Array<{ id: string; description: string; pass: (output: string) => boolean }>;
}

// ─── Results ──────────────────────────────────────────────────────────

export interface EvalResult {
  taskId: string;
  family: EvalFamily;
  role: ModelRole;
  modality: EvalModality;
  profileSlug: string;
  /** Fraction of rubric predicates that passed (0..1). */
  quality: number;
  /** Per-predicate outcomes for auditability. */
  rubricOutcomes: Array<{ id: string; pass: boolean }>;
  costUsd: number | null;
  latencyMs: number;
  /** Honest failure: the invocation itself errored (quality recorded as 0). */
  error?: string;
  evaluatedAt: string;
}

export interface ParetoPoint {
  profileSlug: string;
  role: ModelRole;
  modality: EvalModality;
  meanQuality: number;
  meanCostUsd: number | null;
  tasks: number;
  paretoOptimal: boolean;
}

// ─── Evidence store ───────────────────────────────────────────────────

export interface RoutingEvidenceSnapshot {
  schemaVersion: 1;
  suiteHash: string;
  results: EvalResult[];
  frontier: ParetoPoint[];
  updatedAt: string;
}

export class RoutingEvidenceStore {
  constructor(private filePath: string) {}

  load(): RoutingEvidenceSnapshot | null {
    try {
      if (!fs.existsSync(this.filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.schemaVersion !== 1) return null;
      return parsed as RoutingEvidenceSnapshot;
    } catch {
      return null;
    }
  }

  save(snapshot: RoutingEvidenceSnapshot): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

/** Stable hash of the suite definition (ids + rubric ids), for staleness checks. */
export function hashSuite(tasks: EvalTask[]): string {
  const h = createHash("sha256");
  for (const t of [...tasks].sort((a, b) => a.id.localeCompare(b.id))) {
    h.update(t.id);
    h.update(t.role);
    h.update(t.modality);
    for (const r of t.rubric) h.update(r.id);
  }
  return h.digest("hex");
}

// ─── Execution ────────────────────────────────────────────────────────

function taskMessages(task: EvalTask): ModelMessage[] {
  if (task.modality === "native-file" && task.fixture) {
    return [
      {
        role: "user",
        content: [
          { type: "text", text: task.prompt },
          {
            type: "file",
            mimeType: task.fixture.mimeType,
            data: Buffer.from(task.fixture.dataBase64, "base64"),
            filename: task.fixture.filename,
          },
        ],
      },
    ];
  }
  return [{ role: "user", content: task.prompt }];
}

export interface RunEvalOpts {
  /** Only evaluate these profile slugs (default: all provided). */
  profileSlugs?: string[];
  /** Per-call timeout. */
  timeoutMs?: number;
}

/**
 * Run the suite for a set of profiles through one client. The client's
 * `invoke` is called with an EXPLICIT profile slug (no auto-routing) so the
 * measured profile is the one actually evaluated.
 */
export async function runEvalSuite(
  client: ModelClient,
  profiles: string[],
  tasks: EvalTask[],
  opts: RunEvalOpts = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  const selected = opts.profileSlugs ?? profiles;
  for (const slug of selected) {
    for (const task of tasks) {
      const started = Date.now();
      try {
        const res = await client.invoke(taskMessages(task), {
          modelProfile: slug,
          role: task.role,
          budget: { timeoutMs: opts.timeoutMs ?? 120_000, maxRetries: 0 },
        });
        const output = res.content ?? "";
        const rubricOutcomes = task.rubric.map((r) => {
          let pass = false;
          try {
            pass = r.pass(output);
          } catch {
            pass = false;
          }
          return { id: r.id, pass };
        });
        const quality = rubricOutcomes.length
          ? rubricOutcomes.filter((r) => r.pass).length / rubricOutcomes.length
          : 0;
        results.push({
          taskId: task.id,
          family: task.family,
          role: task.role,
          modality: task.modality,
          profileSlug: slug,
          quality,
          rubricOutcomes,
          costUsd: res.usage?.costUsd ?? null,
          latencyMs: Date.now() - started,
          evaluatedAt: new Date().toISOString(),
        });
      } catch (err) {
        results.push({
          taskId: task.id,
          family: task.family,
          role: task.role,
          modality: task.modality,
          profileSlug: slug,
          quality: 0,
          rubricOutcomes: task.rubric.map((r) => ({ id: r.id, pass: false })),
          costUsd: null,
          latencyMs: Date.now() - started,
          error: String((err as Error)?.message ?? err).slice(0, 300),
          evaluatedAt: new Date().toISOString(),
        });
      }
    }
  }
  return results;
}

// ─── Pareto frontier ──────────────────────────────────────────────────

/**
 * Aggregate results per (role, modality, profile) and mark Pareto-optimal
 * points: a point is dominated when another profile has quality ≥ AND
 * cost ≤ with at least one strict. Profiles with null cost are treated as
 * cost-unknown and never dominate on cost.
 */
export function computeParetoFrontier(results: EvalResult[]): ParetoPoint[] {
  const groups = new Map<string, EvalResult[]>();
  for (const r of results) {
    const key = `${r.role}|${r.modality}|${r.profileSlug}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const points: ParetoPoint[] = [];
  for (const [key, rs] of groups) {
    const [role, modality, profileSlug] = key.split("|") as [ModelRole, EvalModality, string];
    const meanQuality = rs.reduce((s, r) => s + r.quality, 0) / rs.length;
    const costs = rs.map((r) => r.costUsd).filter((c): c is number => c !== null);
    const meanCostUsd = costs.length ? costs.reduce((s, c) => s + c, 0) / costs.length : null;
    points.push({
      profileSlug,
      role,
      modality,
      meanQuality,
      meanCostUsd,
      tasks: rs.length,
      paretoOptimal: false,
    });
  }
  const byCell = new Map<string, ParetoPoint[]>();
  for (const p of points) {
    const key = `${p.role}|${p.modality}`;
    const arr = byCell.get(key) ?? [];
    arr.push(p);
    byCell.set(key, arr);
  }
  for (const cell of byCell.values()) {
    for (const p of cell) {
      p.paretoOptimal = !cell.some((q) => {
        if (q === p) return false;
        if (q.meanQuality < p.meanQuality) return false;
        // q must be at least as cheap; unknown costs cannot dominate.
        if (p.meanCostUsd === null || q.meanCostUsd === null) {
          return q.meanQuality > p.meanQuality && p.meanCostUsd !== null && q.meanCostUsd === null
            ? false
            : q.meanQuality > p.meanQuality;
        }
        if (q.meanCostUsd > p.meanCostUsd) return false;
        return q.meanQuality > p.meanQuality || q.meanCostUsd < p.meanCostUsd;
      });
    }
  }
  return points;
}

/** Build the persisted snapshot from fresh results. */
export function buildSnapshot(tasks: EvalTask[], results: EvalResult[]): RoutingEvidenceSnapshot {
  return {
    schemaVersion: 1,
    suiteHash: hashSuite(tasks),
    results,
    frontier: computeParetoFrontier(results),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The measured preference for a (role, modality): the highest-quality
 * Pareto-optimal profile whose cost is within `maxCostMultiplier` of the
 * cheapest Pareto point. Returns null when there is no evidence for the cell —
 * the caller must fall back to the static order.
 */
export function measuredPreference(
  snapshot: RoutingEvidenceSnapshot,
  role: ModelRole,
  modality: EvalModality,
  opts: { minQuality?: number; maxCostMultiplier?: number } = {},
): string | null {
  const minQuality = opts.minQuality ?? 0.8;
  const cell = snapshot.frontier.filter(
    (p) => p.role === role && p.modality === modality && p.paretoOptimal,
  );
  if (cell.length === 0) return null;
  const qualified = cell.filter((p) => p.meanQuality >= minQuality);
  if (qualified.length === 0) return null;
  const knownCosts = qualified.map((p) => p.meanCostUsd).filter((c): c is number => c !== null);
  const cheapest = knownCosts.length ? Math.min(...knownCosts) : null;
  const maxCost = cheapest !== null ? cheapest * (opts.maxCostMultiplier ?? 3) : null;
  const affordable = qualified.filter(
    (p) => maxCost === null || p.meanCostUsd === null || p.meanCostUsd <= maxCost,
  );
  const pool = affordable.length ? affordable : qualified;
  pool.sort((a, b) => b.meanQuality - a.meanQuality);
  return pool[0]?.profileSlug ?? null;
}
