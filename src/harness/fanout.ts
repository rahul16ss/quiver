/**
 * Fan-out / fan-in runner — §P1 batch execution.
 *
 * Capital-markets workflows repeat one bounded task over a work set: the same
 * extraction over 200 filings, the same comp refresh over 40 companies, the
 * same KPI pull across a portfolio. This runner gives that repetition
 * production semantics:
 *
 *   - per-item retry (bounded by maxItemAttempts)
 *   - bounded concurrency (default 4)
 *   - durable per-item progress (the caller checkpoints it through engine
 *     state, so a restarted run resumes without re-doing completed items)
 *   - partial-failure honesty: failed items are returned as unresolved
 *     entries, never silently dropped from the aggregate
 *
 * The runner is pure orchestration: the per-item work is delegated to an
 * injected handler (tool dispatch or model call), so policy gating stays in
 * the engine's existing seams.
 */

import type { FanOutSpec } from "./goal-contract.js";

export interface FanOutItemState {
  status: "pending" | "completed" | "failed";
  attempts: number;
  error?: string;
  output?: unknown;
}

export type FanOutProgress = Record<string, FanOutItemState>;

export interface FanOutHandlerResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export type FanOutItemHandler = (item: FanOutSpec["items"][number]) => Promise<FanOutHandlerResult>;

export interface FanOutResult {
  progress: FanOutProgress;
  completed: string[];
  failed: Array<{ id: string; error: string }>;
  /** Human-readable unresolved lines for the gap ledger. */
  unresolved: string[];
}

/**
 * Execute the spec's work set with retry + bounded concurrency, starting from
 * prior progress (completed items are NOT re-run — durable resume). The
 * returned progress is a NEW object; the input is not mutated.
 */
export async function runFanOut(
  spec: FanOutSpec,
  prior: FanOutProgress,
  handler: FanOutItemHandler,
): Promise<FanOutResult> {
  const maxAttempts = spec.maxItemAttempts ?? 2;
  const concurrency = Math.max(1, spec.concurrency ?? 4);
  const progress: FanOutProgress = {};
  for (const item of spec.items) {
    const prev = prior[item.id];
    progress[item.id] =
      prev?.status === "completed"
        ? { ...prev }
        : { status: "pending", attempts: prev?.attempts ?? 0 };
  }

  const queue = spec.items.filter((i) => progress[i.id].status === "pending");
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue[cursor++];
      if (!item) return;
      const state = progress[item.id];
      for (;;) {
        state.attempts++;
        try {
          const res = await handler(item);
          if (res.ok) {
            state.status = "completed";
            state.output = res.output;
            state.error = undefined;
            break;
          }
          state.error = res.error ?? "unknown failure";
        } catch (err) {
          state.error = String((err as Error)?.message ?? err).slice(0, 300);
        }
        if (state.attempts >= maxAttempts) {
          state.status = "failed";
          break;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  const completed = spec.items
    .filter((i) => progress[i.id].status === "completed")
    .map((i) => i.id);
  const failed = spec.items
    .filter((i) => progress[i.id].status === "failed")
    .map((i) => ({ id: i.id, error: progress[i.id].error ?? "unknown" }));
  const unresolved = failed.map(
    (f) => `${spec.task} — item '${f.id}' failed after ${maxAttempts} attempt(s): ${f.error}`,
  );
  return { progress, completed, failed, unresolved };
}
