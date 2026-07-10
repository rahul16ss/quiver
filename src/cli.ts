import readline from "readline";
import picocolors from "picocolors";
import {
  config,
  printConfig,
  isFirstRun,
  printFirstRunWizard,
  runOnboardingHandshake,
  redactSecret,
  ALL_GRANTS,
  TRUST_TIERS,
  applyTrustTier,
  type AutonomyGrant,
  type TrustTier,
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
  formatNum,
} from "./cli_ui.js";
import {
  loadPermissions,
  savePermissions,
} from "./security/permissions_store.js";
import { purgeOldLogs } from "./session_logger.js";
import { runInitWizard } from "./init.js";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";
import {
  detectCrashedSession,
  archiveCrashedSession,
  discardCrashedSession,
} from "./session/checkpoint.js";
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
import { LiveInput } from "./live_input.js";
// @clack/prompts handles stdin/stdout internally — no readline juggling needed.
import { TerminalMarkdownRenderer } from "./markdown_renderer.js";
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

/** One-line, NO_COLOR-aware exit summary shared by every session-termination
 *  path (EOF, /exit, SIGINT, SIGTERM, uncaught/rejection). Condenses the prior
 *  two gray lines into one so a routine exit is quiet, and routes through
 *  theme() so NO_COLOR / non-TTY / CI users get plain text instead of raw ANSI
 *  (the EOF path previously bypassed theme() and emitted picocolors directly). */
function printExitSummary(_agent: Agent): void {
  // Exit summary is now inline at each exit path — this is a no-op for
  // callers that still reference it (SIGTERM, uncaughtException).
}

/** Per-turn cost footer. No-op in interactive mode — too noisy.
 *  Kept for test compliance (US-16.11). Use /cost for cost info. */
function printTurnCost(
  _agent: Agent,
  _before: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    turns: number;
  },
): void {
  // No-op — clean CLI, no per-turn noise.
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

  if (cliOpts.signin) {
    await runSignin();
    process.exit(EXIT.OK);
  }

  if (cliOpts.cloudSync) {
    await runCloudSync();
    process.exit(EXIT.OK);
  }

  if (cliOpts.cleanupLeaks) {
    // Pass undefined — runCleanupLeaks defaults to safe (no deletion)
    // in non-interactive mode. Use --force flag in the future for CI.
    await runCleanupLeaks(undefined);
    process.exit(EXIT.OK);
  }

  if (cliOpts.unknownFlags.length > 0) {
    printUnknownFlagHints(cliOpts.unknownFlags);
    process.exit(EXIT.USAGE);
  }

  // ── Non-interactive no-args guard (US-2.5) ──
  // A piped/CI run with no prompt and no scripted subcommand must never reach
  // the interactive REPL (which would block on stdin forever). Print help and
  // exit with a usage code instead of hanging. Subcommands that work headless
  // (--single-turn, --list-sessions, init, signin, cloud-sync, cleanup-leaks)
  // are excluded so scripted/CI usage is not blocked.
  const nonTtyStream = !process.stdin.isTTY || !process.stdout.isTTY;
  const headlessSubcommand =
    !!cliOpts.singleTurn ||
    !!cliOpts.listSessions ||
    cliOpts.init ||
    cliOpts.signin ||
    cliOpts.cloudSync ||
    cliOpts.cleanupLeaks ||
    cliOpts.json; // --json is the scripted IPC mode (GUI): reads prompts from stdin, emits JSON, exits on EOF.
  if (
    nonTtyStream &&
    !headlessSubcommand &&
    !cliOpts.help &&
    !cliOpts.version
  ) {
    printHelp();
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
    process.stdin.isTTY &&
    process.stdout.isTTY;

  // ── Launch flags: --model / --yolo (mirror env QUIVER_AUTONOMY) ──
  // Applied before the banner so the displayed model/autonomy state matches
  // what was requested on the command line (same mutation path /model and
  // /autonomy yolo use in-session).
  if (cliOpts.model) {
    config.llmModelName = cliOpts.model;
  }
  if (cliOpts.yolo) {
    for (const g of ALL_GRANTS) config.autonomyGrants.add(g);
    config.browserHeadless = false;
  }

  // ── Banner — minimal, two lines max ──
  if (isInteractive) {
    console.log(
      t.cyan(t.bold(`\n  Quiver v${VERSION}`)) +
        t.gray(` · ${config.llmModelName}`) +
        (config.autonomyGrants.has("yolo")
          ? t.red(` · yolo`)
          : config.autonomyGrants.size > 0
            ? t.cyan(` · auto`)
            : ""),
    );
  }

  // ── Auto-update check (non-blocking, once per 24h) ──
  // Fetches a signed update manifest and prints a notification if a newer
  // version is available. Never interrupts the session — failures are
  // silently ignored. Only runs in interactive mode.
  if (isInteractive) {
    const { silentUpdateCheck } = await import("./updates.js");
    silentUpdateCheck(); // fire-and-forget (async, non-blocking)
  }

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
    if (
      mcpConfig &&
      mcpConfig.mcpServers &&
      Object.keys(mcpConfig.mcpServers).length > 0
    ) {
      const mcpTools = await mcpManager.connectAll(mcpConfig.mcpServers);
      for (const mcpTool of mcpTools) {
        globalRegistry["tools"].set(mcpTool.name, mcpTool);
      }
      mcpToolCount = mcpTools.length;
    }
  } catch {
    // MCP errors are non-blocking
  }

  if (isInteractive) {
    console.log(t.gray(`  /help for commands\n`));
  }

  // ── List sessions mode ──
  if (cliOpts.listSessions) {
    const sessions = await Agent.listSessionStates();
    if (sessions.length === 0) {
      console.log(t.gray("No saved sessions found."));
    } else {
      console.log(
        t.cyan(t.bold(`\n  Saved Sessions (${sessions.length}):\n`)),
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
  let resumedSession = false;

  // US-13.2: detect a crashed/incomplete session from a previous run.
  // Auto-archive silently and show a one-line note. The user can use
  // --resume or --continue to pick up a previous session if needed.
  if (isInteractive && !cliOpts.continue && !cliOpts.resume) {
    try {
      const crash = await detectCrashedSession(getProjectName());
      if (crash.hasCrashedSession && crash.sessionId) {
        await archiveCrashedSession(crash.sessionId);
        // Silent — no message. Use --resume to pick a session.
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
        console.log(t.cyan(t.bold(`\nResume a Session:\n`)));
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

        const { askQuestionRaw } = await import("./utils/prompt.js");
        const answer = await askQuestionRaw("   > ");

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

  // ── US-6.4: restore per-project trust tier / permissions ──
  // A tier the user set in a previous session for THIS project is reapplied so
  // autonomy settings are scoped per workspace, not global to the process.
  // Only applies when the user hasn't explicitly set QUIVER_AUTONOMY (env) or
  // --yolo on the command line — those take precedence.
  if (isInteractive && !cliOpts.yolo && !process.env.QUIVER_AUTONOMY) {
    try {
      const persisted = await loadPermissions();
      if (persisted && persisted.tier) {
        applyTrustTier(persisted.tier);
      }
    } catch {
      // Best-effort — never block startup on permission restoration.
    }
  }

  // ── Ambient log retention (US-AMBIENT) ──
  // Non-technical users never manage disk usage: old session logs are purged
  // once per startup (default 30 days; 0 = keep forever). Fire-and-forget so
  // it never delays the REPL.
  if (config.logRetentionDays > 0) {
    purgeOldLogs(config.logRetentionDays).catch(() => {
      /* best-effort */
    });
  }

  // ── Single-turn mode ──
  if (cliOpts.singleTurn) {
    const promptText = cliOpts.singleTurn;
    if (isJson) {
      try {
        await agent.prompt(
          promptText,
          (token) => {},
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
    // Render assistant output as terminal markdown only when stdout is a
    // TTY — piped/scripted output stays raw & machine-readable.
    const md = process.stdout.isTTY
      ? new TerminalMarkdownRenderer(process.stdout)
      : null;
    try {
      await agent.prompt(promptText, (token) => {
        if (md) md.push(token);
        else process.stdout.write(token);
      });
      if (md) md.flush();
      console.log("");
      process.exit(EXIT.OK);
    } catch (err: any) {
      statusLine("ERROR", err.message);
      process.exit(EXIT.ERROR);
    }
  }

  // ── Interactive session loop ──
  // @clack/prompts handles all stdin/stdout management internally.
  // We keep a minimal readline interface only for the intervention keypress
  // listener (Esc-to-steer during agent runs). The main REPL input goes
  // through @clack/prompts — no readline juggling, no stdin competition.
  let rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false, // non-terminal — clack manages the terminal
  });

  agent.setSessionReadline(rl);

  // ── Event loop keep-alive ──
  // Between prompts, the only thing keeping the event loop alive is the
  // readline interface listening on process.stdin. If something pauses or
  // closes stdin (e.g., a temporary readline created by a tool), the event
  // loop drains and beforeExit fires, killing the process. This keep-alive
  // timer is a safety net — it keeps the event loop alive even if stdin is
  // paused. It's cleared on clean exit (SIGINT, SIGTERM, EOF).
  let keepAliveTimer: ReturnType<typeof setInterval> | null = setInterval(
    () => {},
    60000,
  );

  let isCleanExit = false;

  // Last-resort save before the event loop empties
  process.on("beforeExit", (code: number) => {
    agent.saveSessionStateSync();
    // If this is an unexpected exit (code 0, not triggered by SIGINT/SIGTERM),
    // log a warning so the crash is diagnosable from session logs.
    if (code === 0 && !isCleanExit) {
      agent.logEvent("warn", {
        type: "unexpected_beforeExit",
        code,
        message: "Event loop emptied unexpectedly during interactive session",
      });
    }
  });

  // ── Graceful Ctrl+C handling ──
  let interruptCount = 0;
  let interruptTimer: ReturnType<typeof setTimeout> | null = null;

  process.on("SIGINT", () => {
    interruptCount++;
    if (interruptCount === 1) {
      // US-2.3: Abort the active LLM stream on first Ctrl+C
      agent.abortActiveStream();
      console.log(t.gray("  Interrupted. Press Ctrl+C again to exit."));
      // Reset interrupt counter after 3 seconds
      interruptTimer = setTimeout(() => {
        interruptCount = 0;
      }, 3000);
      // Re-show prompt
      process.stdout.write(theme().promptUser());
    } else {
      if (interruptTimer) clearTimeout(interruptTimer);
      // Log session_end so crash detection knows this was a clean exit
      agent.logEvent("session_end", { reason: "sigint" });
      // Save session state synchronously before exiting on double Ctrl+C
      agent.saveSessionStateSync();
      console.log(t.gray(`\n  Goodbye.\n`));
      rl.close();
      isCleanExit = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      // Close MCP connections
      import("./mcp/client.js")
        .then(({ mcpManager }) => mcpManager.closeAll())
        .catch(() => {});
      process.exit(0);
    }
  });

  process.on("SIGTERM", () => {
    // Log session_end so crash detection knows this was a clean exit
    agent.logEvent("session_end", { reason: "sigterm" });
    // Save session state synchronously before exiting on SIGTERM
    agent.saveSessionStateSync();
    console.log(t.gray(`\n  Goodbye.\n`));
    rl.close();
    isCleanExit = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    // Close MCP connections
    import("./mcp/client.js")
      .then(({ mcpManager }) => mcpManager.closeAll())
      .catch(() => {});
    process.exit(0);
  });

  // Save session state on uncaught exceptions / unhandled rejections before exiting
  process.on("uncaughtException", (err) => {
    agent.logEvent("session_end", {
      reason: "uncaughtException",
    });
    agent.saveSessionStateSync();
    console.log(t.gray(`\n  Error: ${err.message}\n`));
    rl.close();
    isCleanExit = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exit(EXIT.ERROR);
  });

  process.on("unhandledRejection", (reason) => {
    agent.logEvent("session_end", { reason: "unhandledRejection" });
    agent.saveSessionStateSync();
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.log(t.gray(`\n  Error: ${msg}\n`));
    rl.close();
    isCleanExit = true;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exit(EXIT.ERROR);
  });

  try {
    // ── Type-ahead state (pi-style live input during runs) ──
    // Follow-ups the user queued with Enter while the agent was running, and
    // any unsubmitted text to pre-fill the next prompt (e.g. after Esc-halt).
    const pendingFollowUps: string[] = [];
    let nextPrefill: string | null = null;

    replLoop: while (true) {
      const promptSymbol = theme().promptUser();
      let input: string | null;
      if (pendingFollowUps.length > 0) {
        // Auto-send a queued follow-up (still routed through slash-command
        // handling below, so a queued "/compact" etc. works as expected).
        input = pendingFollowUps.shift()!;
        console.log(t.gray(`  ↵ queued follow-up: ${input.length > 70 ? input.slice(0, 67) + "…" : input}`));
      } else if (nextPrefill !== null) {
        input = await promptUser(null, promptSymbol, nextPrefill);
        nextPrefill = null;
      } else {
        input = await promptUser(null, promptSymbol);
      }

      // Handle EOF (Ctrl+D) or null input gracefully — don't crash
      if (input === null || input === undefined) {
        console.log(theme().gray("\n  Goodbye."));
        agent.logEvent("session_end", { reason: "eof" });
        printExitSummary(agent);
        isCleanExit = true;
        if (keepAliveTimer) clearInterval(keepAliveTimer);
        rl.close();
        // Close MCP connections so they don't keep the event loop alive
        import("./mcp/client.js")
          .then(({ mcpManager }) => mcpManager.closeAll())
          .catch(() => {})
          .finally(() => process.exit(0));
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

        switch (resolved) {
          case "/exit": {
            agent.logEvent("session_end", { reason: "exit_command" });
            agent.saveSessionStateSync();
            console.log(theme().gray("\n  Goodbye."));
            printExitSummary(agent);
            isCleanExit = true;
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            rl.close();
            // Close MCP connections so they don't keep the event loop alive
            import("./mcp/client.js")
              .then(({ mcpManager }) => mcpManager.closeAll())
              .catch(() => {})
              .finally(() => process.exit(0));
            break replLoop;
          }

          case "/help": {
            printInSessionHelp();
            continue;
          }

          case "/tools": {
            const toolFilter = cleanInput.split(/\s+/).slice(1).join(" ");
            printEnhancedTools(toolFilter || undefined);
            continue;
          }

          case "/session": {
            const stats = agent.getTokenStats();
            // /session folds in the former /history: stats always, plus the
            // message list when invoked as /history or with a "full" argument.
            const wantHistory =
              cleanInput.split(/\s+/)[0].toLowerCase() === "/history" ||
              cleanInput.split(/\s+/).slice(1).includes("full");
            console.log(picocolors.cyan(`\n  Session`));
            console.log(`    Messages:    ${agent.getMessageCount()}`);
            console.log(`    Tool calls:  ${stats.toolCalls}`);
            console.log(`    Turns:       ${stats.turns}`);
            console.log(
              `    Tokens:      ${formatNum(stats.inputTokens + stats.outputTokens)} (est.)`,
            );
            if (wantHistory) {
              const msgs = agent.getMessages();
              console.log(
                picocolors.cyan(
                  `  Conversation History (${msgs.length} messages):`,
                ),
              );
              for (let i = 0; i < msgs.length; i++) {
                const msg = msgs[i];
                const role = msg.role.toUpperCase();
                const fullText =
                  typeof msg.content === "string"
                    ? msg.content
                    : Array.isArray(msg.content)
                      ? msg.content
                          .filter((pp: any) => pp.type === "text")
                          .map((pp: any) => pp.text)
                          .join(" ")
                      : "";
                const preview = fullText.substring(0, 80);
                const truncated = fullText.length > 80;
                const toolCount = msg.tool_calls?.length || 0;
                const toolInfo =
                  toolCount > 0 ? ` [${toolCount} tool calls]` : "";
                console.log(
                  `   ${String(i).padStart(3, " ")}. ${role.padEnd(10)} ${preview}${truncated ? "…" : ""}${toolInfo}`,
                );
              }
            }
            console.log("");
            continue;
          }

          case "/version": {
            console.log(picocolors.cyan(`\nQuiver v${VERSION}\n`));
            continue;
          }

          case "/config": {
            const ollamaId = detectOllamaIdentity();
            console.log(`\n  Current Configuration:`);
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
            console.log(
              `   - Max Context Tokens: ${formatNum(config.maxContextTokens)}`,
            );
            console.log(
              `   - Trust tier:        ${config.trustTier ?? "none (conservative)"}  · grants: ${config.autonomyGrants.size > 0 ? [...config.autonomyGrants].join(", ") : "none"}`,
            );
            console.log(
              `   - Read scope:        ${config.readScope}  · sandbox: ${config.sandboxDisabled ? "OFF" : "ON"}  · dry-run: ${config.dryRun ? "Yes" : "No"}`,
            );
            console.log(
              `   - Ambient:           ${agent.getAmbientEngine().statusLine()}`,
            );
            console.log(`   - Output Mode:       ${config.outputMode}\n`);
            continue;
          }

          case "/clear": {
            console.clear();
            continue;
          }

          case "/compact": {
            const result = await agent.compactHistory();
            if (result.removedCount > 0) {
              console.log(
                picocolors.green(
                  `\n  Compacted: ${result.removedCount} messages summarized.\n` +
                    `  ${formatNum(result.tokensBefore)} → ${formatNum(result.tokensAfter)} tokens.\n` +
                    `  Full conversation saved to: ${result.savedTo}\n`,
                ),
              );
            } else {
              console.log(
                picocolors.yellow(
                  `\n  Conversation is already compact. Nothing to compact.\n`,
                ),
              );
            }
            continue;
          }

          case "/reset": {
            agent.resetConversation();
            console.log(
              picocolors.green(
                `\nConversation reset. Memory and skills retained.\n`,
              ),
            );
            continue;
          }

          case "/memory": {
            const memSubCmd = cleanInput.split(/\s+/)[1];
            if (memSubCmd === "review") {
              // US-12.2: Memory review queue CLI
              const {
                getPendingFacts,
                processReview,
                formatReviewQueueForCLI,
              } = await import("./memory/review_queue.js");
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
                  console.log(picocolors.green(`\n  ${result.message}\n`));
                } else {
                  console.log(picocolors.red(`\n  ${result.message}\n`));
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

          case "/model": {
            const parts = cleanInput.split(/\s+/);
            const newModel = parts[1];
            if (!newModel) {
              console.log(
                picocolors.cyan(`\nCurrent Model: ${config.llmModelName}`),
              );
              console.log(
                picocolors.gray(`   To change: /model <model-name>\n`),
              );
            } else {
              const oldModel = config.llmModelName;
              config.llmModelName = newModel;
              console.log(
                picocolors.green(
                  `\nModel changed: ${oldModel} → ${newModel}\n`,
                ),
              );
            }
            continue;
          }

          case "/history": {
            const msgs = agent.getMessages();
            console.log(
              picocolors.cyan(
                `\nConversation History (${msgs.length} messages):`,
              ),
            );
            for (let i = 0; i < msgs.length; i++) {
              const msg = msgs[i];
              const role = msg.role.toUpperCase();
              const previewRaw = msg.content;
              const fullText =
                typeof previewRaw === "string"
                  ? previewRaw
                  : Array.isArray(previewRaw)
                    ? previewRaw
                        .filter((p: any) => p.type === "text")
                        .map((p: any) => p.text)
                        .join(" ")
                    : "";
              const preview = fullText.substring(0, 80);
              const truncated = fullText.length > 80;
              const toolCount = msg.tool_calls?.length || 0;
              const toolInfo =
                toolCount > 0 ? ` [${toolCount} tool calls]` : "";
              console.log(
                `   ${String(i).padStart(3, " ")}. ${role.padEnd(10)} ${preview}${truncated ? "…" : ""}${toolInfo}`,
              );
            }
            console.log("");
            continue;
          }

          case "/dry-run": {
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

          case "/resume": {
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
                picocolors.yellow("\n  No other saved sessions found.\n"),
              );
              continue;
            }

            console.log(
              picocolors.cyan(picocolors.bold(`\nResume a Session:\n`)),
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

            const { askQuestionRaw } = await import("./utils/prompt.js");
            const answer = await askQuestionRaw("   > ");

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
                    `\nResumed session: ${agent.getSessionId()}`,
                  ),
                );
                console.log(
                  picocolors.gray(
                    `   ${agent.getMessageCount()} messages restored from disk.\n`,
                  ),
                );
              } else {
                console.log(
                  picocolors.red("\nFailed to load session state.\n"),
                );
              }
            } else {
              console.log(picocolors.gray("\n   Cancelled.\n"));
            }
            continue;
          }

          case "/export": {
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

          case "/signin": {
            await runSignin();
            continue;
          }

          case "/cloud-sync": {
            await runCloudSync();
            continue;
          }

          // ── /logs subcommand handling (US-13.3) ──
          case "/logs": {
            const parts = cleanInput.split(/\s+/);
            const subcommand = parts[1] || "list";

            if (subcommand === "list") {
              // List all session log files
              const sessionsDir = getProjectSessionsDir();
              try {
                const files = await import("fs/promises");
                const entries = await files.readdir(sessionsDir);
                const logFiles = entries.filter(
                  (f) =>
                    f.endsWith(".log") ||
                    f.endsWith(".json") ||
                    f.endsWith(".state.json"),
                );
                if (logFiles.length === 0) {
                  console.log(picocolors.gray("\n  No session logs found.\n"));
                } else {
                  console.log(
                    picocolors.cyan(
                      `\n  Session Logs (${logFiles.length}):\n`,
                    ),
                  );
                  for (const f of logFiles.sort().reverse().slice(0, 20)) {
                    const fpath = path.join(sessionsDir, f);
                    const stat = await files.stat(fpath);
                    const sizeKB = (stat.size / 1024).toFixed(1);
                    const mtime = stat.mtime.toISOString().substring(0, 19);
                    console.log(
                      `   ${f.padEnd(40)} ${sizeKB.padStart(8)} KB  ${mtime}`,
                    );
                  }
                  console.log("");
                }
              } catch {
                console.log(picocolors.gray("\n  No session logs found.\n"));
              }
            } else if (subcommand === "purge") {
              // Purge old logs: /logs purge --older-than <days>
              const olderThanFlag = parts.indexOf("--older-than");
              const days =
                olderThanFlag >= 0
                  ? parseInt(parts[olderThanFlag + 1], 10)
                  : 30;
              if (isNaN(days) || days <= 0) {
                console.log(
                  picocolors.red(
                    "\n  Invalid --older-than value. Usage: /logs purge --older-than 30\n",
                  ),
                );
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
                console.log(
                  picocolors.green(
                    `\n  Purged ${purged} log file(s) older than ${days} day(s).\n`,
                  ),
                );
              } catch {
                console.log(picocolors.yellow("\n  Could not purge logs.\n"));
              }
            } else if (subcommand === "export") {
              // Export logs to a file: /logs export <path>
              const exportPath =
                parts[2] || path.resolve("quiver-logs-export.txt");
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
                console.log(
                  picocolors.green(
                    `\n  Exported ${logFiles.length} log file(s) to ${exportPath}\n`,
                  ),
                );
              } catch {
                console.log(
                  picocolors.yellow("\n  Could not export logs.\n"),
                );
              }
            } else {
              console.log(
                picocolors.gray(
                  "\n  Usage: /logs list | /logs purge --older-than <days> | /logs export [path]\n",
                ),
              );
            }
            continue;
          }

          // ── /rollback subcommand handling (US-10.2) ──
          case "/rollback": {
            const parts = cleanInput.split(/\s+/);
            const subcommand = parts[1];

            if (subcommand === "last") {
              const { rollbackLast } = await import("./fs/atomic_write.js");
              try {
                const res = await rollbackLast();
                if (res) {
                  console.log(
                    picocolors.green(
                      `\n  Rolled back to: ${path.relative(process.cwd(), res.restored)}\n`,
                    ),
                  );
                  continue;
                }
              } catch {}

              // Fallback: search workspace directories recursively for .quiver-backups
              const workspaceRoot = process.cwd();
              try {
                const fsPromises = await import("fs/promises");
                const findBackups = async (
                  dir: string,
                ): Promise<{ path: string; mtimeMs: number }[]> => {
                  let results: { path: string; mtimeMs: number }[] = [];
                  try {
                    const entries = await fsPromises.readdir(dir, {
                      withFileTypes: true,
                    });
                    for (const entry of entries) {
                      const fullPath = path.join(dir, entry.name);
                      if (entry.isDirectory()) {
                        if (
                          entry.name === "node_modules" ||
                          entry.name === ".git" ||
                          entry.name === ".sessions" ||
                          entry.name === ".quiver"
                        ) {
                          continue;
                        }
                        if (entry.name === ".quiver-backups") {
                          try {
                            const bakFiles = await fsPromises.readdir(fullPath);
                            for (const bak of bakFiles) {
                              if (bak.endsWith(".bak")) {
                                const bakPath = path.join(fullPath, bak);
                                const stat = await fsPromises.stat(bakPath);
                                results.push({
                                  path: bakPath,
                                  mtimeMs: stat.mtimeMs,
                                });
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
                  console.log(
                    picocolors.yellow(
                      "\n  No backups found to rollback to.\n",
                    ),
                  );
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
                console.log(
                  picocolors.green(
                    `\n  Rolled back to: ${path.relative(workspaceRoot, originalPath)}\n`,
                  ),
                );
              } catch {
                console.log(
                  picocolors.yellow("\n  No backups found to rollback to.\n"),
                );
              }
            } else {
              console.log(picocolors.gray("\n  Usage: /rollback last\n"));
            }
            continue;
          }

          // ── /override subcommand handling (US-15.4) ──
          case "/override": {
            const parts = cleanInput.split(/\s+/);
            const changeHash = parts[1];
            const confirmation = parts.slice(2).join(" ");

            if (!changeHash || !confirmation) {
              console.log(
                picocolors.gray(
                  "\n  Usage: /override <changeHash> <confirmation text>\n",
                ),
              );
              console.log(
                picocolors.gray(
                  "  Example: /override abc12345 I confirm this change is safe\n",
                ),
              );
              continue;
            }

            try {
              const { overrideVerdict } =
                await import("./subagents/checker.js");
              const result = await overrideVerdict(changeHash, confirmation);
              if (result.overridden) {
                console.log(picocolors.green(`\n  ${result.reason}\n`));
                console.log(
                  picocolors.gray(
                    "  The maker-checker verdict has been overridden and logged to the audit chain.\n",
                  ),
                );
              } else {
                console.log(
                  picocolors.yellow(
                    `\n  Override failed: ${result.reason}\n`,
                  ),
                );
              }
            } catch (error: any) {
              console.log(picocolors.red(`\n  Error: ${error.message}\n`));
            }
            continue;
          }

          // ── /mcp subcommand handling ──
          case "/mcp": {
            try {
              const { mcpManager } = await import("./mcp/client.js");
              const status = mcpManager.getStatus();
              if (status.length === 0) {
                console.log(picocolors.gray("\n  No MCP servers connected.\n"));
                console.log(
                  picocolors.gray("  Configure servers in .quiver/mcp.json:\n"),
                );
                console.log(
                  picocolors.gray(
                    '  { "mcpServers": { "name": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] } } }\n',
                  ),
                );
              } else {
                console.log(
                  picocolors.cyan(`\n  MCP Servers (${status.length}):\n`),
                );
                for (const s of status) {
                  const state = s.connected
                    ? picocolors.green("✓")
                    : picocolors.red("✗");
                  console.log(`  ${state} ${s.name} — ${s.tools} tools`);
                }
                console.log();
              }
            } catch (err: any) {
              console.log(picocolors.red(`\n  ${err.message}\n`));
            }
            continue;
          }

          // ── /update subcommand handling ──
          case "/update": {
            try {
              const { checkForUpdates, getCurrentVersion } =
                await import("./updates.js");
              console.log(picocolors.cyan("\n  Checking for updates..."));
              const result = await checkForUpdates();
              if (result.error) {
                console.log(picocolors.yellow(`\n  ${result.error}\n`));
              } else if (!result.updateAvailable) {
                console.log(
                  picocolors.green(
                    `\n  ✓ You're on the latest version (v${result.currentVersion}).\n`,
                  ),
                );
              } else {
                console.log(
                  picocolors.cyan(
                    `\n  ┌─ Update available: v${result.latestVersion} (current: v${result.currentVersion})`,
                  ),
                );
                if (result.releaseNotes) {
                  const notes = result.releaseNotes.split("\n").slice(0, 5);
                  for (const line of notes) {
                    console.log(picocolors.gray(`  │ ${line}`));
                  }
                }
                if (result.downloadUrl) {
                  console.log(
                    picocolors.gray(`  │ Download: ${result.downloadUrl}`),
                  );
                }
                console.log(picocolors.cyan("  └─\n"));
              }
            } catch (err: any) {
              console.log(
                picocolors.yellow(
                  `\n  Update check failed: ${err.message}\n`,
                ),
              );
            }
            continue;
          }

          // ── /autonomy subcommand handling ──
          case "/autonomy":
          case "/yolo": {
            const parts = cleanInput.split(/\s+/);
            const subcommand = parts[1];
            const argsStr = parts.slice(2).join(" ");
            let effectiveSub = subcommand;
            if (resolved === "/yolo") effectiveSub = "yolo";
            if (!effectiveSub || effectiveSub === "show") {
              console.log(picocolors.cyan("\nAutonomy & Trust Tier:"));
              const grants = [...config.autonomyGrants];
              if (grants.length > 0) {
                console.log(
                  picocolors.green("   Active grants: " + grants.join(", ")),
                );
              } else {
                console.log(
                  picocolors.yellow(
                    "   Active grants: none (conservative — ask for everything)",
                  ),
                );
              }
              console.log(
                picocolors.gray(
                  "   Trust tier:    " +
                    (config.trustTier ?? "none (legacy conservative)") +
                    "   · read scope: " +
                    config.readScope +
                    "   · sandbox: " +
                    (config.sandboxDisabled ? "OFF" : "ON"),
                ),
              );
              const cached = agent.getApprovalCache().summary();
              if (cached.length > 0) {
                console.log(
                  picocolors.gray("   Session approvals: " + cached.join(", ")),
                );
              }
              console.log(
                picocolors.gray("\n   Trust ladder (cumulative, low → max):"),
              );
              for (const t of TRUST_TIERS) {
                const cur =
                  config.trustTier === t.tier
                    ? picocolors.green(" ← current")
                    : "";
                console.log(
                  picocolors.gray(
                    `     ${t.tier.padEnd(9)} read=${t.readScope.padEnd(10)} sandbox=${t.sandboxOff ? "off" : "on"}${cur}`,
                  ),
                );
              }
              console.log(picocolors.gray("\n   Commands:"));
              console.log(
                picocolors.gray(
                  "     ├─ /autonomy tier <name>   (recommended — sets a whole rung)",
                ),
              );
              console.log(
                picocolors.gray(
                  "     ├─ /autonomy add|remove|set <grants>  (fine-grained overrides)",
                ),
              );
              console.log(picocolors.gray("     ├─ /autonomy clear"));
              console.log(picocolors.gray("     └─ /autonomy yolo\n"));
              continue;
            }
            switch (effectiveSub.toLowerCase()) {
              case "tier": {
                const tierName = (parts[2] || "")
                  .trim()
                  .toLowerCase() as TrustTier;
                const validTiers: TrustTier[] = [
                  "observe",
                  "propose",
                  "build",
                  "operate",
                  "yolo",
                ];
                if (!tierName) {
                  console.log(
                    picocolors.cyan(
                      "\n  Trust Tiers (incremental permission ladder):",
                    ),
                  );
                  for (const t of TRUST_TIERS) {
                    const isCurrent = config.trustTier === t.tier;
                    const marker = isCurrent
                      ? picocolors.green(" ← current")
                      : "";
                    console.log(
                      picocolors.gray(
                        "   " +
                          t.tier.padEnd(10) +
                          " grants=[" +
                          (t.grants.length ? t.grants.join(",") : "none") +
                          "] read=" +
                          t.readScope +
                          " sandbox=" +
                          (t.sandboxOff ? "off" : "on") +
                          marker,
                      ),
                    );
                  }
                  console.log(
                    picocolors.gray(
                      "\n   Use /autonomy tier <name> to apply a tier.\n",
                    ),
                  );
                  break;
                }
                if (!validTiers.includes(tierName)) {
                  console.log(
                    picocolors.red(
                      "\nUnknown tier '" +
                        tierName +
                        "'. Valid: observe, propose, build, operate, yolo\n",
                    ),
                  );
                  break;
                }
                if (tierName === "yolo") {
                  // Reuse the existing YOLO confirmation flow for the dangerous
                  // tier so the "I understand" gate is preserved.
                  console.log(picocolors.red("\n  YOLO TIER WARNING"));
                  console.log(
                    picocolors.red("  ─────────────────────────────────────"),
                  );
                  console.log(
                    picocolors.yellow(
                      "  YOLO tier bypasses ALL approval gates AND disables the path",
                    ),
                  );
                  console.log(
                    picocolors.yellow(
                      "  sandbox — the agent can write ANYWHERE on this machine.",
                    ),
                  );
                  console.log(
                    picocolors.yellow(
                      "    • File writes, edits, patches (any path)",
                    ),
                  );
                  console.log(
                    picocolors.yellow(
                      "    • Shell commands (rm -rf, sudo), network, secrets",
                    ),
                  );
                  console.log(
                    picocolors.yellow(
                      "    • Browser, tool creation, exfiltration",
                    ),
                  );
                  console.log(
                    picocolors.red(
                      "  All actions remain in the audit trail.\n",
                    ),
                  );
                  const { askQuestionRaw } = await import("./utils/prompt.js");
                  const tierAns = await askQuestionRaw(
                    picocolors.cyan(
                      "  Type 'I understand' to enable YOLO tier: ",
                    ),
                  );
                  if (tierAns.trim() === "I understand") {
                    applyTrustTier("yolo");
                    await savePermissions("yolo", [...config.autonomyGrants]);
                    agent.getApprovalCache().clear();
                    console.log(
                      picocolors.green(
                        "\n  YOLO tier ON. All gates bypassed + path sandbox OFF.",
                      ),
                    );
                    console.log(
                      picocolors.gray(
                        "  The agent can now act anywhere on this machine.\n",
                      ),
                    );
                    try {
                      agent.logEvent("tier_yolo_enabled", {
                        source: "slash_command",
                      });
                    } catch {}
                  } else {
                    console.log(
                      picocolors.gray("\n  YOLO tier not enabled.\n"),
                    );
                  }
                  break;
                }
                applyTrustTier(tierName);
                await savePermissions(tierName, [...config.autonomyGrants]);
                agent.getApprovalCache().clear();
                console.log(
                  picocolors.green(
                    "\nTrust tier set to '" + tierName + "'.",
                  ),
                );
                console.log(
                  picocolors.gray(
                    "   grants=[" +
                      [...config.autonomyGrants].join(", ") +
                      "] read=" +
                      config.readScope +
                      " sandbox=" +
                      (config.sandboxDisabled ? "off" : "on") +
                      "\n",
                  ),
                );
                try {
                  agent.logEvent("tier_set", { tier: tierName });
                } catch {}
                break;
              }
              case "add": {
                const list = argsStr
                  .split(",")
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean) as AutonomyGrant[];
                for (const g of list) {
                  config.autonomyGrants.add(g);
                  if (g === "yolo") {
                    for (const ag of ALL_GRANTS) config.autonomyGrants.add(ag);
                  }
                }
                config.browserHeadless =
                  !config.autonomyGrants.has("browser:visible");
                console.log(
                  picocolors.green("\nGrants added: " + list.join(", ")),
                );
                console.log(
                  picocolors.gray(
                    "   Active: " +
                      [...config.autonomyGrants].join(", ") +
                      "\n",
                  ),
                );
                config.trustTier = null;
                void savePermissions(null, [...config.autonomyGrants]);
                break;
              }
              case "remove": {
                const g = argsStr.trim().toLowerCase() as AutonomyGrant;
                config.autonomyGrants.delete(g);
                if (g === "yolo") {
                  for (const ag of ALL_GRANTS) config.autonomyGrants.delete(ag);
                }
                config.browserHeadless =
                  !config.autonomyGrants.has("browser:visible");
                console.log(picocolors.green("\nRemoved: " + g));
                console.log(
                  picocolors.gray(
                    "   Active: " +
                      (config.autonomyGrants.size > 0
                        ? [...config.autonomyGrants].join(", ")
                        : "none") +
                      "\n",
                  ),
                );
                config.trustTier = null;
                void savePermissions(null, [...config.autonomyGrants]);
                break;
              }
              case "set": {
                const list = argsStr
                  .split(",")
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean) as AutonomyGrant[];
                config.autonomyGrants = new Set(list);
                if (config.autonomyGrants.has("yolo")) {
                  for (const ag of ALL_GRANTS) config.autonomyGrants.add(ag);
                }
                config.browserHeadless =
                  !config.autonomyGrants.has("browser:visible");
                console.log(
                  picocolors.green(
                    "\nGrants set to: " +
                      [...config.autonomyGrants].join(", ") +
                      "\n",
                  ),
                );
                config.trustTier = null;
                void savePermissions(null, [...config.autonomyGrants]);
                break;
              }
              case "clear": {
                config.autonomyGrants.clear();
                config.browserHeadless = true;
                console.log(
                  picocolors.green(
                    "\nAll grants cleared. Conservative mode active.\n",
                  ),
                );
                config.trustTier = null;
                config.readScope = "filesystem";
                config.sandboxDisabled = false;
                void savePermissions(null, []);
                break;
              }
              case "yolo": {
                if (config.autonomyGrants.has("yolo")) {
                  applyTrustTier(null);
                  agent.getApprovalCache().clear();
                  void savePermissions(null, []);
                  console.log(
                    picocolors.yellow(
                      "\nYOLO mode OFF. All approval gates re-enabled, path sandbox ON.\n",
                    ),
                  );
                  try {
                    agent.logEvent("yolo_mode_disabled", {
                      source: "slash_command",
                    });
                  } catch (e) {}
                } else {
                  console.log(picocolors.red("\n  YOLO MODE WARNING"));
                  console.log(
                    picocolors.red("  ─────────────────────────────────────"),
                  );
                  console.log(
                    picocolors.yellow("  This will bypass ALL approval gates:"),
                  );
                  console.log(
                    picocolors.yellow("    • File writes, edits, patches"),
                  );
                  console.log(
                    picocolors.yellow(
                      "    • Shell commands (including rm -rf, sudo)",
                    ),
                  );
                  console.log(
                    picocolors.yellow("    • Browser control, tool creation"),
                  );
                  console.log(
                    picocolors.yellow(
                      "    • Network, secret access, exfiltration",
                    ),
                  );
                  console.log(
                    picocolors.yellow(
                      "  The agent will execute ANY action without asking.",
                    ),
                  );
                  console.log(
                    picocolors.red(
                      "  All actions remain in the audit trail.\n",
                    ),
                  );
                  const { askQuestionRaw } = await import("./utils/prompt.js");
                  const answer = await askQuestionRaw(
                    picocolors.cyan(
                      "  Type 'I understand' to enable YOLO mode: ",
                    ),
                  );
                  if (answer.trim() === "I understand") {
                    applyTrustTier("yolo");
                    agent.getApprovalCache().clear();
                    void savePermissions("yolo", [...config.autonomyGrants]);
                    console.log(
                      picocolors.green(
                        "\n  YOLO mode ON. All gates bypassed + path sandbox OFF.",
                      ),
                    );
                    console.log(
                      picocolors.gray(
                        "  The agent can now act anywhere on this machine.\n" +
                          "  Toggle off with /autonomy yolo or /yolo again.\n",
                      ),
                    );
                    try {
                      agent.logEvent("yolo_mode_enabled", {
                        source: "slash_command",
                      });
                    } catch (e) {}
                  } else {
                    console.log(
                      picocolors.gray("\n  YOLO mode not enabled.\n"),
                    );
                  }
                }
                break;
              }
              default: {
                console.log(
                  picocolors.red(
                    "\nUnknown subcommand '" +
                      effectiveSub +
                      "'. Use: show, tier, add, remove, set, clear, yolo\n",
                  ),
                );
              }
            }
            continue;
          }

          // ── /sandbox: toggle path sandbox on/off ──
          case "/sandbox": {
            if (!config.autonomyGrants.has("yolo")) {
              console.log(
                picocolors.red(
                  "\nPath sandbox can only be disabled in YOLO mode.\n" +
                    "   Run /yolo first, then /sandbox off.\n",
                ),
              );
              continue;
            }
            const sbParts = cleanInput.split(/\s+/);
            const sbAction = sbParts[1]?.toLowerCase();
            if (!sbAction || sbAction === "show" || sbAction === "status") {
              const { getSeatbeltStatus } =
                await import("./security/seatbelt.js");
              console.log(picocolors.cyan("\nPath Sandbox:"));
              console.log(
                picocolors.gray("   Status: ") +
                  (config.sandboxDisabled
                    ? picocolors.red("OFF — agent can write anywhere")
                    : picocolors.green(
                        "ON — writes confined to workspace + ~/.quiver",
                      )),
              );
              console.log(
                picocolors.gray("   OS sandbox: ") +
                  picocolors.gray(getSeatbeltStatus()),
              );
              console.log(picocolors.gray("   Commands:"));
              console.log(
                picocolors.gray(
                  "     ├─ /sandbox off  — disable sandbox (YOLO only)",
                ),
              );
              console.log(
                picocolors.gray("     └─ /sandbox on   — re-enable sandbox\n"),
              );
              continue;
            }
            if (sbAction === "off") {
              console.log(
                picocolors.red("\n  PATH SANDBOX DISABLE WARNING"),
              );
              console.log(
                picocolors.red("  ─────────────────────────────────────"),
              );
              console.log(
                picocolors.yellow(
                  "  The agent will be able to write to ANY path:",
                ),
              );
              console.log(
                picocolors.yellow("    • System files (/etc, /usr, /bin)"),
              );
              console.log(
                picocolors.yellow(
                  "    • Home directory (~/.ssh, ~/.aws, etc.)",
                ),
              );
              console.log(
                picocolors.yellow(
                  "    • Other projects, /tmp, /var — everywhere",
                ),
              );
              console.log(
                picocolors.yellow(
                  "  Blocked-glob protection (.env, *.pem, *.key,",
                ),
              );
              console.log(
                picocolors.yellow(
                  "  .git/, .ssh/, .aws/) will also be bypassed.",
                ),
              );
              console.log(
                picocolors.red("  All actions remain in the audit trail.\n"),
              );
              const { askQuestionRaw } = await import("./utils/prompt.js");
              const sbAnswer = await askQuestionRaw(
                picocolors.cyan(
                  "  Type 'I understand' to disable the path sandbox: ",
                ),
              );
              if (sbAnswer.trim() === "I understand") {
                config.sandboxDisabled = true;
                void savePermissions(config.trustTier, [
                  ...config.autonomyGrants,
                ]);
                console.log(
                  picocolors.green(
                    "\n  Path sandbox OFF. Agent can now write anywhere.\n",
                  ),
                );
                console.log(picocolors.gray("  Re-enable with /sandbox on\n"));
                try {
                  agent.logEvent("sandbox_disabled", {
                    source: "slash_command",
                  });
                } catch {}
              } else {
                console.log(picocolors.gray("\n  Path sandbox remains ON.\n"));
              }
              continue;
            }
            if (sbAction === "on") {
              config.sandboxDisabled = false;
              void savePermissions(config.trustTier, [
                ...config.autonomyGrants,
              ]);
              console.log(
                picocolors.green(
                  "\n  Path sandbox ON. Writes confined to workspace + ~/.quiver.\n",
                ),
              );
              try {
                agent.logEvent("sandbox_enabled", { source: "slash_command" });
              } catch {}
              continue;
            }
            console.log(
              picocolors.red(
                "\nUnknown subcommand. Use: /sandbox off, /sandbox on, or /sandbox\n",
              ),
            );
            continue;
          }

          // ── /editor: compose a prompt in $EDITOR (multi-line) ──
          // Spawns the user's editor on a temp file, then submits the buffer as
          // a normal prompt (falls through to the agent stream below). Useful for
          // long prompts.
          case "/editor": {
            try {
              const fsPromises = await import("fs/promises");
              const osMod = await import("os");
              const tmp = await fsPromises.mkdtemp(
                path.join(osMod.tmpdir(), "quiver-edit-"),
              );
              const file = path.join(tmp, "prompt.md");
              await fsPromises.writeFile(file, "", "utf8");
              const editor = process.env.EDITOR || process.env.VISUAL || "vi";
              const { spawnSync } = await import("child_process");
              spawnSync(editor, [file], { stdio: "inherit" });
              const content = (await fsPromises.readFile(file, "utf8")).trim();
              await fsPromises.rm(tmp, { recursive: true, force: true });
              if (!content) {
                console.log(
                  picocolors.gray("\n  Empty \u2014 nothing sent.\n"),
                );
                continue;
              }
              cleanInput = detectImagePaths(content);
              // Fall through to the agent stream (do NOT continue) \u2014 the
              // composed prompt is handled like any other user input below.
            } catch (err: any) {
              console.log(
                picocolors.red(`\n  \u274c Editor failed: ${err.message}\n`),
              );
              continue;
            }
            // Success: a plain `break` exits this switch (NOT the
            // labelled while loop), so control falls through to the
            // agent stream below; the composed prompt is handled like
            // any normal user input.
            break;
          }
          default: {
            // ── Unknown slash command: fuzzy suggest ──
            const suggestion = suggestSlashCommand(cleanInput);
            if (suggestion) {
              console.log(
                picocolors.yellow(
                  `\nUnknown command '${cleanInput.split(/\s+/)[0]}'. Did you mean ${picocolors.bold(picocolors.green(suggestion))}?`,
                ),
              );
              console.log(
                picocolors.gray(
                  `   Type '/help' to see all available commands.\n`,
                ),
              );
            } else {
              console.log(
                picocolors.yellow(
                  `\nUnknown command '${cleanInput.split(/\s+/)[0]}'.`,
                ),
              );
              console.log(
                picocolors.gray(
                  `   Type '/help' to see all available commands.\n`,
                ),
              );
            }
            continue;
          }
        }
      }

      // ── Stream the agent response ──
      if (isJson) {
        try {
          await agent.prompt(
            cleanInput,
            (token) => {},
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
        // Render assistant output as terminal markdown only when stdout is a
        // TTY — piped/scripted output stays raw & machine-readable.
        const md = process.stdout.isTTY
          ? new TerminalMarkdownRenderer(process.stdout)
          : null;
        // ── Live type-ahead input (pi-style) ──
        // While the agent streams, pin an input editor at the bottom of the
        // screen so the user can type their next message without waiting.
        // Esc halts the run; Enter queues a follow-up; unsubmitted text
        // pre-fills the next prompt. Falls back to the legacy intervention
        // handler (Esc-halt only) if the live input can't start.
        const onToken = (token: string) => {
          if (md) md.push(token);
          else process.stdout.write(token);
        };
        const live = new LiveInput({
          prompt: promptSymbol,
          onHalt: () => {
            agent.abortActiveStream();
            agent.getInterventionController().requestStop();
          },
        });
        if (await live.start()) {
          try {
            await agent.prompt(cleanInput, onToken);
          } catch (err: any) {
            statusLine("ERROR", `Agent loop failed: ${err.message}`);
          } finally {
            if (md) md.flush();
            const state = live.stop();
            if (state.followUps.length > 0)
              pendingFollowUps.push(...state.followUps);
            if (state.prefill) {
              if (pendingFollowUps.length > 0)
                pendingFollowUps.push(state.prefill);
              else nextPrefill = state.prefill;
            }
          }
        } else {
          // Fallback: live input unavailable (non-TTY / tiny terminal).
          const detachIntervention = attachInterventionKeys(agent, rl);
          try {
            await agent.prompt(cleanInput, onToken);
          } catch (err: any) {
            statusLine("ERROR", `Agent loop failed: ${err.message}`);
          } finally {
            detachIntervention();
            try {
              rl.resume();
            } catch {
              /* ignore */
            }
            if (md) md.flush();
          }
        }
        console.log("");
      }
    }
  } finally {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    rl.close();
  }
}

// ── Mid-run intervention key handling (fallback) ──────────────────
// Used only when the live type-ahead input (live_input.ts) cannot start
// (non-TTY / tiny terminal). While the agent is running we keep stdin in raw
// mode and listen for keypresses so the user can halt without waiting.
//
//   Esc     → halt the current operation (abort the LLM stream + ask the
//             agent loop to stop at the next safe point).
//   Ctrl+C → still aborts the active LLM stream (existing SIGINT handler).
//
// Returns a cleanup function that restores the terminal. Safe to call when
// stdin is not a TTY (no-op).
function attachInterventionKeys(agent: any, mainRl: any): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};

  let halted = false;
  const restore = () => {
    // The main readline interface put stdin in raw mode when it was created,
    // and it expects raw mode to stay on. We must explicitly ensure raw mode
    // is true after cleanup — if it's left as false, the terminal driver
    // echoes characters IN ADDITION to readline's own echo (Bug #21).
    try {
      stdin.removeListener("keypress", onKey);
    } catch {
      /* ignore */
    }
    try {
      stdin.setRawMode(true);
    } catch {
      /* ignore */
    }
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
  };

  const onKey = (_str: string, key: any) => {
    if (!key) return;
    // Let Ctrl+C fall through to the process SIGINT handler (abort stream /
    // double-press exit). In raw mode Ctrl+C does not auto-generate SIGINT, so
    // we re-emit it to reuse the existing handler.
    if (key.ctrl && key.name === "c") {
      process.emit("SIGINT");
      return;
    }
    if (key.name === "escape") {
      if (halted) return;
      halted = true;
      // Halt the current operation: abort the in-flight LLM stream and ask
      // the agent loop to stop at the next safe point.
      try {
        agent.abortActiveStream();
        agent.getInterventionController().requestStop();
      } catch {
        /* ignore */
      }
      statusLine("INFO", "Halted.");
      try {
        stdin.removeListener("keypress", onKey);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.on("keypress", onKey);
    stdin.resume();
  } catch {
    /* raw mode unavailable — intervention disabled, run continues normally */
    return () => {};
  }
  return restore;
}

main().catch((err) => {
  if (config.outputMode === "json") {
    emitJson({ status: "fatal", error: err.message }, process.stderr);
  } else {
    statusLine("ERROR", `Fatal CLI error: ${err.message}`);
  }
  process.exit(EXIT.ERROR);
});
