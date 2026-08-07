// Settings — loads/saves via the daemon's loadConfig/saveConfig API. Secrets
// go to the OS credential store; everything else persists on the daemon side
// and applies without a restart. Plain business language only.

const api = window.quiver;
const $ = (id) => document.getElementById(id);

let currentConfig = null;

async function loadSettings() {
  currentConfig = await api.loadConfig();
  $("workspacePath").value = currentConfig.workspacePath || "";
  const modelName = currentConfig.provider?.modelName || "";
  // "model chosen by workflow" is a display alias for the automatic profile,
  // not a value the user typed — show it as a placeholder, not editable text.
  if (modelName === "model chosen by workflow") {
    $("modelName").value = "";
    $("modelName").placeholder = "Chosen automatically by the workflow";
  } else {
    $("modelName").value = modelName;
  }
  $("baseUrl").value = currentConfig.provider?.baseUrl || "";
  $("checkerModelName").value = currentConfig.checkerModelName || "";
  $("maxContextTokens").value = currentConfig.maxContextTokens || 120000;
  $("apiKey").value = "";
  $("parallelApiKey").value = "";
  $("apiKey").placeholder = currentConfig.credentials?.llmApiKeyStored
    ? "Stored in your system credential store"
    : "Enter provider key";
  $("parallelApiKey").placeholder = currentConfig.credentials?.parallelApiKeyStored
    ? "Stored in your system credential store"
    : "Optional provider key";

  const grants = currentConfig.autonomyGrants || "";
  const parts = grants.split(",");
  const tierGrant = parts.find((g) => g.startsWith("tier:") || g === "yolo") || "";
  $("autonomyMode").value = tierGrant;
  setToggle("browserVisible", grants.includes("browser:visible"));
  setToggle("consentGateEnabled", currentConfig.consentGateEnabled === true);
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

function showSettingsError(message) {
  let el = document.getElementById("settingsInlineError");
  if (!el) {
    el = document.createElement("div");
    el.id = "settingsInlineError";
    el.className = "settings-inline-error";
    el.setAttribute("role", "alert");
    const host = document.querySelector(".settings-body") || document.body;
    host.prepend(el);
  }
  el.hidden = false;
  el.textContent = message;
}

async function saveSettings() {
  let grants = $("autonomyMode").value;
  if (isToggleActive("browserVisible")) {
    grants = grants ? grants + ",browser:visible" : "browser:visible";
  }
  // Store credentials in the OS credential store. Never mirror them into the
  // JSON config or a workspace .env file.
  const key = $("apiKey").value.trim();
  if (key && typeof api.settingsSetCredential === "function") {
    try {
      const stored = await api.settingsSetCredential("LLM_API_KEY", key);
      if (!stored) {
        showSettingsError(
          "Quiver could not access the system credential store. The key was not saved.",
        );
        return;
      }
    } catch {
      showSettingsError(
        "Quiver could not access the system credential store. The key was not saved.",
      );
      return;
    }
  }
  const parallelKey = $("parallelApiKey").value.trim();
  if (parallelKey && typeof api.settingsSetCredential === "function") {
    try {
      const stored = await api.settingsSetCredential("PARALLEL_API_KEY", parallelKey);
      if (!stored) {
        showSettingsError(
          "Quiver could not store the second provider key securely. It was not saved.",
        );
        return;
      }
    } catch {
      showSettingsError(
        "Quiver could not store the second provider key securely. It was not saved.",
      );
      return;
    }
  }

  const saved = await api.saveConfig({
    ...(currentConfig || {}),
    provider: {
      ...currentConfig?.provider,
      apiKey: "",
      modelName: $("modelName").value.trim(),
      baseUrl: $("baseUrl").value.trim(),
    },
    checkerModelName: $("checkerModelName").value.trim(),
    llmApiKey: "",
    parallelApiKey: "",
    maxContextTokens: parseInt($("maxContextTokens").value, 10) || 120000,
    autonomyGrants: grants,
    consentGateEnabled: isToggleActive("consentGateEnabled"),
    sessionLogEnabled: isToggleActive("sessionLogEnabled"),
    sessionLogMaxChars: parseInt($("sessionLogMaxChars").value, 10) || 512,
  });
  if (!saved) {
    showSettingsError("Quiver could not save these settings securely.");
    return;
  }
  await api.loadMain();
}

$("saveBtn").addEventListener("click", saveSettings);
$("cancelBtn").addEventListener("click", () => api.loadMain());

["browserVisible", "sessionLogEnabled", "consentGateEnabled"].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener("click", () => el.classList.toggle("active"));
});

loadSettings();
