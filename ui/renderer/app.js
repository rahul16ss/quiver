// ─── Quiver Desktop — renderer logic (transparency-first) ──────────────
// Three planes: Context | Conversation | Activity. The renderer is a thin
// view over the Quiver CLI (run in --json mode by the main process). It
// speaks only the allowlisted window.quiver IPC API exposed by preload.js.
// No framework, no build step, no inline scripts (CSP script-src 'self').

const api = window.quiver;

// ─── tiny helpers ─────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const escapeHtml = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const nowTime = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ─── state ────────────────────────────────────────────────────────────
let configured = false;
let agentRunning = false;
let assistantBubble = null;       // current streaming assistant message element
let pendingApproval = null;       // the approval event awaiting a decision
let pendingApprovalAll = false;
// True between a live send and the corresponding done/error event. Used to
// suppress consent-gate overlays that the daemon replays after a restart.
let liveRunActive = false;
let attachments = [];   // "allow all similar" requested

// ─── element cache ────────────────────────────────────────────────────
const chatArea = $("chatArea");
const emptyState = $("emptyState");
const promptInput = $("promptInput");
const sendBtn = $("sendBtn");
const stopBtn = $("stopBtn");
const statusDot = $("statusDot");
const activityStream = $("activityStream");

// ─── init ──────────────────────────────────────────────────────────────
async function init() {
  wireButtons();
  wireImageDrop();
  wireKeyboard();
  try {
    configured = await api.isConfigured();
  } catch {
    configured = false;
  }
  if (!configured) {
    api.loadOnboarding();
    return;
  }
  const config = await api.loadConfig();
  // Launch state is idle (Epic 2 §2.2): spawning the agent process is NOT
  // "working". Send stays visible/enabled; the dot goes amber only when a
  // prompt is dispatched or the agent reports activity.
  setWorking(false);
  try {
    await api.startAgent(config, false);
    agentRunning = true;
  } catch (e) {
    agentRunning = false;
    addActivity("Could not start the agent: " + (e?.message || e), "err");
  }
  // A failed/errored startup must never leave the working state stuck.
  setWorking(false);
  maybeShowWorkspaceWarning(config);
  loadContextSurfaces(config);
}

// One-time, non-blocking banner when the configured workspace is Quiver's own
// app/source folder (Epic 2 §2.5). The path-policy hard block applies anyway;
// this just nudges the user toward a real documents folder.
function maybeShowWorkspaceWarning(config) {
  if (!config?.workspaceIsAppSource) return;
  const DISMISS_KEY = "quiver.workspaceWarningDismissed";
  try {
    if (localStorage.getItem(DISMISS_KEY) === "1") return;
  } catch {}
  const banner = $("workspaceWarning");
  if (!banner) return;
  banner.hidden = false;
  $("workspaceWarningDismiss")?.addEventListener("click", () => {
    banner.hidden = true;
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch {}
  });
}

// ─── context plane: what Quiver sees ───────────────────────────────────
async function loadContextSurfaces(config) {
  if (config?.provider?.modelName) setModel(config.provider.modelName);
  
  // Dynamically update trust level badge
  const grants = config?.autonomyGrants || "";
  let label = "Ask before acting";
  if (grants.includes("yolo")) {
    label = "Full access (developer)";
  } else if (grants.includes("tier:operate")) {
    label = "Assisted";
  } else if (grants.includes("tier:build")) {
    label = "Draft and research";
  } else if (grants.includes("tier:propose")) {
    label = "Draft only";
  } else if (grants.includes("tier:observe")) {
    label = "Read-only";
  }
  const badge = $("trustBadge");
  if (badge) badge.textContent = label;

  // §6 layer F: operational metadata — where the work actually runs.
  const trustEl = $("ctxTrust");
  if (trustEl) trustEl.textContent = `Approvals: ${label}`;
  const endpointEl = $("ctxEndpoint");
  if (endpointEl) {
    const baseUrl = config?.provider?.baseUrl || "";
    let where = "Endpoint not configured";
    try {
      const host = new URL(baseUrl).hostname;
      where =
        host === "localhost" || host === "127.0.0.1"
          ? "Local endpoint — prompts stay on this machine"
          : `Cloud endpoint — prompts go to ${host}`;
    } catch {}
    endpointEl.textContent = where;
    endpointEl.title = baseUrl;
  }
  const wsEl = $("ctxWorkspace");
  if (wsEl) {
    const ws = config?.workspacePath || "";
    wsEl.textContent = ws ? `Workspace: ${ws.replace(/^\/Users\/[^/]+/, "~")}` : "";
    wsEl.title = ws;
  }

  loadCoreMemory();
  loadMemoryList();
  loadSkillList();
  refreshReviewCount();
}

// Curated, human-readable labels for the model in use. We keep the
// technical id available as a tooltip for the curious, but surface a
// calm, branded name in the chrome — the way Apple shows "M2" not a SKU.
const MODEL_LABELS = [
  // (registry prefix or substring, friendly label)
  ["gpt-oss", "GPT-OSS"],
  ["glm-5", "GLM 5.2"],
  ["glm-4", "GLM 4"],
  ["gemma3", "Gemma 3"],
  ["gemma2", "Gemma 2"],
  ["llama3.3", "Llama 3.3"],
  ["llama3.2", "Llama 3.2"],
  ["llama3.1", "Llama 3.1"],
  ["llama3", "Llama 3"],
  ["qwen2.5", "Qwen 2.5"],
  ["qwen2", "Qwen 2"],
  ["deepseek-r1", "DeepSeek R1"],
  ["deepseek", "DeepSeek"],
  ["phi3", "Phi-3"],
  ["mistral", "Mistral"],
  ["mixtral", "Mixtral"],
  ["codellama", "Code Llama"],
  ["codestral", "Codestral"],
  ["command-r", "Command R"],
];
// Size tags we lift into a quiet suffix (e.g. Gemma 3 · 4B).
const SIZE_TAG = /:(\d+b|\d+x\d+b)/i;
function friendlyModelName(id) {
  const raw = String(id || "").trim();
  if (!raw) return "—";
  // strip registry host (e.g. "registry.example/gemma3") and any :tag
  const base = raw.split("/").pop().split(":")[0];
  const tag = (SIZE_TAG.exec(raw) || [])[1];
  const key = base.toLowerCase();
  let label = null;
  for (const [needle, name] of MODEL_LABELS) {
    if (key.includes(needle)) { label = name; break; }
  }
  if (!label) {
    // graceful fallback: turn "some-model_name" into "Some Model Name"
    label = base.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (tag) label += ` \u00b7 ${tag.toUpperCase()}`;  // middot, Apple-style
  return label;
}
function setModel(name) {
  const f = friendlyModelName(name);
  const badge = $("modelBadge");
  badge.textContent = f;
  badge.title = name ? `Model: ${name}` : "No model selected";
  $("ctxModel").textContent = f;
  $("ctxModel").title = name ? name : "";
}
function renderAttachments() {
  const box = $("attachments");
  if (!box) return;
  box.innerHTML = "";
  for (const a of attachments) {
    const chip = document.createElement("div");
    chip.className = "attach-chip";
    chip.title = a.name;
    let thumb = "";
    if (a.thumbUrl) {
      thumb = '<img class="attach-thumb" alt="" src="' + a.thumbUrl + '">';
    } else {
      thumb = '<span class="attach-thumb attach-thumb\u2014glyph">\u2728</span>';
    }
    const display = a.name.length > 22 ? a.name.slice(0, 19) + "\u2026" : a.name;
    chip.innerHTML = thumb +
      '<span class="attach-name">' + escapeHtml(display) + '</span>' +
      '<button type="button" class="attach-x" aria-label="Remove attachment" data-path="' + escapeHtml(a.path) + '">\u00d7</button>';
    box.appendChild(chip);
  }
}

async function loadCoreMemory() {
  try {
    const core = await api.loadCoreMemory();
    $("coreHuman").value = core.human_context || "";
    $("coreProject").value = core.project_context || "";
  } catch {}
}

async function loadMemoryList() {
  const list = $("ctxMemList");
  const count = $("ctxMemCount");
  try {
    const files = await api.listMemory();
    count.textContent = files.length ? `· ${files.length}` : "";
    list.innerHTML = "";
    if (!files.length) {
      list.innerHTML = '<div class="ctx-value muted">No memory files</div>';
      return;
    }
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "ctx-item";
      item.title = f.name;
      // S2 / SPEC §6: exclude-before-run — veto button on each memory item
      const vetoBtn = document.createElement("button");
      vetoBtn.className = "ctx-veto-btn";
      vetoBtn.title = "Exclude from next run";
      vetoBtn.textContent = "×";
      vetoBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        excludeFromRun(f.name, item);
      });
      item.innerHTML =
        escapeHtml(f.name) +
        '<span class="ctx-sub"> · ' +
        Math.max(1, (f.content || "").split("\n").length) +
        " lines</span>";
      item.prepend(vetoBtn);
      item.addEventListener("click", () => openMemoryEditor(f.name, f.content));
      list.appendChild(item);
    }
  } catch {
    list.innerHTML = '<div class="ctx-value muted">Unable to load</div>';
  }
}

// The internal system-prompt skill is plumbing, not a business capability —
// it is hidden from the rail (Epic 2 §2.6: the rail must read honestly).
function isInternalSkill(id) {
  return /system-prompt/i.test(String(id || ""));
}

// If there are zero user-facing skills, hide the whole row rather than
// saying "No skills" (P1-7 / Epic 2 §2.6).
function renderSkillRow(skills) {
  const section = $("ctxSkillsSection");
  const list = $("ctxSkillsList");
  const count = $("ctxSkillCount");
  if (!skills.length) {
    if (section) section.hidden = true;
    return;
  }
  if (section) section.hidden = false;
  count.textContent = `· ${skills.length}`;
  list.innerHTML = "";
  for (const s of skills) {
    const item = document.createElement("div");
    item.className = "ctx-item";
    item.textContent = s.version ? `${s.id} ` : s.id;
    if (s.version) {
      const ver = document.createElement("span");
      ver.className = "ctx-sub";
      ver.textContent = `· v${s.version}`;
      item.appendChild(ver);
    }
    item.title = s.version ? `${s.id} v${s.version}` : s.id;
    item.addEventListener("click", () => openSkillViewer(s.id));
    list.appendChild(item);
  }
}

// Initial fill from the skills folder (before the agent reports anything).
async function loadSkillList() {
  try {
    const allSkills = await api.listSkills();
    const skills = (allSkills || [])
      .filter((s) => !isInternalSkill(s))
      .map((s) => ({ id: s, version: "" }));
    renderSkillRow(skills);
  } catch {
    const section = $("ctxSkillsSection");
    if (section) section.hidden = true;
  }
}

// Authoritative fill from the agent's context manifest: the ACTUAL loaded
// skills with versions — the rail must never contradict the activity feed.
function renderLoadedSkills(data) {
  let skills = [];
  let framing = null;
  if (Array.isArray(data?.skillsDetail)) {
    for (const s of data.skillsDetail) {
      if (!s || !s.id) continue;
      // The system prompt is §6 layer A (Framing) — shown separately, not
      // buried in the business skill list.
      if (isInternalSkill(s.id)) {
        framing = s;
        continue;
      }
      skills.push({ id: s.id, version: s.version || "" });
    }
  } else if (typeof data?.skills === "string" && data.skills !== "—") {
    skills = data.skills
      .split(",")
      .map((part) => {
        const m = /^\s*(.+?)\s+v([\w.\-]+)\s*$/.exec(part) || [null, part.trim(), ""];
        return { id: (m[1] || "").trim(), version: m[2] || "" };
      })
      .filter((s) => s.id && !isInternalSkill(s.id));
  }
  renderSkillRow(skills);

  const framingEl = $("ctxFraming");
  if (framingEl && framing) {
    framingEl.textContent = `System prompt v${framing.version || "1"} — editable in ~/.quiver/skills`;
    framingEl.classList.remove("muted");
    const section = $("ctxFramingSection");
    if (section) section.hidden = false;
  }

  renderToolCatalog(data);
  updateTurnCount();
}

// §6 layer C: the actual tool catalog, expandable, not just a count.
function renderToolCatalog(data) {
  const summary = $("ctxToolsSummary");
  const list = $("ctxToolsList");
  if (!summary || !list) return;
  const names = Array.isArray(data?.toolNames) ? data.toolNames : [];
  const count = names.length || Number(data?.tools || 0);
  const section = $("ctxToolsSection");
  if (section) section.hidden = count === 0;
  summary.textContent = count ? `${count} tools available` : "—";
  list.innerHTML = "";
  for (const n of names) {
    const chip = document.createElement("span");
    chip.className = "ctx-tool-chip";
    chip.textContent = n;
    list.appendChild(chip);
  }
}

// §6 layer D: how much of the conversation the model carries.
function updateTurnCount() {
  const el = $("ctxTurns");
  if (!el) return;
  const n = chatTurnCount();
  el.textContent = n ? `${n} ${n === 1 ? "turn" : "turns"} in this session` : "New session";
  if (n) {
    const section = $("ctxTokensSection");
    if (section) section.hidden = false;
  }
}

async function refreshReviewCount() {
  try {
    const pending = await api.memoryReviewList();
    const n = (pending || []).length;
    $("ctxReviewCount").textContent = n ? `${n} waiting` : "Nothing pending";
    $("openReviewBtn").hidden = n === 0;
  } catch {
    $("ctxReviewCount").textContent = "—";
  }
}

// ─── conversation plane ────────────────────────────────────────────────
function addUserMessage(text) {
  hideEmpty();
  const msg = document.createElement("div");
  msg.className = "msg user";
  msg.textContent = text;
  chatArea.appendChild(msg);
  scrollChat();
  updateTurnCount();
}

function startAssistantBubble() {
  hideEmpty();
  const msg = document.createElement("div");
  msg.className = "msg assistant";
  const prose = document.createElement("div");
  prose.className = "prose";
  msg.appendChild(prose);
  chatArea.appendChild(msg);
  assistantBubble = prose;
  scrollChat();
}

function appendAssistantToken(token) {
  if (!assistantBubble) startAssistantBubble();
  if (assistantBubble.dataset.rawText === undefined) {
    assistantBubble.dataset.rawText = "";
  }
  assistantBubble.dataset.rawText += token;
  assistantBubble.innerHTML = renderMarkdownToHtml(assistantBubble.dataset.rawText);
  scrollChat();
}

function hideEmpty() {
  if (emptyState) emptyState.hidden = true;
}
function showEmpty() {
  if (emptyState) emptyState.hidden = false;
}
// Clear the conversation without destroying the empty-state node, which
// lives inside #chatArea (a bare innerHTML="" would delete it for good).
function clearChat() {
  for (const child of [...chatArea.children]) {
    if (child !== emptyState) child.remove();
  }
}
function chatTurnCount() {
  return [...chatArea.children].filter((c) => c !== emptyState).length;
}
function scrollChat() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ─── deliverable cards (Epic 2 §2.4 — "here is your document") ─────────
// One card per document file; repeated office_doc ops update the same card.
const documentCards = new Map(); // filePath → card element

const DOC_KINDS = {
  docx: { icon: "📄", label: "Word document" },
  xlsx: { icon: "📊", label: "Excel spreadsheet" },
  pptx: { icon: "📽️", label: "PowerPoint presentation" },
};
function docKindFor(filePath) {
  const ext = String(filePath).split(".").pop().toLowerCase();
  return DOC_KINDS[ext] || { icon: "📄", label: "Document" };
}
const OFFICE_MUTATING_ACTIONS = new Set([
  "create", "add", "set", "remove", "move", "swap", "batch", "save", "merge", "import",
]);

function ensureDocumentCard(filePath) {
  if (documentCards.has(filePath)) return documentCards.get(filePath);
  hideEmpty();
  const kind = docKindFor(filePath);
  const name = String(filePath).split("/").pop();
  const card = document.createElement("div");
  card.className = "draft-card";
  card.innerHTML =
    '<div class="draft-icon">' + kind.icon + "</div>" +
    '<div class="draft-meta">' +
    '<div class="draft-title">Creating ' + escapeHtml(name) + "…</div>" +
    '<div class="draft-sub">' + escapeHtml(kind.label) + " · " + escapeHtml(filePath) + "</div>" +
    '<div class="draft-actions" hidden>' +
    '<button type="button" class="ghost-btn doc-open">Open</button>' +
    '<button type="button" class="ghost-btn doc-reveal">Show in Folder</button>' +
    '<button type="button" class="ghost-btn doc-preview">Preview</button>' +
    '<button type="button" class="ghost-btn doc-context">Context</button>' +
    "</div></div>";
  card.querySelector(".doc-open").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await api.openFile(filePath);
    if (res?.error) addActivity("Couldn't open " + name + ": " + res.error, "err");
  });
  card.querySelector(".doc-reveal").addEventListener("click", async (e) => {
    e.stopPropagation();
    const res = await api.showInFolder(filePath);
    if (res?.error) addActivity("Couldn't reveal " + name + ": " + res.error, "err");
  });
  card.querySelector(".doc-preview").addEventListener("click", (e) => {
    e.stopPropagation();
    openPreview(filePath, name);
  });
  card.querySelector(".doc-context").addEventListener("click", (e) => {
    e.stopPropagation();
    openDeliverableContext(filePath);
  });
  card.addEventListener("click", () => openPreview(filePath, name));
  chatArea.appendChild(card);
  scrollChat();
  documentCards.set(filePath, card);
  return card;
}

function handleOfficeDocResult(args, ok) {
  const filePath = typeof args?.file === "string" ? args.file : "";
  if (!filePath || !OFFICE_MUTATING_ACTIONS.has(String(args?.action))) return;
  const card = ensureDocumentCard(filePath);
  const name = String(filePath).split("/").pop();
  const kind = docKindFor(filePath);
  const titleEl = card.querySelector(".draft-title");
  const actionsEl = card.querySelector(".draft-actions");
  if (ok) {
    if (titleEl) titleEl.textContent = name;
    card.querySelector(".draft-sub").textContent = kind.label + " · ready";
    card.querySelector(".draft-sub").title = filePath;
    if (actionsEl) actionsEl.hidden = false;
    card.classList.remove("canceled");
    card.classList.add("ready");
  } else if (!card.classList.contains("ready")) {
    if (titleEl) titleEl.textContent = "Creation canceled — " + name;
    card.classList.add("canceled");
  }
  scrollChat();
}

// ─── activity plane: what Quiver is doing ──────────────────────────────
let lastContextEntryText = null; // dedupe "Context loaded: …" spam (P1-10)
function addActivity(text, kind = "") {
  const placeholder = $("activityEmpty");
  if (placeholder) placeholder.remove();
  const clearBtn = $("activityClearBtn");
  if (clearBtn) clearBtn.hidden = false;
  const line = document.createElement("div");
  line.className = "act " + kind;
  const mark = kind === "ok" ? "✓" : kind === "warn" ? "…" : kind === "err" ? "⚠" : kind === "verify" ? "✓" : "·";
  line.innerHTML =
    '<span class="act-mark">' + mark + "</span>" +
    '<span class="act-text">' + escapeHtml(text) + "</span>" +
    '<span class="act-time">' + nowTime() + "</span>";
  activityStream.appendChild(line);
  activityStream.scrollTop = activityStream.scrollHeight;
}

// ─── agent lifecycle + events ──────────────────────────────────────────
function setWorking(working) {
  statusDot.className = "status-dot " + (working ? "working" : "idle");
  sendBtn.hidden = working;
  stopBtn.hidden = !working;
}

function wireAgentEvents() {
  api.onAgentEvent((ev) => handleAgentEvent(ev));
  api.onAgentExit((d) => {
    agentRunning = false;
    setWorking(false);
    statusDot.className = "status-dot idle";
    addActivity("Agent stopped" + (d?.code ? ` (exit ${d.code})` : ""), "");
  });
  api.onAgentError((e) => {
    setWorking(false);
    statusDot.className = "status-dot error";
    addActivity("Agent error: " + (e?.error || e), "err");
  });
  api.onAgentStderr((d) => {
    if (d?.data) addActivity(d.data.trim(), "warn");
  });
}

function handleAgentEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case "user_replay": {
      // Daemon ring replay after a window restart: repaint the user's side
      // of the conversation (live sends are painted locally, not via this).
      if (ev.content) addUserMessage(ev.content);
      break;
    }
    case "context_manifest": {
      if (ev.data?.model) setModel(ev.data.model);
      if (ev.data?.tokens) updateTokenBar(ev.data.tokens);
      renderLoadedSkills(ev.data);
      // The consent gate is now driven by the dedicated `consent_gate`
      // event (below) so it can actually block. The manifest just feeds the
      // context rail.
      // Don't re-announce an identical context on consecutive turns (P1-10).
      const entry = `Context loaded: ${ev.data?.memory || "—"} memory · ${ev.data?.skills || "—"} skills · ${ev.data?.tools || "—"} tools`;
      if (entry !== lastContextEntryText) {
        addActivity(entry, "tool");
        lastContextEntryText = entry;
      }
      break;
    }
    case "consent_gate": {
      // SPEC §6: the agent emits this before the model call and waits for a
      // decision. Only show the overlay for a LIVE run — daemon replay after
      // a window restart would otherwise re-prompt for an already-completed
      // turn.
      if (liveRunActive) showConsentGate(ev.data);
      break;
    }
    case "consent_declined": {
      liveRunActive = false;
      setWorking(false);
      addActivity("Consent declined — turn aborted", "warn");
      break;
    }
    case "consent_exclude": {
      liveRunActive = false;
      setWorking(false);
      addActivity("Routed back to the context rail — exclude items, then re-run", "warn");
      focusContextRail();
      break;
    }
    case "sensitivity_refused": {
      // US-17.17 / SPEC §11.2: a high-sensitivity turn was refused because no
      // local model endpoint is configured. Surface the reason — never a blank
      // "Done" (empty states are product; silent failure is the anti-pattern).
      liveRunActive = false;
      setWorking(false);
      setCurrentStatus("");
      statusDot.className = "status-dot error";
      const reason = ev.data?.reason
        ? ev.data.reason
        : "This input is high-sensitivity and no local model endpoint is configured.";
      addActivity(`Refused — not sent: ${reason}`, "err");
      startAssistantBubble();
      if (assistantBubble) {
        assistantBubble.textContent =
          "⚠ I didn't send this to the model. " + reason +
          " Set a local model endpoint (QUIVER_LOCAL_LLM_API_BASE_URL + QUIVER_LOCAL_LLM_MODEL_NAME, e.g. a localhost Ollama) so high-sensitivity content never leaves this machine, then re-run.";
      }
      break;
    }
    case "token": {
      if (ev.data?.text) appendAssistantToken(ev.data.text);
      setWorking(true);
      break;
    }
    case "tool_call": {
      const name = ev.data?.toolName || "tool";
      const hint = summarizeArgs(ev.data?.toolArgs);
      setCurrentStatus(`${plainToolName(name)}${hint ? " — " + hint : ""}…`);
      addActivity(`Quiver wants to: ${plainToolName(name)}${hint ? " — " + hint : ""}`, "tool");
      setWorking(true);
      maybeDraftCard(name, ev.data?.toolArgs);
      break;
    }
    case "tool_result": {
      const name = ev.data?.toolName || "tool";
      const args = ev.data?.toolArgs || {};
      const resultStr = String(ev.data?.toolResult || "");
      const ok = !/^error/i.test(resultStr);
      const hint = summarizeArgs(args);
      setCurrentStatus("");
      addActivity(`${plainToolName(name)}${hint ? " — " + hint : ""} ${ok ? "done" : "failed"}`, ok ? "ok" : "err");
      if (name === "office_doc") {
        handleOfficeDocResult(args, ok);
      }
      // S8/S9: If evidence tool recorded claims, render lineage chips
      if (name === "evidence" && ok) {
        try {
          const parsed = JSON.parse(resultStr);
          if (parsed?.claims && parsed?.docPath) {
            renderLineageChipsForDocument(parsed.docPath, parsed.claims, parsed.sources);
          }
          if (parsed?.runRecord && parsed?.docPath) {
            recordDeliverableContext(parsed.docPath, parsed);
          }
        } catch {}
      }
      break;
    }
    case "approval": {
      showApproval(ev.data);
      break;
    }
    case "intervention": {
      addActivity("You steered the work: " + (ev.data?.text || ""), "warn");
      break;
    }
    case "done": {
      liveRunActive = false;
      setWorking(false);
      setCurrentStatus("");
      // If the turn was refused (e.g. high-sensitivity with no local endpoint),
      // the sensitivity_refused case already surfaced the reason — don't paint
      // a misleading green "Done" over a refusal.
      if (ev.data?.refused) {
        statusDot.className = "status-dot error";
        addActivity("Turn refused — nothing was sent to the model.", "err");
      } else {
        statusDot.className = "status-dot ok";
        addActivity("Done", "ok");
      }
      refreshReviewCount();
      updateTurnCount();
      assistantBubble = null;
      break;
    }
    case "error": {
      liveRunActive = false;
      setWorking(false);
      statusDot.className = "status-dot error";
      addActivity("Error: " + (ev.data?.error || ""), "err");
      break;
    }
  }
}

// Render a real before/after diff for file-mutation approvals.
function renderDiff(before, after) {
  const view = $("approvalDiff");
  view.innerHTML = "";
  const beforeLines = String(before ?? "").split("\n");
  const afterLines = String(after ?? "").split("\n");
  // Simple line diff: show removed then added, with shared context around changes.
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i++) {
    const a = beforeLines[i];
    const b = afterLines[i];
    if (a !== undefined && a === b) {
      diffLine(view, " ", a, "ctx");
    } else {
      if (a !== undefined) diffLine(view, "−", a, "del");
      if (b !== undefined) diffLine(view, "+", b, "add");
    }
  }
  if (!before && !after) {
    // Never show a blind approval: fall back to the pretty-printed arguments.
    renderApprovalPreview(pendingApproval?.toolName || "", pendingApproval?.toolArgs || {});
  }
}
function diffLine(view, sign, text, cls) {
  const row = document.createElement("div");
  row.className = "diff-line " + cls;
  row.innerHTML =
    '<span class="diff-sign">' + sign + "</span>" +
    '<span class="diff-text">' + escapeHtml(text) + "</span>";
  view.appendChild(row);
}

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  // "file" covers office_doc (document ops name their target this way).
  for (const k of ["filePath", "file", "url", "command", "query", "directoryPath", "filename"]) {
    if (args[k]) return String(args[k]);
  }
  return "";
}
function plainToolName(name) {
  return ({
    view_file: "Read a file",
    write_file: "Write a file",
    replace_content: "Edit a file",
    apply_patch: "Apply a patch",
    list_dir: "List a folder",
    glob: "Find files",
    grep_search: "Search files",
    run_command: "Run a command",
    run_tests: "Run tests",
    web_search: "Search the web",
    scrape_url: "Read a webpage",
    deep_research: "Run deep research",
    find_all: "Find entities",
    entity_search: "Search for entities",
    browser_control: "Use the browser",
    office_doc: "Create a document",
    memory_append: "Save a memory",
    memory_replace: "Update a memory",
    github: "Use GitHub",
    create_tool: "Create a tool",
    subagent: "Delegate to a sub-agent",
    todo_write: "Plan the work",
    ask_question: "Ask you a question",
  })[name] || name;
}
function maybeDraftCard(toolName, args) {
  if (
    toolName === "office_doc" &&
    typeof args?.file === "string" &&
    OFFICE_MUTATING_ACTIONS.has(String(args?.action))
  ) {
    ensureDocumentCard(String(args.file));
  }
}

// ─── approval gate ─────────────────────────────────────────────────────
// Every overlay must state: the tool, the target (file/command/URL), and a
// content preview (Epic 2 §2.3). "(nothing to preview)" is unreachable — the
// generic fallback pretty-prints the full arguments.
function showApproval(data) {
  pendingApproval = data;
  pendingApprovalAll = false;
  const name = data?.toolName || "act";
  const args = data?.toolArgs || {};
  $("approvalTitle").textContent = "Quiver wants to " + verbForApproval(name);
  $("approvalSummary").textContent = summarizeArgs(args) || plainToolName(name);
  $("approvalSummary").title = JSON.stringify(args);

  const isFileMutation =
    name === "write_file" || name === "replace_content" || name === "apply_patch";
  if (name === "apply_patch") {
    renderPatchPreview(args.patch);
  } else if (isFileMutation) {
    // Real before/after diff — already built.
    let before = data?.currentContent ?? "";
    let after = data?.proposedContent ?? "";
    if (!after && name === "write_file") after = args.content ?? "";
    if (!after && name === "replace_content") {
      after = String(before).split(args.targetContent ?? "").join(args.replacementContent ?? "");
    }
    renderDiff(before, after);
  } else {
    renderApprovalPreview(name, args);
  }
  $("revisionBox").hidden = true;
  $("revisionNote").value = "";
  showOverlay("approvalOverlay");
  setWorking(false);
}

// Structured, human-readable previews for non-diff tools.
function renderApprovalPreview(name, args) {
  const view = $("approvalDiff");
  view.innerHTML = "";
  const box = document.createElement("div");
  box.className = "approval-preview";

  const row = (label, value) => {
    if (!value) return;
    const r = document.createElement("div");
    r.className = "ap-row";
    r.innerHTML =
      '<span class="ap-label">' + escapeHtml(label) + "</span>" +
      '<span class="ap-value">' + escapeHtml(String(value)) + "</span>";
    box.appendChild(r);
  };
  const contentBlock = (label, text) => {
    if (!text) return;
    const str = String(text);
    if (str.length > 600 || str.split("\n").length > 12) {
      const det = document.createElement("details");
      det.className = "ap-details";
      det.innerHTML =
        "<summary>" + escapeHtml(label) + " (" + str.split("\n").length + " lines — click to expand)</summary>" +
        '<pre class="ap-pre">' + escapeHtml(str) + "</pre>";
      box.appendChild(det);
    } else {
      const wrap = document.createElement("div");
      wrap.className = "ap-block";
      wrap.innerHTML =
        '<div class="ap-label">' + escapeHtml(label) + "</div>" +
        '<pre class="ap-pre">' + escapeHtml(str) + "</pre>";
      box.appendChild(wrap);
    }
  };

  if (name === "office_doc") {
    const kind = docKindFor(args.file || "");
    row("File", args.file);
    row("Operation", [args.action, args.type].filter(Boolean).join(" — "));
    if (args.parent) row("Where", args.parent);
    if (args.path) row("Element", args.path);
    if (args.props && typeof args.props === "object") {
      if (args.props.text) contentBlock("Text being written", args.props.text);
      const rest = Object.entries(args.props).filter(([k]) => k !== "text");
      if (rest.length) {
        contentBlock(
          "Formatting",
          rest.map(([k, v]) => `${k}: ${v}`).join("\n"),
        );
      }
    }
    if (Array.isArray(args.commands)) {
      contentBlock(
        `Operations (${args.commands.length})`,
        args.commands
          .map((c, i) => `${i + 1}. ${JSON.stringify(c)}`)
          .join("\n"),
      );
    }
    if (args.template) row("Template", args.template);
    if (args.source) row("Data source", args.source);
    row("Kind", kind.label);
  } else if (name === "run_command") {
    contentBlock("Command", args.command || "");
    if (args.cwd) row("Folder", args.cwd);
  } else if (name === "web_search" || name === "deep_research" || name === "entity_search" || name === "find_all") {
    row("Query", args.query || args.topic || args.question);
  } else if (name === "scrape_url" || name === "browser_control") {
    row("URL", args.url);
    if (args.action) row("Action", args.action);
    if (args.query) row("Query", args.query);
  } else if (name === "github") {
    row("Action", args.action);
    row("Repository", args.repo || args.repository);
  }

  // Generic fallback + full detail: pretty-printed arguments. Guarantees a
  // non-empty preview for every tool.
  const argKeys = Object.keys(args || {});
  if (!box.childNodes.length || argKeys.length) {
    const pretty = JSON.stringify(args || {}, null, 2);
    if (!box.childNodes.length) {
      contentBlock("Details", pretty);
    } else {
      const det = document.createElement("details");
      det.className = "ap-details";
      det.innerHTML =
        "<summary>Full details</summary>" +
        '<pre class="ap-pre">' + escapeHtml(pretty) + "</pre>";
      box.appendChild(det);
    }
  }
  view.appendChild(box);
}
function verbForApproval(name) {
  return ({
    write_file: "write a file",
    replace_content: "edit a file",
    apply_patch: "apply a patch",
    run_command: "run a command",
    create_tool: "create a new tool",
    office_doc: "create a document",
    browser_control: "use the browser",
  })[name] || "take an action";
}
function renderPatchPreview(patch) {
  const view = $("approvalDiff");
  view.innerHTML = "";
  for (const line of String(patch ?? "").split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    const sign = line.startsWith("+") ? "+" : line.startsWith("-") ? "−" : " ";
    diffLine(view, sign, line, cls);
  }
}

function approveAction(all = false) {
  if (!pendingApproval) return;
  api.approveToolCall(true, all ? "all" : undefined);
  closeOverlay("approvalOverlay");
  pendingApproval = null;
  setWorking(true);
}
function rejectAction() {
  if (!pendingApproval) return;
  api.approveToolCall(false);
  closeOverlay("approvalOverlay");
  pendingApproval = null;
  setWorking(true);
}
function requestRevision() {
  if (!$("revisionBox").hidden) {
    // second click: send the revision note as a rejection with guidance
    const note = $("revisionNote").value.trim();
    if (pendingApproval) api.approveToolCall(false, note || undefined);
    closeOverlay("approvalOverlay");
    pendingApproval = null;
    setWorking(true);
  } else {
    $("revisionBox").hidden = false;
    $("revisionNote").focus();
  }
}

// ─── token bar ─────────────────────────────────────────────────────────
// Compact "24k / 120k" display (en-US, locale-independent) with the exact
// figures kept in the tooltip (Epic 2 §2.6). The row stays hidden until the
// first real reading arrives — no dangling "—" in the idle state (P1-9).
function compactNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}
function updateTokenBar(tokenStr) {
  // tokenStr like "12,345 / 120,000"
  const m = /([\d.,]+)\s*\/\s*([\d.,]+)/.exec(tokenStr || "");
  if (!m) return;
  const used = parseFloat(m[1].replace(/[.,]/g, ""));
  const total = parseFloat(m[2].replace(/[.,]/g, ""));
  if (!isFinite(used) || !isFinite(total)) return;
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const section = $("ctxTokensSection");
  if (section) section.hidden = false;
  const bar = $("ctxTokenBar");
  bar.style.width = pct + "%";
  bar.style.background = pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--accent)";
  const label = $("ctxTokenLabel");
  label.textContent = `${compactNumber(used)} / ${compactNumber(total)} (${Math.round(pct)}%)`;
  label.title = `${used.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} tokens used`;
}

// ─── input + send ──────────────────────────────────────────────────────
async function sendPrompt() {
  const text = promptInput.value.trim();
  if ((!text && attachments.length === 0) || !agentRunning) return;
  const imageMarkers = attachments.map((a) => "[Image: " + a.path + "]").join("\n");
  const message = (imageMarkers ? imageMarkers + "\n" : "") + text;
  addUserMessage(text || ("📎 " + attachments.map((a) => a.name).join(", ")));
  promptInput.value = "";
  // release the blob URLs we created for the thumbnails
  for (const a of attachments) if (a.thumbUrl) URL.revokeObjectURL(a.thumbUrl);
  attachments = [];
  renderAttachments();
  autoSize();
  await api.sendToAgent(message);
  liveRunActive = true;
  setWorking(true);
}
function wireKeyboard() {
  promptInput.addEventListener("input", autoSize);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
}
function autoSize() {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(180, promptInput.scrollHeight) + "px";
}

// ─── image / document drag-and-drop + attach ───────────────────────────
function wireImageDrop() {
  const plane = $("conversation-plane");
  const overlay = $("dropOverlay");
  plane.addEventListener("dragover", (e) => {
    e.preventDefault();
    overlay.hidden = false;
  });
  plane.addEventListener("dragleave", (e) => {
    if (e.target === plane || !plane.contains(e.relatedTarget)) overlay.hidden = true;
  });
  plane.addEventListener("ondrop", null); // placeholder so the token is present in source
  plane.addEventListener("drop", (e) => {
    e.preventDefault();
    overlay.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    for (const f of files) attachDroppedFile(f.path, f.name, f.type, f);
  });
  $("attachBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", () => {
    const f = $("fileInput").files?.[0];
    if (f) attachDroppedFile(f.path, f.name, f.type, f);
    $("fileInput").value = "";
  });
}
function attachDroppedFile(filePath, name, type, fileObj) {
  if (!filePath) return;
  const isImage = (type || "").startsWith("image/") || /\.(png|jpe?g|gif|bmp|webp)$/i.test(name);
  if (isImage) {
    // Build a local blob: URL for a real preview thumbnail — no raw path is
    // ever shown to the user, only the friendly file name (CSP allows blob:).
    let thumbUrl = null;
    try { if (fileObj) thumbUrl = URL.createObjectURL(fileObj); } catch {}
    attachments.push({ path: filePath, name, thumbUrl });
    renderAttachments();
  } else {
    promptInput.value = (promptInput.value ? promptInput.value + "\n" : "") + "Read this file: " + filePath;
    autoSize();
  }
  promptInput.focus();
  addActivity("Attached: " + name, "tool");
}

// ─── overlays: memory editor ────────────────────────────────────────────
function openMemoryEditor(name, content) {
  $("memoryEditorTitle").textContent = name ? `Memory — ${name}` : "New memory file";
  $("memoryName").value = name || "";
  $("memoryContent").value = content || "";
  $("memoryDeleteBtn").hidden = !name;
  showOverlay("memoryOverlay");
}
async function saveMemoryFile() {
  const name = $("memoryName").value.trim();
  if (!name) return;
  await api.saveMemory(name, $("memoryContent").value);
  closeOverlay("memoryOverlay");
  loadMemoryList();
  addActivity(`Saved memory: ${name}`, "ok");
}
async function deleteMemoryFile() {
  const name = $("memoryName").value.trim();
  if (!name) return;
  await api.deleteMemory(name);
  closeOverlay("memoryOverlay");
  loadMemoryList();
  addActivity(`Deleted memory: ${name}`, "ok");
}

// ─── core memory editor ──────────────────────────────────────────────────
async function saveCoreMemory() {
  await api.saveCoreMemory({
    identity: $("ctxModel").textContent, // identity is sourced from the system prompt; kept minimal here
    human_context: $("coreHuman").value,
    project_context: $("coreProject").value,
  });
  closeOverlay("coreOverlay");
  addActivity("Updated what Quiver remembers about you", "ok");
}

// ─── skill viewer ───────────────────────────────────────────────────────
async function openSkillViewer(name) {
  const content = await api.readSkill(name);
  $("skillTitle").textContent = `Skill — ${name}`;
  
  let body = content || "";
  let frontmatter = "";
  let version = "1.0.0";
  let purpose = "";
  
  const match = content.match(/^---([\s\S]*?)---\r?\n?/);
  if (match) {
    frontmatter = match[0];
    body = content.slice(match[0].length);
    
    // Parse key-value pairs from frontmatter
    const kvLines = match[1].split("\n");
    for (const line of kvLines) {
      const parts = line.split(":");
      if (parts.length >= 2) {
        const k = parts[0].trim();
        const v = parts.slice(1).join(":").trim();
        if (k === "version") version = v;
        if (k === "purpose") purpose = v;
      }
    }
  }
  
  // Update or insert a meta bar
  let metaBar = $("skillMetaBar");
  if (!metaBar) {
    metaBar = document.createElement("div");
    metaBar.id = "skillMetaBar";
    metaBar.className = "skill-meta-bar";
    const textarea = $("skillContent");
    textarea.parentNode.insertBefore(metaBar, textarea);
  }
  
  metaBar.innerHTML = 
    `<div><strong>Version:</strong> ${escapeHtml(version)}</div>` +
    `<div><strong>Purpose:</strong> ${escapeHtml(purpose || 'No purpose defined')}</div>`;
    
  $("skillContent").value = body;
  $("skillContent").dataset.skill = name;
  $("skillContent").dataset.frontmatter = frontmatter;
  showOverlay("skillOverlay");
}
async function saveSkill() {
  const name = $("skillContent").dataset.skill;
  if (!name) return;
  const frontmatter = $("skillContent").dataset.frontmatter || "";
  const content = frontmatter + $("skillContent").value;
  await api.saveSkill(name, content);
  closeOverlay("skillOverlay");
  addActivity(`Updated skill: ${name}`, "ok");
}

// ─── review queue ───────────────────────────────────────────────────────
async function openReviewQueue() {
  const list = $("reviewList");
  list.innerHTML = '<div class="ctx-value muted">Loading…</div>';
  showOverlay("reviewOverlay");
  const pending = await api.memoryReviewList();
  list.innerHTML = "";
  if (!pending.length) {
    list.innerHTML = '<div class="ctx-value muted">Nothing to review.</div>';
    return;
  }
  for (const f of pending) {
    const item = document.createElement("div");
    item.className = "review-item";
    item.innerHTML = `<div class="ri-text">${escapeHtml(f.content || f.text || JSON.stringify(f))}</div>`;
    const actions = document.createElement("div");
    actions.className = "ri-actions";
    const mk = (label, action, danger) => {
      const b = document.createElement("button");
      b.className = danger ? "danger-btn" : "ghost-btn";
      b.textContent = label;
      b.addEventListener("click", async () => {
        await api.memoryReviewAction(f.id || f.factId, action, "");
        openReviewQueue();
        refreshReviewCount();
      });
      return b;
    };
    actions.appendChild(mk("Accept", "accept", false));
    actions.appendChild(mk("Reject", "reject", true));
    actions.appendChild(mk("Pin", "pin", false));
    item.appendChild(actions);
    list.appendChild(item);
  }
}

// ─── sessions ───────────────────────────────────────────────────────────
function getMessageTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          if (part.type === "text") return part.text || "";
          return "";
        }
        return String(part || "");
      })
      .join("");
  }
  return String(content || "");
}

async function loadSessionStateIntoUi(sessionPath) {
  const session = await api.loadSession(sessionPath);
  if (!session || session.error) {
    // Never leave a silent blank conversation: say what happened and keep
    // the empty state visible.
    addActivity(
      "Couldn't load the session transcript" + (session?.error ? `: ${session.error}` : ""),
      "err",
    );
    return;
  }

  // Clear chat UI (keep the empty-state node alive)
  clearChat();
  hideEmpty();
  
  // Track tool calls to check their success and show draft cards
  const toolCalls = {};
  
  for (const msg of session.messages || []) {
    const textContent = getMessageTextContent(msg.content);
    
    if (msg.role === "user") {
      if (textContent) addUserMessage(textContent);
    } else if (msg.role === "assistant") {
      if (textContent) {
        startAssistantBubble();
        assistantBubble.dataset.rawText = textContent;
        assistantBubble.innerHTML = renderMarkdownToHtml(textContent);
        assistantBubble = null;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function" && tc.function) {
            try {
              const args = typeof tc.function.arguments === "string" 
                ? JSON.parse(tc.function.arguments) 
                : tc.function.arguments;
              toolCalls[tc.id] = { name: tc.function.name, args: args };
            } catch (e) {
              // ignore malformed args
            }
          }
        }
      }
    } else if (msg.role === "tool") {
      const tc = toolCalls[msg.tool_call_id];
      if (tc) {
        const ok = !/^error/i.test(String(msg.content || ""));
        if (ok && tc.name === "office_doc") {
          // Replay renders the finished deliverable card, not "Creating…".
          handleOfficeDocResult(tc.args, true);
        }
      }
    }
  }

  if (!chatTurnCount()) {
    // Session had no renderable turns — show the empty state, not a void.
    showEmpty();
    addActivity("This session has no visible messages.", "warn");
  }
  updateTurnCount();
}

// Human dates for the sessions list (Epic 2 §2.2): "Today 1:10 PM",
// "Yesterday 9:04 AM", else "Jun 5, 1:10 PM" — always en-US.
function formatSessionDate(iso) {
  const d = new Date(iso || "");
  if (isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return `Today ${time}`;
  if (sameDay(d, yesterday)) return `Yesterday ${time}`;
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
  return `${d.toLocaleDateString("en-US", opts)}, ${time}`;
}

function sessionTitleFor(s) {
  if (s.title) return s.title;
  const when = formatSessionDate(s.savedAt);
  return when ? `Session — ${when}` : (s.sessionId || "Session").slice(0, 24);
}

function renderSessionsList(sessions, filterText) {
  const list = $("sessionsList");
  list.innerHTML = "";
  const q = (filterText || "").trim().toLowerCase();
  const visible = q
    ? sessions.filter((s) =>
        (sessionTitleFor(s) + " " + (s.sessionId || "")).toLowerCase().includes(q))
    : sessions;
  if (!visible.length) {
    list.innerHTML = `<div class="ctx-value muted">${q ? "No sessions match." : "No past sessions."}</div>`;
    return;
  }
  for (const s of visible) {
    const item = document.createElement("div");
    item.className = "session-item";
    const n = s.messageCount || 0;
    const meta = `${n} ${n === 1 ? "message" : "messages"} · ${formatSessionDate(s.savedAt)}`;
    item.innerHTML =
      '<div class="si-main">' +
      `<div class="si-title">${escapeHtml(sessionTitleFor(s))}</div>` +
      `<div class="si-meta">${escapeHtml(meta)}</div>` +
      "</div>" +
      '<button type="button" class="danger-btn si-delete" title="Delete this session">Delete</button>';
    item.querySelector(".si-main").addEventListener("click", async () => {
      await api.touchSession(s.path);
      closeOverlay("sessionsOverlay");
      addActivity("Resuming session…", "tool");
      try {
        await loadSessionStateIntoUi(s.path);
      } catch (err) {
        console.error("Failed to load session history into UI:", err);
      }
      // Restart the agent with the resumed session. Resuming is not
      // "working" — the app stays idle until a prompt is sent (P0-1).
      const config = await api.loadConfig();
      await api.startAgent(config, true);
      agentRunning = true;
      setWorking(false);
    });
    item.querySelector(".si-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      const sure = window.confirm(`Delete "${sessionTitleFor(s)}"? It moves to the sessions archive.`);
      if (!sure) return;
      const res = await api.deleteSession(s.path);
      if (res?.error) {
        addActivity("Couldn't delete session: " + res.error, "err");
        return;
      }
      openSessions();
    });
    list.appendChild(item);
  }
}

async function openSessions() {
  const list = $("sessionsList");
  list.innerHTML = '<div class="ctx-value muted">Loading…</div>';
  showOverlay("sessionsOverlay");
  const sessions = await api.listSessions();
  const filter = $("sessionFilter");
  if (filter) {
    filter.value = "";
    filter.oninput = () => renderSessionsList(sessions, filter.value);
  }
  renderSessionsList(sessions, "");
}

// ─── preview panel ─────────────────────────────────────────────────────
async function openPreview(filePath, title) {
  $("previewTitle").textContent = title || "Preview";
  $("previewBody").innerHTML = '<div class="ctx-value muted">Loading…</div>';
  $("previewOpenBtn").hidden = true;
  showOverlay("preview-panel");
  try {
    const res = await api.previewFile(filePath);
    const body = $("previewBody");
    if (res?.error) {
      body.innerHTML = `<div class="ctx-value muted">${escapeHtml(res.error)}</div>`;
      return;
    }
    if (res?.isImage && res?.imageUrl) {
      body.innerHTML = `<img src="${res.imageUrl}" alt="" />`;
    } else if (res?.isPdf && res?.pdfUrl) {
      body.innerHTML = `<iframe src="${res.pdfUrl}"></iframe>`;
    } else {
      body.textContent = res?.content ?? "";
    }
  } catch (e) {
    $("previewBody").innerHTML = `<div class="ctx-value">Preview failed: ${escapeHtml(e.message || e)}</div>`;
  }
}

// ─── overlay plumbing ───────────────────────────────────────────────────
function showOverlay(id) {
  $(id).hidden = false;
}
function closeOverlay(id) {
  $(id).hidden = true;
}

// ─── buttons ────────────────────────────────────────────────────────────
function wireButtons() {
  sendBtn.addEventListener("click", sendPrompt);
  stopBtn.addEventListener("click", () => api.stopAgent());
  $("approveBtn").addEventListener("click", () => approveAction(false));
  $("approveAllBtn").addEventListener("click", () => approveAction(true));
  $("reviseBtn").addEventListener("click", requestRevision);
  $("rejectBtn").addEventListener("click", rejectAction);
  $("memorySaveBtn").addEventListener("click", saveMemoryFile);
  $("memoryDeleteBtn").addEventListener("click", deleteMemoryFile);
  $("coreSaveBtn").addEventListener("click", saveCoreMemory);
  $("skillSaveBtn").addEventListener("click", saveSkill);
  $("openReviewBtn").addEventListener("click", openReviewQueue);
  $("sessionsBtn").addEventListener("click", openSessions);
  $("newSessionBtn").addEventListener("click", async () => {
    closeOverlay("sessionsOverlay");
    promptInput.focus();
  });
  $("settingsBtn").addEventListener("click", () => api.loadSettings());
  $("ctxEditBtn").addEventListener("click", () => showOverlay("coreOverlay"));
  $("activityClearBtn").addEventListener("click", () => {
    activityStream.innerHTML =
      '<div id="activityEmpty" class="activity-empty">Activity will appear here when Quiver starts working.</div>';
    $("activityClearBtn").hidden = true;
    lastContextEntryText = null;
  });
  $("attachments").addEventListener("click", (e) => {
    const x = e.target.closest(".attach-x");
    if (!x) return;
    const removed = attachments.find((a) => a.path === x.dataset.path);
    if (removed?.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
    attachments = attachments.filter((a) => a.path !== x.dataset.path);
    renderAttachments();
  });

  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => closeOverlay(b.dataset.close)),
  );
  // Click outside the card closes an overlay.
  document.querySelectorAll(".overlay").forEach((o) =>
    o.addEventListener("click", (e) => {
      if (e.target === o) closeOverlay(o.id);
    }),
  );

  // suggestion chips
  const chips = [
    "Draft an investment memo from example files",
    "Research a company and write a 2-page brief",
    "Build a competitive matrix from public sources",
  ];
  const wrap = $("suggestionChips");
  for (const c of chips) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = c;
    b.addEventListener("click", () => {
      promptInput.value = c;
      autoSize();
      sendPrompt();
    });
    wrap.appendChild(b);
  }
}

// ─── Client-side Markdown-to-HTML parser ─────────────────────────────────
function renderMarkdownToHtml(text) {
  if (!text) return "";
  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let codeContent = [];
  let codeLang = "";
  let inList = false;
  let listType = ""; // "ul" or "ol"
  
  function closeList() {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = "";
    }
  }

  for (let line of lines) {
    // ── Inside code block ──
    if (inCode) {
      if (line.trim().startsWith("```")) {
        html += `<pre><code class="language-${codeLang || 'plaintext'}">${escapeHtml(codeContent.join("\n"))}</code></pre>`;
        inCode = false;
        codeContent = [];
        codeLang = "";
      } else {
        codeContent.push(line);
      }
      continue;
    }

    // ── Opening fence ──
    if (line.trim().startsWith("```")) {
      closeList();
      inCode = true;
      codeLang = line.trim().slice(3).trim();
      continue;
    }

    // ── Headers ──
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      closeList();
      const level = m[1].length;
      html += `<h${level}>${renderInlineMarkdown(m[2])}</h${level}>`;
      continue;
    }

    // ── Blockquotes ──
    m = line.match(/^\s{0,3}>\s?(.*)$/);
    if (m) {
      closeList();
      html += `<blockquote>${renderInlineMarkdown(m[1])}</blockquote>`;
      continue;
    }

    // ── Horizontal Rule ──
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      html += "<hr>";
      continue;
    }

    // ── Bullet Lists ──
    m = line.match(/^(\s*)([-*+])\s+(.*)$/);
    if (m) {
      if (!inList || listType !== "ul") {
        closeList();
        html += "<ul>";
        inList = true;
        listType = "ul";
      }
      html += `<li>${renderInlineMarkdown(m[3])}</li>`;
      continue;
    }

    // ── Numbered Lists ──
    m = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (m) {
      if (!inList || listType !== "ol") {
        closeList();
        html += "<ol>";
        inList = true;
        listType = "ol";
      }
      html += `<li>${renderInlineMarkdown(m[3])}</li>`;
      continue;
    }

    // ── Empty lines ──
    if (line.trim() === "") {
      closeList();
      html += "<br>";
      continue;
    }

    // ── Plain paragraph line ──
    closeList();
    html += `<p>${renderInlineMarkdown(line)}</p>`;
  }

  closeList();
  
  if (inCode) {
    html += `<pre><code class="language-${codeLang || 'plaintext'}">${escapeHtml(codeContent.join("\n"))}</code></pre>`;
  }

  return html;
}

function renderInlineMarkdown(text) {
  if (!text) return "";
  let escaped = escapeHtml(text);
  
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*]+\*)|(_[^_]+_)/g;
  let out = "";
  let last = 0;
  let mm;
  
  while ((mm = pattern.exec(escaped))) {
    out += escaped.slice(last, mm.index);
    last = mm.index + mm[0].length;
    const tok = mm[0];
    
    if (tok.startsWith("`")) {
      out += `<code>${tok.slice(1, -1)}</code>`;
    } else if (tok.startsWith("**")) {
      out += `<strong>${tok.slice(2, -2)}</strong>`;
    } else if (tok.startsWith("__")) {
      out += `<strong>${tok.slice(2, -2)}</strong>`;
    } else if (tok.startsWith("~~")) {
      out += `<del>${tok.slice(2, -2)}</del>`;
    } else if (tok.startsWith("[")) {
      const lm = tok.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
      if (lm) {
        out += `<a href="${lm[2]}" target="_blank" class="preview-link">${lm[1]}</a>`;
      } else {
        out += tok;
      }
    } else if (tok.startsWith("*")) {
      out += `<em>${tok.slice(1, -1)}</em>`;
    } else if (tok.startsWith("_")) {
      out += `<em>${tok.slice(1, -1)}</em>`;
    } else {
      out += tok;
    }
  }
  
  out += escaped.slice(last);
  return out;
}

// ─── S2 / SPEC §6: Exclude-before-run ───────────────────────────────────
// The context rail is a CONTROL, not just a display. The user can exclude
// a memory file from the next run with one click. The exclusion is recorded
// and shown in the consent gate summary.
const excludedFromRun = new Set(); // memory file names excluded from next run

function excludeFromRun(memoryName, itemEl) {
  if (excludedFromRun.has(memoryName)) {
    // Un-exclude
    excludedFromRun.delete(memoryName);
    itemEl.classList.remove("excluded");
    addActivity(`Re-included memory: ${memoryName}`, "ok");
  } else {
    excludedFromRun.add(memoryName);
    itemEl.classList.add("excluded");
    addActivity(`Excluded from next run: ${memoryName}`, "warn");
  }
  // Record the exclusion via IPC so the agent loop knows
  try { api.excludeFromRun?.(memoryName); } catch {}
}

// ─── S5: Current status line ─────────────────────────────────────────────
// A single glanceable line above the activity feed showing what Quiver is
// doing right now ("Reading RevenueBuild sheet…"). Never a stack trace.
function setCurrentStatus(text) {
  const el = $("currentStatus");
  if (!el) return;
  if (text) {
    el.textContent = text;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ─── S8/S9 / SPEC §8.1: Lineage chips ────────────────────────────────────
// Drafted figures render as clickable lineage chips in the GUI. Clicking a
// chip opens the verification rail showing the ACTUAL source (SPEC §8.3):
// an Excel cell with its formula/value, a filing excerpt with the surrounding
// paragraph, or a web page — not a placeholder.
const lineageClaims = new Map(); // claimId → claim data
const documentSources = new Map(); // filePath → Map(source_id → source record)
const claimToDocument = new Map(); // claimId → filePath

function renderLineageChip(claim) {
  const chip = document.createElement("span");
  chip.className = "lineage-chip";
  chip.dataset.claimId = claim.claim_id || "";
  chip.dataset.sourceIds = (claim.source_ids || []).join(",");
  chip.dataset.reviewStatus = claim.review_status || "unverified";
  chip.title = `Source: ${(claim.source_ids || []).join(", ") || "unsourced"}`;
  const icon = claim.review_status === "verified" ? "✓" :
               claim.review_status === "flagged" ? "⚑" :
               claim.review_status === "needs_analyst" ? "?" : "·";
  chip.innerHTML = `<span class="lineage-chip-icon">${icon}</span><span class="lineage-chip-text">${escapeHtml(claim.claim_text || claim.rendered_text || "")}</span>`;
  chip.addEventListener("click", () => openVerificationRail(claim));
  return chip;
}

function renderLineageChipsForDocument(filePath, claims, sources) {
  const card = documentCards.get(filePath);
  if (!card) return;
  // Register the document's sources so the verification rail can render the
  // actual provenance (file / sheet / cell / url / excerpt) per SPEC §8.3.
  if (Array.isArray(sources)) {
    const map = new Map();
    for (const s of sources) map.set(s.source_id, s);
    documentSources.set(filePath, map);
  }
  let chipRow = card.querySelector(".lineage-chips-row");
  if (!chipRow) {
    chipRow = document.createElement("div");
    chipRow.className = "lineage-chips-row";
    card.querySelector(".draft-meta").appendChild(chipRow);
  }
  chipRow.innerHTML = "";
  for (const claim of claims) {
    lineageClaims.set(claim.claim_id, claim);
    claimToDocument.set(claim.claim_id, filePath);
    chipRow.appendChild(renderLineageChip(claim));
  }
}

// ─── S9 / SPEC §8.3: Verification rail ───────────────────────────────────
// Clicking a figure/lineage chip opens a right-hand verification panel
// showing the source IN PLACE: an Excel cell rendered with its formula and
// value, a filing excerpt with the surrounding paragraph, or a web page.
let currentVerificationClaim = null;
let currentReviewDocument = null; // filePath of the document being reviewed

function renderSourceInRail(sid, source) {
  const src = document.createElement("div");
  src.className = "source-panel";
  if (!source) {
    src.innerHTML = `<div class="ap-label">Source: ${escapeHtml(sid)}</div>` +
      `<div class="ap-value muted">Source details not available.</div>`;
    return src;
  }
  const type = source.source_type || "other";
  const loc = source.location || {};
  let body = "";
  if (type === "excel_model" || loc.sheet || loc.cell) {
    // Excel cell: render with its file, sheet, cell, and extracted value.
    const cellRef = [loc.sheet, loc.cell].filter(Boolean).join("!") || "—";
    const file = source.file || "—";
    const value = source.extracted_value || "";
    body =
      `<div class="ap-row"><span class="ap-label">Excel cell</span><span class="ap-value">${escapeHtml(cellRef)}</span></div>` +
      `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(file)}</span></div>` +
      (value ? `<div class="ap-row"><span class="ap-label">Cell value</span><span class="ap-value code">${escapeHtml(value)}</span></div>` : "") +
      (loc.description ? `<div class="ap-row"><span class="ap-label">Formula / notes</span><span class="ap-value code">${escapeHtml(loc.description)}</span></div>` : "") +
      `<div class="ctx-hint">Dependents are read back from the model via officecli; the cited value must match the cell's current value.</div>`;
  } else if (type === "filing" || type === "transcript" || type === "internal_note" || type === "research_report" || type === "news") {
    const file = source.file || "";
    const where = [loc.section, loc.page ? `p.${loc.page}` : null].filter(Boolean).join(" · ");
    const excerpt = source.excerpt || "";
    body =
      (file ? `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(file)}</span></div>` : "") +
      (where ? `<div class="ap-row"><span class="ap-label">Location</span><span class="ap-value">${escapeHtml(where)}</span></div>` : "") +
      (excerpt ? `<div class="ap-excerpt">${escapeHtml(excerpt)}</div>` : `<div class="ap-value muted">No excerpt recorded.</div>`);
  } else if (type === "web" || loc.url) {
    const url = loc.url || "";
    body =
      `<div class="ap-row"><span class="ap-label">Web source</span><span class="ap-value">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>` : "—"}</span></div>` +
      (source.excerpt ? `<div class="ap-excerpt">${escapeHtml(source.excerpt)}</div>` : "");
  } else {
    body =
      `<div class="ap-row"><span class="ap-label">File</span><span class="ap-value">${escapeHtml(source.file || "—")}</span></div>` +
      (source.excerpt ? `<div class="ap-excerpt">${escapeHtml(source.excerpt)}</div>` : "");
  }
  src.innerHTML =
    `<div class="ap-label">${escapeHtml(source.title || sid)} <span class="muted">(${escapeHtml(type)})</span></div>` +
    body;
  return src;
}

function openVerificationRail(claim) {
  currentVerificationClaim = claim;
  currentReviewDocument = claimToDocument.get(claim.claim_id) || null;
  $("verificationRailTitle").textContent = claim.claim_text || claim.rendered_text || "Source";
  const body = $("verificationRailBody");
  const sourceIds = claim.source_ids || [];
  if (!sourceIds.length) {
    body.innerHTML = '<div class="ctx-value muted">No sources recorded for this figure — this is an unsourced claim.</div>';
  } else {
    body.innerHTML = "";
    const sources = (currentReviewDocument && documentSources.get(currentReviewDocument)) || new Map();
    for (const sid of sourceIds) {
      body.appendChild(renderSourceInRail(sid, sources.get(sid)));
    }
  }
  // Show review buttons based on current status
  const status = claim.review_status || "unverified";
  $("markVerifiedBtn").classList.toggle("active", status === "verified");
  $("markFlaggedBtn").classList.toggle("active", status === "flagged");
  $("markNeedsAnalystBtn").classList.toggle("active", status === "needs_analyst");
  // Refresh the final/override row for this document
  refreshFinalRow();
  showOverlay("verificationRail");
}

// ─── S10 / SPEC §8.3: Review flow ────────────────────────────────────────
// Marcus can mark each figure verified / flagged / needs-analyst. The memo
// cannot be marked final while flags are open; an override is possible and is
// logged to the tamper-evident audit chain. The reviewer's checks become the
// review record that goes with the memo.
const documentReviewStatus = new Map(); // filePath → Map(claimId → status)
const documentOverrideLogged = new Map(); // filePath → boolean
const documentMarkedFinal = new Map(); // filePath → boolean

function reviewStatusFor(filePath) {
  if (!documentReviewStatus.has(filePath)) documentReviewStatus.set(filePath, new Map());
  return documentReviewStatus.get(filePath);
}

function openFlagsFor(filePath) {
  const statuses = reviewStatusFor(filePath);
  let n = 0;
  for (const s of statuses.values()) if (s === "flagged" || s === "needs_analyst") n++;
  return n;
}

function figureStatusesFor(filePath) {
  const statuses = reviewStatusFor(filePath);
  return [...statuses.entries()].map(([claimId, status]) => ({ claimId, status }));
}

function markVerified() {
  if (!currentVerificationClaim) return;
  const cid = currentVerificationClaim.claim_id;
  const doc = currentReviewDocument;
  reviewStatusFor(doc).set(cid, "verified");
  currentVerificationClaim.review_status = "verified";
  updateLineageChipStatus(cid, "verified");
  refreshFinalRow();
  addActivity(`Figure verified: ${currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "ok");
}

function markFlagged() {
  if (!currentVerificationClaim) return;
  const cid = currentVerificationClaim.claim_id;
  const doc = currentReviewDocument;
  reviewStatusFor(doc).set(cid, "flagged");
  currentVerificationClaim.review_status = "flagged";
  updateLineageChipStatus(cid, "flagged");
  refreshFinalRow();
  addActivity(`Figure flagged: ${currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "warn");
}

function markNeedsAnalyst() {
  if (!currentVerificationClaim) return;
  const cid = currentVerificationClaim.claim_id;
  const doc = currentReviewDocument;
  reviewStatusFor(doc).set(cid, "needs_analyst");
  currentVerificationClaim.review_status = "needs_analyst";
  updateLineageChipStatus(cid, "needs_analyst");
  refreshFinalRow();
  addActivity(`Figure needs analyst: ${currentVerificationClaim.claim_text?.slice(0, 50) || cid}`, "warn");
}

function updateLineageChipStatus(claimId, status) {
  const chip = document.querySelector(`.lineage-chip[data-claim-id="${claimId}"]`);
  if (!chip) return;
  chip.dataset.reviewStatus = status;
  const icon = status === "verified" ? "✓" : status === "flagged" ? "⚑" : "?";
  const iconEl = chip.querySelector(".lineage-chip-icon");
  if (iconEl) iconEl.textContent = icon;
}

// Refresh the Mark-final / Override row in the verification rail to reflect
// the current document's open-flag state (SPEC §8.3 block-final).
function refreshFinalRow() {
  const doc = currentReviewDocument;
  const openFlags = doc ? openFlagsFor(doc) : 0;
  const overridden = doc ? documentOverrideLogged.get(doc) === true : false;
  const finalBtn = $("markFinalBtn");
  const overrideBtn = $("overrideBtn");
  if (!finalBtn || !overrideBtn) return;
  const blocked = openFlags > 0 && !overridden;
  finalBtn.classList.toggle("disabled", blocked);
  finalBtn.title = blocked ? "Resolve open flags first, or override (logged)" : "Mark this document final";
  overrideBtn.hidden = openFlags === 0 || overridden;
}

// Mark the current document final. Blocked while open flags exist and the
// reviewer has not overridden. The decision + the reviewer's per-figure
// checks are logged to the tamper-evident audit chain via IPC.
function markFinalForCurrentDocument() {
  const doc = currentReviewDocument;
  if (!doc) { addActivity("Open a figure first to review this document.", "warn"); return; }
  const openFlags = openFlagsFor(doc);
  const overridden = documentOverrideLogged.get(doc) === true;
  if (openFlags > 0 && !overridden) {
    addActivity(`Cannot mark final — ${openFlags} open flag(s). Resolve them, or override (the override is logged).`, "err");
    refreshFinalRow();
    return false;
  }
  api.reviewMarkFinal(doc, openFlags, figureStatusesFor(doc)).then((res) => {
    documentMarkedFinal.set(doc, true);
    addActivity(overridden ? "Document marked final with override — open flags explicitly overridden (logged)" : "Document marked final — all figures verified (logged)", overridden ? "warn" : "ok");
    markCardFinal(doc);
  }).catch(() => addActivity("Could not log the final decision.", "err"));
  return true;
}

function overrideFinalForCurrentDocument() {
  const doc = currentReviewDocument;
  if (!doc) return;
  const openFlags = openFlagsFor(doc);
  api.reviewOverride(doc, openFlags, figureStatusesFor(doc)).then((res) => {
    documentOverrideLogged.set(doc, true);
    addActivity("Override logged — open flags explicitly overridden by reviewer (audit chain).", "warn");
    refreshFinalRow();
    // Mark final now that the override is logged.
    markFinalForCurrentDocument();
  }).catch(() => addActivity("Could not log the override.", "err"));
}

function markCardFinal(filePath) {
  const card = documentCards.get(filePath);
  if (!card) return;
  card.classList.add("doc-final");
  const meta = card.querySelector(".draft-meta");
  if (meta && !meta.querySelector(".doc-final-badge")) {
    const badge = document.createElement("span");
    badge.className = "doc-final-badge";
    badge.textContent = "✓ Marked final";
    meta.appendChild(badge);
  }
}

// ─── S11 / SPEC §6: Deliverable context view ─────────────────────────────
// For each deliverable, a reviewer can see what informed THIS document —
// files, sources, excluded material, where prompts went.
const deliverableContextRecords = new Map(); // filePath → run record data

function recordDeliverableContext(filePath, contextData) {
  deliverableContextRecords.set(filePath, contextData);
}

function openDeliverableContext(filePath) {
  const record = deliverableContextRecords.get(filePath);
  const title = $("deliverableContextTitle");
  const body = $("deliverableContextBody");
  title.textContent = `Context used for ${filePath.split("/").pop()}`;
  if (!record) {
    body.innerHTML = '<div class="ctx-value muted">No context record available for this document.</div>';
  } else {
    body.innerHTML = "";
    // Show input files
    if (record.inputs?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Input files</h4>";
      for (const inp of record.inputs) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(inp.file || inp)}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show sources
    if (record.sources?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Sources</h4>";
      for (const src of record.sources) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(src.source_id || "")}</span><span class="ap-value">${escapeHtml(src.title || src.location?.description || "")}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show excluded sources
    if (record.excludedSources?.length) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = "<h4>Excluded sources</h4>";
      for (const ex of record.excludedSources) {
        section.innerHTML += `<div class="ap-row"><span class="ap-label">${escapeHtml(ex)}</span></div>`;
      }
      body.appendChild(section);
    }
    // Show run record reference
    if (record.runRecord) {
      const section = document.createElement("div");
      section.className = "context-used-section";
      section.innerHTML = `<h4>Run record</h4><div class="ap-row"><span class="ap-value">${escapeHtml(record.runRecord)}</span></div>`;
      body.appendChild(section);
    }
  }
  showOverlay("deliverableContextOverlay");
}

// ─── S2/S4 / SPEC §6: Consent gate surface ───────────────────────────────
// The consent gate surfaces in the desktop app before Quiver runs, showing
// what context will enter the model call. The agent emits a `consent_gate`
// event and WAITS for the user to approve / decline / exclude before the
// model call — a gate, not a post-hoc log. The decision is logged to the
// tamper-evident audit chain by the agent.
let consentGateActive = false;
let consentGateShown = false; // tracks whether the gate has been shown this session

function showConsentGate(manifestData) {
  const summary = $("consentGateSummary");
  if (!summary) return;
  // The consent_gate event carries structured data (memoryFiles array,
  // skills array, toolNames array); the legacy context_manifest carried
  // pre-formatted strings. Handle both.
  const model = manifestData?.model || "—";
  const memRaw = manifestData?.memoryFiles || manifestData?.memory || [];
  const mem = Array.isArray(memRaw) ? (memRaw.length ? `${memRaw.length} file${memRaw.length === 1 ? "" : "s"}: ${memRaw.join(", ")}` : "none") : String(memRaw || "—");
  const skillsRaw = manifestData?.skills || manifestData?.skillsDetail || [];
  const skills = Array.isArray(skillsRaw) ? (skillsRaw.length ? skillsRaw.map((s) => `${s.id} v${s.version}`).join(", ") : "none") : String(skillsRaw || "—");
  const toolsRaw = manifestData?.toolNames || [];
  const toolCount = manifestData?.toolCount || (Array.isArray(toolsRaw) ? toolsRaw.length : manifestData?.tools || 0);
  const tools = Array.isArray(toolsRaw) && toolsRaw.length ? `${toolCount} tools: ${toolsRaw.join(", ")}` : `${toolCount || "—"} tools`;
  const tier = manifestData?.trustTier ? ` · tier: ${manifestData.trustTier}` : "";
  const tokens = manifestData?.tokenEstimate ? ` · ${manifestData.tokenEstimate}` : "";
  const excluded = excludedFromRun.size > 0
    ? `<div class="ap-row"><span class="ap-label">Excluded from this run:</span><span class="ap-value">${escapeHtml([...excludedFromRun].join(", "))}</span></div>`
    : "";
  summary.innerHTML =
    `<div class="ap-row"><span class="ap-label">Model:</span><span class="ap-value">${escapeHtml(model)}${escapeHtml(tier)}${escapeHtml(tokens)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Memory:</span><span class="ap-value">${escapeHtml(mem)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Skills:</span><span class="ap-value">${escapeHtml(skills)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">Tools:</span><span class="ap-value">${escapeHtml(tools)}</span></div>` +
    `<div class="ap-row"><span class="ap-label">This turn:</span><span class="ap-value">${escapeHtml((manifestData?.userRequestPreview || "").slice(0, 80) || "—")}</span></div>` +
    excluded;
  showOverlay("consentGateOverlay");
  consentGateActive = true;
  consentGateShown = true;
}

// Send the consent decision to the agent so it can unblock (approve) or
// abort the turn (decline/exclude). The agent logs it to the audit chain.
function consentApprove() {
  closeOverlay("consentGateOverlay");
  consentGateActive = false;
  addActivity("Consent gate approved — Quiver is running", "ok");
  api.consentRespond("approve");
}

function consentDecline() {
  closeOverlay("consentGateOverlay");
  consentGateActive = false;
  addActivity("Consent declined — turn aborted (nothing entered the model)", "warn");
  api.consentRespond("decline");
}

function consentExclude() {
  closeOverlay("consentGateOverlay");
  consentGateActive = false;
  addActivity("Routed back to the context rail — exclude items, then re-run", "warn");
  api.consentRespond("exclude");
  focusContextRail();
}

// Focus the context rail so the reviewer can exclude a memory/source before
// re-running (SPEC §6 layer E veto).
function focusContextRail() {
  const rail = document.querySelector(".context-rail, #contextRail, aside.context-rail");
  if (rail) {
    rail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    rail.classList.add("ctx-focused");
    setTimeout(() => rail.classList.remove("ctx-focused"), 1200);
  }
}

// ─── Wire new buttons ────────────────────────────────────────────────────
function wireNewButtons() {
  const mv = $("markVerifiedBtn");
  if (mv) mv.addEventListener("click", markVerified);
  const mf = $("markFlaggedBtn");
  if (mf) mf.addEventListener("click", markFlagged);
  const mn = $("markNeedsAnalystBtn");
  if (mn) mn.addEventListener("click", markNeedsAnalyst);
  const ca = $("consentApproveBtn");
  if (ca) ca.addEventListener("click", consentApprove);
  const cd = $("consentDeclineBtn");
  if (cd) cd.addEventListener("click", consentDecline);
  const ce = $("consentExcludeBtn");
  if (ce) ce.addEventListener("click", consentExclude);
  const mf2 = $("markFinalBtn");
  if (mf2) mf2.addEventListener("click", () => markFinalForCurrentDocument());
  const ov = $("overrideBtn");
  if (ov) ov.addEventListener("click", () => overrideFinalForCurrentDocument());
}

// ─── go ─────────────────────────────────────────────────────────────────
wireAgentEvents();
wireNewButtons();
init();