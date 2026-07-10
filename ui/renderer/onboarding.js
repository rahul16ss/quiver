// Onboarding — zero-config first run. Stores the single API key in the OS
// keychain (preferred) with a saveConfig fallback. Plain business language.

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
          inKeychain = await api.settingsSetCredential("OLLAMA_API_KEY", key);
        } catch {
          inKeychain = false;
        }
      }
      // Also mirror into the config so the agent process picks it up this session.
      const config = await api.loadConfig();
      config.ollamaApiKey = key;
      config.provider = config.provider || {};
      config.provider.apiKey = key;
      await api.saveConfig(config);
      if (!inKeychain) {
        // Non-blocking: the key was saved to config (.env via sync), not the keychain.
      }
    }
    await api.loadMain();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Get started";
    alert("Could not save your key. You can add it later in Settings.");
  }
});