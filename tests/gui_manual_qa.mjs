// Manual GUI QA — launches the REAL Electron app against a FAKE local model,
// drives every user story over the Chrome DevTools Protocol, captures a
// screenshot per story, and verifies real side effects (file writes).
// Run: node tests/gui_manual_qa.mjs   (dev-only; opens a real window)
import http from "http";
import os from "os";
import { spawn } from "child_process";
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "fs";

const MODEL_PORT = 9223, DEBUG_PORT = 9222;
const SHOTS = "/tmp/quiver-qa-shots";
const WS_DIR = "/tmp/quiver-qa-ws";
const UD = "/tmp/quiver-qa-ud";
const ELECTRON = "/Users/rahul/quiver/node_modules/.bin/electron";
const REPO = "/Users/rahul/quiver";
const REAL_HOME = os.homedir();
const PROJ = REAL_HOME + "/.quiver/projects/quiver-qa-ws";
const PROJ_MEM = PROJ + "/memory";
const SKILLS_DIR = REAL_HOME + "/.quiver/skills";
const added = [];
for (const d of [SHOTS, UD]) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
try { rmSync(WS_DIR + "/answer.md", { force: true }); } catch {}
mkdirSync(SHOTS, { recursive: true });

// Seed a TEMPORARY QA project + skills into the real ~/.quiver (cleaned up after;
// never touch the user's core.json or other projects).
mkdirSync(PROJ_MEM, { recursive: true }); added.push(PROJ);
writeFileSync(PROJ_MEM + "/persona.txt", "Be concise. Always cite SEC filings. Prefer 1-page briefs.");
writeFileSync(PROJ_MEM + "/workspace-facts.md", "# Workspace facts\n- Industry: industrial manufacturing\n- Fiscal year ends Dec");
for (const s of ["investment-brief", "due-diligence", "office-doc"]) {
  const d = SKILLS_DIR + "/" + s;
  if (!existsSync(d)) { mkdirSync(d, { recursive: true }); try { copyFileSync(REPO + "/skills/" + s + "/SKILL.md", d + "/SKILL.md"); added.push(d); } catch {} }
}

// ─── fake OpenAI-compatible model (SSE) ────────────────────────────────
let modelHits = 0;
function lastUser(m) { for (let i = m.length - 1; i >= 0; i--) if (m[i].role === "user") return String(m[i].content ?? ""); return ""; }
function lastRole(m) { return m[m.length - 1]?.role; }
function sendSSE(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  let i = 0; const tick = () => { if (i >= chunks.length) { res.write("data: [DONE]\n\n"); res.end(); return; } res.write("data: " + JSON.stringify(chunks[i]) + "\n\n"); i++; setTimeout(tick, 25); }; tick();
}
const txt = (s) => [{ choices: [{ delta: { role: "assistant", content: s } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }];
const toolCall = (name, args) => [
  { choices: [{ delta: { role: "assistant", content: "" } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];
const model = http.createServer((req, res) => {
  if (req.url.endsWith("/models")) { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ data: [{ id: "glm-5.2:cloud", object: "model", context_length: 120000 }] })); return; }
  if (req.url.endsWith("/chat/completions")) {
    modelHits++;
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      let msgs = []; try { msgs = JSON.parse(body).messages || []; } catch {}
      if (lastRole(msgs) === "tool") return sendSSE(res, txt("Done — saved to answer.md. [Source: workspace]"));
      const u = lastUser(msgs).toLowerCase();
      if (u.includes("save")) return sendSSE(res, toolCall("write_file", { filePath: "answer.md", content: "# Acme Corp — Investment Brief\n\nRevenue was $42.3M in FY2024 [Source: 10-K, https://sec.gov/].\n\nRecommendation: Hold.\n" }));
      if (u.includes("report") || u.includes("document")) return sendSSE(res, toolCall("office_doc", { action: "create", filePath: "/tmp/quiver-qa-ws/brief.docx", fileType: "docx" }));
      return sendSSE(res, txt("Here's a quick brief on Acme Corp: revenue $42.3M (FY2024) [Source: 10-K, https://sec.gov/]. Margins expanded 300bps YoY. No material liabilities found in public records. I'd proceed to a full diligence checklist next."));
    });
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => model.listen(MODEL_PORT, r));
console.log("fake model on :" + MODEL_PORT);

// ─── launch real Electron (real home; workspace = temp dir) ────────────
const env = {
  ...process.env,
  LLM_API_BASE_URL: "http://127.0.0.1:" + MODEL_PORT + "/v1",
  OLLAMA_API_KEY: "fake-key",
  QUIVER_AMBIENT: "0",
  QUIVER_AUTONOMY: "",
  QUIVER_SESSION_LOG: "0",
  QUIVER_LIFECYCLE_TRACE: "0",
  ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
};
const app = spawn(ELECTRON, [REPO, "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + UD], { cwd: WS_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
app.stdout.on("data", (d) => process.stdout.write("[gui] " + d));
app.stderr.on("data", () => {});
const cleanup = () => { try { app.kill("SIGTERM"); } catch {} try { model.close(); } catch {} for (const p of added) { try { rmSync(p, { recursive: true, force: true }); } catch {} } };
process.on("exit", cleanup); process.on("SIGINT", () => { cleanup(); process.exit(1); });

// ─── CDP client ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getPageWs() {
  for (let i = 0; i < 60; i++) { try { const list = await (await fetch("http://127.0.0.1:" + DEBUG_PORT + "/json")).json(); const p = list.find((t) => t.type === "page"); if (p) return p.webSocketDebuggerUrl; } catch {} await sleep(200); }
  throw new Error("no CDP target");
}
const ws = new WebSocket(await getPageWs());
let nextId = 1; const pending = new Map();
const ready = new Promise((res, rej) => { ws.addEventListener("open", () => res()); ws.addEventListener("error", (e) => rej(e)); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
await ready;
const cdp = (method, params = {}) => new Promise((res, rej) => { const id = nextId++; pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params })); });
await cdp("Page.enable"); await cdp("Runtime.enable");
const evalJS = async (expr) => { const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result?.value; };
const wait = async (cond, timeout = 20000) => { const s = Date.now(); while (Date.now() - s < timeout) { try { if (await evalJS(cond)) return true; } catch {} await sleep(150); } throw new Error("timeout: " + cond); };
const shot = async (name) => { const r = await cdp("Page.captureScreenshot", { format: "png" }); writeFileSync(SHOTS + "/" + name + ".png", Buffer.from(r.data, "base64")); console.log("📸 " + name); };
const click = (id) => evalJS("document.getElementById('" + id + "').click()");
const setVal = (id, v) => evalJS("(function(){const e=document.getElementById('" + id + "');e.value=" + JSON.stringify(v) + ";e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
const send = () => evalJS("(function(){const e=document.getElementById('promptInput');const ev=new Event('keydown',{bubbles:true});ev.key='Enter';e.dispatchEvent(ev);})()");

const notes = [];
const pass = (s) => { notes.push("✔ " + s); console.log("✔ " + s); };
const fail = (s) => { notes.push("✗ " + s); console.log("✗ " + s); };

try {
  // 1 — Onboarding
  await wait("document.getElementById('onbKey') !== null", 25000); await shot("01-onboarding");
  await setVal("onbKey", "fake-key"); await click("onbStartBtn");
  await wait("document.getElementById('context-plane') !== null", 20000); pass("Onboarding: reached main surface");

  // 2 — Main surface + context plane
  await sleep(900); await shot("02-main-empty");
  const mem = await evalJS("document.querySelectorAll('#ctxMemList .ctx-item').length");
  const sk = await evalJS("document.querySelectorAll('#ctxSkillsList .ctx-item').length");
  mem >= 2 ? pass("Context: " + mem + " memory files loaded") : fail("Context: only " + mem + " memory files");
  sk >= 3 ? pass("Context: " + sk + " skills loaded") : fail("Context: only " + sk + " skills");

  // 3 — Send prompt → streaming + activity
  await setVal("promptInput", "Give me a quick brief on Acme Corp"); await send();
  await wait("document.querySelector('.msg.assistant .prose')?.textContent?.length > 20", 20000);
  await sleep(400); await shot("03-send-stream");
  (await evalJS("document.getElementById('activityStream').children.length > 0")) ? pass("Activity stream populated") : fail("Activity stream empty");
  (await evalJS("/Acme Corp/.test(document.querySelector('.msg.assistant .prose')?.textContent||'')")) ? pass("Assistant cited brief rendered") : fail("Assistant brief missing");

  // 4 — Approval gate with diff (write_file) → approve → real file write
  await wait("document.getElementById('statusDot').className.includes('ok') || document.getElementById('statusDot').className.includes('idle')", 15000);
  await setVal("promptInput", "save a brief to a file"); await send();
  await wait("document.getElementById('approvalOverlay').hidden === false", 20000);
  await sleep(300); await shot("04-approval-diff");
  (await evalJS("document.querySelectorAll('#approvalDiff .diff-line.add').length > 0")) ? pass("Approval diff renders additions") : fail("Approval diff missing add lines");
  await click("approveBtn");
  await wait("document.getElementById('approvalOverlay').hidden === true", 12000);
  await sleep(1000); await shot("05-approval-done");
  existsSync(WS_DIR + "/answer.md") ? pass("Approval→write: real file written to workspace") : fail("Approval→write: file NOT written");

  // 5 — Image drag-and-drop (a REAL File object so a thumbnail preview renders)
  await evalJS("(function(){const p=document.getElementById('conversation-plane');p.dispatchEvent(new Event('dragover',{bubbles:true,cancelable:true}));const c=document.createElement('canvas');c.width=48;c.height=48;const x=c.getContext('2d');x.fillStyle='#0a84ff';x.fillRect(0,0,48,48);x.fillStyle='#fff';x.font='bold 26px -apple-system,sans-serif';x.textAlign='center';x.textBaseline='middle';x.fillText('Q',24,25);return new Promise(res=>c.toBlob(b=>{const f=new File([b],'chart.png',{type:'image/png'});f.path='/tmp/quiver-qa-ws/chart.png';const ev=new Event('drop',{bubbles:true,cancelable:true});ev.dataTransfer={files:[f]};p.dispatchEvent(ev);res(true);},'image/png'));})()");
  await sleep(400); await shot("06-image-drop");
  (await evalJS("(function(){const t=document.getElementById('attachments').textContent;return /chart\\.png/.test(t) && !/\\/tmp\\//.test(t) && !!document.querySelector('.attach-thumb');})()")) ? pass("Image chip: friendly name, no raw path, thumbnail shown") : fail("Image chip not friendly / missing thumbnail");
  (await evalJS("document.getElementById('attachments').children.length === 1")) ? pass("One attach chip rendered") : fail("Attach chip count wrong");
  (await evalJS("!!document.querySelector('.attach-chip .attach-x')")) ? pass("Attach chip has remove button") : fail("Attach chip missing remove button");

  // 6 — Memory editor
  await evalJS("document.querySelector('#ctxMemList .ctx-item').click()");
  await wait("document.getElementById('memoryOverlay').hidden === false", 5000); await sleep(200); await shot("07-memory-editor");
  (await evalJS("document.getElementById('memoryName').value === 'persona.txt'")) ? pass("Memory editor opens with file") : fail("Memory editor not populated");

  // 7 — Skill viewer
  await evalJS("document.querySelector('[data-close=\"memoryOverlay\"]').click()");
  await evalJS("document.querySelector('#ctxSkillsList .ctx-item').click()");
  await wait("document.getElementById('skillOverlay').hidden === false", 6000); await sleep(300); await shot("08-skill-viewer");
  (await evalJS("document.getElementById('skillContent').value.length > 0")) ? pass("Skill viewer opens with content") : fail("Skill viewer empty");

  // 8 — Sessions
  await evalJS("document.querySelector('[data-close=\"skillOverlay\"]').click()");
  await click("sessionsBtn");
  await wait("document.getElementById('sessionsOverlay').hidden === false", 6000); await sleep(300); await shot("09-sessions");
  (await evalJS("document.querySelectorAll('#sessionsList .session-item').length >= 1")) ? pass("Sessions list shows a session") : fail("Sessions list empty");

  // 9 — Settings (6 sections)
  await evalJS("document.querySelector('[data-close=\"sessionsOverlay\"]').click()");
  await click("settingsBtn");
  await wait("document.getElementById('saveBtn') !== null", 10000); await sleep(400); await shot("10-settings");
  const sections = await evalJS('["Model Provider","API Credentials","Vision Model","Approvals","Cloud Sync","Memory"].filter(s=>document.body.innerText.includes(s)).length');
  sections === 6 ? pass("Settings: all 6 sections present") : fail("Settings: only " + sections + "/6 sections");

  // 10 — office_doc approval + preview overlay (reject to avoid OfficeCLI network install)
  await evalJS("document.getElementById('cancelBtn').click()");
  await wait("document.querySelectorAll('#ctxMemList .ctx-item').length > 0", 12000); await sleep(500);
  await setVal("promptInput", "make a report document"); await send();
  await wait("document.getElementById('approvalOverlay').hidden === false", 20000); await sleep(300); await shot("11-office-approval");
  (await evalJS("/document/i.test(document.getElementById('approvalTitle').textContent)")) ? pass("Office doc approval gate shows") : fail("Office doc approval missing");
  await click("rejectBtn");
  await wait("document.getElementById('approvalOverlay').hidden === true", 10000); await sleep(500);
  await evalJS("document.querySelector('.draft-card')?.click()");
  await wait("document.getElementById('preview-panel').hidden === false", 8000); await sleep(300); await shot("12-preview");
  pass("Preview overlay opens from draft card");

  await sleep(200);
} catch (e) {
  fail("EXCEPTION: " + e.message); try { await shot("99-error"); } catch {}
} finally {
  console.log("\n=== Manual QA summary ===\n" + notes.join("\n") + "\n\nScreenshots in " + SHOTS + "/  (modelHits=" + modelHits + ")");
  cleanup(); process.exit(0);
}