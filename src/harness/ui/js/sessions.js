import { $, escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { addActivity } from "./activity.js";
import { showOverlay, closeOverlay, confirmDialog } from "./overlays.js";
import { renderMarkdownToHtml } from "./markdown.js";
import {
  addUserMessage,
  startAssistantBubble,
  clearChat,
  hideEmpty,
  showEmpty,
  chatTurnCount,
  setWorking,
} from "./chat.js";
import { handleOfficeDocResult } from "./cards.js";
import { updateTurnCount } from "./context.js";

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
        state.assistantBubble.dataset.rawText = textContent;
        state.assistantBubble.innerHTML = renderMarkdownToHtml(textContent);
        state.assistantBubble = null;
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.type === "function" && tc.function) {
            try {
              const args =
                typeof tc.function.arguments === "string"
                  ? JSON.parse(tc.function.arguments)
                  : tc.function.arguments;
              toolCalls[tc.id] = { name: tc.function.name, args: args };
            } catch {
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
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
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
        (sessionTitleFor(s) + " " + (s.sessionId || "")).toLowerCase().includes(q),
      )
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
      $("conversationTitle").textContent = sessionTitleFor(s);
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
      state.agentAvailable = true;
      state.turnRunning = false;
      setWorking(false);
    });
    item.querySelector(".si-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      const sure = await confirmDialog({
        title: "Delete session?",
        message: `"${sessionTitleFor(s)}" will move to the sessions archive.`,
        confirmLabel: "Delete",
        danger: true,
      });
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

export {
  getMessageTextContent,
  loadSessionStateIntoUi,
  formatSessionDate,
  sessionTitleFor,
  renderSessionsList,
  openSessions,
};
