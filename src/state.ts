import { promises as fs } from "fs";
import * as path from "path";
import { Agent, Message } from "./agent.js";
import { config } from "./config.js";
import { getCoreMemoryPath, getProjectMemoryDir } from "./paths.js";

export interface CoreMemory {
  identity: string;
  human_context: string;
  project_context: string;
}

export interface AgentFile {
  format: "quiver-qf";
  version: string;
  metadata: {
    name: string;
    exportedAt: string;
    sessionId: string;
  };
  system_prompt: string;
  core_memory: CoreMemory;
  model_config: {
    model: string;
    baseUrl: string;
  };
  messages: Message[];
}

/**
 * Loads the structured Quiver Core Memory.
 * Identity and human_context are global (shared across projects).
 * project_context is per-project (loaded from the project's memory dir).
 * If files don't exist, returns default starting memory fields.
 */
export async function loadCoreMemory(): Promise<CoreMemory> {
  const corePath = getCoreMemoryPath();
  let globalMemory: { identity: string; human_context: string } = {
    identity:
      "You are Quiver, an AI work assistant for business users — analysts, researchers, consultants, and legal professionals.",
    human_context: "",
  };

  // Load global identity + human context
  try {
    const content = await fs.readFile(corePath, "utf8");
    globalMemory = JSON.parse(content);
  } catch {
    // First run — create with defaults
    await fs.mkdir(path.dirname(corePath), { recursive: true });
    await fs.writeFile(
      corePath,
      JSON.stringify(globalMemory, null, 2),
      "utf8",
    );
  }

  // Load per-project context
  const projectContextPath = path.join(getProjectMemoryDir(), "project.json");
  let projectContext = "";
  try {
    const content = await fs.readFile(projectContextPath, "utf8");
    const parsed = JSON.parse(content);
    projectContext = parsed.project_context || "";
  } catch {
    // First run for this project — create default
    const defaults = {
      project_context: `This workspace is ${path.basename(process.cwd())}.`,
    };
    await fs.mkdir(path.dirname(projectContextPath), { recursive: true });
    await fs.writeFile(
      projectContextPath,
      JSON.stringify(defaults, null, 2),
      "utf8",
    );
    projectContext = defaults.project_context;
  }

  return {
    identity: globalMemory.identity,
    human_context: globalMemory.human_context,
    project_context: projectContext,
  };
}

/**
 * Persists core memory — splits global (identity, human_context) from
 * per-project (project_context) into separate files.
 */
export async function saveCoreMemory(memory: CoreMemory): Promise<void> {
  // Save global part
  const corePath = getCoreMemoryPath();
  await fs.mkdir(path.dirname(corePath), { recursive: true });
  await fs.writeFile(
    corePath,
    JSON.stringify(
      { identity: memory.identity, human_context: memory.human_context },
      null,
      2,
    ),
    "utf8",
  );

  // Save project-specific part
  const projectContextPath = path.join(getProjectMemoryDir(), "project.json");
  await fs.mkdir(path.dirname(projectContextPath), { recursive: true });
  await fs.writeFile(
    projectContextPath,
    JSON.stringify({ project_context: memory.project_context }, null, 2),
    "utf8",
  );
}

/**
 * Serializes the agent's system prompt, current messages, core memory blocks,
 * and active model configuration into a portable '.af' (Agent File) JSON file.
 */
export async function exportToAgentFile(
  agent: Agent,
  targetPath: string,
): Promise<void> {
  const coreMemory = await loadCoreMemory();
  const systemPromptRaw =
    agent.getMessages().find((m) => m.role === "system")?.content || "";
  const systemPrompt =
    typeof systemPromptRaw === "string" ? systemPromptRaw : "";

  const af: AgentFile = {
    format: "quiver-qf",
    version: "1.0.0",
    metadata: {
      name: "quiver-agent-state",
      exportedAt: new Date().toISOString(),
      sessionId: agent.getSessionId(),
    },
    system_prompt: systemPrompt,
    core_memory: coreMemory,
    model_config: {
      model: config.llmModelName,
      baseUrl: config.llmBaseUrl,
    },
    messages: agent.getMessages().map((m) => ({
      ...m,
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("\n")
            : "",
    })),
  };

  await fs.writeFile(targetPath, JSON.stringify(af, null, 2), "utf8");
}

/**
 * Restores the agent's messages list and core memory from a '.af' agent file.
 */
export async function importFromAgentFile(
  agent: Agent,
  sourcePath: string,
): Promise<void> {
  const content = await fs.readFile(sourcePath, "utf8");
  const af: AgentFile = JSON.parse(content);

  if (af.format !== "quiver-qf") {
    throw new Error("Invalid format: Not a Quiver Agent File (.qf)");
  }

  // Restore core memory
  await saveCoreMemory(af.core_memory);

  // Re-populate agent's internal message history
  const messages = agent.getMessages();
  messages.length = 0; // Clear array in place
  messages.push(...af.messages);
}
