import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { atomicWrite } from "../fs/atomic_write.js";
import { isScratchModeActive, resolveScratchPath, ensureScratchDir } from "../security/scratch_area.js";

export const tool: Tool = {
  name: "replace_content",
  description:
    "Replaces a specific target substring in a file with a new replacement string. Accurate for small, scoped edits.",
  parameters: z.object({
    filePath: z
      .string()
      .describe("The absolute or relative path to the file to modify."),
    targetContent: z
      .string()
      .describe("The exact target substring in the file to find and replace."),
    replacementContent: z
      .string()
      .describe("The new replacement content to substitute."),
  }),
  execute: async ({ filePath, targetContent, replacementContent }) => {
    try {
      // US-9.2: sandbox the path before any filesystem access.
      const resolved = assertToolPathAllowed(filePath, "write");
      const resolvedPath = resolved.absolutePath;

      // US-17.14: In scratch mode, read from the real file but write to scratch.
      // assertToolPathAllowed already redirected resolvedPath to the scratch
      // location, so we need to read from the original real path.
      let readPath = resolvedPath;
      if (isScratchModeActive()) {
        const realAbs = path.resolve(filePath);
        // If the scratch file already exists (continuing an edit), read from it.
        // Otherwise, read from the real file.
        if (await fs.stat(resolvedPath).then(() => true).catch(() => false)) {
          readPath = resolvedPath;
        } else {
          readPath = realAbs;
        }
      }

      const content = await fs.readFile(readPath, "utf8");

      if (!content.includes(targetContent)) {
        // Provide a helpful hint: show the first 80 chars of the target
        // so the model can identify what it was looking for.
        const hint =
          targetContent.length > 80
            ? targetContent.slice(0, 77) + "…"
            : targetContent;
        throw new Error(
          `Target content to replace was not found in ${filePath}. ` +
            `The file may have been modified since it was last read, or the ` +
            `target string doesn't match exactly (whitespace, line endings). ` +
            `Target was: "${hint}". ` +
            `Re-read the file with view_file to see current content, then retry.`,
        );
      }

      // Check for multiple occurrences
      const occurrences = content.split(targetContent).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Target content appears multiple times (${occurrences}) in the file. Make your targetContent more specific.`,
        );
      }

      const updated = content.replace(targetContent, replacementContent);
      // US-10.2: atomic write (temp → rename) with backup + rollback history.
      await atomicWrite(resolvedPath, updated);
      return `Successfully replaced target content in ${resolvedPath}.`;
    } catch (error: any) {
      throw new Error(
        `Failed to replace content in ${filePath}: ${error.message}`,
      );
    }
  },
};
