/**
 * Workflow Watcher — file system monitoring for auto-triggered workflows.
 *
 * Monitors configured input directories for new files (e.g., dropped CIMs,
 * earnings releases). When a matching file appears, triggers the
 * corresponding workflow via the orchestrator.
 *
 * Uses Node's built-in `fs.watch` (recursive on macOS/Windows) — no
 * external file-watching dependency required.
 *
 * SPEC §12 / §19 Build Order #7.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { executeWorkflow, type AgentCallback } from "./orchestrator.js";
import { discoverWorkflows } from "./loader.js";
import type { WorkflowDefinition } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────

export interface WatchRule {
  /** Watch ID */
  id: string;
  /** Directories to monitor (absolute paths) */
  directories: string[];
  /** File glob patterns to match (e.g., "*.pdf", "*.xlsx") */
  patterns: string[];
  /** Workflow to trigger when a match is found */
  workflow: string;
  /** Packs directory for workflow discovery */
  packsDir: string;
  /** Debounce interval in milliseconds */
  debounce_ms: number;
  /** Whether this rule is active */
  enabled: boolean;
  /** When this rule was created */
  createdAt: string;
}

interface WatchStore {
  version: string;
  rules: WatchRule[];
}

// ─── Persistence ───────────────────────────────────────────────────────

function watchConfigPath(): string {
  return path.join(os.homedir(), ".quiver", "watch-rules.json");
}

function loadWatchStore(): WatchStore {
  try {
    const raw = fs.readFileSync(watchConfigPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return { version: "1.0.0", rules: [] };
  }
}

function saveWatchStore(store: WatchStore): void {
  const dir = path.dirname(watchConfigPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(watchConfigPath(), JSON.stringify(store, null, 2));
}

// ─── Glob matching ─────────────────────────────────────────────────────

/**
 * Simple glob match supporting `*` wildcard.
 * Matches against the filename only (not the full path).
 */
function globMatch(pattern: string, filename: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`, "i");
  return regex.test(filename);
}

// ─── Watcher ───────────────────────────────────────────────────────────

export class WorkflowWatcher {
  private watchers: Map<string, fs.FSWatcher[]> = new Map();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private running = false;
  private agent?: AgentCallback;
  /** Workflow/input identities currently being processed — prevents duplicates */
  private processing: Set<string> = new Set();

  constructor(agent?: AgentCallback) {
    this.agent = agent;
  }

  /**
   * Add a new watch rule.
   */
  addRule(
    directories: string[],
    patterns: string[],
    workflow: string,
    packsDir: string,
    debounce_ms: number = 2000,
  ): WatchRule {
    const store = loadWatchStore();

    const rule: WatchRule = {
      id: `watch-${Date.now().toString(36)}`,
      directories: directories.map((d) => path.resolve(d)),
      patterns,
      workflow,
      packsDir,
      debounce_ms,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    store.rules.push(rule);
    saveWatchStore(store);

    // Start watching immediately if the watcher is running
    if (this.running) {
      this.startRule(rule);
    }

    return rule;
  }

  /**
   * Remove a watch rule by ID.
   */
  removeRule(id: string): boolean {
    this.stopRule(id);
    const store = loadWatchStore();
    const idx = store.rules.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    store.rules.splice(idx, 1);
    saveWatchStore(store);
    return true;
  }

  /**
   * List all watch rules.
   */
  listRules(): WatchRule[] {
    return loadWatchStore().rules;
  }

  /**
   * Start watching all enabled rules.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    const store = loadWatchStore();
    for (const rule of store.rules) {
      if (rule.enabled) {
        this.startRule(rule);
      }
    }
  }

  /**
   * Stop all watchers.
   */
  stop(): void {
    this.running = false;
    for (const [id, watchers] of this.watchers) {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // Ignore close errors
        }
      }
    }
    this.watchers.clear();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Start watching for a specific rule.
   */
  private startRule(rule: WatchRule): void {
    const ruleWatchers: fs.FSWatcher[] = [];

    for (const dir of rule.directories) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch {
          console.error(`WorkflowWatcher: cannot create directory ${dir}`);
          continue;
        }
      }

      try {
        const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
          if (!filename) return;
          if (eventType !== "rename" && eventType !== "change") return;

          // Check if filename matches any pattern
          const baseName = path.basename(filename);
          const matches = rule.patterns.some((p) => globMatch(p, baseName));
          if (!matches) return;

          const fullPath = path.join(dir, filename);

          // Skip if this workflow/input identity is already processing.
          const processingKey = `${rule.workflow}:${fullPath}`;
          if (this.processing.has(processingKey)) return;

          // Debounce
          const timerKey = `${rule.id}:${fullPath}`;
          const existing = this.debounceTimers.get(timerKey);
          if (existing) clearTimeout(existing);

          this.debounceTimers.set(
            timerKey,
            setTimeout(() => {
              this.debounceTimers.delete(timerKey);
              this.onFileDetected(rule, fullPath);
            }, rule.debounce_ms),
          );
        });

        ruleWatchers.push(watcher);
      } catch (err: any) {
        console.error(`WorkflowWatcher: failed to watch ${dir}:`, err?.message || err);
      }
    }

    this.watchers.set(rule.id, ruleWatchers);
  }

  /**
   * Stop watching for a specific rule.
   */
  private stopRule(id: string): void {
    const watchers = this.watchers.get(id);
    if (watchers) {
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // Ignore close errors
        }
      }
      this.watchers.delete(id);
    }
  }

  /**
   * Handle a detected file — trigger the workflow.
   */
  private async onFileDetected(rule: WatchRule, filePath: string): Promise<void> {
    // Verify the file actually exists (it may have been a transient event)
    if (!fs.existsSync(filePath)) return;

    const processingKey = `${rule.workflow}:${filePath}`;
    if (this.processing.has(processingKey)) return;
    this.processing.add(processingKey);

    try {
      const def = discoverWorkflows(rule.packsDir).find((w) => w.name === rule.workflow);
      if (!def) {
        console.error(`WorkflowWatcher: workflow "${rule.workflow}" not found`);
        return;
      }

      console.log(
        `WorkflowWatcher: file detected "${path.basename(filePath)}" — ` +
          `triggering "${rule.workflow}"`,
      );

      await executeWorkflow(def, {
        agent: this.agent,
        trigger: "watch",
        triggerInput: filePath,
      });
    } catch (err: any) {
      console.error(
        `WorkflowWatcher: workflow "${rule.workflow}" failed:`,
        err?.message || err,
      );
    } finally {
      this.processing.delete(processingKey);
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
