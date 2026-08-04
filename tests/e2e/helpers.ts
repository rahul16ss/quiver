/**
 * Shared helpers for Quiver e2e tiers.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export interface CheckResult {
  id: string;
  ok: boolean;
  detail: string;
}

export class E2eReporter {
  results: CheckResult[] = [];
  pass(id: string, detail = "ok") {
    this.results.push({ id, ok: true, detail });
    console.log(`  ✔ ${id} — ${detail}`);
  }
  fail(id: string, detail: string) {
    this.results.push({ id, ok: false, detail });
    console.error(`  ✗ ${id} — ${detail}`);
  }
  assert(id: string, condition: boolean, detail: string) {
    if (condition) this.pass(id, detail);
    else this.fail(id, detail);
  }
  summary(): { passed: number; failed: number } {
    const passed = this.results.filter((r) => r.ok).length;
    const failed = this.results.filter((r) => !r.ok).length;
    return { passed, failed };
  }
}

export function makeTempWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `quiver-${prefix}-`));
  fs.mkdirSync(path.join(dir, ".quiver"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".sessions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
  // Fail-closed sensitivity requires a valid engagement config even for
  // synthetic e2e workspaces. Default to a public/low tier so normal agent
  // loops can reach the model; individual tests override as needed.
  writeJson(path.join(dir, ".quiver", "sensitivity.json"), {
    version: 1,
    defaultTier: "low",
    modelEndpoints: {
      cloud: "mock-cloud",
      local: "mock-local",
    },
    mnpiPatterns: [
      {
        type: "deal_code",
        pattern: "\\bMNPI-[A-Z0-9]+\\b",
        replacement: "[DEAL]",
      },
    ],
    classificationRules: [
      {
        type: "mnpi_marker",
        pattern: "\\bMNPI\\b",
        tier: "high",
        reason: "Explicit MNPI marker in the prompt",
      },
    ],
  });
  return dir;
}

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export interface RunAgentOpts {
  cwd: string;
  baseUrl: string;
  model?: string;
  apiKey?: string;
  prompt: string;
  env?: Record<string, string | undefined>;
  /** Lines fed to stdin after launch (consent / approvals). */
  stdinLines?: string[];
  timeoutMs?: number;
  yolo?: boolean;
  json?: boolean;
}

export interface RunAgentResult {
  code: number | null;
  stdout: string;
  stderr: string;
  events: any[];
}

export async function runSingleTurn(opts: RunAgentOpts): Promise<RunAgentResult> {
  const args = [
    "tsx",
    path.join(ROOT, "src/cli.ts"),
    "--single-turn",
    opts.prompt,
  ];
  if (opts.json !== false) args.push("--json");
  if (opts.yolo) args.push("--yolo");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    LLM_API_BASE_URL: opts.baseUrl,
    LLM_MODEL_NAME: opts.model || "mock-model",
    LLM_API_KEY: opts.apiKey || "mock-key",
    QUIVER_OUTPUT_MODE: "json",
    // Keep e2e isolated from the developer's live home state where possible.
    HOME: opts.env?.HOME || opts.cwd,
    // Disable consent by default unless the test enables it.
    QUIVER_CONSENT_GATE: opts.env?.QUIVER_CONSENT_GATE ?? "0",
    QUIVER_EVIDENCE_REQUIRED: opts.env?.QUIVER_EVIDENCE_REQUIRED ?? "1",
  };
  // Remove undefined
  for (const k of Object.keys(env)) {
    if (env[k] === undefined) delete env[k];
  }

  const child: ChildProcess = spawn("npx", args, {
    cwd: opts.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  if (opts.stdinLines?.length) {
    for (const line of opts.stdinLines) {
      child.stdin?.write(line.endsWith("\n") ? line : line + "\n");
    }
  }
  // Keep stdin open briefly so consent prompts can read; then close.
  setTimeout(() => {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  }, 50);

  const timeoutMs = opts.timeoutMs ?? 45_000;
  const code: number | null = await new Promise((resolve) => {
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
    child.on("close", (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });

  const events: any[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      /* ignore non-json lines */
    }
  }

  return { code, stdout, stderr, events };
}

export function eventTypes(events: any[]): string[] {
  return events.map((e) => e?.type).filter(Boolean);
}

export function hasEvent(events: any[], type: string): boolean {
  return events.some((e) => e?.type === type);
}

export function textJoined(events: any[]): string {
  return events
    .filter((e) => e?.type === "text_delta" || e?.type === "assistant" || e?.type === "token")
    .map((e) => e?.data?.content || e?.content || e?.data || "")
    .join("");
}
