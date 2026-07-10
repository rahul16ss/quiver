// Measure the live layout to confirm/deny "bottom cut off" and panel fit.
import os from "os";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "fs";
const REPO = "/Users/rahul/quiver", DEBUG_PORT = 9222;
const UD = "/tmp/quiver-qa-ud", WS_DIR = "/tmp/quiver-qa-ws";
const REAL_HOME = os.homedir();
const PROJ = REAL_HOME + "/.quiver/projects/quiver-qa-ws";
const added = [];
for (const d of [UD]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
mkdirSync(UD, { recursive: true });
// Pre-seed config so the app skips onboarding and goes straight to the main surface.
writeFileSync(UD + "/quiver-config.json", JSON.stringify({ provider: { baseUrl: "http://127.0.0.1:9/v1", modelName: "glm-5.2:cloud", apiKey: "fake" }, ollamaApiKey: "fake", maxContextTokens: 120000, workspacePath: WS_DIR }, null, 2));
try { rmSync(PROJ, { recursive: true, force: true }); } catch {}
mkdirSync(PROJ + "/memory", { recursive: true }); added.push(PROJ);
writeFileSync(PROJ + "/memory/persona.txt", "be concise");
const env = { ...process.env, LLM_API_BASE_URL: "http://127.0.0.1:9/v1", OLLAMA_API_KEY: "fake", QUIVER_AMBIENT: "0", QUIVER_AUTONOMY: "", QUIVER_SESSION_LOG: "0", ELECTRON_DISABLE_SECURITY_WARNINGS: "true" };
const app = spawn(REPO + "/node_modules/.bin/electron", [REPO, "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + UD], { cwd: WS_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", () => {}); app.stderr.on("data", () => {});
const cleanup = () => { try { app.kill("SIGTERM"); } catch {} for (const p of added) { try { rmSync(p, { recursive: true, force: true }); } catch {} } };
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWs() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json")).json(); const p = l.find((t) => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error("no target"); }
const ws = new WebSocket(await getWs());
let id = 1; const pend = new Map();
const ready = new Promise((r) => { ws.addEventListener("open", () => r()); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data.toString()); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
await ready;
const cdp = (method, params = {}) => new Promise((r, rej) => { const i = id++; pend.set(i, { resolve: r, reject: rej }); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp("Page.enable"); await cdp("Runtime.enable");
const evalJS = async (e) => { const r = await cdp("Runtime.evaluate", { expression: e, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
await sleep(2500);
const m = await evalJS(`(function(){
  const r = (id) => { const e = document.getElementById(id); if(!e) return null; const b = e.getBoundingClientRect(); return {top:b.top,bottom:b.bottom,h:b.height}; };
  const win = {innerH: window.innerHeight, scrollH: document.body.scrollHeight};
  return JSON.stringify({win, topbar:r('topbar'), workspace:r('workspace'), ctx:r('context-plane'), conv:r('conversation-plane'), act:r('activity-plane'), chat:r('chatArea'), input:r('inputBar'), prompt:r('promptInput')});
})()`);
console.log("LAYOUT MEASUREMENTS (CSS px):");
console.log(m);
const o = JSON.parse(m);
console.log("\nDiagnosis:");
console.log("  body scrollHeight vs innerHeight:", o.win.scrollH, "vs", o.win.innerH, o.win.scrollH > o.win.innerH ? "→ OVERFLOW (content taller than viewport)" : "→ fits");
console.log("  inputBar bottom:", o.input?.bottom, "| innerHeight:", o.win.innerH, (o.input && o.input.bottom > o.win.innerH + 1) ? "→ INPUT BAR CLIPPED" : "→ input bar within viewport");
console.log("  conversation plane bottom:", o.conv?.bottom, "vs innerHeight:", o.win.innerH);
cleanup(); process.exit(0);