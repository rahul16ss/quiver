import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import picocolors from "picocolors";
import { Tool } from "../registry.js"
import { assertToolPathAllowed } from "../security/tool_paths.js";
import { getProjectSessionsDir } from "../paths.js";

interface SessionEvent {
  timestamp: string;
  type: string;
  data: any;
}

interface SessionSummary {
  sessionId: string;
  filePath: string;
  startTime: string | null;
  endTime: string | null;
  durationSeconds: number;
  totalEvents: number;
  turns: number;
  userInputs: number;
  assistantResponses: number;
  toolCalls: number;
  toolResults: number;
  apiErrors: number;
  toolsUsed: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedTotalTokens: number;
  historySizes: number[];
  maxHistorySize: number;
}

/**
 * Reads session events from a legacy JSON array file or NDJSON (.jsonl) log.
 */
async function readSessionEvents(filePath: string): Promise<SessionEvent[]> {
  const content = await fs.readFile(filePath, "utf8");

  if (filePath.endsWith(".jsonl")) {
    const events: SessionEvent[] = [];
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        events.push(JSON.parse(line) as SessionEvent);
      } catch {
        // Skip corrupt lines
      }
    }
    return events;
  }

  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("Session log does not contain an array of events.");
  }
  return parsed;
}

/**
 * Estimates token count from a string using a rough heuristic:
 * ~4 characters per token for English text and code.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateFromLength(charLength: number): number {
  return Math.ceil(charLength / 4);
}

/**
 * Parses a session log JSON file and extracts statistics.
 */
function parseSessionLog(events: SessionEvent[], filePath: string): SessionSummary {
  const sessionId = path.basename(filePath).replace(/\.jsonl?$/, "");

  let startTime: string | null = null;
  let endTime: string | null = null;
  let turns = 0;
  let userInputs = 0;
  let assistantResponses = 0;
  let toolCalls = 0;
  let toolResults = 0;
  let apiErrors = 0;
  const toolsUsedSet = new Set<string>();
  let estimatedInputTokens = 0;
  let estimatedOutputTokens = 0;
  const historySizes: number[] = [];

  for (const event of events) {
    if (!startTime) startTime = event.timestamp;
    endTime = event.timestamp;

    switch (event.type) {
      case "user_input": {
        userInputs++;
        const contentLength = event.data?.contentLength;
        if (typeof contentLength === "number") {
          estimatedInputTokens += estimateFromLength(contentLength);
        } else {
          estimatedInputTokens += estimateTokens(event.data?.content || "");
        }
        break;
      }
      case "turn_start": {
        turns++;
        if (typeof event.data?.historySize === "number") {
          historySizes.push(event.data.historySize);
        }
        break;
      }
      case "assistant_response": {
        assistantResponses++;
        const contentLength = event.data?.contentLength;
        if (typeof contentLength === "number") {
          estimatedOutputTokens += estimateFromLength(contentLength);
        } else {
          estimatedOutputTokens += estimateTokens(event.data?.content || "");
        }

        // Count tool calls in the assistant response
        const toolCallsArr = event.data?.tool_calls;
        if (Array.isArray(toolCallsArr)) {
          toolCalls += toolCallsArr.length;
          for (const tc of toolCallsArr) {
            const toolName = tc?.function?.name;
            if (toolName) toolsUsedSet.add(toolName);
            const argsLength = tc?.function?.argumentsLength;
            if (typeof argsLength === "number") {
              estimatedOutputTokens += estimateFromLength(argsLength);
            } else {
              estimatedOutputTokens += estimateTokens(tc?.function?.arguments || "");
            }
          }
        }
        break;
      }
      case "tool_result": {
        toolResults++;
        const toolName = event.data?.tool;
        if (toolName) toolsUsedSet.add(toolName);
        const resultLength = event.data?.resultLength;
        if (typeof resultLength === "number") {
          estimatedInputTokens += estimateFromLength(resultLength);
        } else {
          const result = event.data?.result;
          const resultStr = typeof result === "string" ? result : JSON.stringify(result || "");
          estimatedInputTokens += estimateTokens(resultStr);
        }
        break;
      }
      case "api_error": {
        apiErrors++;
        break;
      }
      case "context_manifest": {
        // Context manifest contributes to input tokens (system context)
        const manifestStr = JSON.stringify(event.data || {});
        estimatedInputTokens += estimateTokens(manifestStr);
        break;
      }
    }
  }

  const durationSeconds =
    startTime && endTime
      ? Math.round((new Date(endTime).getTime() - new Date(startTime).getTime()) / 1000)
      : 0;

  return {
    sessionId,
    filePath,
    startTime,
    endTime,
    durationSeconds,
    totalEvents: events.length,
    turns,
    userInputs,
    assistantResponses,
    toolCalls,
    toolResults,
    apiErrors,
    toolsUsed: Array.from(toolsUsedSet),
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens: estimatedInputTokens + estimatedOutputTokens,
    historySizes,
    maxHistorySize: historySizes.length > 0 ? Math.max(...historySizes) : 0,
  };
}

/**
 * Finds the latest session log file in the .sessions/ directory.
 * Supports legacy session_<timestamp>.json and append-only session_<timestamp>.jsonl.
 */
async function findLatestSessionLog(sessionsDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(sessionsDir);
    const sessionFiles = files
      .filter(
        (f) =>
          f.startsWith("session_") && (f.endsWith(".jsonl") || f.endsWith(".json"))
      )
      .sort();

    if (sessionFiles.length === 0) return null;
    return path.join(sessionsDir, sessionFiles[sessionFiles.length - 1]);
  } catch {
    return null;
  }
}

export const tool: Tool = {
  name: "log_tokens",
  description:
    "Parses the latest session log from .sessions/ and prints token/turn summary statistics to help optimize context bounds. Optionally specify a specific session file path to parse.",
  parameters: z.object({
    sessionFile: z
      .string()
      .optional()
      .describe("Optional: specific session log file path to parse. Defaults to the latest session in .sessions/."),
  }),
  execute: async ({ sessionFile }) => {
    // Path-policy guard (US-9.2): reject sensitive paths
    try {
      if (sessionFile) assertToolPathAllowed(sessionFile, "read");
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
    const sessionsDir = getProjectSessionsDir();

    // Determine which file to parse
    let targetFile: string | null;
    if (sessionFile) {
      targetFile = path.resolve(sessionFile);
    } else {
      targetFile = await findLatestSessionLog(sessionsDir);
    }

    if (!targetFile) {
      return JSON.stringify(
        {
          success: false,
          error: "No session log files found in .sessions/ directory.",
        },
        null,
        2
      );
    }

    // Check file exists
    try {
      await fs.access(targetFile);
    } catch {
      return JSON.stringify(
        {
          success: false,
          error: `Session log file not found: ${targetFile}`,
        },
        null,
        2
      );
    }

    console.log(picocolors.gray(`   Parsing session log: ${path.basename(targetFile)}...`));

    // Read and parse the session log
    let events: SessionEvent[];
    try {
      events = await readSessionEvents(targetFile);
    } catch (err: any) {
      return JSON.stringify(
        {
          success: false,
          error: `Failed to parse session log ${targetFile}: ${err?.message || err}`,
        },
        null,
        2
      );
    }

    const summary = parseSessionLog(events, targetFile);

    // Print formatted summary to console
    console.log("");
    console.log(picocolors.cyan(`   ╭──────────────────────────────────────────────╮`));
    console.log(picocolors.cyan(`   │          📊 SESSION TOKEN SUMMARY             │`));
    console.log(picocolors.cyan(`   ├──────────────────────────────────────────────┤`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Session ID:     `) + picocolors.green(summary.sessionId));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Duration:       `) + picocolors.white(`${summary.durationSeconds}s`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Total Events:   `) + picocolors.white(`${summary.totalEvents}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Turns:          `) + picocolors.white(`${summary.turns}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`User Inputs:    `) + picocolors.white(`${summary.userInputs}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Assistant Resp: `) + picocolors.white(`${summary.assistantResponses}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Tool Calls:     `) + picocolors.white(`${summary.toolCalls}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Tool Results:   `) + picocolors.white(`${summary.toolResults}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`API Errors:     `) + (summary.apiErrors > 0 ? picocolors.red(`${summary.apiErrors}`) : picocolors.green(`${summary.apiErrors}`)));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Max History:    `) + picocolors.white(`${summary.maxHistorySize} msgs`));
    console.log(picocolors.cyan(`   ├──────────────────────────────────────────────┤`));
    console.log(picocolors.cyan(`   │ `) + picocolors.bold(picocolors.yellow(`TOKEN ESTIMATES (heuristic ~4 chars/token)`)));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Input Tokens:   `) + picocolors.magenta(`${summary.estimatedInputTokens.toLocaleString()}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Output Tokens:  `) + picocolors.magenta(`${summary.estimatedOutputTokens.toLocaleString()}`));
    console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Total Tokens:   `) + picocolors.bold(picocolors.magenta(`${summary.estimatedTotalTokens.toLocaleString()}`)));
    console.log(picocolors.cyan(`   ├──────────────────────────────────────────────┤`));
    if (summary.toolsUsed.length > 0) {
      console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Tools Used:     `) + picocolors.green(summary.toolsUsed.join(", ")));
    } else {
      console.log(picocolors.cyan(`   │ `) + picocolors.gray(`Tools Used:     `) + picocolors.yellow("None"));
    }
    console.log(picocolors.cyan(`   ╰──────────────────────────────────────────────╯`));

    return JSON.stringify(summary, null, 2);
  },
};