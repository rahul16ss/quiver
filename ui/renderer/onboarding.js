// Onboarding — zero-config first run. Stores the API key in the OS credential
// store and refuses to persist it in the JSON config if that store is unavailable.

const api = window.quiver;
const $ = (id) => document.getElementById(id);

$("onbStartBtn").addEventListener("click", async () => {
  const key = $("onbKey").value.trim();
  const btn = $("onbStartBtn");
  btn.disabled = true;
  btn.textContent = "Setting up…";
  try {
    if (key) {
      // Prefer the OS keychain (settings:set-credential → keychain.ts).
      let inKeychain = false;
      if (typeof api.settingsSetCredential === "function") {
        try {
          inKeychain = await api.settingsSetCredential("LLM_API_KEY", key);
        } catch {
          inKeychain = false;
        }
      }
      if (!inKeychain) {
        throw new Error("The system credential store is unavailable.");
      }
      // The main process hydrates the key from the credential store when the
      // agent starts; no secret is sent back into the renderer config.
      const config = await api.loadConfig();
      const saved = await api.saveConfig({
        ...config,
        provider: { ...(config.provider || {}), apiKey: "" },
        llmApiKey: "",
        parallelApiKey: "",
      });
      if (!saved) throw new Error("Could not save the workspace settings securely.");
    }
    await api.loadMain();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Get started";
    let err = document.getElementById("onbError");
    if (!err) {
      err = document.createElement("p");
      err.id = "onbError";
      err.className = "onboarding-error";
      err.setAttribute("role", "alert");
      btn.parentElement?.appendChild(err);
    }
    err.textContent = "Could not save your key. You can add it later in Settings.";
  }
});