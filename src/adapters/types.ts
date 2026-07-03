/**
 * Harness Adapter Contract — Part 2.B
 *
 * The adapter layer handles prompting shapes, tool format mapping,
 * tokenizer overrides, memory citation styling, and parsing.
 *
 * This solves the Model-Harness-Fit problem by decoupling the transport
 * layer (Provider) from the configuration and alignment layer (Adapter).
 */

import type { ModelInfo } from "../providers/types.js";

// ─── Types ───────────────────────────────────────────────────────────

export interface AdapterDefaults {
  maxContextTokens: number;
  maxOutputTokens: number;
  connectionTimeoutMs: number;
  streamStallTimeoutMs: number;
  toolCallTimeoutMs: number;
  preferredEditMode: "patch" | "string_replace" | "whole_file";
  citationStyle: "xml" | "markdown" | "none";
}

export interface MemorySource {
  file: string;
  section?: string;
}

export interface MemoryCitation {
  file: string;
  section?: string;
  text: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any;
}

export interface ParsedModelEvent {
  type: "text" | "tool_call" | "error" | "done" | "unsupported" | "reasoning";
  content?: string;
  toolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  error?: string;
  rawEvent?: any;
  rawDescription?: string;
  /** For "reasoning" events: the reasoning content (not persisted). */
  reasoning?: string;
}

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ToolCallParseError {
  error: string;
  raw: string;
}

export interface PromptAssemblyInput {
  identity: string;
  safetyPolicy: string;
  adapterInstructions: string;
  toolInstructions: string;
  memoryContext: string;
  projectContext: string;
  conversationSummary: string;
  recentMessages: any[];
  currentUserRequest: string;
}

// ─── Harness Adapter Interface ───────────────────────────────────────

export interface HarnessAdapter {
  id: string;
  displayName: string;
  supports(model: ModelInfo): boolean;
  getDefaults(model: ModelInfo): AdapterDefaults;
  buildSystemPrompt(input: PromptAssemblyInput): string;
  formatTools(tools: ToolDefinition[]): unknown;
  parseModelEvent(event: any): ParsedModelEvent;
  parseToolCall(raw: unknown): ParsedToolCall | ToolCallParseError;
  formatMemoryCitation(source: MemorySource): string;
  parseMemoryCitations(output: string): MemoryCitation[];
  estimateTokensFallback(input: string): number;
}

// ─── Default Adapter ─────────────────────────────────────────────────

/**
 * The default adapter — works with OpenAI-compatible models (GLM, GPT, etc.)
 * Uses XML-style memory citations and standard tool format.
 */
export class DefaultAdapter implements HarnessAdapter {
  id = "default";
  displayName = "Default (OpenAI-compatible)";

  supports(model: ModelInfo): boolean {
    // Default adapter supports all OpenAI-compatible models
    return true;
  }

  getDefaults(model: ModelInfo): AdapterDefaults {
    return {
      maxContextTokens: model.contextWindowTokens || 120000,
      maxOutputTokens: 16384,
      connectionTimeoutMs: 30000,
      streamStallTimeoutMs: 60000,
      toolCallTimeoutMs: 120000,
      preferredEditMode: "string_replace",
      citationStyle: "xml",
    };
  }

  buildSystemPrompt(input: PromptAssemblyInput): string {
    // Deterministic prompt assembly (US-11.1)
    const sections: string[] = [
      // 1. System identity
      input.identity,
      // 2. Safety policy
      input.safetyPolicy,
      // 3. Adapter instructions
      input.adapterInstructions,
      // 4. Tool instructions
      input.toolInstructions,
      // 5. Memory context
      input.memoryContext,
      // 6. Project context
      input.projectContext,
      // 7. Conversation summary (if any)
      input.conversationSummary,
    ].filter(Boolean);

    return sections.join("\n\n---\n\n");
  }

  formatTools(tools: ToolDefinition[]): unknown {
    // OpenAI function-calling format
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  parseModelEvent(event: any): ParsedModelEvent {
    if (event.type === "text_delta") {
      return { type: "text", content: event.content };
    }
    if (event.type === "reasoning_delta") {
      // Chain-of-thought tokens — recognized but not persisted (US-2.2)
      return { type: "reasoning", reasoning: event.reasoning };
    }
    if (event.type === "tool_call_start") {
      return {
        type: "tool_call",
        toolCall: {
          id: event.toolCallId || "",
          name: event.toolCallName || "",
          arguments: "",
        },
      };
    }
    if (event.type === "tool_call_delta") {
      return {
        type: "tool_call",
        toolCall: {
          id: event.toolCallId || "",
          name: "",
          arguments: event.toolCallArguments || "",
        },
      };
    }
    if (event.type === "error") {
      return { type: "error", error: event.error };
    }
    if (event.type === "unsupported") {
      return {
        type: "unsupported",
        rawEvent: event.rawEvent,
        rawDescription: event.rawDescription || "Unknown event type",
      };
    }
    // Only return 'done' for actual done events
    if (event.type === "done") {
      return { type: "done" };
    }
    // Unknown event types become 'unsupported' instead of silently becoming 'done'
    return {
      type: "unsupported",
      rawEvent: event,
      rawDescription: `Unrecognized event type: ${event.type || "undefined"}`,
    };
  }

  parseToolCall(raw: unknown): ParsedToolCall | ToolCallParseError {
    if (typeof raw !== "object" || raw === null) {
      return { error: "Tool call must be an object", raw: String(raw) };
    }

    const obj = raw as any;
    if (!obj.function?.name) {
      return { error: "Missing function.name", raw: JSON.stringify(raw) };
    }

    let args: any;
    try {
      args =
        typeof obj.function.arguments === "string"
          ? JSON.parse(obj.function.arguments)
          : obj.function.arguments || {};
    } catch {
      return {
        error: "Failed to parse tool arguments as JSON",
        raw: obj.function.arguments,
      };
    }

    return {
      id: obj.id || "",
      name: obj.function.name,
      arguments: args,
    };
  }

  formatMemoryCitation(source: MemorySource): string {
    if (this.getDefaults({} as ModelInfo).citationStyle === "xml") {
      return `<memory-citation doc="${source.file}"${source.section ? ` section="${source.section}"` : ""}>`;
    }
    if (this.getDefaults({} as ModelInfo).citationStyle === "markdown") {
      return `[${source.file}${source.section ? ` §${source.section}` : ""}]`;
    }
    return "";
  }

  parseMemoryCitations(output: string): MemoryCitation[] {
    const results: MemoryCitation[] = [];
    // XML style: <memory-citation doc="file" section="section">text</memory-citation>
    const xmlPattern =
      /<memory-citation\s+doc="([^"]*)"(?:\s+section="([^"]*)")?>([\s\S]*?)<\/memory-citation>/gi;
    let match: RegExpExecArray | null;
    while ((match = xmlPattern.exec(output)) !== null) {
      results.push({
        file: match[1],
        section: match[2] || undefined,
        text: match[3].trim(),
      });
    }

    // Markdown style: [file §section](text)
    const mdPattern = /\[([^\]§\s]+)(?:\s*§([^\]]+))?\]\(([^)]*)\)/g;
    while ((match = mdPattern.exec(output)) !== null) {
      results.push({
        file: match[1],
        section: match[2] || undefined,
        text: match[3].trim(),
      });
    }

    return results;
  }

  estimateTokensFallback(input: string): number {
    // Rough heuristic: ~4 chars per token
    return Math.ceil((input || "").length / 4);
  }
}

// ─── GLM Adapter ─────────────────────────────────────────────────────

/**
 * Adapter for GLM models (GLM-5.2, etc.)
 * GLM uses OpenAI-compatible API but may have different defaults.
 */
export class GLMAdapter extends DefaultAdapter {
  id = "glm";
  displayName = "GLM (GLM-5.2 compatible)";

  supports(model: ModelInfo): boolean {
    return (
      model.id.toLowerCase().includes("glm") ||
      model.displayName.toLowerCase().includes("glm")
    );
  }

  getDefaults(model: ModelInfo): AdapterDefaults {
    return {
      maxContextTokens: model.contextWindowTokens || 128000,
      maxOutputTokens: 16384,
      connectionTimeoutMs: 30000,
      streamStallTimeoutMs: 60000,
      toolCallTimeoutMs: 120000,
      preferredEditMode: "string_replace",
      citationStyle: "xml",
    };
  }
}

// ─── Claude Adapter ───────────────────────────────────────────────────

/**
 * Adapter for Claude models (Anthropic).
 * Uses Anthropic's message format with XML-style tool calls.
 */
export class ClaudeAdapter extends DefaultAdapter {
  id = "claude";
  displayName = "Claude (Anthropic)";

  supports(model: ModelInfo): boolean {
    return (
      model.id.toLowerCase().includes("claude") ||
      model.displayName.toLowerCase().includes("claude")
    );
  }

  getDefaults(model: ModelInfo): AdapterDefaults {
    return {
      maxContextTokens: model.contextWindowTokens || 200000,
      maxOutputTokens: 16384,
      connectionTimeoutMs: 30000,
      streamStallTimeoutMs: 60000,
      toolCallTimeoutMs: 120000,
      preferredEditMode: "patch",
      citationStyle: "xml",
    };
  }
}

// ─── Adapter Registry ────────────────────────────────────────────────

const adapters: Map<string, HarnessAdapter> = new Map();
const defaultAdapter = new DefaultAdapter();
const glmAdapter = new GLMAdapter();
const claudeAdapter = new ClaudeAdapter();

adapters.set("default", defaultAdapter);
adapters.set("glm", glmAdapter);
adapters.set("claude", claudeAdapter);

/**
 * Get an adapter by name.
 */
export function getAdapter(name: string): HarnessAdapter {
  return adapters.get(name) || defaultAdapter;
}

/**
 * Get the adapter that best fits a given model.
 */
export function getAdapterForModel(model: ModelInfo): HarnessAdapter {
  // Check specific adapters first (claude, glm), then fall back to the
  // default adapter. DefaultAdapter.supports() returns true for every model,
  // so it must be evaluated LAST or it would shadow the model-specific ones.
  for (const adapter of adapters.values()) {
    if (adapter.id === "default") continue;
    if (adapter.supports(model)) return adapter;
  }
  return defaultAdapter;
}

/**
 * Register a custom adapter.
 */
export function registerAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.id, adapter);
}

/**
 * List all registered adapters.
 */
export function listAdapters(): HarnessAdapter[] {
  return Array.from(adapters.values());
}
