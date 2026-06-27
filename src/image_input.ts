import { existsSync } from "fs";

/**
 * Detect image file paths in user input.
 * When you drag a file from Finder/Explorer into a terminal, it inserts
 * the file path as text. This function detects image file paths and
 * wraps them in [Image: path] markers so the agent knows to look at them.
 *
 * Security: only includes paths where the file actually exists on disk.
 * The agent's processImageMarkers provides a second layer of defense
 * with magic-byte validation.
 */
export function detectImagePaths(input: string): string {
  // Match file paths that end with an image extension
  const pathRegex =
    /(?:"([^"]+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|svg))")|('([^']+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|svg))')|(~?\/[^\s]+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|svg))|(\.{0,2}\/[^\s]+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|svg))/gi;

  const matches = [...input.matchAll(pathRegex)];
  if (matches.length === 0) return input;

  const paths: string[] = [];
  for (const match of matches) {
    const p = match[1] || match[2] || match[3] || match[4] || match[5];
    if (p) {
      const expanded = p.startsWith("~/")
        ? p.replace("~", process.env.HOME || "")
        : p;
      if (existsSync(expanded)) {
        paths.push(expanded);
      }
    }
  }

  if (paths.length === 0) return input;

  const imageBlock = paths.map((p) => `[Image: ${p}]`).join("\n");

  let cleanedInput = input;
  for (const match of matches) {
    cleanedInput = cleanedInput.replace(match[0], "").trim();
  }

  if (!cleanedInput) {
    return `${imageBlock}\n\nPlease look at the image(s) above.`;
  }

  return `${imageBlock}\n\n${cleanedInput}`;
}
