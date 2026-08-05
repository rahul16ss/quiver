/**
 * GoalContract + GapLedger — Phase 4 (ADR-002).
 *
 * A typed contract for a goal-seeking run, plus an explicit gap ledger. The
 * ExecutionEngine (LangGraph substrate, Phase 4) consumes these. A failed tool
 * call, unsupported event, stale source, missing entitlement or invalid Office
 * file can never be reported as successful completion — the contract's
 * definition of done must be fully met, or the run returns an honest
 * blocked/partial result stating exactly what remains.
 */

import type { SourceCategory, SensitivityProfile } from "./interfaces.js";

export interface GoalContract {
  runId: string;
  objective: string;
  requiredDeliverables: DeliverableSpec[];
  definitionOfDone: string[];
  requiredSourceCategories: SourceCategory[];
  dataSensitivity: SensitivityProfile;
  reviewer: string;
  budgets: {
    costUsd?: number;
    timeMs?: number;
    iterations?: number;
  };
  stopConditions: string[];
  createdAt: string;
}

export interface DeliverableSpec {
  /** Deliverable type, e.g. "memo", "tracker", "primer", "pitchbook". */
  type: string;
  /** Output MIME type the OfficeEngine must produce. */
  mimeType: string;
  /** Required sections/elements. */
  sections: string[];
}

export interface GapLedgerEntry {
  id: string;
  description: string;
  category: SourceCategory | "deliverable" | "validation" | "approval";
  status: "open" | "in_progress" | "resolved" | "blocked";
  blocker?: string;
  /** Source/connector the gap is waiting on, if any. */
  waitingOn?: string;
}

export class GapLedger {
  private entries: GapLedgerEntry[] = [];
  private nextId = 1;

  /** Reconstruct a ledger from serialized state (checkpoint-safe). */
  static from(entries: GapLedgerEntry[], nextId = 1): GapLedger {
    const l = new GapLedger();
    l.entries = entries.map((e) => ({ ...e }));
    l.nextId = nextId;
    return l;
  }

  /** Serialize for checkpoint storage (plain data, no methods). */
  snapshot(): { entries: GapLedgerEntry[]; nextId: number } {
    return { entries: this.entries.map((e) => ({ ...e })), nextId: this.nextId };
  }

  add(description: string, category: GapLedgerEntry["category"], waitingOn?: string): GapLedgerEntry {
    const entry: GapLedgerEntry = {
      id: `gap-${this.nextId++}`,
      description,
      category,
      status: "open",
      waitingOn,
    };
    this.entries.push(entry);
    return entry;
  }

  update(id: string, patch: Partial<Omit<GapLedgerEntry, "id">>): void {
    const e = this.entries.find((x) => x.id === id);
    if (e) Object.assign(e, patch);
  }

  resolve(id: string): void {
    this.update(id, { status: "resolved" });
  }

  block(id: string, blocker: string): void {
    this.update(id, { status: "blocked", blocker });
  }

  open(): GapLedgerEntry[] {
    return this.entries.filter((e) => e.status === "open" || e.status === "in_progress" || e.status === "blocked");
  }

  all(): GapLedgerEntry[] {
    return [...this.entries];
  }

  /** Honest summary: never claim complete while open/blocked gaps remain. */
  summary(): { complete: boolean; unresolved: string[] } {
    const unresolved = this.open().map((e) => `${e.id}: ${e.description}${e.blocker ? ` (blocked: ${e.blocker})` : ""}`);
    return { complete: unresolved.length === 0, unresolved };
  }
}

/**
 * Decide whether a run is honestly complete: every definition-of-done item must
 * be satisfied and the gap ledger must be empty of open/blocked entries. A
 * partial result returns `status: "partial"` with the exact unresolved items.
 */
export function evaluateCompletion(
  contract: GoalContract,
  ledger: GapLedger,
  doneChecks: Array<{ id: string; pass: boolean; detail: string }>,
): { status: "completed" | "partial" | "blocked"; unresolved: string[]; stopReason: string } {
  const failedChecks = doneChecks.filter((c) => !c.pass);
  const ledgerSummary = ledger.summary();
  const unresolved = [...failedChecks.map((c) => `${c.id}: ${c.detail}`), ...ledgerSummary.unresolved];

  if (unresolved.length === 0) {
    return { status: "completed", unresolved: [], stopReason: "all acceptance checks passed" };
  }
  const blocked = ledger.open().some((e) => e.status === "blocked");
  return {
    status: blocked ? "blocked" : "partial",
    unresolved,
    stopReason: blocked
      ? "blocked — a required source, entitlement, validation or approval is missing"
      : "partial — mandatory evidence, validation or save-back not yet complete",
  };
}

/** Build the initial gap ledger from a contract's required source categories + deliverables. */
export function initialLedger(contract: GoalContract): GapLedger {
  const ledger = new GapLedger();
  for (const cat of contract.requiredSourceCategories) {
    ledger.add(`Resolve required source category: ${cat}`, cat);
  }
  for (const d of contract.requiredDeliverables) {
    ledger.add(`Produce deliverable: ${d.type} (${d.mimeType})`, "deliverable");
  }
  ledger.add("Run independent checker/critic", "validation");
  ledger.add("Obtain human approval before commit", "approval");
  return ledger;
}