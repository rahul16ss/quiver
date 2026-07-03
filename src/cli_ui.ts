import picocolors from "picocolors";
import { distance } from "fastest-levenshtein";
import { config } from "./config.js";

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  CONFIG: 3,
} as const;

export type StatusTag = "OK" | "WARN" | "ERROR" | "INFO" | "DRY";

const KNOWN_FLAGS = [
  "--help",
  "-h",
  "--version",
  "-v",
  "--json",
  "--quiet",
  "-q",
  "--dry-run",
  "-n",
  "--single-turn",
  "init",
  "signin",
  "cloud-sync",
  "--continue",
  "-c",
  "--resume",
  "-r",
  "--list-sessions",
  "-ls",
  "--model",
  "--yolo",
];

export interface CliOptions {
  help: boolean;
  version: boolean;
  json: boolean;
  quiet: boolean;
  dryRun: boolean;
  init: boolean;
  signin: boolean;
  cloudSync: boolean;
  cleanupLeaks: boolean;
  singleTurn?: string;
  continue?: boolean;
  resume?: boolean;
  listSessions?: boolean;
  model?: string;
  yolo?: boolean;
  unknownFlags: string[];
}

type ColorFn = (s: string) => string;

export interface QuiverTheme {
  bold: ColorFn;
  dim: ColorFn;
  italic: ColorFn;
  underline: ColorFn;
  strikethrough: ColorFn;
  cyan: ColorFn;
  green: ColorFn;
  yellow: ColorFn;
  red: ColorFn;
  blue: ColorFn;
  magenta: ColorFn;
  gray: ColorFn;
  white: ColorFn;
  brand: ColorFn;
  accent: ColorFn;
  muted: ColorFn;
  success: ColorFn;
  warning: ColorFn;
  danger: ColorFn;
  info: ColorFn;
  dry: ColorFn;
  promptUser: () => string;
  promptAgent: () => string;
  brandBorder: ColorFn;
  brandBar: ColorFn;
}

const identity = {
  bold: (s: string) => s,
  dim: (s: string) => s,
  italic: (s: string) => s,
  underline: (s: string) => s,
  strikethrough: (s: string) => s,
  cyan: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
  red: (s: string) => s,
  blue: (s: string) => s,
  magenta: (s: string) => s,
  gray: (s: string) => s,
  white: (s: string) => s,
};

export function supportsColor(
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  if (process.env.QUIVER_NO_COLOR === "1") {
    return false;
  }
  if (
    process.env.FORCE_COLOR !== undefined &&
    process.env.FORCE_COLOR !== "0"
  ) {
    return true;
  }
  return stream.isTTY === true;
}

/** Theme with semantic color aliases. */
export function theme(
  stream: NodeJS.WriteStream = process.stdout,
): QuiverTheme {
  const useColor = supportsColor(stream);
  const pc = useColor ? picocolors : identity;

  return {
    ...pc,
    brand: pc.cyan,
    accent: pc.magenta,
    muted: pc.gray,
    success: pc.green,
    warning: pc.yellow,
    danger: pc.red,
    info: pc.blue,
    dry: pc.cyan,
    promptUser: () => pc.bold(pc.green("Q> ")),
    promptAgent: () =>
      pc.bold(pc.cyan("\u25c6 ")) +
      pc.gray(`[${config.llmModelName}] `),
    brandBorder: pc.gray,
    brandBar: pc.cyan,
  };
}

function tagColor(tag: StatusTag, t: QuiverTheme): ColorFn {
  switch (tag) {
    case "OK":
      return t.success;
    case "WARN":
      return t.warning;
    case "ERROR":
      return t.danger;
    case "DRY":
      return t.dry;
    default:
      return t.info;
  }
}

/** Accessible status line: always includes a text tag, color is optional. */
export function statusLine(
  tag: StatusTag,
  message: string,
  stream: NodeJS.WriteStream = process.stderr,
): void {
  const t = theme(stream);
  const coloredTag = tagColor(tag, t)(`[${tag}]`);
  stream.write(`${coloredTag} ${message}\n`);
}

export function statusBlock(
  tag: StatusTag,
  title: string,
  lines: string[] = [],
  stream: NodeJS.WriteStream = process.stderr,
): void {
  const t = theme(stream);
  stream.write(`${tagColor(tag, t)(`[${tag}]`)} ${t.bold(title)}\n`);
  for (const line of lines) {
    stream.write(`  ${line}\n`);
  }
}

export function renderProgressBar(
  current: number,
  total: number,
  label = "",
  width = 24,
): string {
  if (total <= 0) return label;
  const ratio = Math.min(1, Math.max(0, current / total));
  const filled = Math.round(ratio * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const pct = Math.round(ratio * 100);
  const suffix = label ? ` ${label}` : "";
  return `[${bar}] ${pct}% (${current}/${total})${suffix}`;
}

/** Locale-stable integer formatter (en-US grouping) — single source of
 *  truth so token counts never render as locale-dependent "1,20,000". */
export function formatNum(n: number): string {
  return Number(n || 0).toLocaleString("en-US");
}

/** Theme-aware inline diff renderer for the terminal approval gate.
 *  Color is optional (respects NO_COLOR / non-TTY via theme()), so the
 *  +/- structure is the source of truth, not color alone. */
export function renderInlineDiff(
  diff: string,
  stream: NodeJS.WriteStream = process.stdout,
  maxLines = 200,
): string {
  const t = theme(stream);
  const allLines = diff.split("\n");
  const lines = allLines.slice(0, maxLines);
  const rendered = lines
    .map((line) => {
      if (line.startsWith("+++") || line.startsWith("---")) return t.info(line);
      if (line.startsWith("@@")) return t.muted(line);
      if (line.startsWith("+")) return t.success(line);
      if (line.startsWith("-")) return t.danger(line);
      return t.muted(line);
    })
    .join("\n");
  if (allLines.length > maxLines) {
    return rendered + "\n" + t.muted(`  \u2026 (${allLines.length - maxLines} more lines)`);
  }
  return rendered;
}

export function suggestFlag(input: string): string | null {
  let best = "";
  let bestDist = Infinity;
  for (const flag of KNOWN_FLAGS) {
    const d = distance(input, flag);
    if (d < bestDist) {
      bestDist = d;
      best = flag;
    }
  }
  if (bestDist > 0 && bestDist <= 2) return best;
  return null;
}

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    help: false,
    version: false,
    json: false,
    quiet: false,
    dryRun: false,
    init: false,
    signin: false,
    cloudSync: false,
    cleanupLeaks: false,
    continue: false,
    resume: false,
    listSessions: false,
    model: undefined,
    yolo: false,
    unknownFlags: [],
  };

  // Normalize argv before dispatch so the parser supports two POSIX-isms the
  // raw loop below does not:
  //  - `--flag=value` (e.g. `--model=glm-5.2:cloud`, `--single-turn="hi there"`)
  //    is split into `--flag` + `value` tokens so the value-flag branches below
  //    consume the value via `argv[i + 1]` exactly as they would for a space.
  //  - Combined boolean short flags (e.g. `-qc`) are split into `-q` `-c`.
  //    Multi-char shorts that are themselves known flags (`-ls` = --list-sessions)
  //    are left intact so they keep their special meaning.
  const expanded: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--") && a.includes("=")) {
      const eq = a.indexOf("=");
      expanded.push(a.slice(0, eq));
      expanded.push(a.slice(eq + 1));
    } else if (/^-[A-Za-z]{2,}$/.test(a) && !KNOWN_FLAGS.includes(a)) {
      for (const ch of a.slice(1)) expanded.push("-" + ch);
    } else {
      expanded.push(a);
    }
  }

  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      opts.version = true;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      opts.quiet = true;
      continue;
    }
    if (arg === "--dry-run" || arg === "-n") {
      opts.dryRun = true;
      continue;
    }
    if (arg === "init") {
      opts.init = true;
      continue;
    }
    if (arg === "signin") {
      opts.signin = true;
      continue;
    }
    if (arg === "cloud-sync") {
      opts.cloudSync = true;
      continue;
    }
    if (arg === "--cleanup-leaks") {
      opts.cleanupLeaks = true;
      continue;
    }
    if (arg === "--single-turn") {
      const next = expanded[i + 1];
      if (!next || next.startsWith("-")) {
        throw new UsageError("--single-turn requires a prompt string.");
      }
      opts.singleTurn = next;
      i++;
      continue;
    }
    if (arg === "--model") {
      const next = expanded[i + 1];
      if (!next || next.startsWith("-")) {
        throw new UsageError("--model requires a model name.");
      }
      opts.model = next;
      i++;
      continue;
    }
    if (arg === "--yolo") {
      opts.yolo = true;
      continue;
    }
    if (arg === "--continue" || arg === "-c") {
      opts.continue = true;
      continue;
    }
    if (arg === "--resume" || arg === "-r") {
      opts.resume = true;
      continue;
    }
    if (arg === "--list-sessions" || arg === "-ls") {
      opts.listSessions = true;
      continue;
    }
    if (arg.startsWith("-")) {
      opts.unknownFlags.push(arg);
    }
  }

  return opts;
}

export class UsageError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export function emitJson(
  payload:
    | Record<string, unknown>
    | { type: string; data?: Record<string, unknown> },
  stream: NodeJS.WriteStream = process.stdout,
): void {
  stream.write(`${JSON.stringify(payload)}\n`);
}

export function printUnknownFlagHints(flags: string[]): void {
  for (const flag of flags) {
    const suggestion = suggestFlag(flag);
    if (suggestion) {
      statusLine(
        "WARN",
        `Unknown flag '${flag}'. Did you mean '${suggestion}'?`,
      );
    } else {
      statusLine(
        "WARN",
        `Unknown flag '${flag}'. Run 'quiver --help' for options.`,
      );
    }
  }
}
