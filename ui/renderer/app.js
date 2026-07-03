const chatArea = document.getElementById("chatArea");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDot = document.getElementById("statusDot");
const emptyState = document.getElementById("emptyState");
const activeSessionTitle = document.getElementById("activeSessionTitle");
const contextPanel = document.getElementById("contextSidebar");
const contextBtn = document.getElementById("contextBtn");

let agentRunning = false;
let contextVisible = false;

// ── Context transparency ─────────────────────────────────────────────

function toggleContext() {
  contextVisible = !contextVisible;
  contextPanel.style.display = contextVisible ? "flex" : "none";
  contextBtn.classList.toggle("active", contextVisible);
  if (contextVisible) loadContextData();
}

function updateContext(data) {
  if (data.model) document.getElementById("ctxModel").textContent = data.model;
  if (data.tools !== undefined) document.getElementById("ctxTools").textContent = data.tools || "—";
  if (data.tokens) {
    document.getElementById("ctxTokens").textContent = data.tokens;
    // Parse "12,345 / 120,000" format and show a progress bar
    const parts = data.tokens.split("/");
    if (parts.length === 2) {
      const used = parseInt(parts[0].replace(/[^0-9]/g, ""), 10);
      const max = parseInt(parts[1].replace(/[^0-9]/g, ""), 10);
      if (max > 0) {
        const pct = Math.min(100, (used / max) * 100);
        const bar = document.getElementById("ctxTokenBar");
        const label = document.getElementById("ctxTokenBarLabel");
        const wrap = document.getElementById("ctxTokenBarWrap");
        bar.style.width = pct + "%";
        bar.className = "ctx-token-bar" + (pct > 85 ? " danger" : pct > 65 ? " warning" : "");
        label.textContent = Math.round(pct) + "% of context window";
        wrap.style.display = "block";
      }
    }
  }
}

async function loadContextData() {
  try {
    const core = await window.quiver.loadCoreMemory();
    document.getElementById("ctxIdentity").value = core.identity || "";
    document.getElementById("ctxHuman").value = core.human_context || "";
    document.getElementById("ctxProject").value = core.project_context || "";
  } catch {}

  try {
    const files = await window.quiver.listMemory();
    const list = document.getElementById("ctxMemList");
    if (!files || files.length === 0) {
      list.innerHTML = '<div class="ctx-loading">No memory files</div>';
    } else {
      list.innerHTML = "";
      for (const f of files) {
        const item = document.createElement("div");
        item.className = "ctx-mem-item";
        item.style.cursor = "pointer";
        item.onclick = () => openMemoryEditor(f.name, f.content);
        const preview = f.content.substring(0, 200).replace(/\n/g, " ");
        item.innerHTML = '<div class="ctx-mem-item-name">' + f.name + '</div>' +
          '<div class="ctx-mem-item-meta">' + f.size + ' bytes</div>' +
          '<div class="ctx-mem-item-preview">' + escapeHtml(preview) + (f.content.length > 200 ? '\u2026' : '') + '</div>';
        list.appendChild(item);
      }
    }
  } catch { document.getElementById("ctxMemList").innerHTML = '<div class="ctx-loading">Unable to load</div>'; }

  try {
    const skills = await window.quiver.listSkills();
    const list = document.getElementById("ctxSkillsList");
    if (!skills || skills.length === 0) {
      list.innerHTML = '<div class="ctx-loading">No skills</div>';
    } else {
      list.innerHTML = "";
      for (const s of skills) {
        const item = document.createElement("div");
        item.className = "ctx-skill-item";
        item.style.cursor = "pointer";
        item.onclick = () => openSkillViewer(s);
        item.textContent = s;
        list.appendChild(item);
      }
    }
  } catch { document.getElementById("ctxSkillsList").innerHTML = '<div class="ctx-loading">Unable to load</div>'; }
}

async function saveCoreMemory() {
  try {
    await window.quiver.saveCoreMemory({
      identity: document.getElementById("ctxIdentity").value.trim(),
      human_context: document.getElementById("ctxHuman").value.trim(),
      project_context: document.getElementById("ctxProject").value.trim(),
    });
  } catch {}
}

// ── Memory file editor ────────────────────────────────────────────────

let editingMemName = "";

function openMemoryEditor(name, content) {
  editingMemName = name || "";
  document.getElementById("memEditorTitle").textContent = name ? "Edit " + name : "New Memory File";
  document.getElementById("memEditorName").value = name || "";
  document.getElementById("memEditorContent").value = content || "";
  document.getElementById("memDeleteBtn").style.display = name ? "inline-block" : "none";
  document.getElementById("memEditorOverlay").style.display = "flex";
}

function closeMemoryEditor(event) {
  if (event && event.target !== document.getElementById("memEditorOverlay")) return;
  document.getElementById("memEditorOverlay").style.display = "none";
}

async function saveMemoryFile() {
  const name = document.getElementById("memEditorName").value.trim();
  const content = document.getElementById("memEditorContent").value;
  if (!name) { alert("Please enter a filename"); return; }
  try {
    await window.quiver.saveMemory(name, content);
    closeMemoryEditor();
    loadContextData();
  } catch (e) { alert("Failed to save: " + (e.message || e)); }
}

async function deleteMemoryFile() {
  const name = document.getElementById("memEditorName").value.trim();
  if (!name || !confirm("Delete " + name + "?")) return;
  try {
    await window.quiver.deleteMemory(name);
    closeMemoryEditor();
    loadContextData();
  } catch (e) { alert("Failed to delete: " + (e.message || e)); }
}

// ── Skill viewer ───────────────────────────────────────────────────────

let editingSkillName = "";

async function openSkillViewer(skillName) {
  editingSkillName = skillName;
  document.getElementById("skillViewerTitle").textContent = "Skill: " + skillName;
  document.getElementById("skillViewerContent").value = "Loading…";
  document.getElementById("skillViewerOverlay").style.display = "flex";
  try {
    const content = await window.quiver.readSkill(skillName);
    document.getElementById("skillViewerContent").value = content || "(empty)";
  } catch (e) {
    document.getElementById("skillViewerContent").value = "Error loading skill: " + (e.message || e);
  }
}

function closeSkillViewer(event) {
  if (event && event.target !== document.getElementById("skillViewerOverlay")) return;
  document.getElementById("skillViewerOverlay").style.display = "none";
}

async function saveSkillFile() {
  const content = document.getElementById("skillViewerContent").value;
  try {
    await window.quiver.saveSkill(editingSkillName, content);
    closeSkillViewer();
  } catch (e) { alert("Failed to save skill: " + (e.message || e)); }
}

let currentAgentMsg = null;
let currentSessionPath = null;
let pendingToolDivs = [];
let pendingImages = [];

// ── Sessions ──────────────────────────────────────────────────────────

function generateSessionTitle(session) {
  // Try to extract the first user message from the session
  if (session.firstUserMessage) {
    const msg = session.firstUserMessage;
    return msg.length > 40 ? msg.substring(0, 40) + "…" : msg;
  }
  // Fall back to a shorter UUID with date
  const date = new Date(session.savedAt);
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const shortId = session.sessionId.length > 12 ? session.sessionId.substring(0, 12) : session.sessionId;
  return shortId + " · " + dateStr;
}

async function loadSessionsList() {
  const list = document.getElementById("sessionsList");
  const sessions = await window.quiver.listSessions();
  if (!sessions || sessions.length === 0) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-faint);padding:8px;">No previous sessions</div>';
    return;
  }
  list.innerHTML = "";
  sessions.slice(0, 20).forEach(s => {
    const item = document.createElement("div");
    item.className = "session-item";
    if (currentSessionPath === s.path) item.classList.add("active");

    const date = new Date(s.savedAt);
    const timeStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

    const title = generateSessionTitle(s);

    item.innerHTML = `
      <div style="flex:1;overflow:hidden;" onclick="selectSession('${s.path}','${s.sessionId}')">
        <div class="name">${escapeHtml(title)}</div>
        <div class="meta">${s.messageCount} msgs · ${timeStr}</div>
      </div>
      <button class="delete-btn" onclick="deleteSession(event,'${s.path}')">×</button>
    `;
    list.appendChild(item);
  });
}

async function selectSession(path, sessionId) {
  if (agentRunning) return;
  currentSessionPath = path;
  // Load session to get first user message for title
  const state = await window.quiver.loadSession(path);
  const firstUserMsg = (state.messages || []).find(m => m.role === "user");
  if (firstUserMsg) {
    const title = firstUserMsg.content.length > 40 ? firstUserMsg.content.substring(0, 40) + "…" : firstUserMsg.content;
    activeSessionTitle.textContent = title;
  } else {
    activeSessionTitle.textContent = sessionId.length > 24 ? sessionId.substring(0, 24) + "…" : sessionId;
  }

  renderHistory(state.messages || []);
  await loadSessionsList();
}

async function deleteSession(event, path) {
  event.stopPropagation();
  if (!confirm("Delete this session?")) return;
  await window.quiver.deleteSession(path);
  if (currentSessionPath === path) startNewChat();
  await loadSessionsList();
}

function startNewChat() {
  if (agentRunning) return;
  currentSessionPath = null;
  activeSessionTitle.textContent = "New Chat";
  chatArea.innerHTML = "";
  chatArea.appendChild(emptyState);
  emptyState.style.display = "flex";
  loadSessionsList();
}

// ── Chat ──────────────────────────────────────────────────────────────

function renderHistory(messages) {
  chatArea.innerHTML = "";
  emptyState.style.display = "none";

  const toolResults = {};
  messages.forEach(m => {
    if (m.role === "tool" && m.tool_call_id) toolResults[m.tool_call_id] = m.content;
  });

  messages.forEach(m => {
    if (m.role === "system") return;
    if (m.role === "user") {
      addMessage("user", m.content);
    } else if (m.role === "assistant") {
      if (m.content) addMessage("agent", m.content);
      if (m.tool_calls) {
        m.tool_calls.forEach(tc => {
          const div = addToolCall(tc.function.name, tc.function.arguments || {});
          const result = toolResults[tc.id];
          if (result !== undefined) showToolResult(div, result);
        });
      }
    }
  });
}

async function sendPrompt() {
  const text = promptInput.value.trim();
  if (!text && pendingImages.length === 0) return;

  // If agent is running, send as a mid-run steering message instead of blocking.
  if (agentRunning) {
    if (!text) return;
    addMessage("user", text);
    promptInput.value = "";
    promptInput.style.height = "auto";
    await window.quiver.sendToAgent(text);
    return;
  }

  emptyState.style.display = "none";

  let fullPrompt = text;
  if (pendingImages.length > 0) {
    const imageBlock = pendingImages.map(img => `[Image: ${img.path}]`).join("\n");
    fullPrompt = text ? `${imageBlock}\n\n${text}` : `${imageBlock}\n\nPlease look at the image(s) above.`;
    pendingImages = [];
    promptInput.placeholder = "Ask Quiver…";
  }

  addMessage("user", text || "(image only)");
  promptInput.value = "";
  promptInput.style.height = "auto";

  agentRunning = true;
  sendBtn.disabled = false;  // Keep enabled for mid-run steering
  sendBtn.style.display = "none";
  stopBtn.style.display = "inline-block";
  statusDot.className = "status-dot live";
  promptInput.placeholder = "Steer Quiver mid-run…";
  promptInput.disabled = false;

  const config = await window.quiver.loadConfig();
  if (currentSessionPath) {
    await window.quiver.touchSession(currentSessionPath);
    await window.quiver.startAgent(config, true);
  } else {
    await window.quiver.startAgent(config, false);
  }
  await window.quiver.sendToAgent(fullPrompt);

  currentAgentMsg = addMessage("agent", "");
}

function addMessage(role, content) {
  const div = document.createElement("div");
  div.className = `msg msg-${role}`;
  div.innerHTML = `<div class="role">${role === "agent" ? "Quiver" : role}</div><div class="body"></div>`;
  const body = div.querySelector(".body");
  if (content) {
    body._rawText = content;
    body.innerHTML = renderMarkdown(content);
  }
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
  return div;
}

// ── Tool calls ────────────────────────────────────────────────────────

const TOOL_NAMES = {
  view_file: "Read file", write_file: "Write file", replace_content: "Edit file",
  apply_patch: "Apply patch", list_dir: "List folder", glob: "Find files",
  format_code: "Format code", grep_search: "Search files", run_command: "Run command",
  run_tests: "Run tests", create_tool: "Create tool", log_tokens: "Log stats",
  web_search: "Web search", scrape_url: "Read webpage",
  browser_control: "Browser", deep_research: "Deep research", find_all: "Find entities",
  entity_search: "Entity search", memory_append: "Save memory", memory_replace: "Update memory",
  github: "GitHub", todo_write: "Task list", ask_question: "Ask user",
  prompt_update: "Update prompt", continual_learning: "Learn from sessions", ralph_loop: "Ralph loop", subagent: "Subagent",
};

const TOOL_ICONS = {
  view_file: "icon-folder.png", write_file: "icon-edit.png", replace_content: "icon-edit.png",
  apply_patch: "icon-edit.png", list_dir: "icon-folder.png", glob: "icon-search.png",
  format_code: "icon-edit.png", grep_search: "icon-search.png", run_command: "icon-cli.png",
  run_tests: "icon-verification.png", create_tool: "icon-edit.png", log_tokens: "icon-cli.png",
  web_search: "icon-search.png", scrape_url: "icon-browser.png",
  browser_control: "icon-browser.png", deep_research: "icon-deep-search.png", find_all: "icon-search.png",
  entity_search: "icon-search.png", memory_append: "icon-database.png", memory_replace: "icon-database.png",
  github: "icon-github.png", todo_write: "icon-verification.png", ask_question: "icon-cli.png",
  prompt_update: "icon-edit.png", continual_learning: "icon-database.png", ralph_loop: "icon-goals.png", subagent: "icon-quiver-logo.png",
};

function getToolIcon(name) { return TOOL_ICONS[name] || null; }

function formatToolName(name) { return TOOL_NAMES[name] || name; }

function toggleToolCard(header) { header.parentElement.classList.toggle("collapsed"); }

function addToolCall(toolName, toolArgs) {
  const div = document.createElement("div");
  div.className = "tool-call collapsed";
  const argsStr = Object.entries(toolArgs || {})
    .map(([k, v]) => `${k}: ${truncate(String(v), 60)}`).join(", ");

  const iconFile = getToolIcon(toolName);
  const iconHtml = iconFile ? `<img src="assets/${iconFile}" class="tool-icon-img" alt="">` : `<span class="tool-icon">○</span>`;

  div.innerHTML = `
    <div class="tool-header" onclick="toggleToolCard(this)">
      ${iconHtml}
      <span class="tool-name">${formatToolName(toolName)}</span>
      <span class="tool-args">${escapeHtml(truncate(argsStr, 70))}</span>
      <span class="tool-chevron">▾</span>
    </div>
    <div class="tool-content">
      <pre>${escapeHtml(JSON.stringify(toolArgs, null, 2))}</pre>
      <div class="tool-result" style="display:none;"></div>
    </div>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
  return div;
}

function showToolResult(toolDiv, result) {
  const iconImg = toolDiv.querySelector(".tool-icon-img");
  if (iconImg) iconImg.style.opacity = "1";
  const iconSpan = toolDiv.querySelector(".tool-icon");
  if (iconSpan) iconSpan.textContent = "✓";
  const resultEl = toolDiv.querySelector(".tool-result");
  const toolName = toolDiv.querySelector(".tool-name")?.textContent || "";
  const chips = renderFileChips(toolName, result);
  resultEl.innerHTML = `<pre>${escapeHtml(result)}</pre>${chips}`;
  resultEl.style.display = "block";
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ── Approval ─────────────────────────────────────────────────────────

const FILE_MUTATION_TOOLS = new Set(["write_file", "replace_content", "apply_patch", "create_tool"]);

/**
 * Render a side-by-side diff preview for a file-mutation approval (US-2.4).
 * Shows the proposed change so the user can make an informed Approve / Reject
 * / Request revision decision.
 */
function renderDiff(toolName, toolArgs) {
  const fp = toolArgs && (toolArgs.filePath || toolArgs.path || "");
  const isNew = toolName === "create_tool" || (toolName === "write_file" && !toolArgs.content);
  const proposed = String(toolArgs.content || toolArgs.newString || toolArgs.new_content || "");
  const original = String(toolArgs.oldString || toolArgs.old_string || "");
  const escape = (t) => String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;");
  if (toolName === "replace_content") {
    return `<div class="diff-sideBySide"><div class="diff-col"><div class="diff-h">before</div><pre>${escape(original)}</pre></div><div class="diff-col"><div class="diff-h">after</div><pre>${escape(proposed)}</pre></div></div>`;
  }
  return `<div class="diff-sideBySide"><div class="diff-col"><div class="diff-h">${isNew ? "new file" : "current"}</div><pre>${escape(original)}</pre></div><div class="diff-col"><div class="diff-h">proposed</div><pre>${escape(proposed)}</pre></div></div>`;
}

function addApproval(toolName, toolArgs) {
  const div = document.createElement("div");
  div.className = "approval";
  const argsStr = Object.entries(toolArgs || {})
    .map(([k, v]) => `${k}: ${truncate(String(v), 80)}`).join("\n    ");
  const isMutation = FILE_MUTATION_TOOLS.has(toolName);
  const diffHtml = isMutation ? `<div class="diff-preview">${renderDiff(toolName, toolArgs)}</div>` : "";
  const reviseBtn = isMutation
    ? `<button class="btn-revise" onclick="requestRevision(this)">Request revision</button>`
    : "";

  div.innerHTML = `
    <div class="approval-title">Quiver needs your approval</div>
    <div class="approval-desc">Quiver wants to: <strong>${formatToolName(toolName)}</strong><pre>${argsStr}</pre></div>
    ${diffHtml}
    <div class="approval-actions">
      <button class="btn-yes" onclick="approveAction(true,this)">Approve</button>
      <button class="btn-no" onclick="approveAction(false,this)">Reject</button>
      ${reviseBtn}
    </div>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
}

/**
 * Request revision: reject the proposed change and signal the agent to revise.
 * Sends the existing approval as denied with a revision hint (US-2.4).
 */
async function requestRevision(btn) {
  const div = btn.closest(".approval");
  if (div) {
    div.style.opacity = "0.5";
    div.style.pointerEvents = "none";
    div.querySelector(".approval-actions").innerHTML =
      `<span style="color:var(--warning);font-size:12px;font-weight:500;">↩ Revision requested</span>`;
  }
  await window.quiver.approveToolCall(false);
}

async function approveAction(approve, btn) {
  const div = btn.closest(".approval");
  if (div) {
    div.style.opacity = "0.5";
    div.style.pointerEvents = "none";
    div.querySelector(".approval-actions").innerHTML =
      `<span style="color:${approve ? "var(--success)" : "var(--danger)"};font-size:12px;font-weight:500;">${approve ? "✓ Approved" : "✗ Denied"}</span>`;
  }
  await window.quiver.approveToolCall(approve);
}

// ── Preview Panel ─────────────────────────────────────────────────────

let currentPreviewPath = "";

/**
 * Open the preview panel for a file.
 * Calls the preview:file IPC handler to get content/type.
 */
async function openPreview(filePath) {
  currentPreviewPath = filePath;
  const overlay = document.getElementById("previewOverlay");
  const body = document.getElementById("previewBody");
  const title = document.getElementById("previewTitle");

  const fileName = filePath.split("/").pop().split("\\").pop();
  title.textContent = fileName;
  body.innerHTML = '<div class="preview-loading">Loading…</div>';
  overlay.style.display = "flex";

  try {
    const result = await window.quiver.previewFile(filePath);

    if (result.error) {
      body.innerHTML = `<div class="preview-error">${escapeHtml(result.error)}</div>`;
      return;
    }

    if (result.isImage && result.imageUrl) {
      body.innerHTML = `<img src="${result.imageUrl}" class="preview-image" alt="${escapeHtml(fileName)}">`;
    } else if (result.isPdf && result.pdfUrl) {
      body.innerHTML = `<iframe src="${result.pdfUrl}" class="preview-pdf" allow="fullscreen"></iframe>`;
    } else if (result.officeDoc) {
      body.innerHTML = `<div class="preview-office-meta">📄 Office document — text extraction view</div><pre class="preview-text">${escapeHtml(result.content)}</pre>`;
    } else if (result.content) {
      // Render markdown files with basic formatting
      if (result.type === ".md") {
        body.innerHTML = `<div class="preview-text">${renderMarkdown(result.content)}</div>`;
      } else {
        body.innerHTML = `<pre class="preview-text">${escapeHtml(result.content)}</pre>`;
      }
    } else {
      body.innerHTML = '<div class="preview-error">No preview available</div>';
    }
  } catch (err) {
    body.innerHTML = `<div class="preview-error">Failed to load: ${escapeHtml(err.message || err)}</div>`;
  }
}

function closePreview(event) {
  if (event && event.target !== document.getElementById("previewOverlay")) return;
  document.getElementById("previewOverlay").style.display = "none";
  currentPreviewPath = "";
}

function openInDefault() {
  if (currentPreviewPath) {
    // Use a hidden link to open the file in the OS default app
    const a = document.createElement("a");
    a.href = `file://${currentPreviewPath}`;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
}

/**
 * Detect file paths in tool results and render them as clickable chips.
 * When the agent creates a file (e.g., report.docx), show a chip that
 * opens the preview panel when clicked.
 */
function extractFilePaths(toolName, result) {
  const paths = [];
  // Match file paths in tool results — look for common patterns
  const pathRegex = /(?:\/[\w\-./]+|[\w:\\-]+)\.\w{2,5}/g;
  const matches = (result || "").match(pathRegex) || [];
  for (const m of matches) {
    // Only include if it looks like a real file path (has an extension we can preview)
    const ext = m.split(".").pop().toLowerCase();
    const previewable = ["docx", "xlsx", "pptx", "pdf", "md", "txt", "json",
      "csv", "png", "jpg", "jpeg", "gif", "webp", "svg", "html", "js", "ts",
      "py", "sql", "xml", "yaml", "yml"].includes(ext);
    if (previewable && !paths.includes(m)) {
      paths.push(m);
    }
  }
  return paths;
}

/**
 * Render file chips for previewable files in a tool result.
 */
function renderFileChips(toolName, result) {
  const paths = extractFilePaths(toolName, result);
  if (paths.length === 0) return "";
  return paths.map(p => {
    const name = p.split("/").pop().split("\\").pop();
    const ext = name.split(".").pop().toUpperCase();
    return `<div class="file-chip" onclick="openPreview('${p.replace(/'/g, "\\'")}')">
      <span>📎 ${ext}</span>
      <span>${escapeHtml(name)}</span>
    </div>`;
  }).join("");
}

// ── Markdown ──────────────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return "";
  let html = escapeHtml(text);

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) =>
    `<pre><code>${code.trim()}</code></pre>`);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/^### (.+)$/gm, '<div class="md-h3">$1</div>');
  html = html.replace(/^## (.+)$/gm, '<div class="md-h2">$1</div>');
  html = html.replace(/^# (.+)$/gm, '<div class="md-h1">$1</div>');
  html = html.replace(/\n/g, "<br>");
  html = html.replace(/<br>(<pre>)/g, "$1");
  html = html.replace(/(<\/pre>)<br>/g, "$1");
  html = html.replace(/<br>(<div class="md-h)/g, "$1");
  html = html.replace(/(<\/div>)<br>/g, "$1");

  return html;
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(str, max) {
  if (!str || str.length <= max) return str || "";
  return str.substring(0, max) + "…";
}

function appendToken(text) {
  if (!currentAgentMsg) currentAgentMsg = addMessage("agent", "");
  const body = currentAgentMsg.querySelector(".body");
  body._rawText = (body._rawText || "") + text;
  body.innerHTML = renderMarkdown(body._rawText);
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ── State ─────────────────────────────────────────────────────────────

function setIdle() {
  agentRunning = false;
  sendBtn.disabled = false;
  sendBtn.style.display = "inline-block";
  stopBtn.style.display = "none";
  statusDot.className = "status-dot idle";
  promptInput.placeholder = "Ask Quiver…";
  promptInput.disabled = false;
  currentAgentMsg = null;
}

function setError(msg) {
  addMessage("error", msg || "Unknown error");
  setIdle();
}

async function stopAgent() {
  await window.quiver.stopAgent();
  setIdle();
}

// ── Events ────────────────────────────────────────────────────────────

window.quiver.onAgentEvent((msg) => {
  if (!msg.type) return;
  switch (msg.type) {
    case "token":
      appendToken(msg.data?.text || "");
      break;
    case "context_manifest":
      updateContext(msg.data || {});
      if (!contextVisible) {
        contextVisible = true;
        contextPanel.style.display = "flex";
        contextBtn.classList.add("active");
      }
      break;
    case "tool_call": {
      const div = addToolCall(msg.data?.toolName || "unknown", msg.data?.toolArgs || {});
      pendingToolDivs.push(div);
      break;
    }
    case "tool_result": {
      if (pendingToolDivs.length > 0) {
        showToolResult(pendingToolDivs.shift(), msg.data?.toolResult || "");
      }
      break;
    }
    case "approval":
      addApproval(msg.data?.toolName || "unknown", msg.data?.toolArgs || {}, msg.data?.currentContent, msg.data?.proposedContent);
      break;
    case "done":
      if (msg.data?.tokenStats) {
        const ts = msg.data.tokenStats;
        const totalTokens = (ts.inputTokens || 0) + (ts.outputTokens || 0);
        const bar = document.querySelector(".stats-bar");
        if (bar) bar.textContent = `${ts.turns || 0} turns · ${ts.toolCalls || 0} tools · ${totalTokens} tokens`;
        updateContext({ tokens: `${totalTokens.toLocaleString()} est.` });
      }
      if (currentAgentMsg && msg.data?.response) {
        const body = currentAgentMsg.querySelector(".body");
        if (!body._rawText) {
          body._rawText = msg.data.response;
          body.innerHTML = renderMarkdown(msg.data.response);
        }
      }
      setIdle();
      if (currentSessionPath === null) {
        loadSessionsList().then(async () => {
          const sessions = await window.quiver.listSessions();
          if (sessions && sessions.length > 0) {
            currentSessionPath = sessions[0].path;
            // Generate a human-readable title from the first user message
            const state = await window.quiver.loadSession(sessions[0].path);
            const firstUserMsg = (state.messages || []).find(m => m.role === "user");
            if (firstUserMsg) {
              activeSessionTitle.textContent = firstUserMsg.content.length > 40
                ? firstUserMsg.content.substring(0, 40) + "…" : firstUserMsg.content;
            } else {
              activeSessionTitle.textContent = sessions[0].sessionId.length > 24
                ? sessions[0].sessionId.substring(0, 24) + "…" : sessions[0].sessionId;
            }
            await loadSessionsList();
          }
        });
      }
      break;
    case "error":
      setError(msg.data?.error || "Unknown error");
      break;
  }
});

window.quiver.onAgentRaw((line) => {
  try { const p = JSON.parse(line); if (p.type) return; } catch {}
  appendToken(line);
});

window.quiver.onAgentStderr((data) => {
  if (data.includes("[ERROR]") || data.includes('"type":"error"')) {
    statusDot.className = "status-dot error";
  }
});

window.quiver.onAgentExit(() => { setIdle(); loadSessionsList(); });
window.quiver.onAgentError((err) => { setError(err.message || "Agent error"); });

// ── Input ─────────────────────────────────────────────────────────────

promptInput.addEventListener("input", () => {
  promptInput.style.height = "auto";
  promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + "px";
});

promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

// ── Drag & Drop ───────────────────────────────────────────────────────

const dropOverlay = document.getElementById("dropOverlay");

function handleDragOver(e) {
  e.preventDefault();
  if (e.dataTransfer.types.includes("Files")) dropOverlay.style.display = "flex";
}

function handleDragLeave(e) {
  e.preventDefault();
  if (e.target === e.currentTarget) dropOverlay.style.display = "none";
}

async function handleDrop(e) {
  e.preventDefault();
  dropOverlay.style.display = "none";
  const files = Array.from(e.dataTransfer.files).filter(f =>
    /\.(png|jpg|jpeg|gif|bmp|webp|tiff|svg)$/i.test(f.name));
  if (files.length === 0) return;

  for (const file of files) {
    const filePath = file.path || file.name;
    pendingImages.push({ path: filePath, name: file.name });
  }

  for (const img of pendingImages.slice(-files.length)) {
    const div = document.createElement("div");
    div.className = "msg msg-image-preview";
    div.innerHTML = `<div class="role">image attached</div><div class="body"><img src="file://${img.path}" class="dropped-image"><div class="image-name">${img.name}</div></div>`;
    chatArea.appendChild(div);
  }

  promptInput.placeholder = `${pendingImages.length} image(s) attached. Type your message…`;
  promptInput.focus();
}

// ── Init ──────────────────────────────────────────────────────────────

loadSessionsList();
promptInput.focus();
// ── Event listener bindings (CSP-safe: no inline handlers) ───────────
// All inline onclick/onchange/ondrop attributes removed from index.html
// for strict CSP compliance (script-src 'self', no unsafe-inline).

document.getElementById("newChatBtn").addEventListener("click", () => startNewChat());
document.getElementById("sendBtn").addEventListener("click", () => sendPrompt());
document.getElementById("stopBtn").addEventListener("click", () => stopAgent());
document.getElementById("contextToggleBtn").addEventListener("click", () => toggleContextPanel());
document.getElementById("contextExpandBtn").addEventListener("click", () => toggleContextPanel());

// Settings button
document.querySelector(".settings-btn").addEventListener("click", () => window.quiver.loadSettings());

// Memory editor buttons
document.querySelector(".ctx-add-btn").addEventListener("click", () => openMemoryEditor(""));

// Core memory textareas — save on change
document.getElementById("ctxIdentity").addEventListener("change", () => saveCoreMemory());
document.getElementById("ctxHuman").addEventListener("change", () => saveCoreMemory());
document.getElementById("ctxProject").addEventListener("change", () => saveCoreMemory());

// Preview panel
document.getElementById("previewOverlay").addEventListener("click", (e) => closePreview(e));
document.querySelector(".preview-panel").addEventListener("click", (e) => e.stopPropagation());
document.querySelector(".preview-btn").addEventListener("click", () => openInDefault());
document.querySelector(".preview-close").addEventListener("click", () => closePreview());

// Memory editor modal
document.getElementById("memEditorOverlay").addEventListener("click", (e) => closeMemoryEditor(e));
document.querySelector("#memEditorOverlay .modal-card").addEventListener("click", (e) => e.stopPropagation());
document.querySelector("#memEditorOverlay .modal-close").addEventListener("click", () => closeMemoryEditor());
document.querySelector("#memEditorOverlay .btn-primary").addEventListener("click", () => saveMemoryFile());
document.querySelector("#memEditorOverlay .btn-secondary").addEventListener("click", () => closeMemoryEditor());
document.getElementById("memDeleteBtn").addEventListener("click", () => deleteMemoryFile());

// Skill viewer modal
document.getElementById("skillViewerOverlay").addEventListener("click", (e) => closeSkillViewer(e));
document.querySelector("#skillViewerOverlay .modal-card").addEventListener("click", (e) => e.stopPropagation());
document.querySelector("#skillViewerOverlay .modal-close").addEventListener("click", () => closeSkillViewer());
document.querySelector("#skillViewerOverlay .btn-primary").addEventListener("click", () => saveSkillFile());
document.querySelector("#skillViewerOverlay .btn-secondary").addEventListener("click", () => closeSkillViewer());

// Input area drag & drop
const inputBar = document.getElementById("inputBar");
inputBar.addEventListener("drop", (e) => handleDrop(e));
inputBar.addEventListener("dragover", (e) => handleDragOver(e));
inputBar.addEventListener("dragleave", (e) => handleDragLeave(e));
