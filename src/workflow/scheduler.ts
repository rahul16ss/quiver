/**
 * Workflow Scheduler — cron-like recurring workflow execution.
 *
 * Parses cron expressions, stores schedule definitions in
 * `.quiver/schedules.json`, runs inside the daemon process. Triggers
 * orchestrator runs at the scheduled time.
 *
 * Uses a lightweight setInterval-based tick (every 60s) rather than
 * adding a cron library dependency. Supports standard 5-field cron
 * expressions (minute hour day-of-month month day-of-week).
 *
 * SPEC §12 / §19 Build Order #7.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { executeWorkflow, type AgentCallback } from "./orchestrator.js";
import { findWorkflow } from "./loader.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface ScheduleEntry {
  id: string;
  workflow: string;
  cron: string;
  label: string;
  packsDir: string;
  enabled: boolean;
  lastRun?: string;
  nextRun?: string;
  createdAt: string;
}

interface ScheduleStore {
  version: string;
  schedules: ScheduleEntry[];
}

// ─── Cron matching ─────────────────────────────────────────────────────

/**
 * Parse a 5-field cron expression and check if a Date matches.
 *
 * Fields: minute hour day-of-month month day-of-week
 *
 * Supports: exact values, `*` (any), `,` (list), `-` (range), `/n` (step).
 */
function cronMatchesDate(cron: string, date: Date): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const checks = [
    { field: fields[0], value: date.getMinutes(), max: 59 },
    { field: fields[1], value: date.getHours(), max: 23 },
    { field: fields[2], value: date.getDate(), max: 31 },
    { field: fields[3], value: date.getMonth() + 1, max: 12 },
    { field: fields[4], value: date.getDay(), max: 7 },
  ];

  for (const { field, value, max } of checks) {
    if (!fieldMatches(field, value, max)) return false;
  }

  return true;
}

function fieldMatches(field: string, value: number, max: number): boolean {
  // Handle comma-separated list
  const parts = field.split(",");
  for (const part of parts) {
    if (partMatches(part.trim(), value, max)) return true;
  }
  return false;
}

function partMatches(part: string, value: number, _max: number): boolean {
  // Wildcard
  if (part === "*") return true;

  // Step: */n or range/n
  if (part.includes("/")) {
    const [rangePart, stepStr] = part.split("/");
    const step = parseInt(stepStr, 10);
    if (isNaN(step) || step <= 0) return false;

    if (rangePart === "*") {
      return value % step === 0;
    }

    // Range with step: 1-30/5
    if (rangePart.includes("-")) {
      const [startStr, endStr] = rangePart.split("-");
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (value < start || value > end) return false;
      return (value - start) % step === 0;
    }

    return false;
  }

  // Range: 1-5
  if (part.includes("-")) {
    const [startStr, endStr] = part.split("-");
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return value >= start && value <= end;
  }

  // Exact value
  return parseInt(part, 10) === value;
}

// ─── Persistence ───────────────────────────────────────────────────────

function schedulesPath(): string {
  return path.join(os.homedir(), ".quiver", "schedules.json");
}

function loadStore(): ScheduleStore {
  try {
    const raw = fs.readFileSync(schedulesPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: "1.0.0", schedules: [] };
  }
}

function saveStore(store: ScheduleStore): void {
  const dir = path.dirname(schedulesPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(schedulesPath(), JSON.stringify(store, null, 2));
}

// ─── Scheduler ─────────────────────────────────────────────────────────

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickRunning = false;
  private agent?: AgentCallback;

  constructor(agent?: AgentCallback) {
    this.agent = agent;
  }

  /**
   * Add a new schedule.
   */
  addSchedule(workflow: string, cron: string, packsDir: string, label?: string): ScheduleEntry {
    const store = loadStore();

    const entry: ScheduleEntry = {
      id: `sched-${Date.now().toString(36)}`,
      workflow,
      cron,
      label: label || `${workflow} schedule`,
      packsDir,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    store.schedules.push(entry);
    saveStore(store);
    return entry;
  }

  /**
   * Remove a schedule by ID.
   */
  removeSchedule(id: string): boolean {
    const store = loadStore();
    const idx = store.schedules.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    store.schedules.splice(idx, 1);
    saveStore(store);
    return true;
  }

  /**
   * Enable or disable a schedule.
   */
  toggleSchedule(id: string, enabled: boolean): boolean {
    const store = loadStore();
    const entry = store.schedules.find((s) => s.id === id);
    if (!entry) return false;
    entry.enabled = enabled;
    saveStore(store);
    return true;
  }

  /**
   * List all schedules.
   */
  listSchedules(): ScheduleEntry[] {
    return loadStore().schedules;
  }

  /**
   * Start the scheduler tick (every 60 seconds).
   */
  start(): void {
    if (this.timer) return;
    this.running = true;

    // Tick every 60 seconds, check if any schedule matches
    this.timer = setInterval(() => this.tick(), 60_000);

    // Don't prevent process exit
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref();
    }
  }

  /**
   * Stop the scheduler.
   */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Check schedules and trigger any that match the current minute.
   */
  private async tick(): Promise<void> {
    if (!this.running || this.tickRunning) return;
    this.tickRunning = true;

    try {
      const now = new Date();
      const store = loadStore();

      for (const entry of store.schedules) {
        if (!entry.enabled) continue;
        if (!cronMatchesDate(entry.cron, now)) continue;

        // Prevent double-fire in the same minute
        if (entry.lastRun) {
          const lastRunMinute = new Date(entry.lastRun);
          if (
            lastRunMinute.getFullYear() === now.getFullYear() &&
            lastRunMinute.getMonth() === now.getMonth() &&
            lastRunMinute.getDate() === now.getDate() &&
            lastRunMinute.getHours() === now.getHours() &&
            lastRunMinute.getMinutes() === now.getMinutes()
          ) {
            continue;
          }
        }

        // Update last run time before executing so a restart cannot double-fire.
        entry.lastRun = now.toISOString();
        saveStore(store);

        // Find and execute the workflow
        const def = findWorkflow(entry.workflow, entry.packsDir);
        if (!def) {
          console.error(`Scheduled workflow "${entry.workflow}" not found in ${entry.packsDir}`);
          continue;
        }

        try {
          const run = await executeWorkflow(def, {
            agent: this.agent,
            trigger: "schedule",
          });
          if (run.status === "failed") {
            console.error(
              `Scheduled workflow "${entry.workflow}" failed:`,
              run.error || "workflow returned failed status",
            );
          }
        } catch (err: any) {
          console.error(`Scheduled workflow "${entry.workflow}" failed:`, err?.message || err);
        }
      }
    } finally {
      this.tickRunning = false;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}

// ─── Exported helpers ──────────────────────────────────────────────────

/**
 * Validate a cron expression (basic syntax check).
 */
export function isValidCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((f) => /^[0-9*,\-/]+$/.test(f));
}

/**
 * Get a human-readable description of a cron expression.
 */
export function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return "invalid cron expression";

  const [min, hour, dom, month, dow] = fields;
  const parts: string[] = [];

  if (min === "*" && hour === "*") {
    parts.push("every minute");
  } else if (min.startsWith("*/")) {
    parts.push(`every ${min.split("/")[1]} minutes`);
  } else if (hour === "*") {
    parts.push(`at minute ${min} of every hour`);
  } else {
    parts.push(`at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`);
  }

  if (dow !== "*") {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayIdx = parseInt(dow, 10);
    if (dayIdx >= 0 && dayIdx < 7) {
      parts.push(`on ${dayNames[dayIdx]}`);
    }
  }

  if (dom !== "*") {
    parts.push(`on day ${dom}`);
  }

  if (month !== "*") {
    parts.push(`in month ${month}`);
  }

  return parts.join(" ");
}
