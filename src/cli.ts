import readline from "readline";
import picocolors from "picocolors";
import {
  config,
  printConfig,
  isFirstRun,
  printFirstRunWizard,
  runOnboardingHandshake,
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
import { detectCrashedSession, archiveCrashedSession, discardCrashedSession } from "./session/checkpoint.js";
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
import { runCloudSync, runCleanupLeaks } from "./cloud_sync_ui.js";
import {
  getProjectName,
  getProjectMemoryDir,
  getCoreMemoryPath,
  getSkillsDir,
  getProjectSessionsDir,
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

  if (cliOpts.cleanupLeaks) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runCleanupLeaks(rl);
    } finally {
      rl.close();
    }
    process.exit(EXIT.OK);
  }

  if (cliOpts.unknownFlags.length > 0) {
    printUnknownFlagHints(cliOpts.unknownFlags);
    process.exit(EXIT.USAGE);
  }

  // ── First-run onboarding handshake (US-1.1) ──
  // Launches a conversational setup so the user can move forward instead of
  // dead-ending on a static "run quiver init" message + config-error exit.
  // Subcommands (--list-sessions, --single-turn, etc.) must bypass the
  // interactive onboarding handshake in non-TTY mode (US-2.5) so scripted/CI
  // usage is not blocked.
  const isSubcommand = cliOpts.listSessions || !!cliOpts.singleTurn;
  const isNonTty = !process.stdin.isTTY || !process.stdout.isTTY;
  if (isFirstRun() && !(isSubcommand && isNonTty)) {
    await runOnboardingHandshake();
  }

  const t = theme();
  const isQuiet = config.outputMode === "quiet";
  const isJson = config.outputMode === "json";
  // Interactive crash-recovery gating must require a real TTY (US-13.2):
  // piped/non-interactive runs must never consume stdin or auto-discard
  // crashed sessions. isInteractive is therefore bound to BOTH the output
  // mode AND stdin/stdout being a TTY.
  const isInteractive =
    config.outputMode === "interactive" &&
    process.stdin.isTTY && process.stdout.isTTY;

  // ── Banner — one line, no noise ──
  if (isInteractive) {
    const cloudStatus = getCloudSyncStatus();
    console.log(
      t.cyan(t.bold(`\n  Quiver v${VERSION}`)) +
      t.gray(` · ${getProjectName()}`) +
      (cloudStatus.active ? t.gray(` · ${cloudStatus.provider} ✓`) : "") +
      (config.dryRun ? t.yellow(` · dry-run`) : "") +
      (config.yoloMode ? t.red(` · YOLO`) : ""),
    );
  }

  // Config — one line
  printConfig();

  // Connectivity check — only show on failure
  if (isInteractive) {
    const isOllamaConnected = await checkOllamaConnectivity();
    if (!isOllamaConnected) {
      statusBlock("WARN", "Ollama server appears offline", [
        `Endpoint: ${config.llmBaseUrl}`,
        "Run 'ollama serve' or update LLM_API_BASE_URL in .env",
      ]);
    }
  }

  // Load tools — silent
  await globalRegistry.loadAll();
  const tools = globalRegistry.getAllTools();

  // Load MCP servers (if configured)
  let mcpToolCount = 0;
  try {
    const { loadMcpConfig } = await import("./mcp/config.js");
    const { mcpManager } = await import("./mcp/client.js");
    const mcpConfig = loadMcpConfig();
    if (mcpConfig && mcpConfig.mcpServers && Object.keys(mcpConfig.mcpServers).length > 0) {
      if (isInteractive) {
        console.log(t.gray(`  Connecting to MCP servers…`));
      }
      const mcpTools = await mcpManager.connectAll(mcpConfig.mcpServers);
      for (const mcpTool of mcpTools) {
        globalRegistry["tools"].set(mcpTool.name, mcpTool);
      }
      mcpToolCount = mcpTools.length;
    }
  } catch (err: any) {
    if (isInteractive) {
      console.log(t.gray(`  MCP: ${err.message}`));
    }
  }

  if (isInteractive) {
    const totalTools = tools.length + mcpToolCount;
    const mcpInfo = mcpToolCount > 0 ? ` · ${mcpToolCount} MCP` : "";
    console.log(t.gray(`  ${totalTools} tools loaded${mcpInfo} · /help for commands\n`));
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

  // Track whether a session was resumed (via --continue, --resume, or crash
  // recovery) so the "Session started" banner is suppressed appropriately.
  let resumedSession = false;

  // US-13.2: detect a crashed/incomplete session from a previous run and offer
  // to resume, archive, or discard it. Only in interactive mode and when not
  // already resuming via --continue/--resume.
  if (isInteractive && !cliOpts.continue && !cliOpts.resume) {
    try {
      const crash = await detectCrashedSession(getProjectName());
      if (crash.hasCrashedSession && crash.sessionId) {
        console.log(
          t.yellow(
            `\n  ⚠️  Unfinished session detected (crash recovery): ${crash.sessionId.substring(0, 12)}…`,
          ),
        );
        console.log(
          t.gray(`     This session was not properly closed. Choose an option:\n`),
        );
        console.log(`   ${t.green("[1]")} Resume  — continue from where it left off`);
        console.log(`   ${t.green("[2]")} Archive — move to archived folder (keep but don't resume)`);
        console.log(`   ${t.green("[3]")} Discard — delete the crashed session checkpoints`);
        console.log(`   ${t.gray("Enter to skip")}\n`);

        const crashRl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          crashRl.question("   > ", (ans) => resolve(ans.trim()));
        });
        crashRl.close();

        if (answer === "1") {
          // Resume the crashed session
          const loaded = await agent.loadSessionState(
            path.join(getProjectSessionsDir(), `${crash.sessionId}.state.json`),
          );
          if (loaded) {
            resumedSession = true;
            statusLine("OK", `Resumed crashed session: ${agent.getSessionId()}`);
            console.log(t.gray(`   ${agent.getMessageCount()} messages restored from checkpoint.\n`));
          }
        } else if (answer === "2") {
          await archiveCrashedSession(crash.sessionId);
          console.log(t.green("\n  ✅ Crashed session archived.\n"));
        } else if (answer === "3") {
          await discardCrashedSession(crash.sessionId);
          console.log(t.green("\n  ✅ Crashed session discarded.\n"));
        }
      }
    } catch {
      // Crash detection must never block startup.
    }
  }

  // ── Resume/Continue mode ──
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
      // US-2.3: Abort the active LLM stream on first Ctrl+C
      agent.abortActiveStream();
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
      // Close MCP connections
      import("./mcp/client.js").then(({ mcpManager }) => mcpManager.closeAll()).catch(() => {});
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
    // Close MCP connections
    import("./mcp/client.js").then(({ mcpManager }) => mcpManager.closeAll()).catch(() => {});
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
          const toolFilter = cleanInput.split(/\s+/).slice(1).join(" ");
          printEnhancedTools(toolFilter || undefined);
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
          console.log(`   - Skills Dir:        ${getSkillsDir()}`);
          console.log(`   - Memory Dir:        ${getProjectMemoryDir()}`);
          console.log(`   - Browser Headless:  ${config.browserHeadless}`);
          console.log(
            `   - Max Context Tokens: ${config.maxContextTokens.toLocaleString()}`,
          );
          console.log(
            `   - Approvals:         ${config.requireApprovalFor.join(", ") || "None"}`,
          );
          console.log(`   - YOLO Mode:        ${config.yoloMode ? "ON (all gates bypassed)" : "Off"}`);
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
          const result = await agent.compactHistory();
          if (result.removedCount > 0) {
            console.log(
              picocolors.green(
                `\n♻️  Compacted: ${result.removedCount} messages summarized.\n` +
                `   ${result.tokensBefore.toLocaleString()} → ${result.tokensAfter.toLocaleString()} tokens.\n` +
                `   Full conversation saved to: ${result.savedTo}\n`,
              ),
            );
          } else {
            console.log(
              picocolors.yellow(
                `\nℹ️  Conversation is already compact. Nothing to compact.\n`,
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
          const memSubCmd = cleanInput.split(/\s+/)[1];
          if (memSubCmd === "review") {
            // US-12.2: Memory review queue CLI
            const { getPendingFacts, processReview, formatReviewQueueForCLI } =
              await import("./memory/review_queue.js");
            const reviewAction = cleanInput.split(/\s+/)[2];
            const factId = cleanInput.split(/\s+/)[3];
            const newContent = cleanInput.split(/\s+/).slice(4).join(" ");

            if (reviewAction && factId) {
              const result = await processReview(
                factId,
                reviewAction as any,
                newContent || undefined,
              );
              if (result.success) {
                console.log(picocolors.green(`\n  ✅ ${result.message}\n`));
              } else {
                console.log(picocolors.red(`\n  ❌ ${result.message}\n`));
              }
            } else {
              const pending = await getPendingFacts();
              console.log(formatReviewQueueForCLI(pending));
              console.log(
                picocolors.gray(
                  "\n  Usage: /memory review <accept|edit|reject|pin|expire> <id> [new-content]\n",
                ),
              );
            }
            continue;
          }

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
            const fullText = (
              typeof previewRaw === "string"
                ? previewRaw
                : Array.isArray(previewRaw)
                  ? previewRaw
                      .filter((p: any) => p.type === "text")
                      .map((p: any) => p.text)
                      .join(" ")
                  : ""
            );
            const preview = fullText.substring(0, 80);
            const truncated = fullText.length > 80;
            const toolCount = msg.tool_calls?.length || 0;
            const toolInfo = toolCount > 0 ? ` [${toolCount} tool calls]` : "";
            console.log(
              `   ${String(i).padStart(3, " ")}. ${role.padEnd(10)} ${preview}${truncated ? "…" : ""}${toolInfo}`,
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

        // ── /logs subcommand handling (US-13.3) ──
        if (resolved === "/logs") {
          const parts = cleanInput.split(/\s+/);
          const subcommand = parts[1] || "list";

          if (subcommand === "list") {
            // List all session log files
            const sessionsDir = getProjectSessionsDir();
            try {
              const files = await import("fs/promises");
              const entries = await files.readdir(sessionsDir);
              const logFiles = entries.filter((f) => f.endsWith(".log") || f.endsWith(".json") || f.endsWith(".state.json"));
              if (logFiles.length === 0) {
                console.log(picocolors.gray("\n  No session logs found.\n"));
              } else {
                console.log(picocolors.cyan(`\n  📋 Session Logs (${logFiles.length}):\n`));
                for (const f of logFiles.sort().reverse().slice(0, 20)) {
                  const fpath = path.join(sessionsDir, f);
                  const stat = await files.stat(fpath);
                  const sizeKB = (stat.size / 1024).toFixed(1);
                  const mtime = stat.mtime.toISOString().substring(0, 19);
                  console.log(`   ${f.padEnd(40)} ${sizeKB.padStart(8)} KB  ${mtime}`);
                }
                console.log("");
              }
            } catch {
              console.log(picocolors.gray("\n  No session logs found.\n"));
            }
          } else if (subcommand === "purge") {
            // Purge old logs: /logs purge --older-than <days>
            const olderThanFlag = parts.indexOf("--older-than");
            const days = olderThanFlag >= 0 ? parseInt(parts[olderThanFlag + 1], 10) : 30;
            if (isNaN(days) || days <= 0) {
              console.log(picocolors.red("\n  ❌ Invalid --older-than value. Usage: /logs purge --older-than 30\n"));
              continue;
            }
            const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
            const sessionsDir = getProjectSessionsDir();
            try {
              const files = await import("fs/promises");
              const entries = await files.readdir(sessionsDir);
              let purged = 0;
              for (const f of entries) {
                if (f.endsWith(".log")) {
                  const fpath = path.join(sessionsDir, f);
                  const stat = await files.stat(fpath);
                  if (stat.mtime.getTime() < cutoff) {
                    await files.unlink(fpath);
                    purged++;
                  }
                }
              }
              console.log(picocolors.green(`\n  ✅ Purged ${purged} log file(s) older than ${days} day(s).\n`));
            } catch {
              console.log(picocolors.yellow("\n  ⚠️  Could not purge logs.\n"));
            }
          } else if (subcommand === "export") {
            // Export logs to a file: /logs export <path>
            const exportPath = parts[2] || path.resolve("quiver-logs-export.txt");
            const sessionsDir = getProjectSessionsDir();
            try {
              const files = await import("fs/promises");
              const entries = await files.readdir(sessionsDir);
              const logFiles = entries.filter((f) => f.endsWith(".log"));
              let combined = "";
              for (const f of logFiles.sort()) {
                const fpath = path.join(sessionsDir, f);
                const content = await files.readFile(fpath, "utf8");
                combined += `=== ${f} ===\n${content}\n\n`;
              }
              await files.writeFile(exportPath, combined, "utf8");
              console.log(picocolors.green(`\n  ✅ Exported ${logFiles.length} log file(s) to ${exportPath}\n`));
            } catch {
              console.log(picocolors.yellow("\n  ⚠️  Could not export logs.\n"));
            }
          } else {
            console.log(picocolors.gray("\n  Usage: /logs list | /logs purge --older-than <days> | /logs export [path]\n"));
          }
          continue;
        }

        // ── /rollback subcommand handling (US-10.2) ──
        if (resolved === "/rollback") {
          const parts = cleanInput.split(/\s+/);
          const subcommand = parts[1];

          if (subcommand === "last") {
            const { rollbackLast } = await import("./fs/atomic_write.js");
            try {
              const res = await rollbackLast();
              if (res) {
                console.log(picocolors.green(`\n  ✅ Rolled back to: ${path.relative(process.cwd(), res.restored)}\n`));
                continue;
              }
            } catch {}

            // Fallback: search workspace directories recursively for .quiver-backups
            const workspaceRoot = process.cwd();
            try {
              const fsPromises = await import("fs/promises");
              const findBackups = async (dir: string): Promise<{ path: string; mtimeMs: number }[]> => {
                let results: { path: string; mtimeMs: number }[] = [];
                try {
                  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
                  for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".sessions" || entry.name === ".quiver") {
                        continue;
                      }
                      if (entry.name === ".quiver-backups") {
                        try {
                          const bakFiles = await fsPromises.readdir(fullPath);
                          for (const bak of bakFiles) {
                            if (bak.endsWith(".bak")) {
                              const bakPath = path.join(fullPath, bak);
                              const stat = await fsPromises.stat(bakPath);
                              results.push({ path: bakPath, mtimeMs: stat.mtimeMs });
                            }
                          }
                        } catch {}
                      } else {
                        results = results.concat(await findBackups(fullPath));
                      }
                    }
                  }
                } catch {}
                return results;
              };

              const backups = await findBackups(workspaceRoot);
              if (backups.length === 0) {
                console.log(picocolors.yellow("\n  ⚠️  No backups found to rollback to.\n"));
                continue;
              }
              backups.sort((a, b) => b.mtimeMs - a.mtimeMs);
              const latest = backups[0];
              const backupDir = path.dirname(latest.path);
              const parentDir = path.dirname(backupDir);
              const bakName = path.basename(latest.path);
              const parts = bakName.split(".");
              const originalName = parts.slice(0, -2).join(".");
              const originalPath = path.join(parentDir, originalName);

              await fsPromises.copyFile(latest.path, originalPath);
              await fsPromises.unlink(latest.path);
              console.log(picocolors.green(`\n  ✅ Rolled back to: ${path.relative(workspaceRoot, originalPath)}\n`));
            } catch {
              console.log(picocolors.yellow("\n  ⚠️  No backups found to rollback to.\n"));
            }
          } else {
            console.log(picocolors.gray("\n  Usage: /rollback last\n"));
          }
          continue;
        }

        // ── /self-heal subcommand handling ──
        if (resolved === "/self-heal") {
          console.log(picocolors.cyan("\n🛠️  Initiating Self-Healing Routine..."));
          console.log(picocolors.gray("   Running compilation and test checks..."));

          const runCmd = (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
            return new Promise((resolve) => {
              import("child_process").then(({ exec }) => {
                exec(command, { cwd: process.cwd() }, (error, stdout, stderr) => {
                  resolve({
                    stdout: stdout ? stdout.toString() : "",
                    stderr: stderr ? stderr.toString() : "",
                    code: error ? (error.code || 1) : 0
                  });
                });
              });
            });
          };

          const tscResult = await runCmd("npx tsc --noEmit");
          const testResult = await runCmd("npm test");

          if (tscResult.code === 0 && testResult.code === 0) {
            console.log(
              picocolors.green(
                `\n  ✅ Codebase is completely healthy!\n` +
                `     TypeScript compilation: PASS\n` +
                `     Spec acceptance tests:  PASS (all checks met)\n`
              )
            );
            continue;
          }

          console.log(picocolors.yellow("\n⚠️  Failures detected in the codebase:"));
          if (tscResult.code !== 0) {
            console.log(picocolors.red(`\n   [TypeScript Compiler Errors]:`));
            console.log(picocolors.red(tscResult.stdout || tscResult.stderr));
          }
          if (testResult.code !== 0) {
            console.log(picocolors.red(`\n   [Test Failures]:`));
            const lines = (testResult.stdout || testResult.stderr).split("\n");
            const brief = lines.filter(l => l.includes("FAIL") || l.includes("FAILED") || l.includes("•")).slice(0, 10).join("\n");
            console.log(picocolors.red(brief || lines.slice(-20).join("\n")));
          }

          console.log(
            picocolors.yellow(
              `\n🛠️  Handing off diagnostics to the Quiver Agent for self-healing...\n`
            )
          );

          cleanInput = `System Request: The user has initiated a codebase self-healing sweep because compilation or tests are failing. Please examine the diagnostic information below, find the root cause, modify the source code as needed to resolve all issues, and verify that the tests and compilation pass cleanly. Do not stop until the codebase is fully healthy.

[TypeScript Compilation Output]:
${tscResult.stdout || "No stdout"}
${tscResult.stderr || ""}

[Test Failure Output]:
${testResult.stdout || "No stdout"}
${testResult.stderr || ""}
`;
        }

        // ── /override subcommand handling (US-15.4) ──
        if (resolved === "/override") {
          const parts = cleanInput.split(/\s+/);
          const changeHash = parts[1];
          const confirmation = parts.slice(2).join(" ");

          if (!changeHash || !confirmation) {
            console.log(picocolors.gray("\n  Usage: /override <changeHash> <confirmation text>\n"));
            console.log(picocolors.gray("  Example: /override abc12345 I confirm this change is safe\n"));
            continue;
          }

          try {
            const { overrideVerdict } = await import("./subagents/checker.js");
            const result = await overrideVerdict(changeHash, confirmation);
            if (result.overridden) {
              console.log(picocolors.green(`\n  ✅ ${result.reason}\n`));
              console.log(picocolors.gray("  The maker-checker verdict has been overridden and logged to the audit chain.\n"));
            } else {
              console.log(picocolors.yellow(`\n  ⚠️  Override failed: ${result.reason}\n`));
            }
          } catch (error: any) {
            console.log(picocolors.red(`\n  ❌ Error: ${error.message}\n`));
          }
          continue;
        }

        // ── /mcp subcommand handling ──
        if (resolved === "/mcp") {
          try {
            const { mcpManager } = await import("./mcp/client.js");
            const status = mcpManager.getStatus();
            if (status.length === 0) {
              console.log(picocolors.gray("\n  No MCP servers connected.\n"));
              console.log(picocolors.gray("  Configure servers in .quiver/mcp.json:\n"));
              console.log(picocolors.gray('  { "mcpServers": { "name": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }\n'));
            } else {
              console.log(picocolors.cyan(`\n  MCP Servers (${status.length}):\n`));
              for (const s of status) {
                const state = s.connected ? picocolors.green("✓") : picocolors.red("✗");
                console.log(`  ${state} ${s.name} — ${s.tools} tools`);
              }
              console.log();
            }
          } catch (err: any) {
            console.log(picocolors.red(`\n  ❌ ${err.message}\n`));
          }
          continue;
        }

        // ── /yolo subcommand handling ──
        if (resolved === "/yolo") {
          if (config.yoloMode) {
            config.yoloMode = false;
            console.log(picocolors.yellow("\n  🔒 YOLO mode OFF. Approval gates re-enabled.\n"));
            try { agent.logEvent("yolo_mode_disabled", { source: "slash_command" }); } catch (e) {}
          } else {
            console.log(picocolors.red("\n  ⚠️  YOLO MODE WARNING ⚠️"));
            console.log(picocolors.red("  ─────────────────────────────────────"));
            console.log(picocolors.yellow("  This will bypass ALL approval gates:"));
            console.log(picocolors.yellow("    • Tool-level approvals (write_file, replace_content, etc.)"));
            console.log(picocolors.yellow("    • Command risk classifier (rm -rf, sudo, chmod, curl, etc.)"));
            console.log(picocolors.yellow("    • No confirmation prompts for any action"));
            console.log(picocolors.yellow(""));
            console.log(picocolors.yellow("  The agent will be able to execute ANY tool or command"));
            console.log(picocolors.yellow("  without asking for your permission."));
            console.log(picocolors.yellow(""));
            console.log(picocolors.red("  Use at your own risk. All actions are still logged to the audit trail.\n"));

            const yoloRl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((resolve) => {
              yoloRl.question(picocolors.cyan("  Type 'I understand' to enable YOLO mode: "), (ans) => resolve(ans));
            });
            yoloRl.close();

            if (answer.trim() === "I understand") {
              config.yoloMode = true;
              config.requireApprovalFor = [];
              console.log(picocolors.green("\n  ✅ YOLO mode ON. All approval gates bypassed for this session."));
              console.log(picocolors.gray("  Toggle off with /yolo again. All actions remain in the audit trail.\n"));
              try { agent.logEvent("yolo_mode_enabled", { source: "slash_command" }); } catch (e) {}
            } else {
              console.log(picocolors.gray("\n  YOLO mode not enabled. Approval gates remain active.\n"));
            }
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
            console.log(`   - YOLO Mode:        ${config.yoloMode ? picocolors.red("ON (all gates bypassed)") : picocolors.gray("Off")}`);
            console.log(picocolors.gray(`   - Commands:`));
            console.log(picocolors.gray(`     ├─ /approvals set tool1,tool2`));
            console.log(picocolors.gray(`     ├─ /approvals add toolName`));
            console.log(picocolors.gray(`     ├─ /approvals remove toolName`));
            console.log(picocolors.gray(`     ├─ /approvals clear`));
            console.log(picocolors.gray(`     └─ /yolo (bypass ALL gates)\n`));
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
