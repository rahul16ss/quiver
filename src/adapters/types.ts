/**
 * Harness Adapter Contract
 *
 * The adapter layer handles prompting shapes, tool format mapping,
 * tokenizer overrides, memory citation styling, and parsing.
 *
 * With the single-generic-adapter architecture (2026-07-30), there is ONE
 * adapter — the DefaultAdapter — which works with any OpenAI-compatible
 * model. The specialized GLM and Claude adapters were removed because:
 *   1. They only overrode `getDefaults()` with slightly different numbers
 *      (context window sizes, edit mode) — configurable via .env now
 *   2. They introduced model-name-sniffing that would break with renamed
 *      or new models (fragile `includes("glm")` / `includes("claude")`)
 *   3. All models use the same OpenAI-compatible API surface
 *
 * Sampling parameters (temperature, top_p, top_k, reasoning_effort) are
 * configurable via .env so the user can tune per-model without code changes.
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
  /** Optional bound CustomerPack (ADR-004 seam): when set, the assembler inserts
   *  the customer-pack + capital-markets domain-policy layers. Additive; when
   *  unset the legacy 9-section assembly is unchanged. */
  customerPack?: import("../harness/customer-pack.js").CustomerPack;
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

// ─── Generic Adapter (OpenAI-compatible) ──────────────────────────────

/**
 * The single generic adapter — works with any OpenAI-compatible model.
 * Uses XML-style memory citations and standard tool format.
 *
 * Sampling parameters are read from env/config at the call site (agent.ts),
 * not hardcoded here. The adapter only provides structural defaults
 * (timeouts, edit mode, citation style).
 */
export class DefaultAdapter implements HarnessAdapter {
  id = "default";
  displayName = "OpenAI-compatible";

  supports(_model: ModelInfo): boolean {
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
    const sections: string[] = [
      input.identity,
      input.safetyPolicy,
      input.adapterInstructions,
      input.toolInstructions,
      input.memoryContext,
      input.projectContext,
      input.conversationSummary,
    ].filter(Boolean);
    return sections.join("\n\n---\n\n");
  }

  formatTools(tools: ToolDefinition[]): unknown {
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
    if (event.type === "done") {
      return { type: "done" };
    }
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
    return `<memory-citation doc="${source.file}"${source.section ? ` section="${source.section}"` : ""}>`;
  }

  parseMemoryCitations(output: string): MemoryCitation[] {
    const results: MemoryCitation[] = [];
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
    return Math.ceil((input || "").length / 4);
  }
}

// ─── Adapter Registry ────────────────────────────────────────────────

const adapters: Map<string, HarnessAdapter> = new Map();
const defaultAdapter = new DefaultAdapter();
adapters.set("default", defaultAdapter);

export function getAdapter(name: string): HarnessAdapter {
  return adapters.get(name) || defaultAdapter;
}

export function getAdapterForModel(_model: ModelInfo): HarnessAdapter {
  // Single adapter — always the generic one.
  return defaultAdapter;
}

export function registerAdapter(adapter: HarnessAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function listAdapters(): HarnessAdapter[] {
  return Array.from(adapters.values());
}
