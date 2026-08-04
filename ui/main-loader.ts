/**
 * Register the TypeScript ESM loader before importing the Electron main
 * process. Electron can strip types from the entry file, but nested `.js`
 * specifiers in the source tree are resolved by tsx.
 */

import "tsx";

await import("./main.ts");
