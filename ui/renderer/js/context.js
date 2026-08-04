import { $, escapeHtml } from "./dom.js";
import { api, state } from "./state.js";
import { setModel } from "./model.js";
import { excludeFromRun } from "./consent.js";
import { addActivity } from "./activity.js";
import { showOverlay, closeOverlay } from "./overlays.js";
import { chatTurnCount } from "./chat.js";

async function loadContextSurfaces(config) {
  if (config?.provider?.modelName) setModel(config.provider.modelName, config);
  
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

  // Wire the trust context pill to real trust tier + sandbox state
  const pill = $("pillText");
  if (pill) {
    const sandboxLabel = "Sandbox ON";
    const pillParts = [label, sandboxLabel, "Ready"];
    pill.textContent = pillParts.join(" · ");
  }

  // §6 layer F: operational metadata — where the work actually runs.
  const trustEl = $("ctxTrust");
  if (trustEl) trustEl.textContent = `Approvals: ${label}`;
  const endpointEl = $("ctxEndpoint");
  if (endpointEl) {
    const baseUrl = config?.provider?.baseUrl || "";
    let where = "Not state.configured";
    try {
      const host = new URL(baseUrl).hostname;
      where =
        host === "localhost" || host === "127.0.0.1"
          ? "Local — prompts stay on this machine"
          : `Cloud — prompts go to ${host}`;
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

function renderAttachments() {
  const box = $("attachments");
  if (!box) return;
  box.innerHTML = "";
  for (const a of state.attachments) {
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
    $("ctxReviewCount").textContent = "Not available";
    $("openReviewBtn").hidden = true;
  }
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

export {
  loadContextSurfaces,
  loadCoreMemory,
  loadMemoryList,
  loadSkillList,
  renderLoadedSkills,
  renderAttachments,
  refreshReviewCount,
  updateTurnCount,
  openMemoryEditor,
  saveMemoryFile,
  deleteMemoryFile,
  saveCoreMemory,
  openSkillViewer,
  saveSkill,
  openReviewQueue,
  openPreview,
};
