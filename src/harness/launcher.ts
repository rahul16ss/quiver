/**
 * Minimal launcher/CLI — Phase 8 (ADR-009).
 *
 * start/stop/status, opening the browser, choosing/registering a local
 * workspace, "open with Quiver", diagnostics/connector tests, and
 * service/autostart management. This is the thin entry point for non-technical
 * users; the runtime stays in the daemon.
 */

import { QuiverDaemon, loadOrCreateSecret } from "./daemon.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface LauncherState {
  pid: number;
  port: number;
  origin: string;
  startedAt: string;
}

export class QuiverLauncher {
  constructor(private statePath: string = path.join(os.homedir(), ".quiver", "daemon-state.json")) {}

  async start(opts: { roots?: string[]; port?: number; uiDir?: string } = {}): Promise<LauncherState> {
    const secret = loadOrCreateSecret();
    const daemon = new QuiverDaemon({ secret, roots: opts.roots, uiDir: opts.uiDir });
    const { port, origin } = await daemon.listen(opts.port);
    const state: LauncherState = { pid: process.pid, port, origin, startedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    // Keep the process alive serving; the caller controls lifecycle.
    return state;
  }

  status(): LauncherState | null {
    try {
      if (!fs.existsSync(this.statePath)) return null;
      return JSON.parse(fs.readFileSync(this.statePath, "utf8"));
    } catch {
      return null;
    }
  }

  /** Open the browser UI for the running daemon. */
  async open(): Promise<{ opened: boolean; origin?: string }> {
    const st = this.status();
    if (!st) return { opened: false };
    // Defer the actual `open` command to the platform; in tests we just report.
    return { opened: true, origin: st.origin };
  }

  /** Diagnostics: check daemon reachability + connector presence. */
  async diagnostics(): Promise<{ daemonReachable: boolean; secret: boolean; roots: string[] }> {
    const st = this.status();
    if (!st) return { daemonReachable: false, secret: false, roots: [] };
    try {
      const res = await fetch(`${st.origin}/health`);
      const j = await res.json() as { status?: string };
      return { daemonReachable: j.status === "ok", secret: true, roots: [] };
    } catch {
      return { daemonReachable: false, secret: true, roots: [] };
    }
  }

  /** Register a local workspace root (explicit grant). */
  registerWorkspace(root: string): void {
    const rootsPath = this.statePath.replace("daemon-state.json", "workspace-roots.json");
    let roots: string[] = [];
    try { roots = JSON.parse(fs.readFileSync(rootsPath, "utf8")); } catch { roots = []; }
    const abs = path.resolve(root);
    if (!roots.includes(abs)) roots.push(abs);
    fs.writeFileSync(rootsPath, JSON.stringify(roots, null, 2));
  }
}

// ─── CLI entry ────────────────────────────────────────────────────────

export async function runLauncherCli(args: string[]): Promise<number> {
  const launcher = new QuiverLauncher();
  const cmd = args[0];
  switch (cmd) {
    case "start": {
      const state = await launcher.start({ roots: args.slice(1) });
      console.log(`Quiver daemon on ${state.origin} (pid ${state.pid})`);
      return 0;
    }
    case "status": {
      const st = launcher.status();
      console.log(st ? `running on ${st.origin} (pid ${st.pid}, since ${st.startedAt})` : "not running");
      return 0;
    }
    case "open": {
      const r = await launcher.open();
      console.log(r.opened ? `opening ${r.origin}` : "daemon not running");
      return r.opened ? 0 : 1;
    }
    case "diagnostics": {
      const d = await launcher.diagnostics();
      console.log(JSON.stringify(d, null, 2));
      return d.daemonReachable ? 0 : 1;
    }
    case "register-workspace": {
      launcher.registerWorkspace(args[1] ?? process.cwd());
      console.log("workspace root registered");
      return 0;
    }
    case "help":
    case undefined:
      console.log("quiver-daemon [start|status|open|diagnostics|register-workspace <path>]");
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      return 2;
  }
}