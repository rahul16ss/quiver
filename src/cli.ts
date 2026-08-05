import readline from "readline";
import picocolors from "picocolors";
import {
  config,
  printConfig,
  isFirstRun,
  printFirstRunWizard,
  runOnboardingHandshake,
  redactSecret,
  validateRuntimeConfig,
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
  welcome,
  card,
  info,
  success,
  warn,
  error as logError,
  dim as logDim,
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
// (import { Tui } removed — full-screen interactive TUI retired, Phase 8 / ADR-009)
import { runSignin, checkOllamaConnectivity } from "./signin.js";
import { installDaemonAutostart, uninstallDaemonAutostart, isDaemonAutostartInstalled } from "./daemon/client.js";
import {
  getProjectName,
  getProjectMemoryDir,
  getCoreMemoryPath,
  getSkillsDir,
  getProjectSessionsDir,
  ensureDirectories,
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

/** True when an agent onEvent payload means the turn was refused / aborted. */
function isTurnRefusalEvent(event: { type?: string; data?: any }): boolean {
  if (!event || typeof event !== "object") return false;
  if (event.type === "sensitivity_refused") return true;
  if (event.type === "consent_declined" || event.type === "consent_exclude")
    return true;
  if (event.type === "done") {
    const d = event.data || {};
    if (d.refused === true) return true;
    if (d.consent === "decline" || d.consent === "exclude") return true;
  }
  return false;
}

/**
 * Map `quiver workflow …` argv into the workflow tool's execute args.
 * Supports the README surface: list | run | schedule | watch | status | …
 */
function parseWorkflowCliArgs(argv: string[]): Record<string, unknown> {
  const action = (argv[0] || "list").toLowerCase();
  const out: Record<string, unknown> = { action };
  const rest = argv.slice(1);
  const takeValue = (flag: string): string | undefined => {
    const idx = rest.indexOf(flag);
    if (idx === -1) return undefined;
    const v = rest[idx + 1];
    if (!v || v.startsWith("-")) return undefined;
    return v;
  };

  if (action === "list") {
    return out;
  }
  if (action === "run" || action === "schedule" || action === "watch") {
    const name = rest.find((t) => !t.startsWith("-"));
    if (name) out.workflow = name;
  }
  if (action === "status" || action === "cancel" || action === "handover") {
    const id = rest.find((t) => !t.startsWith("-"));
    if (id) out.run_id = id;
  }
  if (action === "history") {
    const name = rest.find((t) => !t.startsWith("-"));
    if (name) out.workflow = name;
  }
  if (action === "schedule") {
    const cron = takeValue("--cron");
    if (cron) out.cron = cron;
  }
  if (action === "watch") {
    const dir = takeValue("--dir");
    const pattern = takeValue("--pattern");
    if (dir) out.watch_dir = dir;
    if (pattern) out.watch_pattern = pattern;
  }
  return out;
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

  if (cliOpts.daemon) {
    const sub = cliOpts.daemon;
    const repoRoot = path.resolve(import.meta.dirname ?? ".", "..");
    if (sub === "install") {
      const r = installDaemonAutostart(repoRoot);
      console.log(r.detail);
      process.exit(r.installed ? 0 : 1);
    } else if (sub === "uninstall") {
      const r = uninstallDaemonAutostart();
      console.log(r.detail);
      process.exit(0);
    } else {
      console.log(`daemon autostart: ${isDaemonAutostartInstalled() ? "installed" : "not installed"} (${process.platform})`);
      process.exit(0);
    }
  }

  // Top-level `quiver workflow …` is handled after the Agent + callback are
  // wired (below) so `workflow run` can actually draft.

  if (cliOpts.unknownFlags.length > 0) {
    printUnknownFlagHints(cliOpts.unknownFlags);
    process.exit(EXIT.USAGE);
  }

  if (cliOpts.unknownPositionals.length > 0) {
    statusLine(
      "ERROR",
      `Unknown command: ${cliOpts.unknownPositionals.join(" ")}. Try \`quiver --help\`.`,
    );
    process.exit(EXIT.USAGE);
  }

  // Seed ~/.quiver/skills (and project dirs) before any agent session.
  try {
    await ensureDirectories();
  } catch {
    /* best-effort — never block startup */
  }

  // ── Non-interactive no-args guard (US-2.5) ──
  // A piped/CI run with no prompt and no scripted subcommand must never reach
  // the interactive REPL (which would block on stdin forever). Print help and
  // exit with a usage code instead of hanging. Subcommands that work headless
  // (--single-turn, --list-sessions, init, signin)
  // are excluded so scripted/CI usage is not blocked.
  const nonTtyStream = !process.stdin.isTTY || !process.stdout.isTTY;
  const headlessSubcommand =
    !!cliOpts.singleTurn ||
    !!cliOpts.listSessions ||
    cliOpts.init ||
    cliOpts.signin ||
    !!cliOpts.daemon ||
    !!cliOpts.workflowArgs ||
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

  // Fail before opening a model session when the endpoint contract is not
  // configured. This avoids a confusing provider error after the user has
  // already started a task.
  if (!cliOpts.listSessions) {
    const preflight = validateRuntimeConfig();
    for (const warning of preflight.warnings) {
      warn(warning);
    }
    if (!preflight.valid) {
      for (const issue of preflight.errors) {
        logError(issue);
      }
      logDim("Run `quiver init` or configure .env / the OS keychain, then try again.");
      process.exit(EXIT.CONFIG);
    }
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

  // ── Banner — calm welcome (one product line + one model line + one hint) ──
  if (isInteractive) {
    const modeSuffix = config.autonomyGrants.has("yolo")
      ? t.red(` · yolo`)
      : config.autonomyGrants.size > 0
        ? t.cyan(` · auto`)
        : "";
    welcome({ version: VERSION, model: config.llmModelName, modeSuffix });
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

  // A delegated subagent receives an enforced tool allowlist from its parent.
  // Prompt text alone is not a security boundary: remove every unlisted tool
  // after built-ins and MCP tools have loaded.
  const subagentToolAllowlist = process.env.QUIVER_SUBAGENT_TOOLS
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (subagentToolAllowlist?.length) {
    const allowed = new Set(subagentToolAllowlist);
    for (const tool of globalRegistry.getAllTools()) {
      if (!allowed.has(tool.name)) {
        globalRegistry.unregisterTool(tool.name);
      }
    }
  }

  // (welcome() already prints the /help hint above)

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

  // Workflow services are adapters around this one Agent, not a second model
  // loop. Scheduled/watched runs can ask the same agent to draft and return
  // the generated phase text; a model-invoked workflow is rejected as a
  // nested turn so the agent cannot recursively call itself.
  const { setWorkflowAgentCallback } = await import(
    "./tools/workflow_tool.js"
  );
  const workflowAgentCallback = async (workflowPrompt: string, context: any) => {
    if (agent.isPromptRunning()) {
      throw new Error(
        "Workflow build refused: the agent is already handling a prompt; retry the workflow after this turn completes.",
      );
    }
    let output = "";
    await agent.prompt(
      workflowPrompt,
      (token) => {
        output += token;
      },
      isJson
        ? (event) => {
            emitJson(event);
          }
        : undefined,
      context.workflow.data_sensitivity,
    );
    return output || "Agent completed the workflow phase without textual output.";
  };
  setWorkflowAgentCallback(workflowAgentCallback);
  if (!cliOpts.singleTurn && (isInteractive || isJson)) {
    const { WorkflowScheduler } = await import("./workflow/scheduler.js");
    const { WorkflowWatcher } = await import("./workflow/watcher.js");
    const scheduler = new WorkflowScheduler(workflowAgentCallback);
    const watcher = new WorkflowWatcher(workflowAgentCallback);
    scheduler.start();
    watcher.start();
  }

  // Top-level `quiver workflow …` — agent callback is now live.
  if (cliOpts.workflowArgs) {
    try {
      const { tool: workflowTool } = await import("./tools/workflow_tool.js");
      const args = parseWorkflowCliArgs(cliOpts.workflowArgs);
      // schedule/watch only register rules; they need a long-lived process.
      // Be honest when the user asks for background automation from a
      // one-shot CLI invocation.
      if (
        (args.action === "schedule" || args.action === "watch") &&
        !isInteractive &&
        !isJson
      ) {
        statusLine(
          "WARN",
          `\`quiver workflow ${args.action}\` registers the rule, then exits. Keep an interactive \`quiver\` session (or the daemon) running for the scheduler/watcher to fire.`,
        );
      }
      const res = await workflowTool.execute(args as any);
      console.log(JSON.stringify(res, null, 2));
      const failed =
        res &&
        typeof res === "object" &&
        (res as any).status === "error";
      process.exit(failed ? EXIT.ERROR : EXIT.OK);
    } catch (err: any) {
      statusLine("ERROR", err?.message || String(err));
      process.exit(EXIT.ERROR);
    }
  }

  // Track whether a session was resumed (via --continue, --resume, or crash
  let resumedSession = false;

  // US-13.2: detect a crashed/incomplete session from a previous run.
  // Auto-archive silently and show a one-line note. The user can use
  // --resume or --continue to pick up a previous session if needed.
  if (isInteractive && !cliOpts.continue && !cliOpts.resume) {
    try {
      const crash = await detectCrashedSession(getProjectName());
      if (crash.error) {
        statusLine("ERROR", crash.error);
      }
      if (crash.hasCrashedSession && crash.sessionId) {
        await archiveCrashedSession(crash.sessionId);
        statusLine(
          "WARN",
          `Incomplete session ${crash.sessionId} was archived. Use --resume to inspect saved sessions.`,
        );
      }
    } catch {
      statusLine(
        "ERROR",
        "Could not inspect prior session state. Check .quiver-backups before continuing.",
      );
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
    let refused = false;
    const trackEvent = (event: { type?: string; data?: any }) => {
      if (isTurnRefusalEvent(event)) refused = true;
    };

    if (isJson) {
      try {
        await agent.prompt(
          promptText,
          (token) => {},
          (event) => {
            trackEvent(event);
            emitJson(event);
          },
        );
        process.exit(refused ? EXIT.ERROR : EXIT.OK);
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
      await agent.prompt(
        promptText,
        (token) => {
          if (md) md.push(token);
          else process.stdout.write(token);
        },
        (event) => {
          trackEvent(event);
        },
      );
      if (md) md.flush();
      console.log("");
      process.exit(refused ? EXIT.ERROR : EXIT.OK);
    } catch (err: any) {
      statusLine("ERROR", err.message);
      process.exit(EXIT.ERROR);
    }
  }

  // ── Interactive default → browser UI (Phase 8, ADR-009) ──
  // The interactive TUI REPL is retired; the experience plane is the
  // responsive browser application served by the loopback daemon. Running
  // `quiver` on a TTY (no --single-turn/--json/subcommand) launches the
  // daemon and opens the browser. --single-turn/--json (automation) and
  // subcommands (--list-sessions, --init, --signin, --daemon) are unaffected.
  if (isInteractive && !cliOpts.singleTurn && !isJson) {
    const { QuiverLauncher } = await import("./harness/launcher.js");
    const launcher = new QuiverLauncher();
    const state = await launcher.startBrowserUI({ open: true });
    console.log(t.cyan(`\n  Quiver is running in your browser:  ${state.origin}`));
    console.log(t.gray(`  The interactive workspace is the browser UI. Press Ctrl+C to stop.\n`));
    return; // the daemon keeps the process alive
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
