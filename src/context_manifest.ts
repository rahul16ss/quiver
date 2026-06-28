/**
 * Context Manifest — transparency display before each model call.
 *
 * Extracted from agent.ts for modularity and testability.
 *
 * Shows the user exactly what enters the model's context:
 *   - Memory files loaded (with type classification)
 *   - Active skills
 *   - System prompt source
 *   - Token usage with progress bar
 *   - Model name (primary or vision)
 *   - Image count (if any)
 */

import picocolors from "picocolors";
import { config } from "./config.js";
import { classifyMemoryFile } from "./memory_types.js";
import { theme } from "./cli_ui.js";
import type { Message } from "./types.js";

export interface ManifestData {
  memories: any[];
  skills: any[];
  coreMemory: any;
  messages: Message[];
  toolCount: number;
}

/**
 * Estimate total context tokens from messages.
 * Handles both string and array (vision) content.
 */
export function estimateContextTokens(messages: Message[]): number {
  const allText = messages
    .map((m) => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(" ");
      }
      return "";
    })
    .join(" ");
  return Math.ceil(allText.length / 4);
}

/**
 * Count vision images in the latest user message.
 */
export function countImagesInLatestMessage(messages: Message[]): number {
  const lastMsg = messages[messages.length - 1];
  return Array.isArray(lastMsg?.content)
    ? lastMsg.content.filter((p: any) => p.type === "image_url").length
    : 0;
}

/**
 * Generate a compact progress bar for context usage.
 */
export function usageBar(pct: number): string {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  return bar;
}

/**
 * Print the context manifest to the console.
 *
 * This is the "Transparency of Context" principle in action —
 * the user sees exactly what the model will see before each call.
 */
export function printContextManifest(data: ManifestData): void {
  const dim = picocolors.gray;
  const t = theme();

  const estTokens = estimateContextTokens(data.messages);
  const maxTokens = config.maxContextTokens;
  const pct = Math.round((estTokens / maxTokens) * 100);
  const imageCount = countImagesInLatestMessage(data.messages);

  // Compact one-line manifest
  const parts: string[] = [];
  parts.push(`${data.memories.length} memory`);
  if (data.skills.length > 0) parts.push(`${data.skills.length} skills`);
  parts.push(`${data.toolCount} tools`);
  if (imageCount > 0) {
    parts.push(`${imageCount} image${imageCount > 1 ? "s" : ""}`);
    parts.push(`${config.visionModelName} (vision)`);
  } else {
    parts.push(config.llmModelName);
  }

  const border = t.brandBorder;
  console.log(border(`  ┌ `) + dim(`context: ${parts.join(" · ")}`));

  // Show memory items
  if (data.memories.length > 0) {
    const memNames = data.memories.map((m) => m.filename).join(", ");
    console.log(border(`  │ `) + dim(`memory: ${memNames}`));

    const typeCounts: Record<string, number> = {
      semantic: 0,
      episodic: 0,
      procedural: 0,
    };
    for (const m of data.memories) {
      const memType = classifyMemoryFile(m.filename);
      typeCounts[memType] = (typeCounts[memType] || 0) + 1;
    }
    const typeParts: string[] = [];
    if (typeCounts.semantic > 0)
      typeParts.push(`${typeCounts.semantic} semantic`);
    if (typeCounts.episodic > 0)
      typeParts.push(`${typeCounts.episodic} episodic`);
    if (typeCounts.procedural > 0)
      typeParts.push(`${typeCounts.procedural} procedural`);
    if (typeParts.length > 0) {
      console.log(border(`  │ `) + dim(`  types: ${typeParts.join(", ")}`));
    }
  }

  // Show active skills
  if (data.skills.length > 0) {
    const skillNames = data.skills
      .map((s) => `${s.id} v${s.version}`)
      .join(", ");
    console.log(border(`  │ `) + dim(`skills: ${skillNames}`));
  }

  // Show system prompt source
  console.log(border(`  │ `) + dim(`prompt: skills/system-prompt/SKILL.md`));

  // Context window usage bar
  const tokColor =
    pct < 60 ? picocolors.gray : pct < 85 ? picocolors.yellow : picocolors.red;
  const barWidth = 20;
  const filled = Math.round((pct / 100) * barWidth);
  const filledBar = t.brandBar("█".repeat(filled));
  const emptyBar = dim("░".repeat(barWidth - filled));
  console.log(
    border(`  │ `) +
      dim(`tokens: `) +
      tokColor(
        `${estTokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${pct}%)`,
      ) +
      dim(` `) +
      filledBar +
      emptyBar,
  );

  console.log(border(`  └`));
}
