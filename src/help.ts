import picocolors from "picocolors";
import { theme } from "./cli_ui.js";
import { SLASH_COMMANDS } from "./slash_commands.js";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";

const TOOL_CATEGORIES: Record<string, string[]> = {
  "Files": [
    "view_file",
    "write_file",
    "replace_content",
    "apply_patch",
    "list_dir",
    "glob",
    "format_code",
    "grep_search",
  ],
  "System": ["run_command", "run_tests", "create_tool", "log_tokens"],
  "Web": [
    "web_search",
    "scrape_url",
    "browser_control",
    "deep_research",
    "find_all",
    "entity_search",
  ],
  "Memory": ["memory_append", "memory_replace", "continual_learning"],
  "GitHub": ["github"],
  "Planning": ["todo_write", "ask_question"],
  "Self-Improvement": ["prompt_update"],
  "Iteration": ["ralph_loop"],
  "Agents": ["subagent"],
};

type ToolDisplay = { name: string; displayName: string; description: string };

function categorizeTools(
  tools: ToolDisplay[],
): { category: string; tools: ToolDisplay[] }[] {
  const categorized: { category: string; tools: ToolDisplay[] }[] = [];
  const assigned = new Set<string>();

  for (const [category, toolNames] of Object.entries(TOOL_CATEGORIES)) {
    const matched = tools.filter((t) => toolNames.includes(t.name));
    if (matched.length > 0) {
      categorized.push({ category, tools: matched });
      matched.forEach((t) => assigned.add(t.name));
    }
  }

  const uncategorized = tools.filter((t) => !assigned.has(t.name));
  if (uncategorized.length > 0) {
    categorized.push({ category: "Other", tools: uncategorized });
  }

  return categorized;
}

export function printHelp(): void {
  const t = theme();
  console.log(
    t.cyan(
      t.bold(`
  Quiver — Your AI analyst, researcher, and writer
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
    `    quiver signin                   Sign in via Ollama (cloud models, web search)`,
  );
  console.log(
    `    quiver cloud-sync               Show sync status & install links`,
  );
  console.log(
    `    quiver --single-turn "prompt"    Run a single prompt and exit`,
  );
  console.log(
    `    quiver --continue, -c            Resume the most recent session`,
  );
  console.log(`    quiver --resume, -r              Pick a session to resume`);
  console.log(`    quiver --list-sessions, -ls      List all saved sessions`);
  console.log(`    quiver --model <name>            Override model for this session`);
  console.log(`    quiver --yolo                     Start in YOLO mode (all gates off)`);
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
  console.log(`    --model <name>    Override the model for this session`);
  console.log(`    --yolo            Start in YOLO mode (all gates bypassed)`);
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
      "  Enter to send  ·  \\+Enter or Option+Enter for a new line  ·  type / for commands",
    ),
  );
  console.log("");
}

export function printInSessionHelp(): void {
  // Self-contained command list with full descriptions — no dependency on
  // SLASH_COMMANDS lookups (which skip aliases like /history, /cost, /hi).
  const groups: {
    title: string;
    cmds: { name: string; desc: string; aliases?: string[] }[];
  }[] = [
    {
      title: "Session",
      cmds: [
        { name: "/help", desc: "Show this help", aliases: ["/h", "/?"] },
        { name: "/exit", desc: "End session (saves state for --continue)", aliases: ["/quit", "/q"] },
        { name: "/session", desc: "Show token usage, cost, message count (+ /session full for history)", aliases: ["/s", "/cost", "/history", "/hi"] },
        { name: "/model", desc: "Show or change the active model", aliases: ["/m"] },
        { name: "/compact", desc: "Compact conversation history (frees context)", aliases: ["/co"] },
        { name: "/reset", desc: "Reset conversation (keeps memory & skills)", aliases: ["/r"] },
        { name: "/clear", desc: "Clear terminal screen", aliases: [] },
        { name: "/resume", desc: "Resume a previous session by ID", aliases: ["/rs"] },
        { name: "/export", desc: "Export session to .qf file", aliases: [] },
      ],
    },
    {
      title: "Permissions",
      cmds: [
        { name: "/autonomy", desc: "Trust tiers & grants (observe→propose→build→operate→yolo)", aliases: ["/a", "/tier"] },
        { name: "/yolo", desc: "Top trust tier — bypass ALL gates + path sandbox off", aliases: [] },
        { name: "/sandbox", desc: "Toggle path sandbox on/off (requires YOLO to disable)", aliases: ["/sb"] },
      ],
    },
    {
      title: "Verification",
      cmds: [
        { name: "/override", desc: "Override a blocked action (advanced)", aliases: ["/ov"] },
      ],
    },
    {
      title: "Settings & info",
      cmds: [
        { name: "/tools", desc: "List available tools (+ /tools <search> to filter)", aliases: ["/t"] },
        { name: "/config", desc: "Show current configuration", aliases: ["/c"] },
        { name: "/version", desc: "Show Quiver version", aliases: ["/v"] },
        { name: "/mcp", desc: "Show MCP server connections and tools", aliases: [] },
        { name: "/memory", desc: "View loaded memory files (/memory review for pending facts)", aliases: ["/mem"] },
        { name: "/logs", desc: "Manage session logs (list, purge, export)", aliases: ["/log"] },
        { name: "/rollback", desc: "Rollback to a previous backup (e.g. /rollback last)", aliases: ["/rb"] },
        { name: "/dry-run", desc: "Toggle dry-run mode (preview actions without executing)", aliases: ["/dry"] },
        { name: "/editor", desc: "Open $EDITOR to compose a multi-line prompt", aliases: ["/ed"] },
        { name: "/signin", desc: "Sign in via Ollama (cloud models, web search)", aliases: ["/si"] },
        { name: "/cloud-sync", desc: "Show cloud sync status & install links", aliases: ["/cs"] },
      ],
    },
  ];

  console.log(picocolors.cyan(`\n  Quiver Commands\n`));
  for (const g of groups) {
    console.log(picocolors.bold(`  ${g.title}`));
    for (const cmd of g.cmds) {
      const aliases =
        cmd.aliases && cmd.aliases.length > 0
          ? picocolors.gray(` (${cmd.aliases.join(", ")})`)
          : "";
      const padded = cmd.name.padEnd(14);
      console.log(`    ${picocolors.green(padded)}${cmd.desc}${aliases}`);
    }
    console.log("");
  }
  // Quick-reference alias map — short forms like /r, /s, /m are what users
  // actually type, so list them explicitly so they're findable without
  // scanning every command's parenthetical.
  const allAliases = groups
    .flatMap((g) => g.cmds)
    .filter((c) => c.aliases && c.aliases.length > 0)
    .flatMap((c) => c.aliases!.map((a) => `${a} → ${c.name}`));
  if (allAliases.length > 0) {
    console.log(picocolors.bold(`  Aliases`));
    console.log(
      `    ${picocolors.gray(allAliases.join("  ·  "))}\n`,
    );
  }

  console.log(
    picocolors.gray(
      `  Finished tasks are auto-verified and healed if needed.`,
    ),
  );
  console.log(
    picocolors.gray(
      `  While the agent is running, press ${picocolors.cyan("Esc")} to steer it — your message is injected at the next step.`,
    ),
  );
  console.log(
    picocolors.gray(
      `  ${picocolors.cyan("Ctrl+C")} aborts the current generation (press twice to exit).`,
    ),
  );
  console.log(
    picocolors.gray(
      `  Type any other text to chat. Enter to send  ·  \\+Enter or Option+Enter for a new line.\n`,
    ),
  );
}

export function printEnhancedTools(filter?: string): void {
  let tools = globalRegistry.getAllTools().map((t) => ({
    name: t.name,
    displayName: Agent.getToolDisplayName(t.name),
    description: t.description,
  }));

  // US-5.1: Search/filter support
  if (filter && filter.trim()) {
    const q = filter.trim().toLowerCase();
    tools = tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.displayName.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }

  console.log(
    picocolors.cyan(
      `\n  Available tools (${tools.length}${filter ? ` matching "${filter}"` : ""})\n`,
    ),
  );

  if (tools.length === 0) {
    console.log(
      picocolors.gray(
        "  No tools match your search. Try /tools without a filter to see all.\n",
      ),
    );
    return;
  }

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

  if (!filter) {
    console.log(
      picocolors.gray("  Tip: /tools <search> to filter (e.g. /tools file)\n"),
    );
  }
}