/**
 * Shared type definitions used across the Quiver codebase.
 *
 * Extracted from agent.ts to break circular dependencies and enable
 * independent module testing.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | null
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

/** Events emitted during prompt execution for GUI consumption. */
export interface AgentEvent {
  type:
    | "token"
    | "tool_call"
    | "tool_result"
    | "approval"
    | "done"
    | "error"
    | "context_manifest";
  data: {
    text?: string;
    toolName?: string;
    toolArgs?: Record<string, unknown>;
    toolResult?: string;
    approved?: boolean;
    response?: string;
    error?: string;
    model?: string;
    memory?: string;
    skills?: string;
    tools?: string;
    tokens?: string;
    tokenStats?: {
      inputTokens: number;
      outputTokens: number;
      toolCalls: number;
      turns: number;
    };
  };
}
