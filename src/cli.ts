import readline from "readline";
import picocolors from "picocolors";
import { distance } from "fastest-levenshtein";
import {
  config,
  validateConfig,
  isFirstRun,
  printFirstRunWizard,
  redactSecret,
} from "./config.js";
import {
  parseCliArgs,
  UsageError,
  EXIT,
  statusLine,
  statusBlock,
  theme,
  emitJson,
  printUnknownFlagHints,
} from "./cli_ui.js";
import { runInitWizard } from "./init.js";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";
import { exportToAgentFile } from "./state.js";
import * as path from "path";
import { readFileSync, existsSync } from "fs";
import { promises as fs } from "fs";

// ─── Package metadata ───────────────────────────────────────────────
function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(
        path.resolve(import.meta.dirname ?? ".", "..", "package.json"),
        "utf8",
      ),
    );
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = getVersion();

// ─── Slash command registry ─────────────────────────────────────────
interface SlashCommand {
  name: string;
  aliases: string[];
  desc: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/exit", aliases: ["/quit", "/q"], desc: "End session" },
  { name: "/help", aliases: ["/h", "/?"], desc: "Show this help" },
  { name: "/tools", aliases: ["/t"], desc: "List available tools" },
  { name: "/approvals", aliases: ["/a"], desc: "Manage approval gates" },
  { name: "/session", aliases: ["/s"], desc: "Show session details" },
  { name: "/version", aliases: ["/v"], desc: "Show Quiver version" },
  { name: "/config", aliases: ["/c"], desc: "Show configuration" },
  { name: "/clear", aliases: [], desc: "Clear terminal screen" },
  { name: "/compact", aliases: ["/co"], desc: "Compact conversation history" },
  { name: "/reset", aliases: ["/r"], desc: "Reset conversation (keep memory)" },
  { name: "/cost", aliases: [], desc: "Show token usage stats" },
  { name: "/memory", aliases: ["/mem"], desc: "View loaded memory" },
  { name: "/model", aliases: ["/m"], desc: "Show or change model" },
  {
    name: "/history",
    aliases: ["/hi"],
    desc: "Show conversation message count",
  },
  { name: "/export", aliases: [], desc: "Export session to .qf file" },
  {
    name: "/dry-run",
    aliases: ["/dry"],
    desc: "Toggle dry-run mode (preview actions)",
  },
  {
    name: "/resume",
    aliases: ["/rs"],
    desc: "Resume a previous session",
  },
];

function resolveSlashCommand(input: string): string | null {
  const cmd = input.split(/\s+/)[0].toLowerCase();
  for (const sc of SLASH_COMMANDS) {
    if (sc.name === cmd || sc.aliases.includes(cmd)) return sc.name;
  }
  return null;
}

function suggestSlashCommand(input: string): string | null {
  const cmd = input.split(/\s+/)[0].toLowerCase();
  const allNames = SLASH_COMMANDS.flatMap((sc) => [sc.name, ...sc.aliases]);
  let bestMatch = "";
  let bestDist = Infinity;
  for (const name of allNames) {
    const d = distance(cmd, name);
    if (d < bestDist) {
      bestDist = d;
      bestMatch = name;
    }
  }
  // Only suggest if edit distance is ≤ 2 (reasonable typo threshold)
  if (bestDist <= 2 && bestDist > 0) {
    // Resolve alias to canonical name for the suggestion
    const canonical = resolveSlashCommand(bestMatch);
    return canonical || bestMatch;
  }
  return null;
}

// ─── Tool categorization ────────────────────────────────────────────
const TOOL_CATEGORIES: Record<string, string[]> = {
  "📁 Files": [
    "view_file",
    "write_file",
    "replace_content",
    "list_dir",
    "format_code",
    "grep_search",
  ],
  "⚙️ System": ["run_command", "run_tests", "create_tool", "log_tokens"],
  "🌐 Web": ["web_search", "scrape_url", "search_docs", "browser_control"],
  "🧠 Memory": ["memory_append", "memory_replace"],
  "🐙 GitHub": ["github"],
};

type ToolDisplay = { name: string; displayName: string; description: string };

function categorizeTools(
  tools: ToolDisplay[],
): { category: string; tools: ToolDisplay[] }[] {
  const categorized: {
    category: string;
    tools: ToolDisplay[];
  }[] = [];
  const assigned = new Set<string>();

  for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
    const matched = tools.filter((t) => toolNames.includes(t.name));
    if (matched.length > 0) {
      categorized.push({ category, tools: matched });
      matched.forEach((t) => assigned.add(t.name));
    }
  }

  // Catch-all for uncategorized tools (e.g., user-created ones)
  const uncategorized = tools.filter((t) => !assigned.has(t.name));
  if (uncategorized.length > 0) {
    categorized.push({ category: "🔧 Other", tools: uncategorized });
  }

  return categorized;
}

// ─── Help display ───────────────────────────────────────────────────
function printHelp(): void {
  const t = theme();
  console.log(
    t.cyan(
      t.bold(`
  ⚡ Quiver — AI coding & research agent for the terminal
`),
    ),
  );
  console.log(`  ${t.bold("USAGE")}`);
  console.log(
    `    quiver                          Start an interactive session`,
  );
  console.log(
    `    quiver init                     Set up .env (first-run wizard)`,
  );
  console.log(
    `    quiver --single-turn "prompt"    Run a single prompt and exit`,
  );
  console.log(`    quiver --recipe <name>           Run a goal recipe`);
  console.log(
    `    quiver --continue, -c            Resume the most recent session`,
  );
  console.log(`    quiver --resume, -r              Pick a session to resume`);
  console.log(`    quiver --list-sessions, -ls      List all saved sessions`);
  console.log("");
  console.log(`  ${t.bold("FLAGS")}`);
  console.log(`    --help, -h       Show this help message`);
  console.log(`    --version, -v    Print version`);
  console.log(`    --json           Structured JSON on stdout (for scripts)`);
  console.log(`    --quiet, -q      Suppress decorative output`);
  console.log(
    `    --dry-run, -n    Preview tool actions without executing them`,
  );
  console.log(`    --continue, -c   Resume the most recent session`);
  console.log(
    `    --resume, -r     Show session picker to resume a specific session`,
  );
  console.log(`    --list-sessions   List all saved sessions`);
  console.log("");
  console.log(`  ${t.bold("COMMANDS")} ${t.gray("(in-session)")}`);
  for (const cmd of SLASH_COMMANDS) {
    const aliases =
      cmd.aliases.length > 0 ? t.gray(` (${cmd.aliases.join(", ")})`) : "";
    const padded = cmd.name.padEnd(14);
    console.log(`    ${t.green(padded)}${cmd.desc}${aliases}`);
  }
  console.log("");
  console.log(
    t.gray(
      "  Status lines use [OK], [WARN], [ERROR], [INFO] tags for accessibility.",
    ),
  );
  console.log(
    t.gray(
      "  End a line with \\ then Enter for multiline input. Plain Enter submits.",
    ),
  );
  console.log("");
}

function printInSessionHelp(): void {
  console.log(picocolors.cyan(`\n  ⚡ Quiver Session Commands\n`));
  for (const cmd of SLASH_COMMANDS) {
    const aliases =
      cmd.aliases.length > 0
        ? picocolors.gray(` (${cmd.aliases.join(", ")})`)
        : "";
    const padded = cmd.name.padEnd(14);
    console.log(`    ${picocolors.green(padded)}${cmd.desc}${aliases}`);
  }
  console.log(
    picocolors.gray(`\n  Type any other text to chat with the AI agent.`),
  );
  console.log(
    picocolors.gray(
      `  End a line with \\ then Enter for multiline input. Plain Enter submits.\n`,
    ),
  );
}

function printEnhancedTools(): void {
  const tools = globalRegistry.getAllTools().map((t) => ({
    name: t.name,
    displayName: Agent.getToolDisplayName(t.name),
    description: t.description,
  }));
  console.log(picocolors.cyan(`\n  Available tools (${tools.length})\n`));

  const categories = categorizeTools(tools);
  for (const group of categories) {
    console.log(`  ${picocolors.bold(group.category)}`);
    const maxNameLen = Math.max(
      ...group.tools.map((t) => t.displayName.length),
    );
    for (const tool of group.tools) {
      const dots =
        " " +
        picocolors.gray(
          "·".repeat(Math.max(1, maxNameLen - tool.displayName.length + 2)),
        ) +
        " ";
      const desc =
        tool.description.length > 55
          ? tool.description.substring(0, 55) + "…"
          : tool.description;
      console.log(`    ${picocolors.green(tool.displayName)}${dots}${desc}`);
    }
    console.log("");
  }
}

// ─── Multiline prompt helper ─────────────────────────────────────────
// Multiline input support using readline's native line handling.
//
// Usage:
//   - Type a single-line prompt and press Enter to submit.
//   - End a line with backslash (\) then press Enter to continue on a new line.
//   - Press Enter on a line without a trailing backslash to submit.
//   - Ctrl+D / EOF resolves to null.
//
// This approach works in ALL terminals (Warp, iTerm2, Terminal.app, kitty,
// foot, etc.) because it relies on readline's own input processing rather
// than intercepting raw keypress events, which are unreliable in modern
// terminals like Warp that have their own input editors.

function isMultilineSupported(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Multiline-aware prompt using readline's built-in line event.
 * A trailing backslash (\) followed by Enter continues input on a new line.
 * Plain Enter submits the accumulated input.
 */
function promptUserMultiline(
  rl: readline.Interface,
  promptText: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let accumulated = "";
    const continuationPrompt = picocolors.gray("… ");

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.removeListener("line", onLine);
      rl.removeListener("close", onClose);
      // Restore the original prompt for next call
      rl.setPrompt(promptText);
      resolve(value);
    };

    const onClose = () => finish(null);

    const onLine = (line: string) => {
      // Check for trailing backslash for line continuation
      if (line.endsWith("\\")) {
        // Remove the backslash and add the line + newline
        accumulated += line.slice(0, -1) + "\n";
        // Set continuation prompt for the next line
        rl.setPrompt(continuationPrompt);
        rl.prompt();
        return;
      }
      // No trailing backslash — this is the final line
      accumulated += line;
      finish(accumulated);
    };

    rl.on("line", onLine);
    rl.once("close", onClose);

    // Set the initial prompt and start
    rl.setPrompt(promptText);
    rl.prompt();
  });
}

// Unified prompt function with multiline support
function promptUser(
  rl: readline.Interface,
  promptText: string,
): Promise<string | null> {
  if (!isMultilineSupported()) {
    // Fallback to plain readline for non-TTY (piped input, CI, etc.)
    return new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      };
      rl.once("close", onClose);
      rl.question(promptText, (answer: string) => {
        if (!settled) {
          settled = true;
          rl.removeListener("close", onClose);
          resolve(answer);
        }
      });
    });
  }

  return promptUserMultiline(rl, promptText);
}
// ─── Connectivity check ─────────────────────────────────────────────
async function checkOllamaConnectivity(): Promise<boolean> {
  if (
    config.llmBaseUrl.includes("localhost") ||
    config.llmBaseUrl.includes("127.0.0.1")
  ) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const baseUrl = config.llmBaseUrl.replace(/\/v1\/?$/, "");
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response.ok;
    } catch (e) {
      return false;
    }
  }
  return true;
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const rawArgs = process.argv.slice(2);
  let cliOpts;
  try {
    cliOpts = parseCliArgs(rawArgs);
  } catch (err) {
    if (err instanceof UsageError) {
      statusLine("ERROR", err.message);
      process.exit(err.exitCode);
    }
    throw err;
  }

  if (cliOpts.help) {
    printHelp();
    process.exit(EXIT.OK);
  }

  if (cliOpts.version) {
    console.log(`quiver v${VERSION}`);
    process.exit(EXIT.OK);
  }

  if (cliOpts.init) {
    await runInitWizard();
    process.exit(EXIT.OK);
  }

  if (cliOpts.unknownFlags.length > 0) {
    printUnknownFlagHints(cliOpts.unknownFlags);
    process.exit(EXIT.USAGE);
  }

  // ── First-run wizard ──
  if (isFirstRun()) {
    printFirstRunWizard();
    process.exit(EXIT.CONFIG);
  }

  const t = theme();
  const isQuiet = config.outputMode === "quiet";
  const isJson = config.outputMode === "json";
  const isInteractive = config.outputMode === "interactive";

  // ── Banner ──
  if (isInteractive) {
    console.log(
      t.cyan(t.bold(`\n================================================`)),
    );
    console.log(t.cyan(t.bold(`⚡ Quiver v${VERSION} — AI Agent Harness ⚡`)));
    console.log(
      t.cyan(t.bold(`================================================`)),
    );
    if (config.dryRun) {
      statusLine(
        "DRY",
        "Dry-run mode — tool actions are previewed, not executed.",
      );
    }
  }

  // Load and validate config
  validateConfig();

  // Check Ollama daemon status if configured to localhost
  if (isInteractive) {
    statusLine("INFO", "Checking AI connection…");
    const isOllamaConnected = await checkOllamaConnectivity();
    if (!isOllamaConnected) {
      statusBlock("WARN", "Ollama server appears offline", [
        `Endpoint: ${config.llmBaseUrl}`,
        "Run 'ollama serve' or update LLM_API_BASE_URL in .env",
        "Press Ctrl+C to exit, or continue if the server is starting",
      ]);
    } else {
      statusLine("OK", "AI connection established");
    }
  }

  // Load Registry
  if (isInteractive) {
    statusLine("INFO", "Loading available AI actions…");
  }
  await globalRegistry.loadAll();
  const tools = globalRegistry.getAllTools();
  if (isInteractive) {
    statusLine("OK", `Loaded ${tools.length} capabilities`);
    console.log(t.gray(`   Use /tools to see all available actions.\n`));
  }

  // ── List sessions mode ──
  if (cliOpts.listSessions) {
    const sessions = await Agent.listSessionStates();
    if (sessions.length === 0) {
      console.log(t.gray("No saved sessions found."));
    } else {
      console.log(
        t.cyan(t.bold(`\n📋 Saved Sessions (${sessions.length}):\n`)),
      );
      console.log(
        `   ${"Session ID".padEnd(30)} ${"Messages".padStart(8)}  ${"Model".padEnd(20)} ${"Saved At"}`,
      );
      console.log(
        `   ${"─".repeat(30)} ${"─".repeat(8)}  ${"─".repeat(20)} ${"─".repeat(20)}`,
      );
      for (const s of sessions.slice(0, 20)) {
        const shortId =
          s.sessionId.length > 28
            ? s.sessionId.substring(0, 28) + "…"
            : s.sessionId;
        console.log(
          `   ${shortId.padEnd(30)} ${String(s.messageCount).padStart(8)}  ${s.model.padEnd(20)} ${s.savedAt.substring(0, 19)}`,
        );
      }
      console.log(t.gray(`\n   Use: quiver --resume   to pick a session`));
      console.log(
        t.gray(`   Use: quiver --continue  to resume the latest session\n`),
      );
    }
    process.exit(EXIT.OK);
  }

  // Instantiate Agent
  const agent = new Agent(globalRegistry);

  // ── Resume/Continue mode ──
  let resumedSession = false;
  if (cliOpts.continue || cliOpts.resume) {
    let statePath: string | null = null;

    if (cliOpts.continue) {
      // --continue: resume the most recent session
      statePath = await Agent.findLatestSessionState();
      if (!statePath) {
        if (isInteractive) {
          statusLine(
            "WARN",
            "No previous session found to continue. Starting fresh.",
          );
        }
      }
    } else if (cliOpts.resume) {
      // --resume: show session picker
      const sessions = await Agent.listSessionStates();
      if (sessions.length === 0) {
        if (isInteractive) {
          statusLine("WARN", "No saved sessions found. Starting fresh.");
        }
      } else {
        console.log(t.cyan(t.bold(`\n📋 Resume a Session:\n`)));
        for (let i = 0; i < Math.min(sessions.length, 20); i++) {
          const s = sessions[i];
          const shortId =
            s.sessionId.length > 28
              ? s.sessionId.substring(0, 28) + "…"
              : s.sessionId;
          console.log(
            `   ${t.green(`[${i + 1}]`)} ${shortId.padEnd(30)} ${String(s.messageCount).padStart(5)} msgs  ${s.savedAt.substring(0, 19)}`,
          );
        }
        console.log(
          t.gray(
            `\n   Enter session number (1-${Math.min(sessions.length, 20)}) or press Enter to start fresh:`,
          ),
        );

        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await new Promise<string>((resolve) => {
          rl.question("   > ", (ans) => resolve(ans));
        });
        rl.close();

        const choice = parseInt(answer.trim(), 10);
        if (
          !isNaN(choice) &&
          choice >= 1 &&
          choice <= Math.min(sessions.length, 20)
        ) {
          statePath = sessions[choice - 1].path;
        }
      }
    }

    if (statePath) {
      const loaded = await agent.loadSessionState(statePath);
      if (loaded) {
        resumedSession = true;
        if (isInteractive) {
          statusLine("OK", `Resumed session: ${agent.getSessionId()}`);
          console.log(
            t.gray(
              `   ${agent.getMessageCount()} messages restored from disk.`,
            ),
          );
          console.log(t.gray(`   Use /compact if context is too large.\n`));
        }
      }
    }
  }

  if (isInteractive && !resumedSession) {
    statusLine("INFO", "Session started");
    console.log(t.gray(`   Type '/help' for commands, '/exit' to quit.`));
    console.log(
      t.gray(
        `   End a line with \\ then Enter for multiline. Plain Enter submits.\n`,
      ),
    );
  }

  // ── Single-turn mode ──
  if (cliOpts.singleTurn) {
    const promptText = cliOpts.singleTurn;
    if (isJson) {
      let fullResponse = "";
      try {
        await agent.prompt(promptText, (token) => {
          fullResponse += token;
        });
        emitJson({
          status: "ok",
          prompt: promptText,
          response: fullResponse,
          sessionId: agent.getSessionId(),
          dryRun: config.dryRun,
          tokenStats: agent.getTokenStats(),
        });
        process.exit(EXIT.OK);
      } catch (err: any) {
        emitJson(
          {
            status: "error",
            prompt: promptText,
            error: err.message,
            sessionId: agent.getSessionId(),
          },
          process.stderr,
        );
        process.exit(EXIT.ERROR);
      }
    }

    if (isInteractive || isQuiet) {
      statusLine("INFO", `Running single-turn prompt: "${promptText}"`);
    }
    process.stdout.write(t.promptAgent());
    try {
      await agent.prompt(promptText, (token) => {
        process.stdout.write(token);
      });
      console.log("\n");
      process.exit(EXIT.OK);
    } catch (err: any) {
      statusLine("ERROR", err.message);
      process.exit(EXIT.ERROR);
    }
  }

  // ── Interactive session loop ──
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Note: No raw mode needed — multiline input uses readline's native
  // line-event handling with backslash continuation, which works in all
  // terminals including Warp.

  agent.setSessionReadline(rl);

  // ── Graceful Ctrl+C handling ──
  let interruptCount = 0;
  let interruptTimer: ReturnType<typeof setTimeout> | null = null;

  process.on("SIGINT", () => {
    interruptCount++;
    if (interruptCount === 1) {
      statusLine("WARN", "Interrupted. Press Ctrl+C again to exit.");
      // Reset interrupt counter after 3 seconds
      interruptTimer = setTimeout(() => {
        interruptCount = 0;
      }, 3000);
      // Re-show prompt
      process.stdout.write(theme().promptUser());
    } else {
      if (interruptTimer) clearTimeout(interruptTimer);
      // Save session state synchronously before exiting on double Ctrl+C
      agent.saveSessionStateSync();
      statusLine("OK", "Exiting session. Goodbye!");
      console.log(t.gray(`   Session saved. Resume with: quiver --continue`));
      console.log(t.gray(`   Session log: ${agent.getSessionLogRelPath()}\n`));
      rl.close();
      process.exit(0);
    }
  });

  process.on("SIGTERM", () => {
    // Save session state synchronously before exiting on SIGTERM
    agent.saveSessionStateSync();
    statusLine("WARN", "Received SIGTERM. Shutting down gracefully.");
    console.log(t.gray(`   Session saved. Resume with: quiver --continue`));
    console.log(t.gray(`   Session log: ${agent.getSessionLogRelPath()}\n`));
    rl.close();
    process.exit(0);
  });

  // Save session state on uncaught exceptions / unhandled rejections before exiting
  process.on("uncaughtException", (err) => {
    agent.saveSessionStateSync();
    statusLine("ERROR", `Uncaught exception: ${err.message}`);
    console.log(t.gray(`   Session saved. Resume with: quiver --continue`));
    console.log(t.gray(`   Session log: ${agent.getSessionLogRelPath()}\n`));
    rl.close();
    process.exit(EXIT.ERROR);
  });

  process.on("unhandledRejection", (reason) => {
    agent.saveSessionStateSync();
    const msg = reason instanceof Error ? reason.message : String(reason);
    statusLine("ERROR", `Unhandled rejection: ${msg}`);
    console.log(t.gray(`   Session saved. Resume with: quiver --continue`));
    console.log(t.gray(`   Session log: ${agent.getSessionLogRelPath()}\n`));
    rl.close();
    process.exit(EXIT.ERROR);
  });

  // Last-resort save before the event loop empties
  process.on("beforeExit", () => {
    agent.saveSessionStateSync();
  });

  try {
    while (true) {
      const promptSymbol = theme().promptUser();
      const input = await promptUser(rl, promptSymbol);

      // Handle EOF (Ctrl+D) or null input gracefully — don't crash
      if (input === null || input === undefined) {
        console.log(
          picocolors.yellow(
            "\n👋 Received EOF (Ctrl+D). Saving session and exiting.",
          ),
        );
        agent.saveSessionStateSync();
        console.log(
          picocolors.gray(`   Session saved. Resume with: quiver --continue\n`),
        );
        break;
      }

      const cleanInput = input.trim();
      interruptCount = 0; // Reset on valid input

      if (!cleanInput) continue;

      // ── Check if it's a slash command ──
      if (cleanInput.startsWith("/")) {
        const resolved = resolveSlashCommand(cleanInput);

        if (resolved === "/exit") {
          agent.saveSessionStateSync();
          console.log(picocolors.yellow("\n👋 Exiting session. Goodbye!"));
          console.log(
            picocolors.gray(`   Session saved. Resume with: quiver --continue`),
          );
          console.log(
            picocolors.gray(
              `   Session log: ${agent.getSessionLogRelPath()}\n`,
            ),
          );
          break;
        }

        if (resolved === "/help") {
          printInSessionHelp();
          continue;
        }

        if (resolved === "/tools") {
          printEnhancedTools();
          continue;
        }

        if (resolved === "/session") {
          const stats = agent.getTokenStats();
          console.log(picocolors.cyan(`\n  Session`));
          console.log(`    Messages:    ${agent.getMessageCount()}`);
          console.log(`    Tool calls:  ${stats.toolCalls}`);
          console.log(`    Turns:       ${stats.turns}`);
          console.log(
            `    Tokens:      ${(stats.inputTokens + stats.outputTokens).toLocaleString()} (est.)\n`,
          );
          continue;
        }

        if (resolved === "/version") {
          console.log(picocolors.cyan(`\n⚡ Quiver v${VERSION}\n`));
          continue;
        }

        if (resolved === "/config") {
          console.log(`\n⚙️  Current Configuration:`);
          console.log(`   - Endpoint Base:     ${config.llmBaseUrl}`);
          console.log(`   - Target Model:      ${config.llmModelName}`);
          console.log(
            `   - API Key:           ${redactSecret(config.llmApiKey)}`,
          );
          console.log(
            `   - Parallel Key:      ${redactSecret(config.parallelApiKey)}`,
          );
          console.log(
            `   - Ollama Pro Key:    ${redactSecret(config.ollamaApiKey)}`,
          );
          console.log(`   - Skills Dir:        ${config.skillsDir}`);
          console.log(`   - Memory Dir:        ${config.memoryDir}`);
          console.log(`   - Max Loop Turns:    ${config.maxLoops}`);
          console.log(
            `   - Max Context Tokens: ${config.maxContextTokens.toLocaleString()}`,
          );
          console.log(
            `   - Approvals:         ${config.requireApprovalFor.join(", ") || "None"}`,
          );
          console.log(`   - Output Mode:       ${config.outputMode}`);
          console.log(
            `   - Dry Run:           ${config.dryRun ? "Yes" : "No"}\n`,
          );
          continue;
        }

        if (resolved === "/clear") {
          console.clear();
          continue;
        }

        if (resolved === "/compact") {
          const removed = agent.compactHistory();
          if (removed > 0) {
            console.log(
              picocolors.green(
                `\n♻️  Compacted conversation: removed ${removed} old messages.\n`,
              ),
            );
          } else {
            console.log(
              picocolors.yellow(
                `\nℹ️  Conversation is already compact. Nothing to trim.\n`,
              ),
            );
          }
          continue;
        }

        if (resolved === "/reset") {
          agent.resetConversation();
          console.log(
            picocolors.green(
              `\n🔄 Conversation reset. Memory and skills retained.\n`,
            ),
          );
          continue;
        }

        if (resolved === "/cost") {
          const stats = agent.getTokenStats();
          console.log(picocolors.cyan(`\n  Usage`));
          console.log(`    Turns:      ${stats.turns}`);
          console.log(`    Tool calls: ${stats.toolCalls}`);
          console.log(
            `    Tokens:     ${(stats.inputTokens + stats.outputTokens).toLocaleString()} (est.)\n`,
          );
          continue;
        }

        if (resolved === "/memory") {
          const memDir = path.resolve(config.memoryDir);
          console.log(picocolors.cyan(`\n  Memory (${memDir})\n`));
          try {
            const files = await import("fs/promises");
            const entries = await files.readdir(memDir);
            for (const f of entries) {
              if (f.startsWith(".")) continue;
              const fpath = path.join(memDir, f);
              const stat = await files.stat(fpath);
              if (stat.isFile()) {
                const content = await files.readFile(fpath, "utf8");
                const lines = content.split("\n").length;
                const chars = content.length;
                const preview =
                  content.substring(0, 100).replace(/\n/g, " ") +
                  (chars > 100 ? "…" : "");
                console.log(
                  `  ${picocolors.green(f.padEnd(20))} ${picocolors.gray(`${lines} lines · ${chars} chars`)}`,
                );
                console.log(picocolors.gray(`    ${preview}\n`));
              }
            }
          } catch {
            console.log(picocolors.yellow("  No memory directory found.\n"));
          }
          continue;
        }

        if (resolved === "/model") {
          const parts = cleanInput.split(/\s+/);
          const newModel = parts[1];
          if (!newModel) {
            console.log(
              picocolors.cyan(`\n🤖 Current Model: ${config.llmModelName}`),
            );
            console.log(picocolors.gray(`   To change: /model <model-name>\n`));
          } else {
            const oldModel = config.llmModelName;
            config.llmModelName = newModel;
            console.log(
              picocolors.green(
                `\n✅ Model changed: ${oldModel} → ${newModel}\n`,
              ),
            );
          }
          continue;
        }

        if (resolved === "/history") {
          const msgs = agent.getMessages();
          console.log(
            picocolors.cyan(
              `\n📜 Conversation History (${msgs.length} messages):`,
            ),
          );
          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i];
            const role = msg.role.toUpperCase();
            const preview = (msg.content || "").substring(0, 80);
            const toolCount = msg.tool_calls?.length || 0;
            const toolInfo = toolCount > 0 ? ` [${toolCount} tool calls]` : "";
            console.log(
              `   ${String(i).padStart(3, " ")}. ${role.padEnd(10)} ${preview}${preview.length === 80 ? "..." : ""}${toolInfo}`,
            );
          }
          console.log("");
          continue;
        }

        if (resolved === "/dry-run") {
          config.dryRun = !config.dryRun;
          statusLine(
            config.dryRun ? "DRY" : "OK",
            config.dryRun
              ? "Dry-run enabled — tool actions are previewed, not executed."
              : "Dry-run disabled — tool actions will execute normally.",
          );
          console.log("");
          continue;
        }

        if (resolved === "/resume") {
          // Save current session before switching
          agent.saveSessionStateSync();

          const sessions = await Agent.listSessionStates();
          // Filter out the current session
          const currentSessionId = agent.getSessionId();
          const otherSessions = sessions.filter(
            (s) => s.sessionId !== currentSessionId,
          );

          if (otherSessions.length === 0) {
            console.log(
              picocolors.yellow("\nℹ️  No other saved sessions found.\n"),
            );
            continue;
          }

          console.log(
            picocolors.cyan(picocolors.bold(`\n📋 Resume a Session:\n`)),
          );
          for (let i = 0; i < Math.min(otherSessions.length, 20); i++) {
            const s = otherSessions[i];
            const shortId =
              s.sessionId.length > 28
                ? s.sessionId.substring(0, 28) + "…"
                : s.sessionId;
            console.log(
              `   ${picocolors.green(`[${i + 1}]`)} ${shortId.padEnd(30)} ${String(s.messageCount).padStart(5)} msgs  ${s.savedAt.substring(0, 19)}`,
            );
          }
          console.log(
            picocolors.gray(
              `\n   Enter session number (1-${Math.min(otherSessions.length, 20)}) or press Enter to cancel:`,
            ),
          );

          const resumeRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          const answer = await new Promise<string>((resolve) => {
            resumeRl.question("   > ", (ans) => resolve(ans || ""));
          });
          resumeRl.close();

          const choice = parseInt(answer.trim(), 10);
          if (
            !isNaN(choice) &&
            choice >= 1 &&
            choice <= Math.min(otherSessions.length, 20)
          ) {
            const statePath = otherSessions[choice - 1].path;
            const loaded = await agent.loadSessionState(statePath);
            if (loaded) {
              console.log(
                picocolors.green(
                  `\n✅ Resumed session: ${agent.getSessionId()}`,
                ),
              );
              console.log(
                picocolors.gray(
                  `   ${agent.getMessageCount()} messages restored from disk.\n`,
                ),
              );
            } else {
              console.log(
                picocolors.red("\n❌ Failed to load session state.\n"),
              );
            }
          } else {
            console.log(picocolors.gray("\n   Cancelled.\n"));
          }
          continue;
        }

        if (resolved === "/export") {
          const exportPath = path.resolve(
            ".sessions",
            `${agent.getSessionId()}.qf`,
          );
          try {
            await exportToAgentFile(agent, exportPath);
            statusLine("OK", `Session exported to ${exportPath}`);
            console.log("");
          } catch (err: any) {
            statusLine("ERROR", `Export failed: ${err.message}`);
            console.log("");
          }
          continue;
        }

        // ── /approvals subcommand handling ──
        if (resolved === "/approvals") {
          const parts = cleanInput.split(/\s+/);
          const subcommand = parts[1];
          const argsStr = parts.slice(2).join(" ");

          if (!subcommand) {
            console.log(picocolors.cyan(`\n🔒 Security Approvals Config:`));
            console.log(
              `   - Current List: ${config.requireApprovalFor.length > 0 ? picocolors.green(config.requireApprovalFor.join(", ")) : picocolors.yellow("None")}`,
            );
            console.log(picocolors.gray(`   - Commands:`));
            console.log(picocolors.gray(`     ├─ /approvals set tool1,tool2`));
            console.log(picocolors.gray(`     ├─ /approvals add toolName`));
            console.log(picocolors.gray(`     ├─ /approvals remove toolName`));
            console.log(picocolors.gray(`     └─ /approvals clear\n`));
            continue;
          }

          switch (subcommand.toLowerCase()) {
            case "set": {
              const list = argsStr
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              config.requireApprovalFor = list;
              console.log(
                picocolors.green(
                  `✅ Approvals set to: ${list.join(", ") || "None"}\n`,
                ),
              );
              break;
            }
            case "add": {
              const toolName = argsStr.trim();
              if (!toolName) {
                console.log(
                  picocolors.red(
                    `❌ Please specify a tool name to add. Example: /approvals add run_command\n`,
                  ),
                );
              } else if (config.requireApprovalFor.includes(toolName)) {
                console.log(
                  picocolors.yellow(
                    `ℹ️  Tool '${toolName}' is already in the approval list.\n`,
                  ),
                );
              } else {
                config.requireApprovalFor.push(toolName);
                console.log(
                  picocolors.green(
                    `✅ Tool '${toolName}' added to approvals list. Current list: ${config.requireApprovalFor.join(", ")}\n`,
                  ),
                );
              }
              break;
            }
            case "remove": {
              const toolName = argsStr.trim();
              if (!toolName) {
                console.log(
                  picocolors.red(
                    `❌ Please specify a tool name to remove. Example: /approvals remove run_command\n`,
                  ),
                );
              } else {
                const idx = config.requireApprovalFor.indexOf(toolName);
                if (idx === -1) {
                  console.log(
                    picocolors.yellow(
                      `ℹ️  Tool '${toolName}' is not in the approval list.\n`,
                    ),
                  );
                } else {
                  config.requireApprovalFor.splice(idx, 1);
                  console.log(
                    picocolors.green(
                      `✅ Tool '${toolName}' removed from approvals list. Current list: ${config.requireApprovalFor.join(", ") || "None"}\n`,
                    ),
                  );
                }
              }
              break;
            }
            case "clear": {
              config.requireApprovalFor = [];
              console.log(
                picocolors.green(
                  `✅ All tool approvals cleared. Tool execution is now fully automatic.\n`,
                ),
              );
              break;
            }
            default: {
              console.log(
                picocolors.red(
                  `❌ Unknown approvals command '${subcommand}'. Use set, add, remove, or clear.\n`,
                ),
              );
            }
          }
          continue;
        }

        // ── Unknown slash command: fuzzy suggest ──
        const suggestion = suggestSlashCommand(cleanInput);
        if (suggestion) {
          console.log(
            picocolors.yellow(
              `\n⚠️  Unknown command '${cleanInput.split(/\s+/)[0]}'. Did you mean ${picocolors.bold(picocolors.green(suggestion))}?`,
            ),
          );
          console.log(
            picocolors.gray(`   Type '/help' to see all available commands.\n`),
          );
        } else {
          console.log(
            picocolors.yellow(
              `\n⚠️  Unknown command '${cleanInput.split(/\s+/)[0]}'.`,
            ),
          );
          console.log(
            picocolors.gray(`   Type '/help' to see all available commands.\n`),
          );
        }
        continue;
      }

      // ── Stream the agent response ──
      if (isJson) {
        let fullResponse = "";
        try {
          await agent.prompt(cleanInput, (token) => {
            fullResponse += token;
          });
          emitJson({
            status: "ok",
            prompt: cleanInput,
            response: fullResponse,
            sessionId: agent.getSessionId(),
            dryRun: config.dryRun,
            tokenStats: agent.getTokenStats(),
          });
        } catch (err: any) {
          emitJson(
            {
              status: "error",
              prompt: cleanInput,
              error: err.message,
              sessionId: agent.getSessionId(),
            },
            process.stderr,
          );
        }
      } else {
        process.stdout.write(theme().promptAgent());
        try {
          await agent.prompt(cleanInput, (token) => {
            process.stdout.write(token);
          });
        } catch (err: any) {
          statusLine("ERROR", `Agent loop failed: ${err.message}`);
        }
        console.log("\n");
      }
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  if (config.outputMode === "json") {
    emitJson({ status: "fatal", error: err.message }, process.stderr);
  } else {
    statusLine("ERROR", `Fatal CLI error: ${err.message}`);
  }
  process.exit(EXIT.ERROR);
});
