import { promises as fs } from "fs";
import * as fsSync from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { getSkillsDir } from "../paths.js";

/**
 * PromptUpdate — the agent proposes an update to the system prompt (SKILL.md).
 *
 * The agent can suggest additions, modifications, or deletions to the system prompt.
 * The proposed change is written to a pending file. The user is then prompted
 * to review, accept, edit, or reject the change.
 *
 * This implements the "suggest → user approves/edits" pattern the user requested.
 * The agent NEVER directly modifies the system prompt — it only proposes changes.
 *
 * Flow:
 * 1. Agent calls prompt_update with the proposed new content (or a diff)
 * 2. Tool writes the proposal to a pending file and shows it to the user
 * 3. User is prompted: accept, edit, or reject
 * 4. If accepted, the proposal is applied to SKILL.md
 * 5. If edited, the user's edited version is applied
 * 6. If rejected, nothing changes
 */

const PENDING_FILE = "system-prompt-pending.md";

function getSystemPromptPath(): string {
  return path.resolve(getSkillsDir(), "system-prompt", "SKILL.md");
}

function getPendingPath(): string {
  return path.resolve(getSkillsDir(), "system-prompt", PENDING_FILE);
}

/**
 * Generate a unified diff between two strings (simplified).
 */
function generateDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines: string[] = [];

  lines.push(`--- ${oldLabel}`);
  lines.push(`+++ ${newLabel}`);

  // Simple line-by-line diff (not a full LCS diff, but good enough for display)
  const maxLen = Math.max(oldLines.length, newLines.length);
  let oldIdx = 0;
  let newIdx = 0;

  while (oldIdx < oldLines.length || newIdx < newLines.length) {
    const oldLine = oldIdx < oldLines.length ? oldLines[oldIdx] : null;
    const newLine = newIdx < newLines.length ? newLines[newIdx] : null;

    if (oldLine === newLine) {
      lines.push(` ${oldLine || ""}`);
      oldIdx++;
      newIdx++;
    } else if (oldLine !== null && newLine !== null) {
      lines.push(`-${oldLine}`);
      lines.push(`+${newLine}`);
      oldIdx++;
      newIdx++;
    } else if (oldLine !== null) {
      lines.push(`-${oldLine}`);
      oldIdx++;
    } else if (newLine !== null) {
      lines.push(`+${newLine}`);
      newIdx++;
    }
  }

  return lines.join("\n");
}

export const tool: Tool = {
  name: "prompt_update",
  description:
    "Proposes an update to the Quiver system prompt (skills/system-prompt/SKILL.md). " +
    "The agent suggests changes — the user then reviews, accepts, edits, or rejects them. " +
    "The agent NEVER directly modifies the system prompt. " +
    "Use this when you discover that the system prompt should be updated based on user preferences, " +
    "learned patterns, or new best practices. " +
    "The proposed content replaces the body of SKILL.md (after the YAML frontmatter). " +
    "The YAML frontmatter (name, version, purpose) is preserved automatically.",
  parameters: z.object({
    proposedContent: z
      .string()
      .describe(
        "The proposed new body content for the system prompt (the part after the YAML frontmatter). " +
          "This should be the complete new body — not a diff or partial edit.",
      ),
    reason: z
      .string()
      .describe(
        "A brief explanation of why this update is being proposed. Shown to the user for context.",
      ),
  }),
  execute: async ({ proposedContent, reason }) => {
    const promptPath = getSystemPromptPath();
    const pendingPath = getPendingPath();

    try {
      // Read current content
      let currentContent = "";
      let frontmatter = "";
      try {
        const raw = await fs.readFile(promptPath, "utf8");
        // Extract frontmatter
        const fmMatch = raw.match(/^(---[\s\S]*?---\s*)/);
        if (fmMatch) {
          frontmatter = fmMatch[1];
          currentContent = raw.substring(frontmatter.length);
        } else {
          currentContent = raw;
        }
      } catch {
        // No existing prompt — will create new one
      }

      // Write the pending proposal
      const pendingContent = frontmatter + proposedContent;
      await fs.mkdir(path.dirname(pendingPath), { recursive: true });
      await fs.writeFile(pendingPath, pendingContent, "utf8");

      // Generate a diff for display
      const diff = generateDiff(
        currentContent.trim(),
        proposedContent.trim(),
        "current SKILL.md",
        "proposed update",
      );

      // In non-interactive mode, just save the proposal and return
      if (
        process.env.QUIVER_OUTPUT_MODE === "json" ||
        process.env.QUIVER_OUTPUT_MODE === "quiet"
      ) {
        return JSON.stringify(
          {
            status: "proposed",
            message: `System prompt update proposed. Reason: ${reason}`,
            pendingFile: pendingPath,
            diff,
          },
          null,
          2,
        );
      }

      // Interactive mode: prompt the user via @clack/prompts
      console.log("\n  ┌── System Prompt Update Proposed ──────────────");
      console.log(`  │  Reason: ${reason}`);
      console.log("  │");
      console.log("  │  Proposed changes (diff):");
      console.log("  │");

      // Show diff (truncated if too long)
      const diffLines = diff.split("\n");
      const maxDiffLines = 50;
      for (let i = 0; i < Math.min(diffLines.length, maxDiffLines); i++) {
        const line = diffLines[i];
        if (line.startsWith("+")) {
          console.log(`  │  \x1b[32m${line}\x1b[0m`);
        } else if (line.startsWith("-")) {
          console.log(`  │  \x1b[31m${line}\x1b[0m`);
        } else {
          console.log(`  │  ${line}`);
        }
      }
      if (diffLines.length > maxDiffLines) {
        console.log(`  │  ... (${diffLines.length - maxDiffLines} more lines)`);
      }

      console.log("  │");
      console.log("  │  Full proposal saved to:");
      console.log(`  │  ${pendingPath}`);
      console.log("  │");
      console.log("  │  [1] Accept — apply the proposed update");
      console.log(
        "  │  [2] Edit — open the proposal in your editor for review",
      );
      console.log("  │  [3] Reject — discard the proposal");
      console.log("  └──────────────────────────────────────────────────");

      const handleChoice = async (
        choice: string,
        resolve: (val: any) => void,
      ) => {
        if (choice === "1") {
          // Accept
          try {
            await fs.writeFile(promptPath, pendingContent, "utf8");
            await fs.unlink(pendingPath).catch(() => {});
            resolve(
              `System prompt updated successfully. The new prompt will be active on the next prompt() call. Reason: ${reason}`,
            );
          } catch (err: any) {
            resolve(`Error applying update: ${err.message}`);
          }
        } else if (choice === "2") {
          // Edit — open in $EDITOR or $VISUAL
          const editor = process.env.VISUAL || process.env.EDITOR || "vi";
          const { execSync } = await import("child_process");
          try {
            execSync(`${editor} "${pendingPath}"`, { stdio: "inherit" });
            // After editing, ask if they want to apply
            const { askQuestionRaw } = await import("../utils/prompt.js");
            const applyAnswer = await askQuestionRaw(
              "\n  Apply the edited version? (y/N): ",
            );
            if (
              applyAnswer.trim().toLowerCase() === "y" ||
              applyAnswer.trim().toLowerCase() === "yes"
            ) {
              try {
                const edited = await fs.readFile(pendingPath, "utf8");
                await fs.writeFile(promptPath, edited, "utf8");
                await fs.unlink(pendingPath).catch(() => {});
                resolve(
                  "System prompt updated with your edited version. The new prompt will be active on the next prompt() call.",
                );
              } catch (err: any) {
                resolve(`Error applying edited update: ${err.message}`);
              }
            } else {
              await fs.unlink(pendingPath).catch(() => {});
              resolve("Update rejected. The proposal has been discarded.");
            }
          } catch (err: any) {
            resolve(
              `Error opening editor: ${err.message}. The proposal is saved at: ${pendingPath}. You can edit it manually and copy it to ${promptPath}.`,
            );
          }
        } else {
          // Reject
          await fs.unlink(pendingPath).catch(() => {});
          resolve("Update rejected. The system prompt remains unchanged.");
        }
      };

      // Use the shared prompt utility for consistent input experience.
      const { askQuestionRaw } = await import("../utils/prompt.js");
      const answer = await askQuestionRaw("  > ");
      return new Promise<string>((resolve) => {
        handleChoice(answer.trim(), resolve);
      });
    } catch (error: any) {
      return `Error proposing system prompt update: ${error.message}`;
    }
  },
};
