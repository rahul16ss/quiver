/**
 * Mid-Run Intervention Controller
 *
 * Lets the user steer the agent *while it is running*. Once `agent.prompt()`
 * is awaiting the model/tool loop, the CLI keeps stdin in raw mode and listens
 * for an interrupt key (Escape). The user types a steering message; it lands
 * as a synthetic user message at the next loop boundary (between turns), so
 * the model sees the new instruction alongside its prior tool results.
 *
 * Three actions:
 *   • inject(text)  — queue a steering message to be injected at the next turn
 *   • requestStop() — ask the loop to halt after the current step
 *   • consume()     — atomically read + clear a pending action (called by the
 *                     agent loop at the top of each iteration)
 *
 * This is non-blocking by design: the agent never waits idle for the user. The
 * intervention is picked up at the next safe point; Ctrl+C still aborts the
 * active LLM stream immediately via the existing AbortController.
 */

export interface PendingIntervention {
  inject: string | null;
  stop: boolean;
}

export class InterventionController {
  private pendingInject: string | null = null;
  private pendingStop = false;
  /** Bumped each time an intervention is queued, for observability/logging. */
  private revision = 0;

  /** Queue a steering message for injection at the next loop boundary. */
  inject(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.pendingInject = trimmed;
    this.revision++;
  }

  /** Request the agent loop to stop after the current step. */
  requestStop(): void {
    this.pendingStop = true;
    this.revision++;
  }

  /** True if any intervention (inject or stop) is pending. */
  hasPending(): boolean {
    return this.pendingInject !== null || this.pendingStop;
  }

  /** Monotonic revision counter — changes when a new intervention queues. */
  getRevision(): number {
    return this.revision;
  }

  /**
   * Atomically read and clear the pending intervention. Called by the agent
   * loop at the top of each `while` iteration. Returns the action to apply.
   */
  consume(): PendingIntervention {
    const result: PendingIntervention = {
      inject: this.pendingInject,
      stop: this.pendingStop,
    };
    this.pendingInject = null;
    this.pendingStop = false;
    return result;
  }

  /** Clear any pending intervention without acting on it. */
  clear(): void {
    this.pendingInject = null;
    this.pendingStop = false;
  }
}
