import { app } from "electron";
import * as path from "path";
import * as os from "os";
import * as fsSync from "fs";
import { config } from "../../src/config.ts";
import { PROJECT_ROOT, UI_DIR } from "./paths.ts";
import { storedCredential } from "./credentials.ts";

export interface ProviderConfig {
  baseUrl: string;
  modelName: string;
  apiKey: string;
}

export interface QuiverConfig {
  workspacePath: string;
  provider: ProviderConfig;
  parallelApiKey: string;
  llmApiKey: string;
  /** Customer GCP project for Vertex AI (BYOK billing). Path-only credentials. */
  vertexProjectId?: string;
  /** Vertex location (global or region). */
  vertexLocation?: string;
  /** Absolute path to the customer's service-account JSON (never the JSON body). */
  googleApplicationCredentials?: string;
  /** Optional checker model (from CHECKER_LLM_MODEL_NAME / Settings). */
  checkerModelName?: string;
  /** Comma-separated autonomy grants (e.g. "write_file,run_command" or "yolo"). */
  autonomyGrants: string;
  maxContextTokens: number;
  memoryDir: string;
  skillsDir: string;
  sessionLogEnabled?: boolean;
  sessionLogMaxChars?: number;
  /** Deployment profile, e.g. finance-client. */
  profile?: string;
  /** SPEC §6 consent gate — when true the agent blocks on pre-action approval. */
  consentGateEnabled?: boolean;
}

export const CONFIG_FILE = path.join(app.getPath("userData"), "quiver-config.json");

/** Resolve the directory that contains Quiver's own package.json. */
export function getQuiverInstallDir(): string {
  if (app.isPackaged) return process.resourcesPath;
  let dir = PROJECT_ROOT;
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(
        fsSync.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      if (typeof pkg.name === "string" && pkg.name.includes("quiver")) {
        return dir;
      }
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return PROJECT_ROOT;
}

const DEFAULT_WORKSPACE = path.join(os.homedir(), "Quiver Workspace");

export function isWorkspaceAppSource(workspacePath: string): boolean {
  if (!workspacePath) return false;
  try {
    const installDir = fsSync.realpathSync(getQuiverInstallDir());
    let ws = path.resolve(workspacePath);
    try {
      ws = fsSync.realpathSync(ws);
    } catch {}
    const rel = path.relative(installDir, ws);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

export const DEFAULT_CONFIG: QuiverConfig = {
  workspacePath: DEFAULT_WORKSPACE,
  provider: {
    baseUrl: config.llmBaseUrl,
    modelName: config.llmModelName,
    apiKey: "",
  },
  parallelApiKey: "",
  llmApiKey: "",
  vertexProjectId: config.vertexProjectId || "",
  vertexLocation: config.vertexLocation || "global",
  googleApplicationCredentials: config.googleApplicationCredentials || "",
  checkerModelName: config.checkerModelName || "",
  autonomyGrants: "",
  maxContextTokens: config.maxContextTokens,
  memoryDir: "./memory",
  skillsDir: "./skills",
  profile: process.env.QUIVER_PROFILE || "",
  consentGateEnabled:
    process.env.QUIVER_CONSENT_GATE === "1" ||
    (process.env.QUIVER_PROFILE === "finance-client" &&
      process.env.QUIVER_CONSENT_GATE !== "0"),
};

export async function loadConfig(): Promise<QuiverConfig> {
  try {
    const fs = await import("fs/promises");
    const content = await fs.readFile(CONFIG_FILE, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(content) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function withoutSecrets(config: QuiverConfig): QuiverConfig {
  const { workspaceIsAppSource: _workspaceIsAppSource, credentials: _credentials, ...persisted } =
    config as QuiverConfig & { workspaceIsAppSource?: boolean; credentials?: unknown };
  return {
    ...persisted,
    provider: {
      ...(config.provider || DEFAULT_CONFIG.provider),
      apiKey: "",
    },
    llmApiKey: "",
    parallelApiKey: "",
  };
}

/** Move legacy plaintext API keys into the OS credential store. */
export async function migratePlaintextCredentials(config: QuiverConfig): Promise<QuiverConfig> {
  try {
    const { setCredential } = await import("../../src/secrets/keychain.js");
    let migrated = false;
    const llm =
      config.provider?.apiKey ||
      config.llmApiKey ||
      "";
    const parallel = config.parallelApiKey || "";
    if (llm && llm.trim()) {
      await setCredential("LLM_API_KEY", llm.trim());
      migrated = true;
    }
    if (parallel && parallel.trim()) {
      await setCredential("PARALLEL_API_KEY", parallel.trim());
      migrated = true;
    }
    if (!migrated) return config;
    const cleaned = withoutSecrets(config);
    await saveConfig(cleaned);
    return cleaned;
  } catch {
    return withoutSecrets(config);
  }
}

export async function saveConfig(config: QuiverConfig): Promise<boolean> {
  try {
    delete (config as any).workspaceIsAppSource;
    const secrets = [
      ["LLM_API_KEY", config.llmApiKey || config.provider?.apiKey || ""],
      ["PARALLEL_API_KEY", config.parallelApiKey || ""],
    ] as const;
    if (secrets.some(([, value]) => value)) {
      const { isKeychainAvailable, setCredential } = await import(
        "../../src/secrets/keychain.js"
      );
      if (!isKeychainAvailable()) {
        console.error("Refusing to persist credentials without an OS credential store.");
        return false;
      }
      for (const [key, value] of secrets) {
        if (value && !(await setCredential(key, value))) {
          console.error(`Could not store ${key} in the OS credential store.`);
          return false;
        }
      }
    }
    const fs = await import("fs/promises");
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      JSON.stringify(withoutSecrets(config), null, 2),
      "utf8",
    );
    return true;
  } catch (err) {
    console.error("Failed to save config:", err);
    return false;
  }
}

export async function isConfigured(): Promise<boolean> {
  const cfg = await loadConfig();
  const vertexReady = Boolean(
    (cfg.vertexProjectId || process.env.VERTEX_PROJECT_ID || "").trim(),
  );
  return Boolean(
    cfg.provider.apiKey ||
      (await storedCredential("LLM_API_KEY")) ||
      process.env.LLM_API_KEY ||
      vertexReady,
  );
}

export function getWorkingDir(cfg: QuiverConfig): string {
  if (cfg.workspacePath) return cfg.workspacePath;
  if (!app.isPackaged) {
    return PROJECT_ROOT;
  }
  return path.join(app.getPath("home"), ".quiver");
}

export async function ensureWorkingDir(dir: string): Promise<void> {
  try {
    const fs = await import("fs/promises");
    await fs.mkdir(dir, { recursive: true });
    const quiverRoot = path.join(app.getPath("home"), ".quiver");
    await fs.mkdir(quiverRoot, { recursive: true });
    await fs.mkdir(path.join(quiverRoot, "skills"), { recursive: true });
    const projectName = path.basename(dir) || "default";
    await fs.mkdir(path.join(quiverRoot, "projects", projectName, "memory"), { recursive: true });
    await fs.mkdir(path.join(quiverRoot, "projects", projectName, ".sessions"), { recursive: true });
  } catch {
    // Non-critical
  }
}

export async function syncToEnv(cfg: QuiverConfig): Promise<void> {
  try {
    const fs = await import("fs/promises");
    const workingDir = getWorkingDir(cfg);
    await ensureWorkingDir(workingDir);
    const envPath = path.resolve(workingDir, ".env");
    let envContent = "";

    try {
      envContent = await fs.readFile(envPath, "utf8");
    } catch {
      try {
        envContent = await fs.readFile(
          path.resolve(cfg.workspacePath || process.cwd(), ".env.example"),
          "utf8",
        );
      } catch {
        envContent = "";
      }
    }

    const vertexProject = (cfg.vertexProjectId || "").trim();
    const replacements: Record<string, string> = {
      LLM_API_BASE_URL: cfg.provider.baseUrl,
      LLM_MODEL_NAME: cfg.provider.modelName,
      LLM_API_KEY: "",
      PARALLEL_API_KEY: "",
      VERTEX_PROJECT_ID: vertexProject,
      VERTEX_LOCATION: (cfg.vertexLocation || "global").trim() || "global",
      GOOGLE_APPLICATION_CREDENTIALS: (
        cfg.googleApplicationCredentials || ""
      ).trim(),
      CHECKER_LLM_MODEL_NAME: (cfg.checkerModelName || "").trim(),
      QUIVER_AUTONOMY: cfg.autonomyGrants || "",
      QUIVER_MAX_CONTEXT_TOKENS: String(cfg.maxContextTokens),
    };
    // Intentionally omit QUIVER_CHECKER_REMOTE_APPROVED from .env persistence.
    // The GUI sets it only in the agent child process env (agent-bridge) so
    // CLI sessions do not permanently inherit a loosened checker policy.

    for (const [key, value] of Object.entries(replacements)) {
      const regex = new RegExp(`^${key}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    }

    await fs.writeFile(envPath, envContent.trim() + "\n", "utf8");
  } catch (err) {
    console.error("Failed to sync .env:", err);
  }
}
