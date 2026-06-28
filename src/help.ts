import picocolors from "picocolors";
import { theme } from "./cli_ui.js";
import { SLASH_COMMANDS } from "./slash_commands.js";
import { globalRegistry } from "./registry.js";
import { Agent } from "./agent.js";

const TOOL_CATEGORIES: Record<string, string[]> = {
  "📁 Files": [
    "view_file",
    "write_file",
    "replace_content",
    "apply_patch",
    "list_dir",
    "glob",
    "format_code",
    "grep_search",
  ],
  "⚙️ System": ["run_command", "run_tests", "create_tool", "log_tokens"],
  "🌐 Web": [
    "web_search",
    "scrape_url",
    "browser_control",
    "deep_research",
    "find_all",
    "entity_search",
  ],
  "🧠 Memory": ["memory_append", "memory_replace", "continual_learning"],
  "🐙 GitHub": ["github"],
  "📋 Planning": ["todo_write", "ask_question"],
  "🔄 Self-Improvement": ["prompt_update"],
  "🔁 Iteration": ["ralph_loop"],
  "🤖 Agents": ["subagent"],
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
    categorized.push({ category: "🔧 Other", tools: uncategorized });
  }

  return categorized;
}

export function printHelp(): void {
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

export function printInSessionHelp(): void {
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

export function printEnhancedTools(): void {
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
