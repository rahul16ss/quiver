/**
 * Daemon client — used by the desktop app's main process (or any local
 * front-end) to connect to a running daemon or start one if needed.
 *
 * The event stream is delivered via callback with the same line-oriented
 * payloads the GUI previously read from the agent child's stdout, so the
 * renderer protocol is unchanged.
 */
import * as fs from "fs";
import * as http from "http";
import { spawn } from "child_process";
import { daemonInfoPath } from "./daemon.ts";

export interface DaemonConnection {
  port: number;
  token: string;
}

export interface AgentEventEntry {
  seq: number;
  kind: "event" | "raw" | "stderr" | "exit" | "error" | "stopped" | "user";
  payload: string;
}

export interface SpawnSpec {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  label?: string;
}

function request(
  conn: DaemonConnection,
  method: string,
  pathName: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: conn.port,
        method,
        path: pathName,
        headers: {
          authorization: `Bearer ${conn.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("daemon request timeout")));
    if (body) req.write(body);
    req.end();
  });
}

/** Read daemon.json and verify the daemon answers with our token. */
export async function findRunningDaemon(): Promise<DaemonConnection | null> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(fs.readFileSync(daemonInfoPath(), "utf8"));
  } catch {
    return null;
  }
  if (!info?.port || !info?.token) return null;
  try {
    const res = await request(info, "GET", "/health");
    return res.status === 200 ? { port: info.port, token: info.token } : null;
  } catch {
    return null;
  }
}

/**
 * Spawn a detached daemon process and wait for daemon.json to become live.
 * `daemonCmd` lets the caller decide dev vs packaged invocation.
 */
export async function launchDaemon(daemonCmd: {
  cmd: string;
  args: string[];
  cwd: string;
}): Promise<DaemonConnection> {
  const proc = spawn(daemonCmd.cmd, daemonCmd.args, {
    cwd: daemonCmd.cwd,
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  proc.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const conn = await findRunningDaemon();
    if (conn) return conn;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("daemon did not become ready within 15s");
}

export async function connectOrLaunch(daemonCmd: {
  cmd: string;
  args: string[];
  cwd: string;
}): Promise<DaemonConnection> {
  return (await findRunningDaemon()) || launchDaemon(daemonCmd);
}

export async function daemonStatus(conn: DaemonConnection): Promise<{
  ok: boolean;
  running: boolean;
  lastSeq: number;
  cwd: string | null;
  label: string | null;
}> {
  const res = await request(conn, "GET", "/health");
  if (res.status !== 200) throw new Error(`health ${res.status}`);
  return JSON.parse(res.body);
}

export async function startAgentViaDaemon(conn: DaemonConnection, spec: SpawnSpec): Promise<void> {
  const res = await request(conn, "POST", "/start", JSON.stringify(spec));
  if (res.status !== 200) throw new Error(`start failed: ${res.status} ${res.body}`);
}

export async function sendLine(
  conn: DaemonConnection,
  line: string,
  echo?: "user",
): Promise<boolean> {
  const res = await request(conn, "POST", "/stdin", JSON.stringify({ line, echo }));
  return res.status === 200;
}

export async function stopAgent(conn: DaemonConnection): Promise<void> {
  await request(conn, "POST", "/stop");
}

/**
 * Subscribe to the daemon's SSE stream. Events already in the ring buffer
 * after `afterSeq` are replayed first — this is what lets a reopened window
 * catch up on everything that happened while it was closed.
 * Returns an unsubscribe function.
 */
export function subscribe(
  conn: DaemonConnection,
  afterSeq: number,
  onEvent: (entry: AgentEventEntry) => void,
  onDisconnect?: (err?: Error) => void,
): () => void {
  const req = http.request(
    {
      host: "127.0.0.1",
      port: conn.port,
      method: "GET",
      path: `/events?after=${afterSeq}`,
      headers: { authorization: `Bearer ${conn.token}`, accept: "text/event-stream" },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try {
            onEvent(JSON.parse(dataLine.slice(6)) as AgentEventEntry);
          } catch {
            // skip malformed frame
          }
        }
      });
      res.on("end", () => onDisconnect?.());
      res.on("error", (e) => onDisconnect?.(e as Error));
    },
  );
  req.on("error", (e) => onDisconnect?.(e as Error));
  req.end();
  return () => req.destroy();
}
