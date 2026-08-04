import * as path from "path";
import { fileURLToPath } from "url";

/** Absolute path to the `ui/` directory (parent of `ui/main/`). */
export const UI_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** Absolute path to the Quiver project root (parent of `ui/`). */
export const PROJECT_ROOT = path.resolve(UI_DIR, "..");
