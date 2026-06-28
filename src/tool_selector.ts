import { config } from "./config.js";
import { ToolRegistry, globalRegistry, Tool } from "./registry.js";

/**
 * LLM Tool Selector Primitive
 *
 * Instead of sending every available tool definition to the model on every call
 * (which wastes context tokens and can confuse the model), this module
 * uses a lightweight LLM call to select the most relevant tools based on
 * the current conversation context.
 *
 * Flow:
 * 1. Build a compact list of tool names + one-line descriptions
 * 2. Send a short prompt to the LLM: "Given this user request, which tools are relevant?"
 * 3. Parse the response and filter the tool registry
 * 4. Fall back to all tools if the selection call fails or returns nothing
 *
 * This is a "low-level primitive" (Principle 05) — it's a building block,
 * not a black box. The selection is transparent and logged.
 */

interface ToolSelectionResult {
  selectedTools: string[];
  reasoning: string;
}

/**
 * Build a compact tool catalog for the selection prompt.
 * Format: "tool_name: one-line description"
 */
function buildToolCatalog(): string {
  const tools = globalRegistry.getAllTools();
  return tools
    .map((t) => {
      const def = ToolRegistry.getOpenAIToolDefinition(t);
      const desc = def.function.description?.split("\n")[0].slice(0, 80) || "";
      return `${def.function.name}: ${desc}`;
    })
    .join("\n");
}

/**
 * Select the most relevant tools for the current conversation context.
 * Uses a lightweight LLM call with the primary model.
 *
 * @param userPrompt - The latest user message
 * @param recentContext - Last few messages for context (optional)
 * @returns Array of selected tool names, or null if selection failed
 */
export async function selectRelevantTools(
  userPrompt: string,
  recentContext?: string,
): Promise<ToolSelectionResult | null> {
  if (!config.llmApiKey && !config.llmBaseUrl.includes("localhost")) {
    // No API key and not local — skip selection, use all tools
    return null;
  }

  const catalog = buildToolCatalog();
  const contextHint = recentContext
    ? `\nRecent context: ${recentContext.slice(0, 500)}`
    : "";

  const selectionPrompt = `You are a tool selector. Given the user's request, select the most relevant tools from this catalog. Return ONLY a JSON object with "tools" (array of tool names) and "reasoning" (one sentence).

Tool catalog:
${catalog}

User request: ${userPrompt.slice(0, 1000)}${contextHint}

Return JSON like: {"tools": ["view_file", "grep_search", "run_command"], "reasoning": "User wants to read and search files then run a command"}`;

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.llmApiKey) {
      headers["Authorization"] = `Bearer ${config.llmApiKey}`;
    }

    // Timeout: if the LLM is slow to respond for tool selection, we must not
    // hang indefinitely. 15 seconds is generous for a lightweight selection call.
    // If it times out, we fall back to all tools (safe default).
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.llmModelName,
        messages: [
          {
            role: "user",
            content: selectionPrompt,
          },
        ],
        temperature: 0,
        max_tokens: 500,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || "";

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = content;
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr
        .replace(/^```(?:json)?\n?/i, "")
        .replace(/\n?```$/, "")
        .trim();
    }

    const parsed = JSON.parse(jsonStr);
    const tools: string[] = Array.isArray(parsed.tools) ? parsed.tools : [];
    const reasoning: string = parsed.reasoning || "";

    if (tools.length === 0) return null;

    // Always include essential tools that the agent might need
    const essential = [
      "ask_question",
      "todo_write",
      "view_file",
      "list_dir",
      "glob",
      "grep_search",
    ];
    const selected = [...new Set([...tools, ...essential])];

    return { selectedTools: selected, reasoning };
  } catch {
    // Selection failed — fall back to all tools
    return null;
  }
}

/**
 * Filter the tool registry to only include selected tools.
 * Returns the filtered tool definitions for the LLM payload.
 * If selection is null or empty, returns all tools (safe fallback).
 */
export function filterTools(selectedToolNames: string[] | null): Tool[] {
  const allTools = globalRegistry.getAllTools();

  if (!selectedToolNames || selectedToolNames.length === 0) {
    return allTools;
  }

  const filtered = allTools.filter((t) => {
    const def = ToolRegistry.getOpenAIToolDefinition(t);
    return selectedToolNames.includes(def.function.name);
  });

  // If filtering removed everything, return all tools (safe fallback)
  if (filtered.length === 0) return allTools;

  return filtered;
}
