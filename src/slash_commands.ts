import { distance } from "fastest-levenshtein";

export interface SlashCommand {
  name: string;
  aliases: string[];
  desc: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
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
  { name: "/memory", aliases: ["/mem"], desc: "View loaded memory (/memory review for pending facts)" },
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
  { name: "/resume", aliases: ["/rs"], desc: "Resume a previous session" },
  {
    name: "/signin",
    aliases: ["/si"],
    desc: "Sign in via Ollama (cloud models, web search)",
  },
  {
    name: "/cloud-sync",
    aliases: ["/cs"],
    desc: "Show cloud sync status & install links",
  },
  {
    name: "/logs",
    aliases: ["/log"],
    desc: "Manage session logs (list, purge, export)",
  },
  {
    name: "/rollback",
    aliases: ["/rb"],
    desc: "Rollback to a previous backup (e.g. /rollback last)",
  },
  {
    name: "/self-heal",
    aliases: ["/heal", "/fix"],
    desc: "Scan codebase for errors/failures and self-heal",
  },
  {
    name: "/override",
    aliases: ["/ov"],
    desc: "Override the last maker-checker verdict (US-15.4)",
  },
  {
    name: "/mcp",
    aliases: [],
    desc: "Show MCP server connections and tools",
  },
];

export function resolveSlashCommand(input: string): string | null {
  const cmd = input.split(/\s+/)[0].toLowerCase();
  for (const sc of SLASH_COMMANDS) {
    if (sc.name === cmd || sc.aliases.includes(cmd)) return sc.name;
  }
  return null;
}

export function suggestSlashCommand(input: string): string | null {
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
  if (bestDist <= 2 && bestDist > 0) {
    const canonical = resolveSlashCommand(bestMatch);
    return canonical || bestMatch;
  }
  return null;
}
