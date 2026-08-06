// Browser bridge — the daemon-backed equivalent of the Electron preload's
// window.quiver API. Every method maps to a daemon HTTP route (secret-gated);
// the agent event stream is an SSE subscription. Exposes the SAME method names
// the renderer modules call, so the rest of the UI is unchanged.
const SECRET = window.__QUIVER_SECRET__ || new URLSearchParams(location.hash.slice(1)).get("token") || "";
const h = () => ({ "X-Quiver-Secret": SECRET, "Content-Type": "application/json" });

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: h(), body: JSON.stringify(body || {}) });
  return r.json();
}
async function get(path) {
  const r = await fetch(path, { headers: h() });
  return r.json();
}

export const api = {
  // Config
  loadConfig: () => get("/api/config"),
  isConfigured: async () => (await get("/api/config/isConfigured")).configured,
  saveConfig: (config) => post("/api/config/save", { config }),

  // Agent
  startAgent: (config, resumeLatest) => post("/api/agent/start", { config, resumeLatest }),
  sendToAgent: (text) => post("/api/agent/send", { text }),
  approveToolCall: (approve, note) => post("/api/agent/approve", { approve, note }),
  stopAgent: () => post("/api/agent/stop", {}),
  // Resolve a pending prompt (approval/consent/main input) the daemon surfaced.
  respondPrompt: (id, answer) => post("/api/agent/respond", { id, answer }),

  // Sessions
  listSessions: () => get("/api/sessions"),
  loadSession: (filePath) => post("/api/sessions/load", { filePath }),
  deleteSession: (filePath) => post("/api/sessions/delete", { filePath }),

  // Memory files
  listMemory: () => get("/api/memory"),
  saveMemory: (name, content) => post("/api/memory/save", { name, content }),
  deleteMemory: (name) => post("/api/memory/delete", { name }),
  loadCoreMemory: () => get("/api/memory/core"),
  saveCoreMemory: (core) => post("/api/memory/core/save", { core }),

  // Memory review
  memoryReviewList: () => get("/api/memory/review"),
  memoryReviewAction: (factId, action, content) => post("/api/memory/review/action", { factId, action, content }),

  // Exclude/veto
  excludeFromRun: (memoryName) => post("/api/memory/exclude", { memoryName }),

  // Consent
  consentRespond: (decision) => post("/api/agent/consent", { decision }),

  // Review flow
  reviewMarkFinal: (filePath, openFlags, figureStatuses) => post("/api/review/markFinal", { filePath, openFlags, figureStatuses }),
  reviewOverride: (filePath, openFlags, figureStatuses) => post("/api/review/override", { filePath, openFlags, figureStatuses }),

  // Skills
  listSkills: () => get("/api/skills"),
  readSkill: async (skillName) => (await post("/api/skills/read", { skillName })).content,
  saveSkill: (skillName, content) => post("/api/skills/save", { skillName, content }),

  // Preview / deliverables
  previewFile: (filePath) => post("/api/preview", { filePath }),
  openFile: (filePath) => post("/api/file/open", { filePath }),
  showInFolder: (filePath) => post("/api/file/showInFolder", { filePath }),

  // Evidence
  loadEvidence: (docFilePath) => post("/api/evidence/load", { docFilePath }),

  // Workflow
  rerunWorkflow: () => post("/api/workflow/rerun", {}),

  // Navigation (no-ops in the browser — all one page)
  loadMain: () => {},
  loadSettings: () => {},
  loadOnboarding: () => { window.location.hash = "#onboarding"; },

  // Events (agent → renderer) — SSE subscription.
  onAgentEvent: (cb) => subscribe("agent_event", cb),
  onAgentRaw: (cb) => subscribe("agent_token", (d) => cb({ token: d.token })),
  onAgentStderr: (cb) => subscribe("agent_error", cb),
  onAgentExit: (cb) => subscribe("agent_exit", cb),
  onAgentError: (cb) => subscribe("agent_error", cb),
  // Prompt requests (the daemon surfaces approvals/consent/main input).
  onPromptRequest: (cb) => subscribe("prompt_request", cb),
};

// SSE subscription via fetch + ReadableStream (can set the x-quiver-secret
// header — the secret never goes in a URL query param, per §16).
let streamController = null;
const subs = new Map(); // kind -> Set<callback>
function subscribe(kind, cb) {
  if (!subs.has(kind)) subs.set(kind, new Set());
  subs.get(kind).add(cb);
  if (!streamController) {
    startEventStream();
  }
  return () => { subs.get(kind)?.delete(cb); };
}

async function startEventStream() {
  try {
    const res = await fetch(`/api/agent/events`, {
      headers: { "x-quiver-secret": SECRET },
    });
    if (!res.ok || !res.body) { setTimeout(startEventStream, 3000); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    streamController = new AbortController();
    // SSE: parse `data: <json>\n\n` frames.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const json = dataLine.slice(5).trim();
        try {
          const ev = JSON.parse(json);
          const set = subs.get(ev.kind);
          if (set) for (const fn of set) fn(ev);
        } catch { /* ignore malformed */ }
      }
    }
  } catch { /* reconnect */ }
  // Reconnect after a delay (the daemon may have restarted).
  setTimeout(startEventStream, 3000);
}

// Make the api available as window.quiver for any renderer code that reads it
// directly (state.js imports from here instead).
window.quiver = api;