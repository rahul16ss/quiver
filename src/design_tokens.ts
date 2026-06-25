import { existsSync, readFileSync } from "fs";
import * as path from "path";

export interface DesignTokens {
  name: string;
  colors: Record<string, string>;
  spacing: Record<string, string>;
  rounded: Record<string, string>;
  typography: Record<string, Record<string, string | number>>;
  components: Record<string, Record<string, string>>;
}

const DEFAULT_DESIGN_PATH = path.resolve("DESIGN.md");

/** Fallback tokens — kept in sync with DESIGN.md defaults. */
export const DEFAULT_TOKENS: DesignTokens = {
  name: "Quiver-Terminal",
  colors: {
    primary: "#6366f1",
    secondary: "#94a3b8",
    background: "#080a0f",
    "text-primary": "#e2e8f0",
    "text-secondary": "#94a3b8",
    accent: "#6366f1",
    border: "#1e293b",
    "border-active": "#4f46e5",
    success: "#10b981",
    warning: "#f59e0b",
    danger: "#ef4444",
    "panel-bg": "#0f172a",
    info: "#3b82f6",
  },
  spacing: { sm: "4px", md: "8px", lg: "16px" },
  rounded: { sm: "2px", md: "4px" },
  typography: {
    h1: { fontFamily: "monospace", fontSize: "18px", fontWeight: 700 },
    body: { fontFamily: "monospace", fontSize: "12px" },
  },
  components: {
    "prompt-user": { textColor: "{colors.success}" },
    "prompt-agent": { textColor: "{colors.primary}" },
    "status-ok": { textColor: "{colors.success}" },
    "status-warn": { textColor: "{colors.warning}" },
    "status-error": { textColor: "{colors.danger}" },
    "status-info": { textColor: "{colors.info}" },
    "status-dry": { textColor: "{colors.accent}" },
    "panel-surface": { backgroundColor: "{colors.panel-bg}" },
    "panel-border": { backgroundColor: "{colors.border}" },
    "panel-border-active": { backgroundColor: "{colors.border-active}" },
    "log-body": { textColor: "{colors.text-primary}" },
    "log-muted": { textColor: "{colors.text-secondary}" },
  },
};

let cached: DesignTokens | null = null;

/** Minimal YAML parser for DESIGN.md front matter (maps, nested maps, scalars). */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [
    { indent: -1, obj: root },
  ];

  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent < 0) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    const parent = stack[stack.length - 1].obj;

    if (value === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    } else {
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      parent[key] = value;
    }
  }

  return root;
}

export function extractFrontmatter(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : null;
}

export function resolveTokenRef(ref: string, tokens: DesignTokens): string {
  const cleaned = ref.replace(/^\{|\}$/g, "");
  const parts = cleaned.split(".");
  if (parts[0] === "colors" && parts[1]) {
    return tokens.colors[parts[1]] ?? ref;
  }
  if (parts[0] === "components" && parts[1] && parts[2]) {
    const comp = tokens.components[parts[1]];
    const val = comp?.[parts[2]];
    if (typeof val === "string" && val.startsWith("{")) {
      return resolveTokenRef(val, tokens);
    }
    return val ?? ref;
  }
  return ref;
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function asNestedMap(
  value: unknown,
): Record<string, Record<string, string | number>> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, Record<string, string | number>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, string | number> = {};
      for (const [ik, iv] of Object.entries(v as Record<string, unknown>)) {
        if (typeof iv === "string" || typeof iv === "number") inner[ik] = iv;
      }
      out[k] = inner;
    }
  }
  return out;
}

function asComponentMap(
  value: unknown,
): Record<string, Record<string, string>> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = asStringMap(v);
    }
  }
  return out;
}

export function parseDesignTokensFromMarkdown(markdown: string): DesignTokens {
  const frontmatter = extractFrontmatter(markdown);
  if (!frontmatter) return { ...DEFAULT_TOKENS };

  const parsed = parseSimpleYaml(frontmatter);
  return {
    name: typeof parsed.name === "string" ? parsed.name : DEFAULT_TOKENS.name,
    colors: { ...DEFAULT_TOKENS.colors, ...asStringMap(parsed.colors) },
    spacing: { ...DEFAULT_TOKENS.spacing, ...asStringMap(parsed.spacing) },
    rounded: { ...DEFAULT_TOKENS.rounded, ...asStringMap(parsed.rounded) },
    typography: {
      ...DEFAULT_TOKENS.typography,
      ...asNestedMap(parsed.typography),
    },
    components: {
      ...DEFAULT_TOKENS.components,
      ...asComponentMap(parsed.components),
    },
  };
}

export function loadDesignTokens(
  filePath: string = process.env.QUIVER_DESIGN_MD || DEFAULT_DESIGN_PATH,
): DesignTokens {
  if (!existsSync(filePath)) return { ...DEFAULT_TOKENS };
  const markdown = readFileSync(filePath, "utf8");
  return parseDesignTokensFromMarkdown(markdown);
}

export function getDesignTokens(): DesignTokens {
  if (!cached) cached = loadDesignTokens();
  return cached;
}

/** Reset cache (for tests). */
export function resetDesignTokenCache(): void {
  cached = null;
}

export function color(
  tokens: DesignTokens,
  tokenName: keyof DesignTokens["colors"] | string,
): string {
  return tokens.colors[tokenName] ?? DEFAULT_TOKENS.colors[tokenName] ?? "#ffffff";
}

export function componentColor(
  tokens: DesignTokens,
  componentName: string,
  prop: string,
): string {
  const raw = tokens.components[componentName]?.[prop];
  if (!raw) return color(tokens, "text-primary");
  if (raw.startsWith("{")) return resolveTokenRef(raw, tokens);
  return raw;
}

export interface ResolvedTerminalPalette {
  background: string;
  panelBg: string;
  primary: string;
  secondary: string;
  textPrimary: string;
  textSecondary: string;
  border: string;
  borderActive: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  accent: string;
  promptUser: string;
  promptAgent: string;
}

export function resolveTerminalPalette(
  tokens: DesignTokens = getDesignTokens(),
): ResolvedTerminalPalette {
  return {
    background: color(tokens, "background"),
    panelBg: color(tokens, "panel-bg"),
    primary: color(tokens, "primary"),
    secondary: color(tokens, "secondary"),
    textPrimary: color(tokens, "text-primary"),
    textSecondary: color(tokens, "text-secondary"),
    border: componentColor(tokens, "panel-border", "backgroundColor"),
    borderActive: componentColor(tokens, "panel-border-active", "backgroundColor"),
    success: componentColor(tokens, "status-ok", "textColor"),
    warning: componentColor(tokens, "status-warn", "textColor"),
    danger: componentColor(tokens, "status-error", "textColor"),
    info: componentColor(tokens, "status-info", "textColor"),
    accent: componentColor(tokens, "status-dry", "textColor"),
    promptUser: componentColor(tokens, "prompt-user", "textColor"),
    promptAgent: componentColor(tokens, "prompt-agent", "textColor"),
  };
}
