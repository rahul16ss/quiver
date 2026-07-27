/**
 * Full-screen TUI shell — a persistent layout with a scrolling transcript and a
 * pinned input box, replacing the scrolling-REPL-with-overlay model.
 *
 * Layout (top → bottom):
 *   ┌─────────────────────────────────────┐
 *   │  transcript (scrolls as content grows) │  ← agent output, tool cards, status
 *   │  ...                                  │
 *   ├─────────────────────────────────────┤
 *   │  status bar (1 line, dim)            │  ← model · context% · mode
 *   ├─────────────────────────────────────┤
 *   │  ❯ input box (grows to 3 lines)       │  ← always editable, always visible
 *   └─────────────────────────────────────┘
 *
 * The transcript is a ring buffer of rendered lines; only the last screen-height
 * worth is visible. The input box is pinned at the bottom via cursor save/restore
 * + absolute positioning (no DEC scroll region — that hack fights with raw-mode
 * editors). The status bar sits between them.
 *
 * Integration: the CLI enters the TUI once at startup (`tui.enter()`), writes
 * agent output to `tui.write()` (transcript), and reads user input from
 * `tui.readInput()` (the pinned box). Slash commands and approvals still render
 * to the transcript. On exit, `tui.leave()` restores the terminal.
 *
 * Non-TTY / JSON / single-turn: never enters the TUI — the CLI gates on
 * `process.stdout.isTTY` as before.
 */

import picocolors from "picocolors";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { theme, type QuiverTheme, supportsColor } from "./cli_ui.js";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const CLEAR = "\x1b[2J";
const HOME = "\x1b[H";
const CLEAR_LINE = "\x1b[2K";
const CURSOR_UP = (n: number) => `\x1b[${n}A`;
const CURSOR_DOWN = (n: number) => `\x1b[${n}B`;
const SCROLL_UP = (n: number) => `\x1b[${n}S`;
const CLEAR_BELOW = "\x1b[J";

export interface TuiOptions {
  model: string;
  modeSuffix?: string;
}

interface TranscriptLine {
  text: string; // may contain ANSI
  width: number; // display width (ANSI-stripped)
}

export class Tui {
  private readonly stdout = process.stdout;
  private readonly rawWrite: typeof process.stdout.write;
  private readonly stdin = process.stdin as NodeJS.Socket & {
    setRawMode?(mode: boolean): void;
  };
  private readonly t: QuiverTheme;
  private entered = false;
  private transcript: TranscriptLine[] = [];
  private inputBuffer = "";
  private inputCursor = 0; // index into inputBuffer
  private statusText = "";
  private rows = 40;
  private cols = 80;
  private inputMaxRows = 3;
  private inputRows = 1;
  private onSend: ((text: string) => void) | null = null;
  private onHalt: (() => void) | null = null;
  private rawMode = false;
  private history: string[] = [];
  private historyIdx = -1;
  private pasteMode = false;

  constructor(opts: TuiOptions) {
    this.t = theme();
    this.statusText = opts.model + (opts.modeSuffix ?? "");
    // Capture the real write BEFORE cli.ts intercepts process.stdout.write,
    // so render() and leave() write directly to the terminal without
    // re-entering tui.write() (which would infinite-recurse).
    this.rawWrite = process.stdout.write.bind(process.stdout);
    this.refreshSize();
  }

  /** Enter full-screen mode. Captures the terminal, renders the initial layout,
   *  and starts listening to stdin for the input box. */
  enter(): void {
    if (this.entered || !this.stdout.isTTY) return;
    this.entered = true;
    this.refreshSize();
    this.rawWrite(HIDE + CLEAR + HOME);
    this.render();
    this.startRawInput();
  }

  /** Leave full-screen mode. Restores the terminal. */
  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.stopRawInput();
    this.rawWrite(SHOW + RESTORE + "\n");
  }

  /** Write text to the transcript region (agent output, tool cards, etc.). */
  write(text: string): void {
    if (!this.entered) {
      this.rawWrite(text);
      return;
    }
    const lines = text.split("\n");
    for (const line of lines) {
      const wrapped = wrapAnsi(line, this.cols, { hard: true }).split("\n");
      for (const w of wrapped) {
        this.transcript.push({ text: w, width: stringWidth(w) });
      }
    }
    this.render();
  }

  /** Write a line to the transcript (convenience). */
  writeLine(text: string = ""): void {
    this.write(text + "\n");
  }

  /** Update the status bar text. */
  setStatus(text: string): void {
    this.statusText = text;
    if (this.entered) this.render();
  }

  /** Set callbacks. */
  setHandlers(onSend: (text: string) => void, onHalt: () => void): void {
    this.onSend = onSend;
    this.onHalt = onHalt;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  private refreshSize(): void {
    this.rows = Math.max(10, this.stdout.rows || 40);
    this.cols = Math.max(40, this.stdout.columns || 80);
  }

  private render(): void {
    if (!this.entered) return;
    this.refreshSize();
    const statusBarRows = 1;
    const inputRegionRows = this.inputRows;
    const transcriptRows = Math.max(1, this.rows - statusBarRows - inputRegionRows - 1);

    // Render from top: clear screen, home, draw transcript lines, then status,
    // then input box. We use absolute cursor positioning so the input box is
    // always pinned at the bottom regardless of transcript length.
    this.rawWrite(HIDE + HOME + CLEAR);

    // Transcript: last N lines
    const visible = this.transcript.slice(-transcriptRows);
    for (const line of visible) {
      this.rawWrite(line.text + "\n");
    }

    // Status bar (1 row)
    this.rawWrite(this.t.muted("─".repeat(this.cols)) + "\n");
    const status = this.t.muted(this.statusText);
    this.rawWrite(status + "\n");

    // Input box (pinned at bottom)
    this.rawWrite(this.t.muted("─".repeat(this.cols)) + "\n");
    this.renderInputBox();
    this.rawWrite(SHOW);
  }

  private renderInputBox(): void {
    const promptSym = this.t.bold(this.t.cyan("❯ "));
    const display = this.inputBuffer;
    // Wrap input to inputMaxRows
    const wrapped = wrapAnsi(display, this.cols - 2, { hard: true }).split("\n");
    this.inputRows = Math.max(1, Math.min(this.inputMaxRows, wrapped.length));
    // Render the visible input lines
    for (let i = 0; i < this.inputRows; i++) {
      const prefix = i === 0 ? promptSym : "  ";
      this.rawWrite(prefix + (wrapped[i] || "") + CLEAR_LINE + "\n");
    }
  }

  // ── Input handling (raw mode) ────────────────────────────────────────

  private startRawInput(): void {
    if (!this.stdin.setRawMode) return;
    try {
      // readline may have left stdin paused; resume so our data listener fires.
      this.stdin.resume();
      this.stdin.setRawMode(true);
      this.rawMode = true;
      this.stdin.setEncoding("utf8");
      // Remove any stale data listeners (e.g. readline's) so we get every byte.
      this.stdin.removeAllListeners("data");
      this.stdin.on("data", this.onData);
    } catch {
      // Non-interactive fallback
    }
  }

  private stopRawInput(): void {
    if (!this.rawMode) return;
    try {
      this.stdin.setRawMode?.(false);
    } catch {
      // ignore
    }
    this.stdin.removeListener("data", this.onData);
    this.rawMode = false;
  }

  private onData = (data: Buffer | string): void => {
    const str = typeof data === "string" ? data : data.toString("utf8");
    for (const ch of str) {
      this.handleChar(ch, str);
    }
  };

  private handleChar(ch: string, full: string): void {
    const code = ch.codePointAt(0)!;
    // Enter
    if (ch === "\r" || ch === "\n") {
      if (this.inputBuffer.trim().length > 0) {
        this.history.push(this.inputBuffer);
        this.historyIdx = this.history.length;
        this.onSend?.(this.inputBuffer);
        this.inputBuffer = "";
        this.inputCursor = 0;
        this.render();
      }
      return;
    }
    // Ctrl+C
    if (code === 3) {
      if (this.inputBuffer.length === 0) {
        this.onHalt?.();
      } else {
        this.inputBuffer = "";
        this.inputCursor = 0;
        this.render();
      }
      return;
    }
    // Ctrl+D (EOF)
    if (code === 4) {
      if (this.inputBuffer.length === 0) {
        this.onHalt?.();
      }
      return;
    }
    // Esc
    if (code === 27) {
      this.onHalt?.();
      return;
    }
    // Backspace
    if (code === 127 || code === 8) {
      if (this.inputCursor > 0) {
        this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor - 1) + this.inputBuffer.slice(this.inputCursor);
        this.inputCursor--;
        this.render();
      }
      return;
    }
    // Up arrow: history
    if (full.includes("\x1b[A")) {
      if (this.historyIdx > 0) {
        this.historyIdx--;
        this.inputBuffer = this.history[this.historyIdx] ?? "";
        this.inputCursor = this.inputBuffer.length;
        this.render();
      }
      return;
    }
    // Down arrow: history
    if (full.includes("\x1b[B")) {
      if (this.historyIdx < this.history.length - 1) {
        this.historyIdx++;
        this.inputBuffer = this.history[this.historyIdx] ?? "";
      } else {
        this.historyIdx = this.history.length;
        this.inputBuffer = "";
      }
      this.inputCursor = this.inputBuffer.length;
      this.render();
      return;
    }
    // Printable char
    if (code >= 0x20 && code !== 0x7f) {
      this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + ch + this.inputBuffer.slice(this.inputCursor);
      this.inputCursor += String(ch).length;
      this.render();
      return;
    }
  }
}