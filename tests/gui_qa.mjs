// GUI QA harness — loads the REAL ui/renderer/index.html + app.js in a jsdom
// DOM, mocks the window.quiver IPC API, and roleplays a manual QA + stress run.
// Dev-only. Run: node tests/gui_qa.mjs
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import * as path from "path";

const R = "ui/renderer";
const results = [];
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) results.push(`  ✔ ${name}`);
  else { results.push(`  ✗ ${name}${extra ? " — " + extra : ""}`); failed++; }
};

// ─── mock window.quiver (the preload IPC API) ──────────────────────────
const mockMemory = [
  { name: "persona.txt", content: "Be concise. Cite sources." },
  { name: "workspace-facts.md", content: "# facts\n- uses Vite" },
];
const mockSkills = ["investment-brief", "due-diligence", "office-doc"];
const mockCore = { identity: "You are Quiver.", human_context: "I'm an analyst at a fund", project_context: "M&A diligence workspace" };
const mockReview = [
  { id: "f1", content: "Prefers 1-page briefs", reviewed: false },
  { id: "f2", content: "Cites SEC filings", reviewed: true },
];
const mockSessions = [{ sessionId: "session_2026_07_09", path: "/x/.sessions/s.state.json", savedAt: "2026-07-09T10:00:00Z", messageCount: 12 }];
let onAgentEventCb = null;
const calls = { send: [], approve: [], stop: 0, saveMemory: [], deleteMemory: [], saveCore: [], saveSkill: [], reviewAction: [], touch: [], preview: [], nav: [] };

const mock = {
  isConfigured: async () => true,
  loadConfig: async () => ({ provider: { modelName: "glm-5.2:cloud", baseUrl: "https://ollama.com/v1", apiKey: "k" }, ollamaApiKey: "k", maxContextTokens: 120000 }),
  startAgent: async () => true,
  sendToAgent: async (t) => { calls.send.push(t); },
  approveToolCall: async (approve, note) => { calls.approve.push({ approve, note }); },
  stopAgent: async () => { calls.stop++; },
  loadCoreMemory: async () => mockCore,
  saveCoreMemory: async (c) => { calls.saveCore.push(c); return true; },
  listMemory: async () => mockMemory,
  saveMemory: async (n, c) => { calls.saveMemory.push({ n, c }); return true; },
  deleteMemory: async (n) => { calls.deleteMemory.push(n); return true; },
  listSkills: async () => mockSkills,
  readSkill: async (n) => `# ${n}\nskill body`,
  saveSkill: async (n, c) => { calls.saveSkill.push({ n, c }); return true; },
  memoryReviewList: async () => mockReview,
  memoryReviewAction: async (id, action, content) => { calls.reviewAction.push({ id, action, content }); return { success: true }; },
  listSessions: async () => mockSessions,
  loadSession: async () => ({}),
  deleteSession: async () => true,
  touchSession: async (p) => { calls.touch.push(p); },
  selectWorkspaceDir: async () => "/tmp/work",
  runTests: async () => ({ success: true, output: "ok" }),
  previewFile: async (fp) => { calls.preview.push(fp); return { content: "hello world preview", type: ".txt" }; },
  loadMain: async () => { calls.nav.push("main"); },
  loadSettings: async () => { calls.nav.push("settings"); },
  loadOnboarding: async () => { calls.nav.push("onboarding"); },
  settingsSetCredential: async () => true,
  onAgentEvent: (cb) => { onAgentEventCb = cb; return () => {}; },
  onAgentRaw: () => () => {},
  onAgentStderr: () => () => {},
  onAgentExit: () => () => {},
  onAgentError: () => () => {},
};
const push = (ev) => onAgentEventCb && onAgentEventCb(ev);

// ─── load the real renderer in jsdom ───────────────────────────────────
const dom = new JSDOM(readFileSync(path.join(R, "index.html"), "utf8"), {
  url: `file://${path.resolve(R)}/index.html`,
  runScripts: "outside-only",
  pretendToBeVisual: true,
  beforeParse(window) {
    window.quiver = mock;
    window.alert = () => {};
    window.scrollTo = () => {};
  },
});
const doc = dom.window.document;
const $ = (id) => doc.getElementById(id);
// Execute the real app.js in the window scope (with the mock already set).
dom.window.eval(readFileSync(path.join(R, "app.js"), "utf8"));
// Let init()'s async chain resolve.
await new Promise((r) => setTimeout(r, 60));

const q = (sel) => doc.querySelector(sel);
const qa = (sel) => doc.querySelectorAll(sel);
const click = (el) => el && el.dispatchEvent(new dom.window.Event("click", { bubbles: true }));

function section(t) { results.push(`\n${t}`); }

// ═══════════════════════════════════════════════════════════════════════
section("1. Three planes present + populated");
ok("context plane exists", !!$("context-plane"));
ok("conversation plane exists", !!$("conversation-plane"));
ok("activity plane exists", !!$("activity-plane"));
ok("model badge shows friendly label", $("modelBadge").textContent === "GLM 5.2", `got "${$("modelBadge").textContent}"`);
ok("model badge tooltip keeps raw id", $("modelBadge").title === "Model: glm-5.2:cloud");
ok("context model shows friendly label", $("ctxModel").textContent === "GLM 5.2");
ok("memory list has 2 items", qa("#ctxMemList .ctx-item").length === 2, `got ${qa("#ctxMemList .ctx-item").length}`);
ok("skills list has 3 items", qa("#ctxSkillsList .ctx-item").length === 3, `got ${qa("#ctxSkillsList .ctx-item").length}`);
ok("core human loaded", $("coreHuman").value === "I'm an analyst at a fund");
ok("review count shows 2 waiting", /2 waiting/.test($("ctxReviewCount").textContent));
ok("review button visible", $("openReviewBtn").hidden === false);

// ═══════════════════════════════════════════════════════════════════════
section("2. Agent events render correctly");
push({ type: "context_manifest", data: { model: "glm-5.2:cloud", tokens: "30,000 / 120,000", memory: "persona.txt", skills: "investment-brief", tools: "28" } });
ok("token bar updates", /30,000/.test($("ctxTokenLabel").textContent), `label="${$("ctxTokenLabel").textContent}"`);
ok("activity shows Context loaded", /Context loaded/.test($("activityStream").textContent));

push({ type: "token", data: { text: "Hello " } });
push({ type: "token", data: { text: "world." } });
ok("assistant bubble created", !!q(".msg.assistant .prose"), `text="${q(".msg.assistant .prose")?.textContent}"`);
ok("assistant text streamed", q(".msg.assistant .prose").textContent === "Hello world.");

push({ type: "tool_call", data: { toolName: "web_search", toolArgs: { query: "acme revenue 2024" } } });
ok("activity shows web search", /Search the web/.test($("activityStream").textContent));

push({ type: "tool_result", data: { toolName: "web_search", toolResult: "3 results" } });
ok("activity shows result done", /Search the web done/.test($("activityStream").textContent));

push({ type: "tool_call", data: { toolName: "office_doc", toolArgs: { filePath: "/tmp/brief.docx" } } });
ok("draft card appears for office_doc", !!q(".draft-card"), `cards=${qa(".draft-card").length}`);

push({ type: "intervention", data: { text: "use 2024 data" } });
ok("activity shows steering", /steered the work/.test($("activityStream").textContent));

// ═══════════════════════════════════════════════════════════════════════
section("3. Approval gate (diff + allow/revise/deny)");
push({ type: "approval", data: { toolName: "write_file", toolArgs: { filePath: "/tmp/a.txt", content: "new line\n" }, currentContent: "old line\n", proposedContent: "" } });
ok("approval overlay opens", $("approvalOverlay").hidden === false);
ok("diff shows removal", !!q("#approvalDiff .diff-line.del"));
ok("diff shows addition", !!q("#approvalDiff .diff-line.add"));
click($("approveBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("Allow → approveToolCall(true)", calls.approve.some((a) => a.approve === true && a.note === undefined));
ok("approval overlay closes", $("approvalOverlay").hidden === true);

// revise flow
push({ type: "approval", data: { toolName: "write_file", toolArgs: { filePath: "/tmp/b.txt", content: "x" }, currentContent: "y", proposedContent: "" } });
ok("approval reopens", $("approvalOverlay").hidden === false);
click($("reviseBtn"));
ok("Suggest a change shows revision box", $("revisionBox").hidden === false);
$("revisionNote").value = "be more concise";
click($("reviseBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("Revise → approveToolCall(false, note)", calls.approve.some((a) => a.approve === false && a.note === "be more concise"));

// deny flow
push({ type: "approval", data: { toolName: "run_command", toolArgs: { command: "rm -rf /tmp/x" }, currentContent: "", proposedContent: "" } });
click($("rejectBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("Don't allow → approveToolCall(false)", calls.approve.at(-1).approve === false);

// allow-all flow
push({ type: "approval", data: { toolName: "write_file", toolArgs: { filePath: "/tmp/c.txt", content: "z" }, currentContent: "", proposedContent: "" } });
click($("approveAllBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("Allow all → approveToolCall(true, 'all')", calls.approve.some((a) => a.approve === true && a.note === "all"));

// ═══════════════════════════════════════════════════════════════════════
section("4. Done / error / status");
push({ type: "done", data: {} });
ok("done → status ok", $("statusDot").className.includes("ok"));
push({ type: "error", data: { error: "boom" } });
ok("error → status error", $("statusDot").className.includes("error"));
ok("activity shows error", /Error: boom/.test($("activityStream").textContent));

// ═══════════════════════════════════════════════════════════════════════
section("5. Image drag-and-drop");
const plane = $("conversation-plane");
plane.dispatchEvent(new dom.window.Event("dragover", { bubbles: true, cancelable: true }));
ok("dragover shows drop overlay", $("dropOverlay").hidden === false);
const dropEv = new dom.window.Event("drop", { bubbles: true, cancelable: true });
dropEv.dataTransfer = { files: [{ path: "/tmp/chart.png", name: "chart.png", type: "image/png" }] };
plane.dispatchEvent(dropEv);
ok("drop overlay hides after drop", $("dropOverlay").hidden === true);
ok("activity notes attachment", /Attached: chart\.png/.test($("activityStream").textContent));
// Friendly attach chip: shows the file name, never the raw path
ok("attach chip shows friendly name", /chart\.png/.test($("attachments").textContent));
ok("attach chip hides raw path", !/\/tmp\/chart\.png/.test($("attachments").textContent), `chip leaked path: "${$("attachments").textContent}"`);
// Sending forwards the [Image: path] marker to the agent (not into the input)
$("promptInput").value = "describe this";
calls.send = [];
click($("sendBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("send forwards [Image:] marker to agent", calls.send.some((m) => /\[Image: \/tmp\/chart\.png\]/.test(m)), `sent=${JSON.stringify(calls.send)}`);
ok("input cleared after send", $("promptInput").value === "");
ok("attach chip cleared after send", $("attachments").children.length === 0);

// ═══════════════════════════════════════════════════════════════════════
section("6. Overlays — memory editor / skill viewer / core memory");
const memItem = q("#ctxMemList .ctx-item");
click(memItem);
ok("memory editor opens", $("memoryOverlay").hidden === false);
ok("memory name populated", $("memoryName").value === "persona.txt");
$("memoryContent").value = "updated";
click($("memorySaveBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("save memory recorded", calls.saveMemory.some((s) => s.n === "persona.txt" && s.c === "updated"));
ok("memory editor closes after save", $("memoryOverlay").hidden === true);

const skillItem = q("#ctxSkillsList .ctx-item");
click(skillItem);
await new Promise((r) => setTimeout(r, 20));
ok("skill viewer opens", $("skillOverlay").hidden === false);
ok("skill content loaded", $("skillContent").value.includes("skill body"));
click($("skillSaveBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("save skill recorded", calls.saveSkill.length === 1);

click($("ctxEditBtn"));
ok("core editor opens", $("coreOverlay").hidden === false);
$("coreHuman").value = "I'm a consultant";
click($("coreSaveBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("core memory saved", calls.saveCore.some((c) => c.human_context === "I'm a consultant"));

// ═══════════════════════════════════════════════════════════════════════
section("7. Review queue");
click($("openReviewBtn"));
await new Promise((r) => setTimeout(r, 20));
ok("review overlay opens", $("reviewOverlay").hidden === false);
ok("review list has 2 items", qa("#reviewList .review-item").length === 2, `got ${qa("#reviewList .review-item").length}`);
const acceptBtn = [...qa("#reviewList .review-item:first-child .ri-actions button")].find((b) => b.textContent === "Accept");
click(acceptBtn);
await new Promise((r) => setTimeout(r, 10));
ok("review accept recorded", calls.reviewAction.some((r) => r.id === "f1" && r.action === "accept"));

// ═══════════════════════════════════════════════════════════════════════
section("8. Sessions");
click($("sessionsBtn"));
await new Promise((r) => setTimeout(r, 20));
ok("sessions overlay opens", $("sessionsOverlay").hidden === false);
ok("sessions list has 1 item", qa("#sessionsList .session-item").length === 1);
const sItem = q("#sessionsList .session-item");
click(sItem);
await new Promise((r) => setTimeout(r, 10));
ok("resume touches session", calls.touch.length === 1);

// ═══════════════════════════════════════════════════════════════════════
section("9. Preview panel");
click(q(".draft-card"));
await new Promise((r) => setTimeout(r, 20));
ok("preview panel opens", $("preview-panel").hidden === false);
ok("preview body filled", /hello world preview/.test($("previewBody").textContent));
ok("preview IPC called", calls.preview.some((p) => p === "/tmp/brief.docx"));

// ═══════════════════════════════════════════════════════════════════════
section("10. Input + suggestions + stop");
$("promptInput").value = "Research Acme Corp";
const chip = q("#suggestionChips .chip");
click(chip);
await new Promise((r) => setTimeout(r, 10));
ok("chip sends prompt", calls.send.some((s) => /Research a company/.test(s)), `sends=${JSON.stringify(calls.send)}`);
ok("user message bubble added", !!q(".msg.user"));
$("promptInput").value = "go";
const ev = new dom.window.Event("keydown", { bubbles: true });
ev.key = "Enter";
$("promptInput").dispatchEvent(ev);
await new Promise((r) => setTimeout(r, 10));
ok("Enter sends (Shift-less)", calls.send.some((s) => s === "go"));
click($("stopBtn"));
await new Promise((r) => setTimeout(r, 10));
ok("Stop calls stopAgent", calls.stop === 1);
click($("activityClearBtn"));
ok("Clear empties activity", $("activityStream").children.length === 0);

// ═══════════════════════════════════════════════════════════════════════
section("11. Stress — high event volume");
const lastProse = () => { const p = qa(".msg.assistant .prose"); return p[p.length - 1]; };
for (let i = 0; i < 300; i++) push({ type: "token", data: { text: "x" } });
const lp = lastProse();
ok("300 rapid tokens appended", lp && lp.textContent.length >= 300, `last bubble len=${lp?.textContent.length}`);
for (let i = 0; i < 100; i++) { push({ type: "tool_call", data: { toolName: "view_file", toolArgs: { filePath: "/f" + i } } }); push({ type: "tool_result", data: { toolName: "view_file", toolResult: "ok" } }); }
ok("100 tool round-trips logged", $("activityStream").children.length >= 200, `got ${$("activityStream").children.length}`);

// ═══════════════════════════════════════════════════════════════════════
section("12. Stress — malformed + huge payloads");
let threw = false;
try {
  push(null);
  push(undefined);
  push("just a string");
  push({ type: "totally-unknown" });
  push({ type: "tool_call" }); // no data
  push({ type: "token" }); // no data.text
  push({ type: "approval", data: { toolName: "write_file", toolArgs: {} } }); // no contents
  push({ type: "context_manifest", data: { tokens: "not-a-number / also-no" } });
} catch (e) { threw = true; }
ok("malformed events don't throw", threw === false);
const big = "A".repeat(500_000);
push({ type: "token", data: { text: big } });
const lpB = lastProse();
ok("500KB token appended without crash", lpB && lpB.textContent.includes(big.slice(0, 100)), `last len=${lpB?.textContent.length}`);
// concurrent approvals queued back-to-back
push({ type: "approval", data: { toolName: "write_file", toolArgs: { filePath: "/a", content: "1" }, currentContent: "", proposedContent: "" } });
push({ type: "approval", data: { toolName: "write_file", toolArgs: { filePath: "/b", content: "2" }, currentContent: "", proposedContent: "" } });
ok("back-to-back approvals don't crash", $("approvalOverlay").hidden === false);

// ─── report ───────────────────────────────────────────────────────────
console.log(results.join("\n"));
const passed = results.filter((r) => r.includes("✔")).length;
const total = results.filter((r) => r.includes("✔") || r.includes("✗")).length;
console.log(`\n  QA: ${passed}/${total} passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);