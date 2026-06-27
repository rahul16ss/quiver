import readline from "readline";
import picocolors from "picocolors";
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
import {
  detectOllamaIdentity,
  formatOllamaIdentity,
} from "./ollama_identity.js";
import { getCloudSyncStatus } from "./cloud_sync.js";
import {
  SLASH_COMMANDS,
  resolveSlashCommand,
  suggestSlashCommand,
} from "./slash_commands.js";
import { detectImagePaths } from "./image_input.js";
import { printHelp, printInSessionHelp, printEnhancedTools } from "./help.js";
import { promptUser } from "./multiline.js";
import { runSignin, checkOllamaConnectivity } from "./signin.js";
import { runCloudSync } from "./cloud_sync_ui.js";
import {
  getProjectName,
  getProjectMemoryDir,
  getCoreMemoryPath,
} from "./paths.js";
import * as path from "path";
import { readFileSync } from "fs";

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

  if (cliOpts.signin) {
    await runSignin();
    process.exit(EXIT.OK);
  }

  if (cliOpts.cloudSync) {
    await runCloudSync();
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
    console.log(t.gray(`   Project: ${getProjectName()}`));

    // Show Ollama identity status
    const ollamaId = detectOllamaIdentity();
    if (ollamaId.hasBinary || ollamaId.hasApiKey || ollamaId.hasSignedIn) {
      const idStatus = formatOllamaIdentity(ollamaId);
      console.log(t.gray(`   Identity: ${idStatus}`));
    } else {
      console.log(
        t.gray(
          `   Identity: Not configured — run 'quiver signin' to link Ollama`,
        ),
      );
    }

    // Show cloud sync status
    const cloudStatus = getCloudSyncStatus();
    if (cloudStatus.active) {
      console.log(
        t.gray(`   Cloud:    ✓ ${cloudStatus.provider} → ${cloudStatus.path}`),
      );
    } else {
      console.log(
        t.gray(`   Cloud:    Not detected (run 'quiver cloud-sync' to set up)`),
      );
    }

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
      try {
        await agent.prompt(
          promptText,
          (token) => {
            emitJson({ type: "token", data: { text: token } });
          },
          (event) => {
            emitJson(event);
          },
        );
        process.exit(EXIT.OK);
      } catch (err: any) {
        emitJson(
          { type: "error", data: { error: err.message } },
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

      let cleanInput = input.trim();
      interruptCount = 0; // Reset on valid input

      if (!cleanInput) continue;

      // Detect dragged-and-dropped image file paths
      // When you drag a file from Finder into a terminal, it inserts the path
      cleanInput = detectImagePaths(cleanInput);

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
          const ollamaId = detectOllamaIdentity();
          console.log(`\n⚙️  Current Configuration:`);
          console.log(`   - Endpoint Base:     ${config.llmBaseUrl}`);
          console.log(`   - Target Model:      ${config.llmModelName}`);
          console.log(
            `   - LLM API Key:       ${redactSecret(config.llmApiKey)}`,
          );
          console.log(
            `   - Ollama Identity:   ${formatOllamaIdentity(ollamaId)}`,
          );
          console.log(
            `   - Ollama Pro Key:    ${redactSecret(config.ollamaApiKey)}`,
          );
          console.log(
            `   - Cloud Sync:        ${config.cloudSyncPath ? config.cloudSyncPath : "Auto-detect"}`,
          );
          console.log(
            `   - Parallel APIs:     ${redactSecret(config.parallelApiKey)}${config.parallelApiKey ? " (search, extract, research, findall, entity)" : ""}`,
          );
          console.log(
            `   - GitHub Token:      ${redactSecret(config.githubToken)}`,
          );
          console.log(
            `   - Context7:          ${config.context7ApiKey ? redactSecret(config.context7ApiKey) : "No key needed (free)"}`,
          );
          console.log(`   - Skills Dir:        ${config.skillsDir}`);
          console.log(`   - Memory Dir:        ${config.memoryDir}`);
          console.log(`   - Browser Headless:  ${config.browserHeadless}`);
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
          const projectName = getProjectName();
          const memDir = getProjectMemoryDir();
          const corePath = getCoreMemoryPath();
          console.log(
            picocolors.cyan(`\n  Memory — Project: ${projectName}`),
          );
          console.log(picocolors.gray(`  Project memory: ${memDir}`));
          console.log(picocolors.gray(`  Global core:    ${corePath}\n`));
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
            const previewRaw = msg.content;
            const preview = (
              typeof previewRaw === "string"
                ? previewRaw
                : Array.isArray(previewRaw)
                  ? previewRaw
                      .filter((p: any) => p.type === "text")
                      .map((p: any) => p.text)
                      .join(" ")
                  : ""
            ).substring(0, 80);
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

        if (resolved === "/signin") {
          await runSignin();
          continue;
        }

        if (resolved === "/cloud-sync") {
          await runCloudSync();
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
        try {
          await agent.prompt(
            cleanInput,
            (token) => {
              emitJson({ type: "token", data: { text: token } });
            },
            (event) => {
              emitJson(event);
            },
          );
          // Final done event is emitted by the agent's onEvent callback
        } catch (err: any) {
          emitJson(
            {
              type: "error",
              data: { error: err.message },
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
