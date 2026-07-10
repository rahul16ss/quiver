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
let attachments = [];   // "allow all similar" requested
let activeDraftCard = null; // reference to the active document draft card

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
  await api.startAgent(config, false);
  agentRunning = true;
  setWorking(true);
  loadContextSurfaces(config);
}

// ─── context plane: what Quiver sees ───────────────────────────────────
async function loadContextSurfaces(config) {
  if (config?.provider?.modelName) setModel(config.provider.modelName);
  
  // Dynamically update trust level badge
  const grants = config?.autonomyGrants || "";
  let label = "Ask before acting";
  if (grants.includes("yolo")) {
    label = "Full auto (YOLO)";
  } else if (grants.includes("tier:operate")) {
    label = "High Autonomy";
  } else if (grants.includes("tier:build")) {
    label = "Semi-Autonomous";
  } else if (grants.includes("tier:propose")) {
    label = "Propose changes";
  } else if (grants.includes("tier:observe")) {
    label = "Read-only";
  }
  const badge = $("trustBadge");
  if (badge) badge.textContent = label;

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
      list.innerHTML = '<div class="ctx-value muted">No memory files yet</div>';
      return;
    }
    for (const f of files) {
      const item = document.createElement("div");
      item.className = "ctx-item";
      item.title = f.name;
      item.innerHTML =
        escapeHtml(f.name) +
        '<span class="ctx-sub"> · ' +
        Math.max(1, (f.content || "").split("\n").length) +
        " lines</span>";
      item.addEventListener("click", () => openMemoryEditor(f.name, f.content));
      list.appendChild(item);
    }
  } catch {
    list.innerHTML = '<div class="ctx-value muted">Unable to load</div>';
  }
}

async function loadSkillList() {
  const list = $("ctxSkillsList");
  const count = $("ctxSkillCount");
  try {
    const allSkills = await api.listSkills();
    const skills = (allSkills || []).filter(s => s !== "system-prompt");
    count.textContent = skills.length ? `· ${skills.length}` : "";
    list.innerHTML = "";
    if (!skills.length) {
      list.innerHTML = '<div class="ctx-value muted">No skills</div>';
      return;
    }
    for (const s of skills) {
      const item = document.createElement("div");
      item.className = "ctx-item";
      item.textContent = s;
      item.addEventListener("click", () => openSkillViewer(s));
      list.appendChild(item);
    }
  } catch {
    list.innerHTML = '<div class="ctx-value muted">Unable to load</div>';
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
function scrollChat() {
  chatArea.scrollTop = chatArea.scrollHeight;
}

function addDraftCard(label, sub, filePath) {
  hideEmpty();
  const card = document.createElement("div");
  card.className = "draft-card";
  card.innerHTML =
    '<div class="draft-icon">📄</div>' +
    '<div class="draft-meta"><div class="draft-title">' +
    escapeHtml(label) +
    '</div><div class="draft-sub">' +
    escapeHtml(sub) +
    "</div></div>";
  card.addEventListener("click", () => openPreview(filePath, label));
  chatArea.appendChild(card);
  scrollChat();
  activeDraftCard = card;
  return card;
}

// ─── activity plane: what Quiver is doing ──────────────────────────────
function addActivity(text, kind = "") {
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
    case "context_manifest": {
      if (ev.data?.model) setModel(ev.data.model);
      if (ev.data?.tokens) updateTokenBar(ev.data.tokens);
      addActivity(
        `Context loaded: ${ev.data?.memory || "—"} memory · ${ev.data?.skills || "—"} skills · ${ev.data?.tools || "—"} tools`,
        "tool",
      );
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
      addActivity(`Quiver wants to: ${plainToolName(name)}${hint ? " — " + hint : ""}`, "tool");
      maybeDraftCard(name, ev.data?.toolArgs);
      break;
    }
    case "tool_result": {
      const name = ev.data?.toolName || "tool";
      const ok = !/^error/i.test(String(ev.data?.toolResult || ""));
      addActivity(`${plainToolName(name)} ${ok ? "done" : "failed"}`, ok ? "ok" : "err");
      if (name === "office_doc" && activeDraftCard) {
        const typeLabel = activeDraftCard.dataset.typeLabel || "Document";
        const titleEl = activeDraftCard.querySelector(".draft-title");
        if (ok) {
          if (titleEl) titleEl.textContent = `${typeLabel} ready`;
        } else {
          if (titleEl) {
            titleEl.textContent = "Creation canceled";
            activeDraftCard.classList.add("canceled");
          }
        }
        activeDraftCard = null;
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
      setWorking(false);
      statusDot.className = "status-dot ok";
      addActivity("Done", "ok");
      refreshReviewCount();
      assistantBubble = null;
      break;
    }
    case "error": {
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
    diffLine(view, " ", "(nothing to preview)", "ctx");
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
  for (const k of ["filePath", "url", "command", "query", "directoryPath", "filename"]) {
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
  if (toolName === "office_doc" && args?.filePath) {
    const fp = String(args.filePath);
    const ext = fp.split(".").pop().toLowerCase();
    const typeLabel =
      ext === "xlsx" ? "Spreadsheet" :
      ext === "pptx" ? "Presentation" :
      "Document";
    addDraftCard(`Creating ${typeLabel.toLowerCase()}...`, fp, fp);
    if (activeDraftCard) {
      activeDraftCard.dataset.typeLabel = typeLabel;
    }
  }
}

// ─── approval gate ─────────────────────────────────────────────────────
function showApproval(data) {
  pendingApproval = data;
  pendingApprovalAll = false;
  const name = data?.toolName || "act";
  $("approvalTitle").textContent = "Quiver wants to " + verbForApproval(name);
  $("approvalSummary").textContent = summarizeArgs(data?.toolArgs) || "";
  $("approvalSummary").title = JSON.stringify(data?.toolArgs || {});

  // Compute the proposed content for a real diff.
  const args = data?.toolArgs || {};
  let before = data?.currentContent ?? "";
  let after = data?.proposedContent ?? "";
  if (!after && name === "write_file") after = args.content ?? "";
  if (!after && name === "replace_content") {
    after = String(before).split(args.targetContent ?? "").join(args.replacementContent ?? "");
  }
  if (name === "apply_patch") {
    after = args.patch ? "(unified patch — see below)" : "";
    renderPatchPreview(args.patch);
  } else {
    renderDiff(before, after);
  }
  $("revisionBox").hidden = true;
  $("revisionNote").value = "";
  showOverlay("approvalOverlay");
  setWorking(false);
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
function updateTokenBar(tokenStr) {
  // tokenStr like "12,345 / 120,000"
  const m = /([\d.,]+)\s*\/\s*([\d.,]+)/.exec(tokenStr || "");
  if (!m) return;
  const used = parseFloat(m[1].replace(/[.,]/g, ""));
  const total = parseFloat(m[2].replace(/[.,]/g, ""));
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const bar = $("ctxTokenBar");
  bar.style.width = pct + "%";
  bar.style.background = pct > 85 ? "var(--bad)" : pct > 60 ? "var(--warn)" : "var(--accent)";
  $("ctxTokenLabel").textContent = tokenStr + ` (${Math.round(pct)}%)`;
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
  if (!session) return;
  
  // Clear chat UI
  chatArea.innerHTML = "";
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
        if (ok) {
          maybeDraftCard(tc.name, tc.args);
        }
      }
    }
  }
}

async function openSessions() {
  const list = $("sessionsList");
  list.innerHTML = '<div class="ctx-value muted">Loading…</div>';
  showOverlay("sessionsOverlay");
  const sessions = await api.listSessions();
  list.innerHTML = "";
  if (!sessions.length) {
    list.innerHTML = '<div class="ctx-value muted">No past sessions.</div>';
    return;
  }
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item";
    item.innerHTML =
      `<div class="si-title">${escapeHtml((s.sessionId || "").slice(0, 24))}</div>` +
      `<div class="si-meta">${s.messageCount || 0} messages · ${(s.savedAt || "").slice(0, 19)}</div>`;
    item.addEventListener("click", async () => {
      await api.touchSession(s.path);
      closeOverlay("sessionsOverlay");
      addActivity("Resuming session…", "tool");
      
      try {
        await loadSessionStateIntoUi(s.path);
      } catch (err) {
        console.error("Failed to load session history into UI:", err);
      }
      
      // Restart the agent with the resumed session.
      const config = await api.loadConfig();
      await api.startAgent(config, true);
      setWorking(true);
    });
    list.appendChild(item);
  }
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
  $("activityClearBtn").addEventListener("click", () => (activityStream.innerHTML = ""));
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
    "Research a company and write a 2-page brief",
    "Build a competitive matrix from public sources",
    "Draft a due-diligence checklist",
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


// ─── go ─────────────────────────────────────────────────────────────────
wireAgentEvents();
init();