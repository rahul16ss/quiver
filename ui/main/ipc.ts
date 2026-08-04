import { app, ipcMain, dialog, shell } from "electron";
import * as path from "path";
import { resolveAndAssertPathAllowed, createDefaultPolicy } from "../../src/security/path_policy.ts";
import {
  DEFAULT_CONFIG,
  loadConfig,
  saveConfig,
  withoutSecrets,
  migratePlaintextCredentials,
  isConfigured,
  isWorkspaceAppSource,
  getWorkingDir,
  syncToEnv,
  type QuiverConfig,
} from "./config.ts";
import { storedCredential, hydrateRuntimeConfig, setStoredCredential } from "./credentials.ts";
import {
  startAgent,
  sendToAgent,
  approveToolCall,
  stopAgent,
  sendConsentDecision,
} from "./agent-bridge.ts";
import {
  listMemoryFiles,
  saveMemoryFile,
  deleteMemoryFile,
  toggleExcludedMemory,
  loadCoreMemory,
  saveCoreMemory,
  excludedMemories,
} from "./memory.ts";
import {
  listSessions,
  loadSessionFile,
  deleteSessionFile,
  touchSessionFile,
  sessionPathGuard,
  sessionPolicyFor,
} from "./sessions.ts";
import { reviewWithEvidenceGate } from "./review.ts";
import {
  findOfficeCliBinary,
  runWorkspaceTests,
  listSkills,
  readSkillFile,
  saveSkillFile,
  rerunWorkflow,
  previewFile,
  loadEvidence,
} from "./workspace.ts";
import {
  createSettingsWindow,
  loadMainView,
  loadOnboardingView,
} from "./windows.ts";
import {
  closeSettingsWindow,
  focusSettingsWindow,
  getMainWindow,
} from "./windows-state.ts";
import { PROJECT_ROOT, UI_DIR } from "./paths.ts";

function ipcPathGuard(filePath: string, op: "read" | "write"): string | null {
  try {
    const workspace = process.cwd();
    const policy = createDefaultPolicy(workspace);
    resolveAndAssertPathAllowed(filePath, op, policy);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle("config:load", async () => {
    const loaded = await loadConfig();
    const config = await migratePlaintextCredentials(loaded);
    return {
      ...withoutSecrets(config),
      credentials: {
        llmApiKeyStored: Boolean(
          (await storedCredential("LLM_API_KEY")) || process.env.LLM_API_KEY,
        ),
        parallelApiKeyStored: Boolean(
          (await storedCredential("PARALLEL_API_KEY")) || process.env.PARALLEL_API_KEY,
        ),
      },
      workspaceIsAppSource: isWorkspaceAppSource(config.workspacePath || ""),
    };
  });
  ipcMain.handle("config:save", async (_evt, config: QuiverConfig) => {
    const saved = await saveConfig(config);
    if (!saved) return false;
    await syncToEnv(withoutSecrets(config));
    return true;
  });
  ipcMain.handle("config:isConfigured", async () => isConfigured());

  ipcMain.handle("agent:start", async (_evt, config: QuiverConfig, resumeLatest: boolean = false) => {
    const persisted = await loadConfig();
    const merged = {
      ...persisted,
      ...config,
      provider: {
        ...(persisted.provider || DEFAULT_CONFIG.provider),
        ...(config.provider || {}),
        apiKey:
          persisted.provider?.apiKey ||
          config.provider?.apiKey ||
          "",
      },
    };
    await startAgent(await hydrateRuntimeConfig(merged), resumeLatest);
    return true;
  });
  ipcMain.handle("agent:send", async (_evt, text: string) => {
    sendToAgent(text);
    return true;
  });
  ipcMain.handle("agent:approve", async (_evt, payload: any) => {
    const approve = typeof payload === "boolean" ? payload : payload?.approve === true;
    const note = typeof payload === "object" && payload ? payload?.note : undefined;
    approveToolCall(approve, note);
    return true;
  });
  ipcMain.handle("agent:stop", async () => {
    await stopAgent();
    return true;
  });

  ipcMain.handle("sessions:list", async () => listSessions());
  ipcMain.handle("sessions:load", async (_evt, filePath: string) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "read", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return loadSessionFile(filePath);
  });
  ipcMain.handle("sessions:delete", async (_evt, filePath: string, permanent: boolean = false) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "write", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return deleteSessionFile(filePath, permanent);
  });
  ipcMain.handle("sessions:touch", async (_evt, filePath: string) => {
    const guardErr = await sessionPathGuard(filePath);
    if (guardErr) return { error: guardErr };
    try {
      resolveAndAssertPathAllowed(filePath, "write", sessionPolicyFor(filePath));
    } catch (e: any) {
      return { error: e?.message || "Path policy rejected the session path" };
    }
    return touchSessionFile(filePath);
  });

  ipcMain.handle("memory:list", async () => listMemoryFiles());
  ipcMain.handle("memory:save", async (_evt, name: string, content: string) =>
    saveMemoryFile(name, content),
  );
  ipcMain.handle("memory:delete", async (_evt, name: string) =>
    deleteMemoryFile(name),
  );
  ipcMain.handle("memory:loadCore", async () => loadCoreMemory());
  ipcMain.handle("memory:saveCore", async (_evt, coreMemory: any) => {
    const memoryFile = path.join(app.getPath("home"), ".quiver", "core.json");
    const guardErr = ipcPathGuard(memoryFile, "write");
    if (guardErr) return false;
    return saveCoreMemory(coreMemory);
  });

  ipcMain.handle("settings:get", async () => loadConfig());
  ipcMain.handle("settings:update", async (_evt, payload: { section: string; values: any }) => {
    const config = await loadConfig();
    const { section, values } = payload;
    if (section === "provider") {
      config.provider = { ...config.provider, ...values };
    } else if (section === "autonomy") {
      config.autonomyGrants = values.grants || "";
    } else if (section === "memory") {
      config.sessionLogEnabled = values.sessionLogEnabled !== false;
      config.sessionLogMaxChars = values.sessionLogMaxChars || 512;
    } else if (section === "consent") {
      config.consentGateEnabled = values.consentGateEnabled === true;
    }
    await saveConfig(config);
    return true;
  });
  ipcMain.handle("settings:set-credential", async (_evt, payload: { key: string; value: string }) =>
    setStoredCredential(payload.key, payload.value),
  );

  ipcMain.handle("memory:review:list", async () => {
    try {
      const { getAllFactsForReview } = await import("../../src/memory/review_queue.js");
      return await getAllFactsForReview();
    } catch {
      return [];
    }
  });
  ipcMain.handle("memory:review:action", async (_evt, payload: { factId: string; action: string; content: string }) => {
    try {
      const { processReview } = await import("../../src/memory/review_queue.js");
      return await processReview(payload.factId, payload.action as any, payload.content || undefined);
    } catch (error: any) {
      return { action: payload.action, factId: payload.factId, success: false, message: error?.message || "Failed" };
    }
  });

  ipcMain.handle("memory:exclude", async (_evt, payload: { memoryName: string }) => {
    if (payload?.memoryName) {
      toggleExcludedMemory(payload.memoryName);
    }
    return { excluded: [...excludedMemories] };
  });

  ipcMain.handle("consent:respond", async (_evt, payload: { decision: string }) => {
    const decision = String(payload?.decision || "").toLowerCase();
    const token = decision.startsWith("e")
      ? "exclude"
      : /^(a|y|yes|approve|allow)$/.test(decision)
        ? "approve"
        : "decline";
    return sendConsentDecision(token);
  });

  ipcMain.handle("review:markFinal", async (_evt, payload: any) =>
    reviewWithEvidenceGate(payload?.filePath, payload?.openFlags || 0, "marked_final", payload?.figureStatuses),
  );
  ipcMain.handle("review:override", async (_evt, payload: any) =>
    reviewWithEvidenceGate(payload?.filePath, payload?.openFlags || 0, "override", payload?.figureStatuses),
  );

  ipcMain.handle("skills:list", async () => {
    const config = await loadConfig();
    return listSkills(config.workspacePath || process.cwd(), config.skillsDir || "./skills");
  });
  ipcMain.handle("skills:read", async (_evt, skillName: string) => readSkillFile(skillName));
  ipcMain.handle("skills:save", async (_evt, skillName: string, content: string) => {
    const globalSkillsDir = path.join(app.getPath("home"), ".quiver", "skills");
    const skillFile = path.join(globalSkillsDir, skillName, "SKILL.md");
    try {
      resolveAndAssertPathAllowed(skillFile, "write", createDefaultPolicy(globalSkillsDir));
    } catch {
      return false;
    }
    return saveSkillFile(skillName, content);
  });

  ipcMain.handle("workspace:runTests", async () => runWorkspaceTests());
  ipcMain.handle("workspace:selectDir", async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  });

  ipcMain.handle("workflow:rerun", async () => {
    const demoRoot = app.isPackaged
      ? path.join(process.resourcesPath, "quiver-demo")
      : PROJECT_ROOT;
    return rerunWorkflow(demoRoot);
  });

  ipcMain.handle("file:open", async (_evt, filePath: string) => {
    const { validateDeliverablePath } = await import("./review.ts");
    const err = await validateDeliverablePath(filePath);
    if (err) return { error: err };
    const result = await shell.openPath(path.resolve(filePath));
    return result ? { error: result } : { ok: true };
  });
  ipcMain.handle("file:showInFolder", async (_evt, filePath: string) => {
    const { validateDeliverablePath } = await import("./review.ts");
    const err = await validateDeliverablePath(filePath);
    if (err) return { error: err };
    shell.showItemInFolder(path.resolve(filePath));
    return { ok: true };
  });

  ipcMain.handle("evidence:load", async (_evt, docFilePath: string) =>
    loadEvidence(docFilePath, ipcPathGuard),
  );

  ipcMain.handle("preview:file", async (_evt, filePath: string) => {
    const guardErr = ipcPathGuard(filePath, "read");
    if (guardErr) return { error: guardErr };
    return previewFile(filePath, ipcPathGuard);
  });

  ipcMain.handle("nav:loadMain", async () => {
    closeSettingsWindow();
    loadMainView();
  });
  ipcMain.handle("nav:loadSettings", async () => {
    if (focusSettingsWindow()) return;
    await createSettingsWindow();
  });
  ipcMain.handle("nav:loadOnboarding", async () => {
    loadOnboardingView();
  });
}
