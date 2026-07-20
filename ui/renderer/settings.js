// Settings — loads/saves via the proven loadConfig/saveConfig path (which
// writes quiver-config.json and syncs .env). Plain business language only.

const api = window.quiver;
const $ = (id) => document.getElementById(id);

let currentConfig = null;

async function loadSettings() {
  currentConfig = await api.loadConfig();
  $("workspacePath").value = currentConfig.workspacePath || "";
  $("modelName").value = currentConfig.provider?.modelName || "";
  $("baseUrl").value = currentConfig.provider?.baseUrl || "";
  $("maxContextTokens").value = currentConfig.maxContextTokens || 120000;
  $("apiKey").value = currentConfig.provider?.apiKey || "";
  $("parallelApiKey").value = currentConfig.parallelApiKey || "";
  $("githubToken").value = currentConfig.githubToken || "";
  $("visionModelName").value = currentConfig.visionModelName || "";
  $("visionModelBaseUrl").value = currentConfig.visionModelBaseUrl || "";

  const grants = currentConfig.autonomyGrants || "";
  $("autonomyMode").value = grants.includes("yolo")
    ? "yolo"
    : grants.startsWith("tier:")
      ? grants
      : grants;
  setToggle("browserVisible", grants.includes("browser:visible"));
  setToggle("consentGateEnabled", currentConfig.consentGateEnabled === true);
  setToggle("syncEnabled", !!(currentConfig.cloudSyncPath && currentConfig.cloudSyncPath.length > 0));
  $("syncPath").value = currentConfig.cloudSyncPath || "";
  setToggle("sessionLogEnabled", currentConfig.sessionLogEnabled !== false);
  $("sessionLogMaxChars").value = currentConfig.sessionLogMaxChars || 512;

  try {
    const stats = await api.memoryReviewList();
    if (Array.isArray(stats)) {
      $("memPending").textContent = `Pending: ${stats.filter((f) => !f.reviewed).length}`;
      $("memReviewed").textContent = `Reviewed: ${stats.filter((f) => f.reviewed).length}`;
      $("memTotal").textContent = `Total: ${stats.length}`;
    }
  } catch {
    /* memory review may not be available yet */
  }
}

function setToggle(id, active) {
  const el = $(id);
  if (el) el.classList.toggle("active", !!active);
}
function isToggleActive(id) {
  const el = $(id);
  return el ? el.classList.contains("active") : false;
}

async function browseWorkspace() {
  const selected = await api.selectWorkspaceDir();
  if (selected) $("workspacePath").value = selected;
}
async function browseSyncDir() {
  const selected = await api.selectWorkspaceDir();
  if (selected) $("syncPath").value = selected;
}

async function saveSettings() {
  let grants = $("autonomyMode").value;
  if (isToggleActive("browserVisible")) {
    grants = grants ? grants + ",browser:visible" : "browser:visible";
  }
  const syncPath = $("syncPath").value.trim();
  const syncOn = isToggleActive("syncEnabled");

  // Store the API key in the OS keychain when available, then mirror to config.
  const key = $("apiKey").value.trim();
  if (key && typeof api.settingsSetCredential === "function") {
    try {
      await api.settingsSetCredential("OLLAMA_API_KEY", key);
    } catch {
      /* keychain unavailable — config fallback below still carries the key */
    }
  }

  await api.saveConfig({
    ...currentConfig,
    workspacePath: $("workspacePath").value.trim(),
    provider: {
      ...currentConfig?.provider,
      apiKey: key,
      modelName: $("modelName").value.trim(),
      baseUrl: $("baseUrl").value.trim(),
    },
    ollamaApiKey: key,
    parallelApiKey: $("parallelApiKey").value.trim(),
    githubToken: $("githubToken").value.trim(),
    visionModelName: $("visionModelName").value.trim(),
    visionModelBaseUrl: $("visionModelBaseUrl").value.trim(),
    maxContextTokens: parseInt($("maxContextTokens").value, 10) || 120000,
    autonomyGrants: grants,
    consentGateEnabled: isToggleActive("consentGateEnabled"),
    cloudSyncPath: syncOn ? syncPath : "",
    sessionLogEnabled: isToggleActive("sessionLogEnabled"),
    sessionLogMaxChars: parseInt($("sessionLogMaxChars").value, 10) || 512,
  });
  await api.loadMain();
}

$("browseWorkspaceBtn").addEventListener("click", browseWorkspace);
$("browseSyncBtn").addEventListener("click", browseSyncDir);
$("saveBtn").addEventListener("click", saveSettings);
$("cancelBtn").addEventListener("click", () => api.loadMain());

["browserVisible", "syncEnabled", "sessionLogEnabled", "consentGateEnabled"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", () => el.classList.toggle("active"));
});

loadSettings();