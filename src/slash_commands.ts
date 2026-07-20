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
  {
    name: "/autonomy",
    aliases: ["/a", "/tier"],
    desc: "Trust tiers & grants (tier observe→yolo, add/remove grants, sandbox)",
  },
  { name: "/session", aliases: ["/s", "/cost", "/history", "/hi"], desc: "Show session stats (+ /session full for message history)" },
  { name: "/version", aliases: ["/v"], desc: "Show Quiver version" },
  { name: "/config", aliases: ["/c"], desc: "Show configuration" },
  { name: "/clear", aliases: [], desc: "Clear terminal screen" },
  { name: "/compact", aliases: ["/co"], desc: "Compact conversation history" },
  { name: "/reset", aliases: ["/r"], desc: "Reset conversation (keep memory)" },
  {
    name: "/memory",
    aliases: ["/mem"],
    desc: "View loaded memory (/memory review for pending facts)",
  },
  { name: "/model", aliases: ["/m"], desc: "Show or change model" },
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
    name: "/override",
    aliases: ["/ov"],
    desc: "Override a blocked action (advanced)",
  },
  {
    name: "/mcp",
    aliases: [],
    desc: "Show MCP server connections and tools",
  },
  {
    name: "/yolo",
    aliases: [],
    desc: "Top trust tier — bypass ALL gates + path sandbox off (anywhere)",
  },
  {
    name: "/sandbox",
    aliases: ["/sb"],
    desc: "Toggle path sandbox on/off (requires YOLO mode to disable)",
  },
  {
    name: "/editor",
    aliases: ["/ed"],
    desc: "Open $EDITOR to compose a multi-line prompt",
  },
  {
    name: "/update",
    aliases: ["/up"],
    desc: "Check for Quiver updates",
  },
  {
    name: "/watchdog",
    aliases: ["/wd"],
    desc: "Self-health queue (show findings / clear / status)",
  },
  {
    name: "/promote",
    aliases: ["/pm"],
    desc: "Promote scratch drafts to real files (/promote all | <path> | list)",
  },
  {
    name: "/consent",
    aliases: ["/cg"],
    desc: "Toggle consent gate (pre-action summary before model calls)",
  },
  {
    name: "/memory-history",
    aliases: ["/mh"],
    desc: "Show version history for a memory file (/memory-history <filename>)",
  },
  {
    name: "/memory-rollback",
    aliases: ["/mr"],
    desc: "Restore a previous version of a memory file (/memory-rollback <filename> <version>)",
  },
  {
    name: "/memory-diff",
    aliases: ["/md"],
    desc: "Compare two versions of a memory file (/memory-diff <filename> <v1> <v2>)",
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
