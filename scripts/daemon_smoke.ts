/**
 * Daemon smoke test — proves stage-1 behavior end to end with a mock agent:
 *  1. launch the daemon as a detached process
 *  2. start a mock agent through it
 *  3. subscribe, send stdin, receive the agent's JSON events
 *  4. drop the subscription ("close the window"), send more input
 *  5. resubscribe with after=<last seen seq> and receive what was missed
 *  6. stop agent + shut down daemon
 * Run: npx tsx scripts/daemon_smoke.ts
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  connectOrLaunch,
  daemonStatus,
  startAgentViaDaemon,
  sendLine,
  stopAgent,
  subscribe,
  AgentEventEntry,
  DaemonConnection,
} from "../src/daemon/client.ts";
import * as http from "http";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function shutdown(conn: DaemonConnection): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: conn.port,
        method: "POST",
        path: "/shutdown",
        headers: { authorization: `Bearer ${conn.token}` },
      },
      () => resolve(),
    );
    req.on("error", () => resolve());
    req.end();
  });
}

async function main() {
  // Isolate from any live user daemon: this run gets its own info file, and
  // the spawned daemon inherits the override via env.
  process.env.QUIVER_DAEMON_INFO = path.join(
    os.tmpdir(),
    `quiver-daemon-smoke-${process.pid}.json`,
  );

  // Mock agent: echoes each stdin line back as a JSON event.
  const mockPath = path.join(os.tmpdir(), `quiver-mock-agent-${process.pid}.js`);
  fs.writeFileSync(
    mockPath,
    `
    console.log(JSON.stringify({ type: "hello", pid: process.pid }));
    const rl = require("readline").createInterface({ input: process.stdin });
    rl.on("line", (l) => console.log(JSON.stringify({ type: "echo", line: l })));
    `,
  );

  const conn = await connectOrLaunch({
    cmd: process.execPath,
    args: ["node_modules/.bin/tsx", "src/daemon/daemon.ts"],
    cwd: ROOT,
  });
  console.log("1. daemon up on port", conn.port);

  await startAgentViaDaemon(conn, {
    cmd: process.execPath,
    args: [mockPath],
    cwd: os.tmpdir(),
    env: {},
  });
  const st = await daemonStatus(conn);
  if (!st.running) fail("agent not running after /start");
  console.log("2. mock agent running, pid status ok");

  // First subscription
  const seen: AgentEventEntry[] = [];
  const unsub = subscribe(conn, 0, (e) => seen.push(e));
  await sendLine(conn, "first message");
  await new Promise((r) => setTimeout(r, 700));
  const gotHello = seen.some((e) => e.kind === "event" && e.payload.includes('"hello"'));
  const gotEcho1 = seen.some((e) => e.payload.includes("first message"));
  if (!gotHello || !gotEcho1) fail(`live events missing (hello=${gotHello}, echo=${gotEcho1})`);
  console.log("3. live events received:", seen.length);

  // "Close the window": drop subscription, keep talking
  unsub();
  const lastSeq = seen[seen.length - 1].seq;
  await sendLine(conn, "sent while window closed");
  await new Promise((r) => setTimeout(r, 500));

  // "Reopen": resubscribe after lastSeq — the missed event must replay
  const replayed: AgentEventEntry[] = [];
  const unsub2 = subscribe(conn, lastSeq, (e) => replayed.push(e));
  await new Promise((r) => setTimeout(r, 700));
  const gotMissed = replayed.some((e) => e.payload.includes("sent while window closed"));
  if (!gotMissed) fail("replay after reconnect did not deliver missed event");
  console.log("4. reconnect replay works:", replayed.length, "event(s) caught up");

  unsub2();
  await stopAgent(conn);
  const st2 = await daemonStatus(conn);
  if (st2.running) fail("agent still running after /stop");
  console.log("5. agent stopped cleanly");

  await shutdown(conn);
  fs.unlinkSync(mockPath);
  console.log("6. daemon shut down. ALL SMOKE CHECKS PASSED");
}

main().catch((e) => fail(String(e?.stack || e)));
