// Real-model GUI QA — uses the ACTUAL API key from .env (no fake model).
// Drives the genuine business-user journey: onboarding → real (web) research →
// real write_file approval → real file written. Screenshots each step.
// Run: node tests/gui_real_qa.mjs
import http from "http";
import os from "os";
import dotenv from "dotenv";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "fs";

dotenv.config({ path: "/Users/rahul/quiver/.env" });
const REPO = "/Users/rahul/quiver";
const DEBUG_PORT = 9222;
const SHOTS = "/tmp/quiver-qa-shots";
const WS_DIR = "/tmp/quiver-qa-ws";
const UD = "/tmp/quiver-qa-ud";
const ELECTRON = REPO + "/node_modules/.bin/electron";
const REAL_HOME = os.homedir();
const PROJ = REAL_HOME + "/.quiver/projects/quiver-qa-ws";
const PROJ_MEM = PROJ + "/memory";
const SKILLS_DIR = REAL_HOME + "/.quiver/skills";
const added = [];
for (const d of [SHOTS, UD]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
try { rmSync(WS_DIR + "/research.md", { force: true }); } catch {}
mkdirSync(SHOTS, { recursive: true });
try { rmSync(PROJ, { recursive: true, force: true }); } catch {}
mkdirSync(PROJ_MEM, { recursive: true }); added.push(PROJ);
writeFileSync(PROJ_MEM + "/persona.txt", "Be concise. Always cite sources. Prefer 1-page briefs.");
for (const s of ["investment-brief", "due-diligence", "office-doc"]) {
  const d = SKILLS_DIR + "/" + s;
  if (!existsSync(d)) { mkdirSync(d, { recursive: true }); try { copyFileSync(REPO + "/skills/" + s + "/SKILL.md", d + "/SKILL.md"); added.push(d); } catch {} }
}

const env = {
  ...process.env,
  QUIVER_AMBIENT: "0",
  QUIVER_AUTONOMY: "web", // auto-approve web research; write_file still prompts
  QUIVER_SESSION_LOG: "0",
  QUIVER_LIFECYCLE_TRACE: "0",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
const app = spawn(ELECTRON, [REPO, "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + UD], { cwd: WS_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", () => {}); app.stderr.on("data", () => {});
const cleanup = () => { try { app.kill("SIGTERM"); } catch {} for (const p of added) { try { rmSync(p, { recursive: true, force: true }); } catch {} } };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getPageWs() { for (let i = 0; i < 60; i++) { try { const list = await (await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json")).json(); const p = list.find((t) => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); } throw new Error("no CDP target"); }
const ws = new WebSocket(await getPageWs());
let nextId = 1; const pending = new Map();
const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", (e) => rej(e)); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
await ready;
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable"); await cdp("Runtime.enable");
const evalJS = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const wait = async (cond, timeout = 30000) => { const s = Date.now(); while (Date.now() - s < timeout) { try { if (await evalJS(cond)) return true; } catch {} await sleep(200); } return false; };
const shot = async (name) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(SHOTS + "/" + name + ".png", Buffer.from(r.data, "base64")); console.log("📸 " + name); };
const click = (id) => evalJS("document.getElementById('" + id + "').click()");
const setVal = (id, v) => evalJS("(function(){const e=document.getElementById('" + id + "');e.value=" + JSON.stringify(v) + ";e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
const send = () => evalJS("(function(){const e=document.getElementById('promptInput');const ev=new Event('keydown',{bubbles:true});ev.key='Enter';e.dispatchEvent(ev);})()");
const notes = [];
const pass = (s) => { notes.push("✔ " + s); console.log("✔ " + s); };
const fail = (s) => { notes.push("✗ " + s); console.log("✗ " + s); };

try {
  // Onboarding with the REAL key (password field — masked in screenshot)
  await wait("document.getElementById('onbKey') !== null", 25000);
  await setVal("onbKey", process.env.OLLAMA_API_KEY || "");
  await click("onbStartBtn");
  await wait("document.querySelectorAll('#ctxMemList .ctx-item').length > 0", 20000);
  await sleep(800); await shot("real_01_main");
  const model = await evalJS("document.getElementById('modelBadge').textContent");
  pass("Onboarded with real key; model badge = " + model);

  // Real web-research prompt (uses real PARALLEL_API_KEY)
  await setVal("promptInput", "Use web_search to find Apple's most recent quarterly revenue, then give me a 2-sentence summary with a cited source URL.");
  await send();
  const got = await wait("document.querySelector('.msg.assistant .prose')?.textContent?.length > 40", 120000);
  await sleep(1000); await shot("real_02_research");
  const asst = await evalJS("(document.querySelector('.msg.assistant .prose')?.textContent||'').slice(0,160)");
  const act = await evalJS("document.getElementById('activityStream').children.length");
  if (got) pass("Real research response rendered (" + asst.length + " chars; " + act + " activity lines)"); else fail("No research response within 120s");
  console.log("   response: " + asst.replace(/\n/g, " "));

  // Ask to save → real write_file approval
  await setVal("promptInput", "Save your summary to a file called research.md");
  await send();
  const appr = await wait("document.getElementById('approvalOverlay').hidden === false", 45000);
  if (appr) {
    await sleep(500); await shot("real_03_approval");
    pass("Real write_file approval gate appeared");
    await click("approveBtn");
    await wait("document.getElementById('approvalOverlay').hidden === true", 15000);
    await sleep(1500); await shot("real_04_done");
    existsSync(WS_DIR + "/research.md") ? pass("Real file written to workspace") : fail("File NOT written");
  } else {
    fail("Model did not raise a write_file approval within 45s");
    await shot("real_04_nodialog");
  }
} catch (e) {
  fail("EXCEPTION: " + e.message); try { await shot("real_99_error"); } catch {}
} finally {
  console.log("\n=== Real-model QA ===\n" + notes.join("\n") + "\n\nScreenshots in " + SHOTS + "/");
  cleanup(); process.exit(0);
}