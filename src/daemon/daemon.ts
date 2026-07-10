/**
 * Quiver daemon — stage 1 of Epic 1 (spec §19 build order #2).
 *
 * A localhost-only service that owns the agent child process so the session
 * survives desktop-app window restarts. The GUI (or any local front-end)
 * connects over HTTP + Server-Sent Events using a bearer token stored in
 * ~/.quiver/daemon.json (0600). Binding is strictly 127.0.0.1.
 *
 * Deliberately NOT yet: launchd/login autostart, multi-frontend fanout
 * guarantees beyond SSE broadcast, model routing. Those are later stages.
 *
 * Trust model: the token file is readable only by the local user; anyone who
 * can read it can already run commands as that user. POST /start accepts a
 * spawn spec on that basis — it is the same trust boundary as the GUI itself.
 */
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn, ChildProcess } from "child_process";

interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Opaque caller-supplied tag (e.g. a config hash) echoed in /health so a
   * reconnecting front-end can tell whether the running agent matches its
   * current configuration or needs a restart. */
  label?: string;
}

interface DaemonInfo {
  port: number;
  token: string;
  pid: number;
  startedAt: string;
}

const RING_MAX = 2000;

class AgentHost {
  private proc: ChildProcess | null = null;
  private ring: { seq: number; kind: string; payload: string }[] = [];
  private seq = 0;
  private listeners = new Set<http.ServerResponse>();
  /** The spec used for the current agent, for status reporting. */
  spec: SpawnSpec | null = null;

  get running(): boolean {
    return this.proc !== null;
  }

  start(spec: SpawnSpec): void {
    this.stop("restart");
    this.spec = spec;
    const proc = spawn(spec.cmd, spec.args, {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        this.emit(isJson(line) ? "event" : "raw", line);
      }
    });
    proc.stderr?.on("data", (data: Buffer) => this.emit("stderr", data.toString()));
    proc.on("exit", (code) => {
      if ((proc as ChildProcess & { _expectedExit?: boolean })._expectedExit) return;
      if (this.proc === proc) this.proc = null;
      this.emit("exit", JSON.stringify({ code }));
    });
    proc.on("error", (err) => {
      if (this.proc === proc) this.proc = null;
      this.emit("error", String(err?.message || err));
    });
    this.proc = proc;
  }

  writeLine(line: string): boolean {
    if (!this.proc?.stdin) return false;
    this.proc.stdin.write(line + "\n");
    return true;
  }

  echoUser(line: string): void {
    this.emit("user", line);
  }

  stop(reason: string): void {
    if (!this.proc) return;
    (this.proc as ChildProcess & { _expectedExit?: boolean })._expectedExit = true;
    this.proc.kill();
    this.proc = null;
    this.emit("stopped", reason);
  }

  /** Broadcast an event to SSE listeners and record it in the replay ring. */
  private emit(kind: string, payload: string): void {
    const entry = { seq: ++this.seq, kind, payload };
    this.ring.push(entry);
    if (this.ring.length > RING_MAX) this.ring.shift();
    const frame = sseFrame(entry);
    for (const res of this.listeners) res.write(frame);
  }

  /** Attach an SSE listener, replaying everything after `afterSeq`. */
  attach(res: http.ServerResponse, afterSeq: number): void {
    for (const entry of this.ring) {
      if (entry.seq > afterSeq) res.write(sseFrame(entry));
    }
    this.listeners.add(res);
    res.on("close", () => this.listeners.delete(res));
  }

  status() {
    return {
      running: this.running,
      pid: this.proc?.pid ?? null,
      lastSeq: this.seq,
      cwd: this.spec?.cwd ?? null,
      label: this.spec?.label ?? null,
    };
  }
}

function isJson(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}

function sseFrame(entry: { seq: number; kind: string; payload: string }): string {
  // SSE data must be single-line-safe; payload is JSON or raw text.
  const data = JSON.stringify(entry);
  return `id: ${entry.seq}\nevent: agent\ndata: ${data}\n\n`;
}

function quiverDir(): string {
  return path.join(os.homedir(), ".quiver");
}

export function daemonInfoPath(): string {
  // Override lets tests/smoke runs use an isolated daemon instead of
  // discovering (and hijacking) a live user daemon.
  return process.env.QUIVER_DAEMON_INFO || path.join(quiverDir(), "daemon.json");
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export async function startDaemon(): Promise<DaemonInfo> {
  const host = new AgentHost();
  const token = crypto.randomBytes(32).toString("hex");

  const server = http.createServer(async (req, res) => {
    // Strictly local: reject anything that didn't arrive over loopback.
    const remote = req.socket.remoteAddress || "";
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") {
      res.writeHead(403).end();
      return;
    }
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");

    try {
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...host.status() }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(": connected\n\n");
        const after = Number(url.searchParams.get("after") || req.headers["last-event-id"] || 0);
        host.attach(res, Number.isFinite(after) ? after : 0);
        return;
      }
      if (req.method === "POST" && url.pathname === "/start") {
        const spec = JSON.parse(await readBody(req)) as SpawnSpec;
        if (!spec?.cmd || !Array.isArray(spec.args) || !spec.cwd) {
          res.writeHead(400).end("invalid spawn spec");
          return;
        }
        host.start(spec);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(host.status()));
        return;
      }
      if (req.method === "POST" && url.pathname === "/stdin") {
        const { line, echo } = JSON.parse(await readBody(req)) as {
          line: string;
          echo?: string;
        };
        if (typeof line !== "string") {
          res.writeHead(400).end("line required");
          return;
        }
        // A front-end can ask for user prompts to be recorded in the ring so
        // a reconnecting window replays the user's side of the conversation
        // too (approval keystrokes are never echoed).
        if (echo === "user") host.echoUser(line);
        const ok = host.writeLine(line);
        res.writeHead(ok ? 200 : 409, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/stop") {
        host.stop("requested");
        res.writeHead(200).end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/shutdown") {
        host.stop("daemon shutdown");
        res.writeHead(200).end();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(500).end(String((err as Error)?.message || err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const info: DaemonInfo = { port, token, pid: process.pid, startedAt: new Date().toISOString() };
  fs.mkdirSync(quiverDir(), { recursive: true });
  fs.writeFileSync(daemonInfoPath(), JSON.stringify(info, null, 2), { mode: 0o600 });

  const cleanup = () => {
    try {
      const current = JSON.parse(fs.readFileSync(daemonInfoPath(), "utf8"));
      if (current.pid === process.pid) fs.unlinkSync(daemonInfoPath());
    } catch {
      // already gone
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));

  return info;
}

// Entrypoint: `npx tsx src/daemon/daemon.ts`
const isMain = process.argv[1] && /daemon\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  startDaemon().then((info) => {
    // Single line on stdout so a parent process can confirm readiness.
    console.log(JSON.stringify({ ready: true, port: info.port, pid: info.pid }));
  });
}
