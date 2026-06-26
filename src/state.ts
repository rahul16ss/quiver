import { promises as fs } from "fs";
import * as path from "path";
import { Agent, Message } from "./agent.js";
import { config } from "./config.js";

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

const MEMORY_FILE = path.resolve("memory", "core.json");

/**
 * Loads the structured Quiver Core Memory.
 * If the file doesn't exist, returns default starting memory fields.
 */
export async function loadCoreMemory(): Promise<CoreMemory> {
  try {
    await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    const content = await fs.readFile(MEMORY_FILE, "utf8");
    return JSON.parse(content);
  } catch (err) {
    const defaults: CoreMemory = {
      identity:
        "You are Quiver, a self-evolving coding and research assistant running in the terminal.",
      human_context: "",
      project_context:
        "This workspace is an agent harness containing TS tools, test runners, and configuration.",
    };
    await saveCoreMemory(defaults);
    return defaults;
  }
}

/**
 * Persists the core memory sections back to memory/core.json.
 */
export async function saveCoreMemory(memory: CoreMemory): Promise<void> {
  await fs.mkdir(path.dirname(MEMORY_FILE), { recursive: true });
  await fs.writeFile(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");
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
  const systemPrompt =
    agent.getMessages().find((m) => m.role === "system")?.content || "";

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
    messages: agent.getMessages(),
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
