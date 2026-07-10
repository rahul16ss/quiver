/**
 * Terminal input system for the Quiver REPL.
 *
 * Design goals — match the ergonomics of mature terminal AI CLIs (Claude Code,
 * Codex CLI) rather than the "press Enter twice to submit" convention:
 *
 *   • Enter submits the message.
 *   • Backslash + Enter, or Alt/Option + Enter, inserts a newline (multi-line).
 *   • Up / Down arrows recall input history (when the buffer is a single line)
 *     or move the cursor across lines (when the buffer is multi-line).
 *   • Pasted text (bracketed paste) is inserted verbatim — newlines and all —
 *     without triggering submit.
 *   • Emacs-style editing: Ctrl+A/E (home/end), Ctrl+K/U (kill to end/start of
 *     line), Ctrl+W (delete word back), Alt+B/F (word move), Alt+Backspace /
 *     Alt+D (delete word back/forward).
 *   • Ctrl+L clears the screen. Ctrl+C clears the current input (or exits on an
 *     empty prompt). Ctrl+D exits on an empty prompt, else deletes forward.
 *   • Tab completes the highlighted slash command from the popup menu.
 *
 * Discoverability for non-coders / business users (Claude Code / Codex parity):
 *   • A dim placeholder hint is shown when the input is empty
 *     ("Ask anything  ·  type / for commands").
 *   • Typing "/" opens a filtered, scrollable command menu (↑/↓ to pick,
 *     Tab or Enter to complete, Enter to run a fully-typed command).
 *
 * Input history is persisted to ~/.quiver/history (capped, deduped).
 *
 * Non-TTY (pipes, CI, JSON mode) falls back to a simple readline `question` —
 * no escape sequences, no raw mode. Single-line approvals/confirmations still
 * use @clack/prompts `text` via promptLine().
 *
 * Exports:
 * - promptUser(promptText) — main REPL input (custom editor for TTY, readline for non-TTY)
 * - promptLine(promptText) — single-line input (approvals, confirmations, steering)
 */

import { text, isCancel } from "@clack/prompts";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import picocolors from "picocolors";
import { SLASH_COMMANDS, type SlashCommand } from "./slash_commands.js";
import { supportsColor } from "./cli_ui.js";

const HISTORY_FILE = path.join(os.homedir(), ".quiver", "history");
const HISTORY_MAX = 2000;

// ANSI helpers.
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Maximum visible rows in the slash-command popup menu.
const MAX_MENU_ROWS = 8;

/**
 * Prompt the user for input in a TTY (custom editor), or single-line in non-TTY.
 * Returns the user's input string, or null on cancel/EOF (Ctrl+C/Ctrl+D at an
 * empty prompt).
 */
export async function promptUser(
  _rl: unknown,
  promptText: string,
  prefill?: string,
): Promise<string | null> {
  // Non-TTY: simple readline — no escape sequences. (Prefill is only ever set
  // from the TTY live-input path, so it is intentionally ignored here.)
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return promptNonTty(promptText);
  }

  // TTY: custom raw-mode editor. Any failure falls back to the non-TTY path so
  // the REPL never hard-crashes on an exotic terminal.
  try {
    return await editLine(promptText, prefill);
  } catch {
    return promptNonTty(promptText);
  }
}

/**
 * Single-line prompt — approvals, confirmations, mid-run steering.
 * Uses @clack/prompts `text` in both TTY and non-TTY. Returns "" on cancel.
 */
export async function promptLine(
  _rl: unknown,
  promptText: string,
): Promise<string> {
  const cleanPrompt = promptText.replace(ANSI_RE, "");

  // Non-TTY (pipes, CI, GUI --json IPC): @clack `text` cancels immediately on a
  // piped stdin, which would auto-deny every approval/confirmation. Use the
  // readline fallback so a single line (e.g. the GUI's "y") is actually read.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    const r = await promptNonTty(cleanPrompt);
    return r ?? "";
  }

  try {
    const result = await text({ message: cleanPrompt });
    if (isCancel(result)) return "";
    return result as string;
  } catch {
    const fallback = await promptNonTty(cleanPrompt);
    return fallback ?? "";
  }
}

/**
 * Non-TTY fallback: simple readline-based input for pipes and CI.
 * @clack/prompts handles non-TTY internally, but we keep this as a safety net.
 */
async function promptNonTty(promptText: string): Promise<string | null> {
  const cleanPrompt = promptText.replace(ANSI_RE, "");
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    let settled = false;
    const onClose = () => {
      if (!settled) {
        settled = true;
        rl.close();
        resolve(null);
      }
    };
    rl.once("close", onClose);
    rl.question(cleanPrompt, (answer: string) => {
      if (!settled) {
        settled = true;
        rl.removeListener("close", onClose);
        rl.close(); // release stdin so the next reader (e.g. an approval) gets it
        resolve(answer);
      }
    });
  });
}

// ─── Input history (persisted to ~/.quiver/history) ────────────────────────

let historyCache: string[] | null = null;

async function loadHistory(): Promise<string[]> {
  if (historyCache) return historyCache;
  try {
    const raw = await fs.readFile(HISTORY_FILE, "utf8");
    // Lines stored oldest → newest; reverse so most-recent is at the end.
    const lines = raw.split("\n").filter((l) => l.length > 0);
    historyCache = lines;
    return lines;
  } catch {
    historyCache = [];
    return [];
  }
}

async function saveHistory(entry: string): Promise<void> {
  const hist = await loadHistory();
  // Dedup consecutive duplicates; skip blanks.
  if (!entry.trim() || hist[hist.length - 1] === entry) return;
  hist.push(entry);
  while (hist.length > HISTORY_MAX) hist.shift();
  try {
    await fs.mkdir(path.dirname(HISTORY_FILE), { recursive: true });
    await fs.writeFile(HISTORY_FILE, hist.join("\n") + "\n", "utf8");
  } catch {
    /* history is best-effort — never block the REPL on it */
  }
}

// ─── Display-width helper ───────────────────────────────────────────────────

function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue; // control / DEL (ANSI escapes live here)
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks
    // Wide ranges (CJK, full-width) → 2 cells; everything else → 1.
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

// ─── Custom raw-mode TTY editor ─────────────────────────────────────────────

async function editLine(
  promptText: string,
  prefill?: string,
): Promise<string | null> {
  const stdin = process.stdin as NodeJS.Socket & {
    setRawMode?(mode: boolean): void;
  };
  const stdout = process.stdout;

  const promptStr = promptText; // may contain ANSI color codes
  const promptWidth = strWidth(promptText.replace(ANSI_RE, ""));
  const contStr = "  "; // continuation prefix for extra lines
  const contWidth = contStr.length;

  let buffer = prefill ?? "";
  let cursor = buffer.length; // index into buffer (UTF-16 code units)
  let pending = ""; // un-parsed tail (for ESC sequences split across chunks)
  let pasting = false;
  let pasteBuf = "";

  // History navigation state.
  const hist = await loadHistory();
  let histIndex = hist.length; // at "end" = current draft
  let draft = ""; // saved in-progress buffer when we step into history

  // Slash-command autocomplete menu state.
  let menuIndex = 0;

  // Color helpers (respect NO_COLOR / QUIVER_NO_COLOR via supportsColor).
  const hasColor = supportsColor(stdout);
  const pc = picocolors;
  const cDim = (x: string) => (hasColor ? pc.dim(x) : x);
  const cCyan = (x: string) => (hasColor ? pc.cyan(x) : x);
  const cGreen = (x: string) => (hasColor ? pc.green(x) : x);
  const cGray = (x: string) => (hasColor ? pc.gray(x) : x);
  const cBold = (x: string) => (hasColor ? pc.bold(x) : x);
  const cInverse = (x: string) => (hasColor ? pc.inverse(x) : x);

  // Friendly placeholder shown when the input is empty — discoverability for
  // non-coders / business users (parity with Claude Code / Codex prompts).
  const PLACEHOLDER = cDim("Ask anything  ·  type / for commands");

  let lastCursorRow = 0; // terminal rows from prompt start to the cursor (last render)
  let done = false;
  let resolveFn: ((v: string | null) => void) | null = null;

  const cols = () => stdout.columns || 80;

  const result = new Promise<string | null>((resolve) => {
    resolveFn = resolve;
  });

  function finish(value: string | null) {
    if (done) return;
    done = true;
    cleanup();
    resolveFn!(value);
  }

  function cleanup() {
    try {
      stdin.removeListener("data", onData);
    } catch {
      /* ignore */
    }
    try {
      stdout.write(PASTE_OFF);
    } catch {
      /* ignore */
    }
    try {
      stdout.write(SHOW);
    } catch {
      /* ignore */
    }
    try {
      stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    try {
      stdin.resume();
    } catch {
      /* ignore */
    }
  }

  // ── Buffer mutations ─────────────────────────────────────────────────────

  function insertText(s: string): void {
    buffer = buffer.slice(0, cursor) + s + buffer.slice(cursor);
    cursor += s.length;
  }

  function deleteBackward(): void {
    if (cursor <= 0) return;
    // Join lines if deleting at the start of a line (removes the '\n').
    buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
    cursor -= 1;
  }

  function deleteForward(): void {
    if (cursor >= buffer.length) return;
    buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
  }

  function lineStart(pos: number): number {
    const i = buffer.lastIndexOf("\n", pos - 1);
    return i + 1; // 0 if not found → start of buffer
  }

  function lineEnd(pos: number): number {
    const i = buffer.indexOf("\n", pos);
    return i === -1 ? buffer.length : i;
  }

  function killToEndOfLine(): void {
    const end = lineEnd(cursor);
    buffer = buffer.slice(0, cursor) + buffer.slice(end);
  }

  function killToStartOfLine(): void {
    const start = lineStart(cursor);
    buffer = buffer.slice(0, start) + buffer.slice(cursor);
    cursor = start;
  }

  function deleteWordBack(): void {
    if (cursor <= 0) return;
    let i = cursor;
    // Skip trailing whitespace, then the word.
    while (i > 0 && /\s/.test(buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(buffer[i - 1])) i--;
    buffer = buffer.slice(0, i) + buffer.slice(cursor);
    cursor = i;
  }

  function deleteWordForward(): void {
    if (cursor >= buffer.length) return;
    let i = cursor;
    while (i < buffer.length && /\s/.test(buffer[i])) i++;
    while (i < buffer.length && !/\s/.test(buffer[i])) i++;
    buffer = buffer.slice(0, cursor) + buffer.slice(i);
  }

  function moveWordBack(): void {
    let i = cursor;
    while (i > 0 && /\s/.test(buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(buffer[i - 1])) i--;
    cursor = i;
  }

  function moveWordForward(): void {
    let i = cursor;
    while (i < buffer.length && /\s/.test(buffer[i])) i++;
    while (i < buffer.length && !/\s/.test(buffer[i])) i++;
    cursor = i;
  }

  function moveLeft(): void {
    if (cursor > 0) cursor -= 1;
  }
  function moveRight(): void {
    if (cursor < buffer.length) cursor += 1;
  }
  function moveLineStart(): void {
    cursor = lineStart(cursor);
  }
  function moveLineEnd(): void {
    cursor = lineEnd(cursor);
  }
  function moveUpLine(): void {
    if (lineStart(cursor) === 0) return; // first line
    const ls = lineStart(cursor);
    const col = cursor - ls;
    const prevEnd = ls - 1; // the '\n'
    const prevLs = lineStart(prevEnd);
    cursor = Math.min(prevLs + col, prevEnd);
  }
  function moveDownLine(): void {
    const le = lineEnd(cursor);
    if (le >= buffer.length) return; // last line
    const col = cursor - lineStart(cursor);
    const nextLs = le + 1;
    const nextLe = lineEnd(nextLs);
    cursor = Math.min(nextLs + col, nextLe);
  }

  // ── History navigation ────────────────────────────────────────────────────

  function historyPrev(): void {
    if (hist.length === 0) return;
    if (histIndex === hist.length) draft = buffer;
    if (histIndex > 0) histIndex -= 1;
    buffer = hist[histIndex] ?? "";
    cursor = buffer.length;
  }
  function historyNext(): void {
    if (hist.length === 0 || histIndex === hist.length) return;
    histIndex += 1;
    buffer = histIndex === hist.length ? draft : hist[histIndex] ?? "";
    cursor = buffer.length;
  }

  // ── Submit / newline ──────────────────────────────────────────────────────

  function submit(): void {
    const value = buffer;
    // Advance to a fresh line, leaving the typed input visible above.
    stdout.write("\n");
    void saveHistory(value);
    finish(value);
  }

  function insertNewline(): void {
    insertText("\n");
    render();
  }

  // ── Slash-command autocomplete menu ───────────────────────────────────────
  // The menu is visible only while the user is typing a command NAME: the
  // buffer must start with "/" and contain no spaces / newlines yet. Once a
  // space is typed (entering arguments) the menu dismisses itself.

  function computeMenu(): SlashCommand[] {
    if (!buffer.startsWith("/")) return [];
    if (buffer.includes(" ") || buffer.includes("\n")) return [];
    const q = buffer.toLowerCase();
    const items: SlashCommand[] = [];
    for (const sc of SLASH_COMMANDS) {
      if (sc.name.startsWith(q) || sc.aliases.some((a) => a.startsWith(q))) {
        items.push(sc);
      }
    }
    return items;
  }

  function clampMenuIndex(n: number): void {
    const max = computeMenu().length;
    menuIndex = max === 0 ? 0 : Math.min(Math.max(0, n), max - 1);
  }

  function menuMove(dir: 1 | -1): void {
    const max = computeMenu().length;
    if (max === 0) return;
    menuIndex = (menuIndex + dir + max) % max;
    render();
  }

  /** Replace the buffer with the selected command name + trailing space, then
   *  close the menu. Used by Tab and (when no exact match) Enter. */
  function menuComplete(): void {
    const items = computeMenu();
    if (items.length === 0) return;
    const idx = Math.min(menuIndex, items.length - 1);
    const cmd = items[idx].name;
    buffer = cmd + " ";
    cursor = buffer.length;
    menuIndex = 0;
    render();
  }

  /** True when the typed prefix already resolves to a real command — in that
   *  case Enter should submit immediately instead of completing. */
  function menuExactMatch(): boolean {
    const q = buffer.trim().toLowerCase();
    if (!q) return false;
    return SLASH_COMMANDS.some(
      (sc) => sc.name === q || sc.aliases.includes(q),
    );
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function rowsForLine(prefixW: number, text: string): number {
    const w = prefixW + strWidth(text);
    if (w === 0) return 1;
    const c = cols();
    return Math.max(1, Math.ceil(w / c));
  }

  function render(): void {
    const c = cols();
    stdout.write(HIDE);
    // Return to prompt start (col 0, row 0 of our region).
    if (lastCursorRow > 0) stdout.write(`\r\x1b[${lastCursorRow}A`);
    else stdout.write("\r");
    stdout.write("\x1b[J"); // clear from cursor to end of screen

    const lines = buffer.split("\n");
    let inputRows = 0;
    for (let li = 0; li < lines.length; li++) {
      const prefix = li === 0 ? promptStr : contStr;
      const text = lines[li];
      // Empty first line: draw the friendly placeholder hint (visual only —
      // not part of the buffer; the cursor sits right after the prompt).
      if (li === 0 && buffer.length === 0) {
        stdout.write(prefix + PLACEHOLDER);
      } else {
        stdout.write(prefix + text);
      }
      inputRows += rowsForLine(li === 0 ? promptWidth : contWidth, text);
      if (li < lines.length - 1) stdout.write("\n");
    }

    // ── Slash-command popup menu (below the input) ──
    const menu = computeMenu();
    let menuRows = 0;
    let lastDrawnW = 0; // display width of the very last drawn line (phantom check)
    if (menu.length > 0) {
      clampMenuIndex(menuIndex);
      const idx = Math.min(menuIndex, menu.length - 1);
      // Scroll window so the selection stays visible.
      let start = 0;
      if (idx < Math.floor(MAX_MENU_ROWS / 2)) start = 0;
      else if (idx > menu.length - 1 - Math.ceil(MAX_MENU_ROWS / 2))
        start = Math.max(0, menu.length - MAX_MENU_ROWS);
      else start = idx - Math.floor(MAX_MENU_ROWS / 2);
      const end = Math.min(menu.length, start + MAX_MENU_ROWS);

      // Pad command names to the widest in the visible window (min 10).
      let nameCol = 10;
      for (let k = start; k < end; k++) {
        const w = strWidth(menu[k].name);
        if (w > nameCol) nameCol = w;
      }
      const prefixLen = 4; // "  ❯ " or "    "
      const descAvail = Math.max(0, c - prefixLen - nameCol - 3);

      stdout.write("\n");
      for (let k = start; k < end; k++) {
        const it = menu[k];
        const selected = k === idx;
        const marker = selected ? cCyan("❯ ") : "  ";
        const name = selected ? cBold(cGreen(it.name)) : cGreen(it.name);
        const pad = " ".repeat(Math.max(0, nameCol - strWidth(it.name)));
        let desc = it.desc;
        if (strWidth(desc) > descAvail) {
          // Truncate to descAvail cells (char-by-char to respect wide chars).
          let cells = 0;
          let cut = 0;
          for (const ch of desc) {
            const w = strWidth(ch);
            if (cells + w > descAvail - 1) break;
            cells += w;
            cut++;
          }
          desc = desc.slice(0, cut) + "…";
        }
        const row = `  ${marker}${name}${pad}  ${cGray(desc)}`;
        // Highlight the selected row with inverse video for an obvious pick.
        stdout.write((selected ? cInverse(row) : row) + "\n");
        menuRows++;
      }
      // Hint footer line.
      const footer = "  \u2191 \u2193 to pick · Tab to complete · Enter to run";
      stdout.write(cGray(footer) + "\n");
      menuRows++;
      lastDrawnW = strWidth(footer);
    } else {
      // No menu: the last drawn line is the last input line.
      const lastLine = lines[lines.length - 1];
      const lastPrefixW = lines.length - 1 === 0 ? promptWidth : contWidth;
      lastDrawnW = lastPrefixW + strWidth(lastLine);
    }

    // Compute the cursor's terminal row/col relative to prompt start.
    const before = buffer.slice(0, cursor);
    const beforeLines = before.split("\n");
    const cLine = beforeLines.length - 1;
    const cColText = beforeLines[beforeLines.length - 1];
    const colInLine =
      (cLine === 0 ? promptWidth : contWidth) + strWidth(cColText);

    let crow = 0;
    for (let li = 0; li < cLine; li++) {
      crow += rowsForLine(
        li === 0 ? promptWidth : contWidth,
        lines[li],
      );
    }
    crow += Math.floor(colInLine / c);
    const ccol = colInLine % c;

    // After drawing, the cursor is at the END of the drawn content. Reposition
    // it to (crow, ccol): go to col 0, up to the top of the region, then down
    // to the cursor row and right to the cursor col. The menu lives below the
    // cursor, so it never affects crow/ccol.
    const drawnRows = inputRows + menuRows;
    // The menu rows + footer are each written with a trailing "\n", so when the
    // menu is open the cursor ends on a fresh row BELOW the content (row
    // drawnRows). Without the menu, the last write is the input line itself
    // (no trailing "\n"), so the cursor is at the end of that line — row
    // drawnRows-1, or drawnRows if it exactly fills the terminal width (the
    // cursor then wraps onto a fresh phantom row). Under-counting this up-move
    // leaves the previous render's top line uncleared and the input drifts
    // down a row every keystroke.
    let endRow: number;
    if (menu.length > 0) {
      endRow = drawnRows;
    } else {
      endRow =
        lastDrawnW > 0 && lastDrawnW % c === 0 ? drawnRows : drawnRows - 1;
    }

    stdout.write("\r");
    if (endRow > 0) stdout.write(`\x1b[${endRow}A`);
    if (crow > 0) stdout.write(`\x1b[${crow}B`);
    if (ccol > 0) stdout.write(`\x1b[${ccol}C`);
    lastCursorRow = crow;
    stdout.write(SHOW);
  }

  // ── Key dispatch ──────────────────────────────────────────────────────────

  function onEnter(alt: boolean): void {
    // Backslash + Enter → newline (drop the backslash), like Claude Code.
    if (!alt && cursor > 0 && buffer[cursor - 1] === "\\") {
      buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      cursor -= 1;
      insertNewline();
      return;
    }
    if (alt) {
      insertNewline();
      return;
    }
    // Slash menu open: Enter completes the highlighted command (Claude Code
    // parity) — unless the typed prefix already resolves to a real command,
    // in which case we submit immediately so a fully-typed command still
    // runs with a single Enter.
    if (computeMenu().length > 0) {
      if (menuExactMatch()) {
        submit();
        return;
      }
      menuComplete();
      return;
    }
    submit();
  }

  function onCtrl(ch: string): void {
    switch (ch) {
      case "\x01": // Ctrl+A
        moveLineStart();
        render();
        break;
      case "\x02": // Ctrl+B
        moveLeft();
        render();
        break;
      case "\x03": // Ctrl+C — clear input, or exit if empty.
        if (buffer.length > 0) {
          buffer = "";
          cursor = 0;
          render();
        } else {
          stdout.write("\n");
          finish(null);
        }
        break;
      case "\x04": // Ctrl+D — EOF if empty, else delete forward.
        if (buffer.length === 0) {
          stdout.write("\n");
          finish(null);
        } else {
          deleteForward();
          render();
        }
        break;
      case "\x05": // Ctrl+E
        moveLineEnd();
        render();
        break;
      case "\x06": // Ctrl+F
        moveRight();
        render();
        break;
      case "\x0b": // Ctrl+K — kill to end of line.
        killToEndOfLine();
        render();
        break;
      case "\x0c": // Ctrl+L — clear screen + redraw.
        stdout.write("\x1b[2J\x1b[3J\x1b[H");
        lastCursorRow = 0;
        render();
        break;
      case "\x0e": // Ctrl+N
        moveDownLine();
        render();
        break;
      case "\x10": // Ctrl+P
        moveUpLine();
        render();
        break;
      case "\x15": // Ctrl+U — kill to start of line.
        killToStartOfLine();
        render();
        break;
      case "\x17": // Ctrl+W — delete word back.
        deleteWordBack();
        render();
        break;
      case "\t": // Tab (Ctrl+I) — complete the highlighted slash command.
        if (computeMenu().length > 0) menuComplete();
        break;
      default:
        break; // ignore other Ctrl combos
    }
  }

  function onAlt(ch: string): void {
    switch (ch) {
      case "b":
        moveWordBack();
        render();
        break;
      case "f":
        moveWordForward();
        render();
        break;
      case "d":
        deleteWordForward();
        render();
        break;
      case "\x7f": // Alt+Backspace
      case "\x08":
        deleteWordBack();
        render();
        break;
      default:
        break;
    }
  }

  function onCsi(params: string, final: string): void {
    const ctrl = params.includes(";5") || params.includes(";9");
    const alt = params.includes(";3");

    // `~`-terminated sequences carry their meaning in params (Home/End/Delete/Insert).
    if (final === "~") {
      switch (params) {
        case "1":
        case "7":
          moveLineStart();
          render();
          break;
        case "4":
        case "8":
          moveLineEnd();
          render();
          break;
        case "3": // Delete (forward) — possibly with a modifier
          if (alt) deleteWordForward();
          else deleteForward();
          render();
          break;
        case "200":
          pasting = true;
          pasteBuf = "";
          break;
        case "201":
          pasting = false;
          pasteBuf = "";
          break;
        default:
          break; // 2~ (Insert) and others — ignore
      }
      return;
    }

    switch (final) {
      case "A": // Up
        if (computeMenu().length > 0) {
          menuMove(-1);
        } else {
          if (buffer.indexOf("\n") === -1) historyPrev();
          else moveUpLine();
          render();
        }
        break;
      case "B": // Down
        if (computeMenu().length > 0) {
          menuMove(1);
        } else {
          if (buffer.indexOf("\n") === -1) historyNext();
          else moveDownLine();
          render();
        }
        break;
      case "C": // Right (Ctrl/Alt → word forward)
        if (ctrl || alt) moveWordForward();
        else moveRight();
        render();
        break;
      case "D": // Left (Ctrl/Alt → word back)
        if (ctrl || alt) moveWordBack();
        else moveLeft();
        render();
        break;
      case "H": // Home (xterm / macOS Terminal)
        moveLineStart();
        render();
        break;
      case "F": // End (xterm / macOS Terminal)
        moveLineEnd();
        render();
        break;
      default:
        break;
    }
  }

  // ── Byte-stream parser ────────────────────────────────────────────────────

  function onData(chunk: Buffer): void {
    pending += chunk.toString("utf8");
    let i = 0;

    while (i < pending.length) {
      // If the input was already submitted/cancelled mid-chunk (e.g. Enter
      // landed inside a batched keystroke), stop mutating the dead buffer so
      // trailing bytes don't render garbled output. Remaining bytes are
      // dropped — in real usage each keystroke is its own chunk, and pasted
      // text is handled verbatim by the bracketed-paste branch below.
      if (done) {
        pending = "";
        break;
      }
      // Bracketed-paste body: grab everything until the end marker in one shot.
      if (pasting) {
        const endIdx = pending.indexOf("\x1b[201~", i);
        if (endIdx === -1) {
          pasteBuf += pending.slice(i);
          pending = "";
          break;
        }
        pasteBuf += pending.slice(i, endIdx);
        insertText(pasteBuf);
        pasteBuf = "";
        pasting = false;
        i = endIdx + "\x1b[201~".length;
        render();
        continue;
      }

      const ch = pending[i];
      const code = pending.charCodeAt(i);

      if (ch === "\x1b") {
        if (i + 1 >= pending.length) break; // incomplete ESC — wait for more
        const c1 = pending[i + 1];
        if (c1 === "[") {
          // CSI: scan for a final byte in 0x40–0x7e.
          let j = i + 2;
          while (
            j < pending.length &&
            !(pending.charCodeAt(j) >= 0x40 && pending.charCodeAt(j) <= 0x7e)
          )
            j++;
          if (j >= pending.length) break; // incomplete CSI — wait for more
          const final = pending[j];
          const params = pending.slice(i + 2, j);
          onCsi(params, final);
          i = j + 1;
        } else if (c1 === "\r" || c1 === "\n") {
          onEnter(true); // Alt/Option + Enter → newline
          i += 2;
        } else {
          onAlt(c1);
          i += 2;
        }
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        onEnter(false);
        i += 1;
        continue;
      }

      if (code === 0x7f || code === 0x08) {
        deleteBackward();
        render();
        i += 1;
        continue;
      }

      if (code < 0x20) {
        onCtrl(ch);
        i += 1;
        continue;
      }

      // Printable (UTF-8 already decoded to a JS string char).
      insertText(ch);
      render();
      i += 1;
    }

    pending = pending.slice(i);
  }

  // ── Boot the editor ───────────────────────────────────────────────────────

  stdin.setRawMode?.(true);
  stdin.resume();
  stdout.write(PASTE_ON);
  stdin.on("data", onData);
  render();

  return result;
}