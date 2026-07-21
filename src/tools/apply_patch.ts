import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { atomicWrite } from "../fs/atomic_write.js";
import { isScratchModeActive } from "../security/scratch_area.js";

/**
 * ApplyPatch — applies a unified diff patch to files.
 * Supports the standard unified diff format (--- / +++ / @@ / + / - / context).
 * Can create new files, modify existing files, and delete files.
 *
 * This is more powerful than replace_content for multi-location edits
 * and is the standard format used by git, patch, and other tools.
 *
 * Format:
 *   --- a/path/to/file
 *   +++ b/path/to/file
 *   @@ -lineStart,lineCount +lineStart,lineCount @@
 *    context line
 *   -removed line
 *   +added line
 *    context line
 *
 * For new files:
 *   --- /dev/null
 *   +++ b/path/to/new/file
 *   @@ -0,0 +1,N @@
 *   +line 1
 *   +line 2
 *
 * For deleted files:
 *   --- a/path/to/file
 *   +++ /dev/null
 *   @@ -1,N +0,0 @@
 *   -line 1
 *   -line 2
 */

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[]; // All lines (context, removed, added)
}

interface PatchFile {
  oldPath: string | null; // null for new files
  newPath: string | null; // null for deleted files
  hunks: PatchHunk[];
}

/**
 * Parse a unified diff patch into structured PatchFile objects.
 */
function parsePatch(patchText: string): PatchFile[] {
  const lines = patchText.split("\n");
  const files: PatchFile[] = [];
  let currentFile: PatchFile | null = null;
  let currentHunk: PatchHunk | null = null;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // File header
    if (line.startsWith("--- ")) {
      const oldPath = line.substring(4).trim();
      // Check next line for +++
      if (i + 1 < lines.length && lines[i + 1].startsWith("+++ ")) {
        const newPath = lines[i + 1].substring(4).trim();
        currentFile = {
          oldPath: oldPath === "/dev/null" ? null : stripPrefix(oldPath),
          newPath: newPath === "/dev/null" ? null : stripPrefix(newPath),
          hunks: [],
        };
        files.push(currentFile);
        i += 2;
        continue;
      }
    }

    // Hunk header
    if (line.startsWith("@@ ") && currentFile) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldCount: match[2] ? parseInt(match[2], 10) : 1,
          newStart: parseInt(match[3], 10),
          newCount: match[4] ? parseInt(match[4], 10) : 1,
          lines: [],
        };
        currentFile.hunks.push(currentHunk);
        i++;
        continue;
      }
    }

    // Hunk content. A bare empty line is ambiguous: standard diff tools
    // represent a blank context line as a single space " ", so a truly
    // empty line is usually a trailing-newline artifact or a hunk separator.
    // Treat it as context ONLY when it sits inside a hunk (the next line is
    // also hunk content); a trailing empty line at EOF / before a non-hunk
    // line ends the hunk instead of being applied as a spurious context line
    // (which would silently consume the next real line — M8).
    if (
      currentHunk &&
      (line.startsWith(" ") ||
        line.startsWith("+") ||
        line.startsWith("-") ||
        line === "")
    ) {
      if (line === "") {
        const next = lines[i + 1];
        const interior =
          next !== undefined &&
          (next.startsWith(" ") ||
            next.startsWith("+") ||
            next.startsWith("-") ||
            next === "");
        if (!interior) {
          // trailing artifact / separator — end the hunk here
          currentHunk = null;
          i++;
          continue;
        }
      }
      currentHunk.lines.push(line);
      i++;
      continue;
    }

    i++;
  }

  return files;
}

/**
 * Strip a/ or b/ prefix from patch paths.
 */
function stripPrefix(p: string): string {
  if (p.startsWith("a/")) return p.substring(2);
  if (p.startsWith("b/")) return p.substring(2);
  return p;
}

/**
 * Apply a single patch file to the filesystem.
 */
async function applyPatchFile(patch: PatchFile): Promise<string> {
  const targetPath = patch.newPath || patch.oldPath;
  if (!targetPath) {
    throw new Error("Patch file has no target path.");
  }

  // US-9.2: sandbox the target path. New files use "write"; deletions use "delete".
  const operation = patch.newPath === null ? "delete" : "write";
  const resolvedPath = assertToolPathAllowed(targetPath, operation).absolutePath;

  // New file creation
  if (patch.oldPath === null && patch.newPath !== null) {
    const newContent = patch.hunks
      .flatMap((h) =>
        h.lines.filter((l) => l.startsWith("+")).map((l) => l.substring(1)),
      )
      .join("\n");
    await atomicWrite(resolvedPath, newContent + "\n");
    return `Created new file: ${resolvedPath}`;
  }

  // File deletion
  if (patch.newPath === null && patch.oldPath !== null) {
    await fs.unlink(resolvedPath).catch(() => {});
    return `Deleted file: ${resolvedPath}`;
  }

  // File modification
  // US-17.14: In scratch mode, read from the real file but write to scratch.
  let readPath = resolvedPath;
  if (isScratchModeActive() && patch.oldPath) {
    const realAbs = path.resolve(patch.oldPath);
    if (await fs.stat(resolvedPath).then(() => true).catch(() => false)) {
      readPath = resolvedPath; // scratch copy exists — continue editing
    } else {
      readPath = realAbs; // read from real file
    }
  }
  const content = await fs.readFile(readPath, "utf8");
  const oldLines = content.split("\n");
  const newLines: string[] = [];
  let oldIdx = 0;

  for (const hunk of patch.hunks) {
    // Copy lines before the hunk
    const hunkStart = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
    while (oldIdx < hunkStart && oldIdx < oldLines.length) {
      newLines.push(oldLines[oldIdx]);
      oldIdx++;
    }

    // Apply hunk
    for (const line of hunk.lines) {
      if (line.startsWith("-")) {
        // Removed line — must match the file's current content. If the file
        // drifted since the diff was generated, applying blindly would
        // delete the wrong line and silently corrupt it. Reject instead
        // (standard `patch` behavior) with the offending line number.
        const expected = line.substring(1);
        if (oldIdx >= oldLines.length || oldLines[oldIdx] !== expected) {
          throw new Error(
            `Patch context mismatch at line ${oldIdx + 1}: hunk expects to remove "${expected.slice(0, 80)}" but the file has "${(oldLines[oldIdx] ?? "<EOF>").slice(0, 80)}". The file changed since the diff was generated — re-read and re-diff.`,
          );
        }
        oldIdx++;
      } else if (line.startsWith("+")) {
        // Added line
        newLines.push(line.substring(1));
      } else {
        // Context line — must match the file's current content (same drift
        // guard as removed lines). A bare "" line is treated as a blank
        // context line (content ""), matching standard unified-diff parsing.
        const expected = line.substring(1);
        if (oldIdx >= oldLines.length || oldLines[oldIdx] !== expected) {
          throw new Error(
            `Patch context mismatch at line ${oldIdx + 1}: hunk expects context "${expected.slice(0, 80)}" but the file has "${(oldLines[oldIdx] ?? "<EOF>").slice(0, 80)}". The file changed since the diff was generated — re-read and re-diff.`,
          );
        }
        newLines.push(expected);
        oldIdx++;
      }
    }
  }

  // Copy remaining lines
  while (oldIdx < oldLines.length) {
    newLines.push(oldLines[oldIdx]);
    oldIdx++;
  }

  await atomicWrite(resolvedPath, newLines.join("\n"));
  return `Patched file: ${resolvedPath} (${patch.hunks.length} hunk${patch.hunks.length === 1 ? "" : "s"})`;
}

export const tool: Tool = {
  name: "apply_patch",
  description:
    "Applies a unified diff patch to one or more files. Supports creating new files, modifying existing files, and deleting files. " +
    "Use this for multi-location edits, complex changes across files, or when you have a diff from git or another source. " +
    "Format: standard unified diff with --- / +++ headers and @@ hunk markers. " +
    "For new files: use --- /dev/null and +++ b/path. For deletions: use --- a/path and +++ /dev/null. " +
    "This is more powerful than replace_content for multi-location or multi-file edits.",
  parameters: z.object({
    patch: z
      .string()
      .describe(
        "The unified diff patch text. Must include --- and +++ file headers and @@ hunk markers. " +
          "Example:\n" +
          "--- a/src/foo.ts\n" +
          "+++ b/src/foo.ts\n" +
          "@@ -10,3 +10,4 @@\n" +
          " existing line\n" +
          "-old line\n" +
          "+new line\n" +
          " existing line",
      ),
  }),
  execute: async ({ patch }) => {
    try {
      const files = parsePatch(patch);

      if (files.length === 0) {
        return "Error: No valid file patches found in the input. Make sure the patch includes --- and +++ headers.";
      }

      const results: string[] = [];
      for (const file of files) {
        try {
          const result = await applyPatchFile(file);
          results.push(result);
        } catch (error: any) {
          results.push(
            `Error patching ${file.newPath || file.oldPath}: ${error.message}`,
          );
        }
      }

      return results.join("\n");
    } catch (error: any) {
      return `Error applying patch: ${error.message}`;
    }
  },
};
