/**
 * Experience plane — secure loopback daemon (Phase 8, ADR-009).
 *
 * A local HTTP server that serves the browser UI and the harness API. It binds
 * to loopback ONLY, uses a per-install secret, strict origin validation, CSRF
 * protection, secure headers, and explicit local-file root grants. It is NOT
 * exposed to the LAN by default.
 *
 * This is additive: the legacy Electron app (`ui/`) remains in place and green
 * until the experience-plane phase migrates and removes it.
 */

import { createServer, IncomingMessage, ServerResponse } from "http";
import { randomBytes, timingSafeEqual } from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

export interface DaemonOptions {
  /** Per-install secret; if omitted a random one is generated per start. */
  secret?: string;
  /** Explicitly granted local file roots (read-only listing). */
  roots?: string[];
  /** UI directory to serve. */
  uiDir?: string;
  port?: number;
  /** Optional injectable API handler for /api/* routes (e.g. the harness API).
   *  Receives the parsed request (method, pathname, body, secret-verified). */
  apiHandler?: (req: { method: string; pathname: string; body: unknown }) => Promise<unknown>;
}

export class QuiverDaemon {
  readonly secret: string;
  private server: ReturnType<typeof createServer> | null = null;
  private roots: string[];
  private apiHandler?: DaemonOptions["apiHandler"];

  constructor(private opts: DaemonOptions = {}) {
    this.secret = opts.secret ?? randomBytes(32).toString("hex");
    this.roots = (opts.roots ?? []).map((r) => path.resolve(r));
    this.apiHandler = opts.apiHandler;
  }

  /** The loopback origin the browser should open. */
  origin(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  listen(port = 0): Promise<{ port: number; origin: string }> {
    return new Promise((resolve) => {
      this.server = createServer((req, res) => this.handle(req, res));
      // Bind to loopback ONLY — never 0.0.0.0.
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server!.address() as { port: number };
        resolve({ port: addr.port, origin: this.origin(addr.port) });
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  // ── Request handling ────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Secure headers.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");

    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const pathname = url.pathname;

    // Strict origin validation: only loopback requests are accepted.
    const host = req.headers.host ?? "";
    if (!/^127\.0\.0\.1(:\d+)?$/.test(host) && !/^localhost(:\d+)?$/.test(host)) {
      return this.send(res, 403, { error: "forbidden: non-loopback host" });
    }

    // CSRF + auth: require the per-install secret in the X-Quiver-Secret header
    // for every state-changing (non-GET) request. GETs that return UI are
    // allowed without the secret (the browser loads the page first), but API
    // GETs still require the secret.
    const isStateChange = req.method !== "GET" && req.method !== "HEAD";
    const isApi = pathname.startsWith("/api/");
    if ((isStateChange || isApi) && !this.checkSecret(req)) {
      return this.send(res, 401, { error: "unauthorized: missing or invalid per-install secret" });
    }

    if (req.method === "GET" && pathname === "/health") {
      return this.send(res, 200, { status: "ok", loopback: true });
    }
    if (req.method === "GET" && pathname === "/api/roots") {
      return this.send(res, 200, { roots: this.roots });
    }
    if (req.method === "GET" && pathname === "/") {
      return this.serveUi(res, "index.html");
    }
    // Static UI assets under /ui/.
    if (req.method === "GET" && pathname.startsWith("/ui/")) {
      return this.serveUi(res, pathname.slice("/ui/".length));
    }
    // Harness API routes (secret-gated above).
    if (this.apiHandler && (pathname === "/api/workflows" || pathname.startsWith("/api/run/"))) {
      let body: unknown = undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        body = await this.readBody(req);
      }
      try {
        const result = await this.apiHandler!({ method: req.method ?? "GET", pathname, body });
        return this.send(res, 200, result);
      } catch (err: any) {
        return this.send(res, 400, { error: err.message });
      }
    }
    return this.send(res, 404, { error: "not found" });
  }

  private checkSecret(req: IncomingMessage): boolean {
    const provided = req.headers["x-quiver-secret"];
    if (!provided) return false;
    const a = Buffer.from(Array.isArray(provided) ? provided[0] : provided);
    const b = Buffer.from(this.secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private serveUi(res: ServerResponse, rel: string): void {
    const uiDir = this.opts.uiDir ?? path.join(path.dirname(new URL(import.meta.url).pathname), "ui");
    const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(uiDir, safe);
    // Path traversal guard: the resolved path must stay inside uiDir.
    if (!full.startsWith(path.resolve(uiDir))) {
      return this.send(res, 403, { error: "forbidden: path traversal" });
    }
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      return this.send(res, 404, { error: "not found" });
    }
    const ext = path.extname(full).toLowerCase();
    const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "application/octet-stream";
    res.setHeader("Content-Type", `${type}; charset=utf-8`);
    fs.createReadStream(full).pipe(res);
  }

  private readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve) => {
      let buf = "";
      req.on("data", (d) => (buf += d.toString()));
      req.on("end", () => { try { resolve(buf ? JSON.parse(buf) : undefined); } catch { resolve(buf); } });
      req.on("error", () => resolve(undefined));
    });
  }

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }
}

/** Default per-install secret storage location. */
export function defaultSecretPath(): string {
  return path.join(os.homedir(), ".quiver", "daemon-secret");
}

/** Load or create a persistent per-install secret. */
export function loadOrCreateSecret(secretPath: string = defaultSecretPath()): string {
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf8").trim();
    }
  } catch { /* fall through to create */ }
  const secret = randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  } catch { /* best effort */ }
  return secret;
}