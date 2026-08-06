import { $, escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { setModel } from "./model.js";
import { renderMarkdownToHtml } from "./markdown.js";
import { addActivity } from "./activity.js";
import {
  renderLoadedSkills,
  refreshReviewCount,
  updateTurnCount,
  renderAttachments,
} from "./context.js";
import {
  ensureDocumentCard,
  handleOfficeDocResult,
  loadEvidenceFromDisk,
  OFFICE_MUTATING_ACTIONS,
} from "./cards.js";
import { docKindFor } from "./icons.js";
import {
  showConsentGate,
  showCompactionGate,
  showEvidenceConsentGate,
  focusContextRail,
} from "./consent.js";
import {
  renderLineageChipsForDocument,
  recordDeliverableContext,
} from "./lineage.js";
import { showOverlay, closeOverlay } from "./overlays.js";

// ─── conversation plane ────────────────────────────────────────────────
function addUserMessage(text) {
  hideEmpty();
  const msg = document.createElement("div");
  msg.className = "msg user";
  msg.textContent = text;
  state.chatArea.appendChild(msg);
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
  state.chatArea.appendChild(msg);
  state.assistantBubble = prose;
  scrollChat();
}

function appendAssistantToken(token) {
  if (!state.assistantBubble) startAssistantBubble();
  if (state.assistantBubble.dataset.rawText === undefined) {
    state.assistantBubble.dataset.rawText = "";
  }
  state.assistantBubble.dataset.rawText += token;
  state.assistantBubble.innerHTML = renderMarkdownToHtml(state.assistantBubble.dataset.rawText);
  scrollChat();
}

function hideEmpty() {
  if (state.emptyState) state.emptyState.hidden = true;
}
function showEmpty() {
  if (state.emptyState) state.emptyState.hidden = false;
}
// Clear the conversation without destroying the empty-state node, which
// lives inside #chatArea (a bare innerHTML="" would delete it for good).
function clearChat() {
  for (const child of [...state.chatArea.children]) {
    if (child !== state.emptyState) child.remove();
  }
}
function chatTurnCount() {
  return [...state.chatArea.children].filter((c) => c !== state.emptyState).length;
}
function scrollChat() {
  state.chatArea.scrollTop = state.chatArea.scrollHeight;
}

// ─── agent lifecycle + events ──────────────────────────────────────────
function setWorking(working) {
  state.statusDot.className = "status-dot " + (working ? "working" : "idle");
  state.sendBtn.hidden = working;
  state.stopBtn.hidden = !working;
  // Update the trust context pill to reflect working/idle state
  const pill = $("pillText");
  if (pill) {
    const badge = $("trustBadge");
    const tier = badge ? badge.textContent : "Ask before acting";
    pill.textContent = tier + " · Sandbox ON · " + (working ? "Working" : "Ready");
  }
}

function wireAgentEvents() {
  api.onAgentEvent((ev) => handleAgentEvent(ev));
  api.onAgentExit((d) => {
    state.agentAvailable = false;
    state.turnRunning = false;
    setWorking(false);
    state.statusDot.className = "status-dot idle";
    addActivity("Agent stopped" + (d?.code ? ` (exit ${d.code})` : ""), "");
  });
  api.onAgentError((e) => {
    state.turnRunning = false;
    state.liveRunActive = false;
    setWorking(false);
    state.statusDot.className = "status-dot error";
    addActivity("Agent error: " + (e?.error || e), "err");
  });
  api.onAgentStderr((d) => {
    if (d?.data) addActivity(d.data.trim(), "warn");
  });
  // Daemon connection state drives the ambient ribbon: honest connectivity,
  // and credit for work that continued while the window was disconnected.
  api.onConnectionChange((s) => {
    if (s === "reconnecting") {
      setCurrentStatus("Reconnecting to Quiver's daemon…");
      return;
    }
    if (state.turnRunning || state.liveRunActive) {
      setCurrentStatus("Reconnected — Quiver kept working");
      addActivity("Reconnected to the daemon — work continued while you were away.", "tool");
    } else {
      setCurrentStatus("");
    }
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
      const mem = ev.data?.memory ?? 0;
      const sk = ev.data?.skills ?? 0;
      const tl = ev.data?.tools ?? 0;
      const entry = `Context loaded: ${mem} memory · ${sk} skills · ${tl} tools`;
      if (entry !== state.lastContextEntryText) {
        addActivity(entry, "tool");
        state.lastContextEntryText = entry;
      }
      break;
    }
    case "consent_gate": {
      // SPEC §6: the agent emits this before the model call and waits for a
      // decision. Only show the overlay for a LIVE run — daemon replay after
      // a window restart would otherwise re-prompt for an already-completed
      // turn.
      if (state.liveRunActive) showConsentGate(ev.data);
      break;
    }
    case "compaction_proposed": {
      // SPEC §7.3: context rewrite requires explicit approval — never auto-apply
      // on the GUI/json path. The agent is blocked on stdin until we respond.
      if (state.liveRunActive) showCompactionGate(ev.data);
      break;
    }
    case "evidence_consent_proposed": {
      // Human/VP promote for sources/claims — second stdin wait after tool approval.
      if (state.liveRunActive) showEvidenceConsentGate(ev.data);
      break;
    }
    case "consent_declined": {
      state.liveRunActive = false;
      state.turnRunning = false;
      setWorking(false);
      addActivity("Consent declined — turn aborted", "warn");
      break;
    }
    case "consent_exclude": {
      state.liveRunActive = false;
      state.turnRunning = false;
      setWorking(false);
      addActivity("Routed back to the context rail — exclude items, then re-run", "warn");
      focusContextRail();
      break;
    }
    case "sensitivity_refused": {
      // US-17.17 / SPEC §11.2: a high-sensitivity turn was refused because no
      // local model endpoint is state.configured. Surface the reason — never a blank
      // "Done" (empty states are product; silent failure is the anti-pattern).
      state.liveRunActive = false;
      state.turnRunning = false;
      setWorking(false);
      setCurrentStatus("");
      state.statusDot.className = "status-dot error";
      const reason = ev.data?.reason
        ? ev.data.reason
        : "This input is high-sensitivity and no local model is state.configured.";
      addActivity(`Refused — not sent: ${reason}`, "err");
      startAssistantBubble();
      if (state.assistantBubble) {
        state.assistantBubble.textContent =
          "I didn't send this to the model. " + reason +
          " Set a local model in Settings (a localhost Ollama) so high-sensitivity content is handled by your local model, then re-run.";
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
      if (state.liveRunActive) showApproval(ev.data);
      break;
    }
    case "intervention": {
      addActivity("You steered the work: " + (ev.data?.text || ""), "warn");
      break;
    }
    case "done": {
      state.liveRunActive = false;
      state.turnRunning = false;
      setWorking(false);
      setCurrentStatus("");
      // If the turn was refused (e.g. high-sensitivity with no local endpoint),
      // the sensitivity_refused case already surfaced the reason — don't paint
      // a misleading green "Done" over a refusal.
      if (ev.data?.refused) {
        state.statusDot.className = "status-dot error";
        addActivity("Turn refused — nothing was sent to the model.", "err");
      } else {
        state.statusDot.className = "status-dot ok";
        addActivity("Done", "ok");
      }
      refreshReviewCount();
      updateTurnCount();
      state.assistantBubble = null;
      break;
    }
    case "error": {
      state.liveRunActive = false;
      state.turnRunning = false;
      setWorking(false);
      state.statusDot.className = "status-dot error";
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
    renderApprovalPreview(state.pendingApproval?.toolName || "", state.pendingApproval?.toolArgs || {});
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
function showApproval(data) {
  state.pendingApproval = data;
  state.pendingApprovalAll = false;
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
  if (!state.pendingApproval) return;
  api.approveToolCall(true, all ? "all" : undefined);
  closeOverlay("approvalOverlay", true);
  state.pendingApproval = null;
  setWorking(true);
}
function rejectAction() {
  if (!state.pendingApproval) return;
  api.approveToolCall(false);
  closeOverlay("approvalOverlay", true);
  state.pendingApproval = null;
  setWorking(true);
}
function requestRevision() {
  if (!$("revisionBox").hidden) {
    // second click: send the revision note as a rejection with guidance
    const note = $("revisionNote").value.trim();
    if (state.pendingApproval) api.approveToolCall(false, note || undefined);
    closeOverlay("approvalOverlay", true);
    state.pendingApproval = null;
    setWorking(true);
  } else {
    $("revisionBox").hidden = false;
    $("revisionNote").focus();
  }
}

// ─── token bar ─────────────────────────────────────────────────────────
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
  const text = state.promptInput.value.trim();
  if (!text && state.attachments.length === 0) return;

  // If a turn is running, queue the message as a steering input rather than
  // dropping it. The agent's InterventionController consumes it at the next
  // loop iteration — same mechanism as the CLI Esc-steering.
  if (state.turnRunning) {
    const imageMarkers = state.attachments.map((a) => "[File: " + a.path + "]").join("\n");
    const message = (imageMarkers ? imageMarkers + "\n" : "") + text;
    // Show the queued steering message in the chat as a muted bubble
    const steer = document.createElement("div");
    steer.className = "msg user-msg steer-queued";
    steer.innerHTML = '<span class="steer-label">↳ Steered: </span>' + escapeHtml(text);
    state.chatArea.appendChild(steer);
    scrollChat();
    // Clear the input immediately
    state.promptInput.value = "";
    for (const a of state.attachments) if (a.thumbUrl) URL.revokeObjectURL(a.thumbUrl);
    state.attachments = [];
    renderAttachments();
    autoSize();
    // Send to the agent's stdin — the InterventionController picks it up
    await api.sendToAgent(message);
    addActivity("Steered: " + text.slice(0, 80), "warn");
    return;
  }

  if (!state.agentAvailable) {
    addActivity("Quiver is not ready — the agent is unavailable.", "err");
    return;
  }
  const imageMarkers = state.attachments.map((a) => "[File: " + a.path + "]").join("\n");
  const message = (imageMarkers ? imageMarkers + "\n" : "") + text;
  addUserMessage(text || ("📎 " + state.attachments.map((a) => a.name).join(", ")));
  state.promptInput.value = "";
  // release the blob URLs we created for the thumbnails
  for (const a of state.attachments) if (a.thumbUrl) URL.revokeObjectURL(a.thumbUrl);
  state.attachments = [];
  renderAttachments();
  autoSize();
  state.liveRunActive = true;
  state.turnRunning = true;
  setWorking(true);
  try {
    await api.sendToAgent(message);
  } catch (error) {
    state.liveRunActive = false;
    state.turnRunning = false;
    setWorking(false);
    addActivity("Could not send the request: " + (error?.message || error), "err");
  }
}
function toggleContextDrawer() {
  const ws = $("workspace");
  if (!ws) return;
  const compact = window.matchMedia?.("(max-width: 840px)")?.matches;
  if (compact) {
    ws.classList.remove("hide-context");
    ws.classList.toggle("drawer-context-open");
    $("toggleContextBtn")?.setAttribute(
      "aria-pressed",
      String(ws.classList.contains("drawer-context-open")),
    );
    return;
  }
  ws.classList.remove("drawer-context-open");
  ws.classList.toggle("hide-context");
  $("toggleContextBtn")?.setAttribute(
    "aria-pressed",
    String(!ws.classList.contains("hide-context")),
  );
}
function toggleActivityDrawer() {
  const ws = $("workspace");
  if (!ws) return;
  const compact = window.matchMedia?.("(max-width: 1180px)")?.matches;
  if (compact) {
    ws.classList.remove("hide-activity");
    ws.classList.toggle("drawer-activity-open");
    $("toggleActivityBtn")?.setAttribute(
      "aria-pressed",
      String(ws.classList.contains("drawer-activity-open")),
    );
    return;
  }
  ws.classList.remove("drawer-activity-open");
  ws.classList.toggle("hide-activity");
  $("toggleActivityBtn")?.setAttribute(
    "aria-pressed",
    String(!ws.classList.contains("hide-activity")),
  );
}
function syncDrawerControls() {
  const ws = $("workspace");
  if (!ws) return;
  const compactContext = window.matchMedia?.("(max-width: 840px)")?.matches;
  const compactActivity = window.matchMedia?.("(max-width: 1180px)")?.matches;
  $("toggleContextBtn")?.setAttribute(
    "aria-pressed",
    String(
      compactContext
        ? ws.classList.contains("drawer-context-open")
        : !ws.classList.contains("hide-context"),
    ),
  );
  $("toggleActivityBtn")?.setAttribute(
    "aria-pressed",
    String(
      compactActivity
        ? ws.classList.contains("drawer-activity-open")
        : !ws.classList.contains("hide-activity"),
    ),
  );
}
function wireKeyboard() {
  state.promptInput.addEventListener("input", autoSize);
  state.promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt();
    }
  });
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "1") {
      e.preventDefault();
      toggleContextDrawer();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === "2") {
      e.preventDefault();
      toggleActivityDrawer();
    }
  });
}
function autoSize() {
  state.promptInput.style.height = "auto";
  state.promptInput.style.height = Math.min(180, state.promptInput.scrollHeight) + "px";
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
    state.attachments.push({ path: filePath, name, thumbUrl });
    renderAttachments();
  } else {
    state.promptInput.value = (state.promptInput.value ? state.promptInput.value + "\n" : "") + "Read this file: " + filePath;
    autoSize();
  }
  state.promptInput.focus();
  addActivity("Attached: " + name, "tool");
}

// ─── S5: Current status line ─────────────────────────────────────────────
function setCurrentStatus(text) {
  const el = $("currentStatus");
  const ribbon = $("ambientRibbon");
  const ambientText = $("ambientStatusText");
  if (el) {
    if (text) {
      el.textContent = text;
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  if (ribbon && ambientText) {
    if (text) {
      ambientText.textContent = text;
      ribbon.hidden = false;
    } else {
      ribbon.hidden = true;
    }
  }
}

export {
  addUserMessage,
  startAssistantBubble,
  appendAssistantToken,
  hideEmpty,
  showEmpty,
  clearChat,
  chatTurnCount,
  scrollChat,
  setWorking,
  wireAgentEvents,
  handleAgentEvent,
  renderDiff,
  diffLine,
  summarizeArgs,
  plainToolName,
  maybeDraftCard,
  showApproval,
  renderApprovalPreview,
  verbForApproval,
  renderPatchPreview,
  approveAction,
  rejectAction,
  requestRevision,
  compactNumber,
  updateTokenBar,
  sendPrompt,
  toggleContextDrawer,
  toggleActivityDrawer,
  syncDrawerControls,
  wireKeyboard,
  autoSize,
  wireImageDrop,
  attachDroppedFile,
  setCurrentStatus,
};
