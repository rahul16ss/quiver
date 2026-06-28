/**
 * Subagent Types — US-5.3
 *
 * Type definitions for parallel subagent execution.
 */

export interface SubagentTask {
  id: string;
  prompt: string;
  tools?: string[]; // restricted tool list
  timeoutMs: number;
  recursionDepth: number;
}

export interface SubagentResult {
  taskId: string;
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
  filesModified: string[];
}

export interface SubagentConfig {
  maxConcurrency: number;
  maxRecursionDepth: number; // default: 2
  defaultTimeoutMs: number;
  scratchpadDir: string;
}

export const DEFAULT_SUBAGENT_CONFIG: SubagentConfig = {
  maxConcurrency: 4,
  maxRecursionDepth: 2,
  defaultTimeoutMs: 300000, // 5 minutes
  scratchpadDir: ".quiver-scratchpad",
};