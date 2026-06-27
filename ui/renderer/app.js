const chatArea = document.getElementById("chatArea");
const promptInput = document.getElementById("promptInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const statusDot = document.getElementById("statusDot");
const emptyState = document.getElementById("emptyState");
const activeSessionTitle = document.getElementById("activeSessionTitle");
const contextPanel = document.getElementById("contextPanel");
const contextBtn = document.getElementById("contextBtn");

let agentRunning = false;
let contextVisible = false;

// ── Context transparency ─────────────────────────────────────────────

function toggleContext() {
  contextVisible = !contextVisible;
  contextPanel.style.display = contextVisible ? "flex" : "none";
  contextBtn.classList.toggle("active", contextVisible);
}

function updateContext(data) {
  if (data.model) document.getElementById("ctxModel").textContent = data.model;
  if (data.memory !== undefined) document.getElementById("ctxMemory").textContent = data.memory || "—";
  if (data.skills !== undefined) document.getElementById("ctxSkills").textContent = data.skills || "—";
  if (data.tools !== undefined) document.getElementById("ctxTools").textContent = data.tools || "—";
  if (data.tokens) document.getElementById("ctxTokens").textContent = data.tokens;
}
let currentAgentMsg = null;
let currentSessionPath = null;
let pendingToolDivs = [];
let pendingImages = [];

// ── Sessions ──────────────────────────────────────────────────────────

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

    const shortId = s.sessionId.length > 20 ? s.sessionId.substring(0, 20) + "…" : s.sessionId;

    item.innerHTML = `
      <div style="flex:1;overflow:hidden;" onclick="selectSession('${s.path}','${s.sessionId}')">
        <div class="name">${shortId}</div>
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
  activeSessionTitle.textContent = sessionId.length > 24 ? sessionId.substring(0, 24) + "…" : sessionId;

  const state = await window.quiver.loadSession(path);
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
  if (agentRunning) return;

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
  sendBtn.disabled = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "inline-block";
  statusDot.className = "status-dot live";

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
  web_search: "Web search", scrape_url: "Read webpage", search_docs: "Search docs",
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
  web_search: "icon-search.png", scrape_url: "icon-browser.png", search_docs: "icon-search.png",
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
  resultEl.innerHTML = `<pre>${escapeHtml(result)}</pre>`;
  resultEl.style.display = "block";
  chatArea.scrollTop = chatArea.scrollHeight;
}

// ── Approval ─────────────────────────────────────────────────────────

function addApproval(toolName, toolArgs) {
  const div = document.createElement("div");
  div.className = "approval";
  const argsStr = Object.entries(toolArgs || {})
    .map(([k, v]) => `${k}: ${truncate(String(v), 80)}`).join("\n    ");

  div.innerHTML = `
    <div class="approval-title">Permission required</div>
    <div class="approval-desc">Quiver wants to run: <strong>${formatToolName(toolName)}</strong><pre>${argsStr}</pre></div>
    <div class="approval-actions">
      <button class="btn-yes" onclick="approveAction(true,this)">Allow</button>
      <button class="btn-no" onclick="approveAction(false,this)">Deny</button>
    </div>
  `;
  chatArea.appendChild(div);
  chatArea.scrollTop = chatArea.scrollHeight;
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
      addApproval(msg.data?.toolName || "unknown", msg.data?.toolArgs || {});
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
            activeSessionTitle.textContent = sessions[0].sessionId.length > 24
              ? sessions[0].sessionId.substring(0, 24) + "…" : sessions[0].sessionId;
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