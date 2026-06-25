import { ToolRegistry } from "./registry.js";

// Export a single shared registry instance to use across CLI, agent loop, and tools
export const globalRegistry = new ToolRegistry();
