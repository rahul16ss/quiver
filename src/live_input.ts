/**
 * Live type-ahead input during agent runs — pi-style prompt UX.
 *
 * While `agent.prompt()` is streaming, this pins a single-row input editor at
 * the bottom of the screen (via a terminal scroll region) so the user can type
 * their next message *without waiting for the agent to finish* — exactly like
 * pi's always-live input box.
 *
 *   • Type freely → text is captured (not lost) and shown in the bottom row.
 *   • Enter        → queue a follow-up; it is sent as the next turn when the
 *                    current run finishes (routed through the normal REPL loop,
 *                    so slash commands work too).
 *   • Esc          → halt the current operation (abort the LLM stream + ask the
 *                    agent loop to stop). The unsubmitted text is kept and
 *                    pre-filled as the next prompt so the user can edit & send.
 *   • Ctrl+C       → clear the typed text (pi's `app.clear`); on an empty
 *                    buffer, abort the run (reuses the SIGINT handler).
 *
 * Coexistence with streaming output: the bottom row is reserved by setting a
 * DEC scroll region (`\x1b[1;H-1r`). Assistant output / status lines scroll
 * *within* the region and never clobber the input echo. The echo is redrawn
 * with DECSC/DECRC (save/restore cursor) so the streaming output cursor is
 * never disturbed.
 *
 * Coexistence with approval prompts: while a tool approval (clack `text`) is
 * open, the live input suspends — it tears down the scroll region, releases
 * stdin, and lets clack own the full screen — then re-arms when the approval
 * resolves. `suspendLiveInput()` / `resumeLiveInput()` are no-ops when no live
 * input is active, so they are safe to call from every prompt path.
 *
 * Robustness: if anything fails during `start()` (no TTY, tiny terminal, CPR
 * timeout, etc.) `start()` returns `false` and the caller falls back to the
 * legacy intervention-key handler. A thrown error disables the instance for
 * the rest of the run.
 */

import picocolors from "picocolors";
import { supportsColor } from "./cli_ui.js";

export interface LiveInputOptions {
  /** Prompt symbol string (may contain ANSI color codes), e.g. theme().promptUser(). */
  prompt: string;
  /** Called when the user presses Esc to halt the current run. */
  onHalt: () => void;
}

export interface LiveInputState {
  /** Unsubmitted text typed during the run (becomes the pre-filled next prompt). */
  prefill: string;
  /** Messages queued with Enter (sent as subsequent turns). */
  followUps: string[];
}

// ANSI helpers.
const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const SAVE = "\x1b7"; // DECSC — save cursor + attributes
const RESTORE = "\x1b8"; // DECRC — restore cursor + attributes
const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ── Module-level singleton so approval prompts can suspend/resume us. ───────
let activeLiveInput: LiveInput | null = null;

/** Suspend the active live input (if any) so a clack prompt can own stdin. */
export function suspendLiveInput(): void {
  activeLiveInput?.suspend();
}

/** Resume the active live input (if any) after a clack prompt completes. */
export function resumeLiveInput(): void {
  activeLiveInput?.resume();
}

// ── Display-width helper (ANSI-aware, wide-char aware). ─────────────────────
function strWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue; // control / DEL
    if (code >= 0x300 && code <= 0x36f) continue; // combining marks
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

export class LiveInput {
  private readonly stdin = process.stdin as NodeJS.Socket & {
    setRawMode?(mode: boolean): void;
  };
  private readonly stdout = process.stdout;
  private readonly prompt: string;
  private readonly onHalt: () => void;

  private buffer = "";
  private cursor = 0;
  private readonly followUps: string[] = [];

  private started = false;
  private suspended = false;
  private halted = false; // Esc was pressed
  private inputDone = false; // ignore further keystrokes after halt/stop
  private pasting = false;
  private pasteBuf = "";

  private rows = 0;
  private promptWidth = 0;

  private awaitingCPR = false;
  private cprBuf = "";
  private cprResolve:
    | ((p: { row: number; col: number }) => void) | null = null;
  private cprTimer: ReturnType<typeof setTimeout> | null = null;

  // Color helpers (respect NO_COLOR).
  private readonly pc = picocolors;
  private readonly hasColor: boolean;
  private readonly cDim: (x: string) => string;
  private readonly cGray: (x: string) => string;

  constructor(opts: LiveInputOptions) {
    this.prompt = opts.prompt;
    this.onHalt = opts.onHalt;
    this.hasColor = supportsColor(this.stdout);
    this.cDim = (x) => (this.hasColor ? this.pc.dim(x) : x);
    this.cGray = (x) => (this.hasColor ? this.pc.gray(x) : x);
    this.promptWidth = strWidth(this.prompt.replace(ANSI_RE, ""));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Start the live input. Returns false if it cannot run (caller falls back). */
  async start(): Promise<boolean> {
    if (this.stdin.isTTY !== true || this.stdout.isTTY !== true) return false;
    this.rows = this.stdout.rows || 24;
    if (this.rows < 4) return false; // too tiny to reserve a row

    try {
      // Attach the key parser first so the CPR response is captured.
      this.stdin.setRawMode?.(true);
      this.stdin.resume();
      this.stdout.write(PASTE_ON);
      this.stdin.on("data", this.onData);

      // Query the cursor position (awaited *before* the agent streams) so we
      // can set the scroll region without jumping the output cursor or
      // clobbering existing content. A terminal that doesn't answer CPR gets
      // a safe default after 300ms.
      const pos = await this.queryCursor();
      this.setupRegion(pos);
      return true;
    } catch {
      this.disable();
      return false;
    }
  }

  /** Tear down the live input and return buffered/queued text. */
  stop(): LiveInputState {
    if (!this.started) {
      // start() failed or is mid-setup; make sure we're not the active instance.
      if (activeLiveInput === this) activeLiveInput = null;
      return { prefill: "", followUps: [] };
    }
    this.cleanup();
    return {
      prefill: this.buffer,
      followUps: this.halted ? [] : this.followUps.slice(),
    };
  }

  // ── Internal: setup / teardown ───────────────────────────────────────────

  private queryCursor(): Promise<{ row: number; col: number }> {
    return new Promise((resolve) => {
      this.awaitingCPR = true;
      this.cprBuf = "";
      this.cprResolve = resolve;
      this.stdout.write("\x1b[6n");
      if (this.cprTimer) clearTimeout(this.cprTimer);
      this.cprTimer = setTimeout(() => {
        if (this.awaitingCPR) {
          this.awaitingCPR = false;
          this.cprResolve = null;
          resolve({ row: 1, col: 1 });
        }
      }, 300);
    });
  }

  private setupRegion(pos: { row: number; col: number }): void {
    try {
      const H = this.rows;
      // Set scroll region to rows 1..H-1 (reserving row H for the input echo).
      // DECSTBM homes the cursor, so we restore the output cursor afterwards.
      this.stdout.write(SAVE + `\x1b[1;${H - 1}r` + RESTORE);

      if (pos.row >= H) {
        // Cursor was on/below the reserved row: move to the bottom of the
        // region and emit a newline so the region scrolls up one line, leaving
        // a fresh line at H-1 for the next output (no content is lost).
        this.stdout.write(`\x1b[${H - 1};1H\n`);
      } else {
        // Output continues exactly where it was.
        this.stdout.write(`\x1b[${pos.row};${Math.max(1, pos.col)}H`);
      }

      this.started = true;
      activeLiveInput = this;
      this.stdout.write(HIDE);
      this.renderEcho();
    } catch {
      this.disable();
    }
  }

  /** Permanently disable (on error) and clean up. */
  private disable(): void {
    this.started = false;
    this.inputDone = true;
    if (activeLiveInput === this) activeLiveInput = null;
    try {
      this.stdin.removeListener("data", this.onData);
    } catch {
      /* ignore */
    }
    try {
      this.stdout.write(PASTE_OFF + SHOW);
    } catch {
      /* ignore */
    }
    try {
      this.resetRegion();
    } catch {
      /* ignore */
    }
  }

  private cleanup(): void {
    this.started = false;
    this.inputDone = true;
    if (activeLiveInput === this) activeLiveInput = null;
    try {
      this.stdin.removeListener("data", this.onData);
    } catch {
      /* ignore */
    }
    try {
      this.stdout.write(PASTE_OFF);
    } catch {
      /* ignore */
    }
    try {
      this.resetRegion();
    } catch {
      /* ignore */
    }
    try {
      // Leave raw mode on (the main readline / next editLine expect it).
      this.stdin.setRawMode?.(true);
    } catch {
      /* ignore */
    }
    try {
      this.stdin.resume();
    } catch {
      /* ignore */
    }
    try {
      this.stdout.write(SHOW);
    } catch {
      /* ignore */
    }
  }

  /** Restore full-screen scroll region + clear the echo row. */
  private resetRegion(): void {
    const H = this.rows || this.stdout.rows || 24;
    // Save the output cursor, clear the reserved echo row, restore, then
    // reset the region to the full screen and restore again.
    this.stdout.write(SAVE);
    this.stdout.write(`\x1b[${H};1H\x1b[2K`);
    this.stdout.write(RESTORE);
    this.stdout.write(`\x1b[1;${H}r`);
    this.stdout.write(RESTORE);
  }

  // ── Suspend / resume (for approval prompts) ──────────────────────────────

  suspend(): void {
    if (!this.started || this.suspended) return;
    this.suspended = true;
    try {
      // Release the bottom row + scroll region so clack has the full screen.
      this.stdout.write(SAVE);
      const H = this.rows;
      this.stdout.write(`\x1b[${H};1H\x1b[2K`);
      this.stdout.write(RESTORE);
      this.stdout.write(`\x1b[1;${H}r`);
      this.stdout.write(RESTORE);
      this.stdout.write(SHOW);
      this.stdin.removeListener("data", this.onData);
      this.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    if (!this.started || !this.suspended) return;
    this.suspended = false;
    try {
      this.stdin.setRawMode?.(true);
      this.stdin.on("data", this.onData);
      // Re-establish the scroll region (preserving the output cursor).
      const H = this.rows;
      this.stdout.write(SAVE + `\x1b[1;${H - 1}r` + RESTORE);
      this.stdout.write(HIDE);
      this.renderEcho();
    } catch {
      /* ignore */
    }
  }

  // ── Buffer mutations (single-line editor subset) ──────────────────────────

  private insertText(s: string): void {
    this.buffer = this.buffer.slice(0, this.cursor) + s + this.buffer.slice(this.cursor);
    this.cursor += s.length;
  }
  private deleteBackward(): void {
    if (this.cursor <= 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor -= 1;
  }
  private deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
  }
  private deleteWordBack(): void {
    let i = this.cursor;
    while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
    while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
    this.buffer = this.buffer.slice(0, i) + this.buffer.slice(this.cursor);
    this.cursor = i;
  }
  private killToEndOfLine(): void {
    this.buffer = this.buffer.slice(0, this.cursor);
  }
  private killToStartOfLine(): void {
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
  }
  private moveLeft(): void {
    if (this.cursor > 0) this.cursor -= 1;
  }
  private moveRight(): void {
    if (this.cursor < this.buffer.length) this.cursor += 1;
  }
  private moveLineStart(): void {
    this.cursor = 0;
  }
  private moveLineEnd(): void {
    this.cursor = this.buffer.length;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  private queueFollowUp(): void {
    const v = this.buffer;
    if (v.trim().length === 0) return; // ignore empty Enter
    this.followUps.push(v);
    this.buffer = "";
    this.cursor = 0;
    this.renderEcho();
  }

  private halt(): void {
    if (this.halted || this.inputDone) return;
    this.halted = true;
    this.inputDone = true;
    try {
      this.onHalt();
    } catch {
      /* ignore */
    }
    // Clear the echo row so the halt is visually clean; the run will end and
    // stop() does the full teardown.
    try {
      const H = this.rows;
      this.stdout.write(SAVE + `\x1b[${H};1H\x1b[2K` + RESTORE);
    } catch {
      /* ignore */
    }
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  private renderEcho(): void {
    if (!this.started || this.suspended) return;
    const H = this.rows;
    const cols = this.stdout.columns || 80;

    // The visible text = last line of the buffer (type-ahead is single-row).
    const lastLine = this.buffer.slice(this.buffer.lastIndexOf("\n") + 1);
    const queueSuffix = this.followUps.length
      ? this.cGray(`  · ${this.followUps.length} queued`)
      : "";
    const queueW = strWidth(queueSuffix.replace(ANSI_RE, ""));
    const avail = Math.max(0, cols - this.promptWidth - queueW - 1);

    let visible: string;
    if (this.buffer.length === 0) {
      visible = this.cDim("type to queue a follow-up  ·  Esc to halt");
      // placeholder isn't part of the buffer; keep it within width
      if (strWidth(visible.replace(ANSI_RE, "")) > avail) {
        visible = visible.slice(0, Math.max(0, avail));
      }
    } else {
      const lineW = strWidth(lastLine);
      if (lineW <= avail) {
        visible = lastLine;
      } else {
        // Show the tail (what the user is currently typing) with an ellipsis.
        let cells = 0;
        let start = lastLine.length;
        while (start > 0 && cells < avail - 1) {
          start--;
          cells += strWidth(lastLine[start]);
        }
        visible = "…" + lastLine.slice(start + 1);
      }
    }

    this.stdout.write(SAVE);
    this.stdout.write(`\x1b[${H};1H\x1b[2K`);
    this.stdout.write(this.prompt + visible + queueSuffix);
    this.stdout.write(RESTORE);
  }

  // ── Key dispatch ─────────────────────────────────────────────────────────

  private onEnter(alt: boolean): void {
    if (alt) {
      this.insertText("\n");
      this.renderEcho();
      return;
    }
    this.queueFollowUp();
  }

  private onCtrl(ch: string): void {
    switch (ch) {
      case "\x01": // Ctrl+A
        this.moveLineStart();
        break;
      case "\x05": // Ctrl+E
        this.moveLineEnd();
        break;
      case "\x02": // Ctrl+B
        this.moveLeft();
        break;
      case "\x06": // Ctrl+F
        this.moveRight();
        break;
      case "\x0b": // Ctrl+K
        this.killToEndOfLine();
        break;
      case "\x15": // Ctrl+U
        this.killToStartOfLine();
        break;
      case "\x17": // Ctrl+W
        this.deleteWordBack();
        break;
      case "\x03": // Ctrl+C — clear buffer (pi `app.clear`), or halt if empty.
        if (this.buffer.length > 0) {
          this.buffer = "";
          this.cursor = 0;
        } else {
          this.halt();
          return;
        }
        break;
      case "\x04": // Ctrl+D — halt if empty, else delete forward.
        if (this.buffer.length === 0) {
          this.halt();
          return;
        }
        this.deleteForward();
        break;
      case "\x0c": // Ctrl+L — clear screen, re-establish region + echo.
        this.stdout.write("\x1b[2J\x1b[3J\x1b[H");
        const Hc = this.rows;
        this.stdout.write(`\x1b[1;${Hc - 1}r`);
        this.renderEcho();
        return; // already rendered
      default:
        return; // ignore other Ctrl combos
    }
    this.renderEcho();
  }

  private onAlt(ch: string): void {
    switch (ch) {
      case "b":
        // move word back
        {
          let i = this.cursor;
          while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
          while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
          this.cursor = i;
        }
        break;
      case "f":
        // move word forward
        {
          let i = this.cursor;
          while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
          while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
          this.cursor = i;
        }
        break;
      case "d":
        {
          let i = this.cursor;
          while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
          while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(i);
        }
        break;
      case "\x7f": // Alt+Backspace
      case "\x08":
        this.deleteWordBack();
        break;
      default:
        return;
    }
    this.renderEcho();
  }

  private onCsi(params: string, final: string): void {
    const ctrl = params.includes(";5") || params.includes(";9");
    const alt = params.includes(";3");
    if (final === "~") {
      switch (params) {
        case "1":
        case "7":
          this.moveLineStart();
          break;
        case "4":
        case "8":
          this.moveLineEnd();
          break;
        case "3": // Delete
          if (alt) {
            let i = this.cursor;
            while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
            while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
            this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(i);
          } else this.deleteForward();
          break;
        case "200":
          this.pasting = true;
          this.pasteBuf = "";
          return; // no render
        case "201":
          this.pasting = false;
          this.pasteBuf = "";
          return; // no render
        default:
          return;
      }
      this.renderEcho();
      return;
    }
    switch (final) {
      case "A": // Up — ignored in single-row echo
      case "B": // Down
        return;
      case "C":
        if (ctrl || alt) {
          let i = this.cursor;
          while (i < this.buffer.length && /\s/.test(this.buffer[i])) i++;
          while (i < this.buffer.length && !/\s/.test(this.buffer[i])) i++;
          this.cursor = i;
        } else this.moveRight();
        break;
      case "D":
        if (ctrl || alt) {
          let i = this.cursor;
          while (i > 0 && /\s/.test(this.buffer[i - 1])) i--;
          while (i > 0 && !/\s/.test(this.buffer[i - 1])) i--;
          this.cursor = i;
        } else this.moveLeft();
        break;
      case "H":
        this.moveLineStart();
        break;
      case "F":
        this.moveLineEnd();
        break;
      default:
        return;
    }
    this.renderEcho();
  }

  // ── Byte-stream parser ───────────────────────────────────────────────────

  private onData = (chunk: Buffer): void => {
    let s = chunk.toString("utf8");

    // Intercept the cursor-position report (CPR) from start().
    if (this.awaitingCPR) {
      this.cprBuf += s;
      const m = this.cprBuf.match(/\x1b\[(\d+);(\d+)R/);
      if (m) {
        this.awaitingCPR = false;
        if (this.cprTimer) {
          clearTimeout(this.cprTimer);
          this.cprTimer = null;
        }
        const leftover = this.cprBuf.replace(/\x1b\[\d+;\d+R/, "");
        this.cprBuf = "";
        const resolve = this.cprResolve;
        this.cprResolve = null;
        if (resolve) resolve({ row: parseInt(m[1], 10), col: parseInt(m[2], 10) });
        s = leftover;
        if (s.length === 0) return;
      } else {
        return; // wait for the rest of the CPR
      }
    }
    // Strip any stray CPR that arrives later.
    s = s.replace(/\x1b\[\d+;\d+R/g, "");

    if (this.inputDone || this.suspended) return;

    let i = 0;
    while (i < s.length) {
      if (this.inputDone) break;

      // Bracketed-paste body: grab until the end marker.
      if (this.pasting) {
        const endIdx = s.indexOf("\x1b[201~", i);
        if (endIdx === -1) {
          this.pasteBuf += s.slice(i);
          break;
        }
        this.pasteBuf += s.slice(i, endIdx);
        this.insertText(this.pasteBuf);
        this.pasteBuf = "";
        this.pasting = false;
        i = endIdx + "\x1b[201~".length;
        this.renderEcho();
        continue;
      }

      const ch = s[i];
      const code = s.charCodeAt(i);

      if (ch === "\x1b") {
        if (i + 1 >= s.length) {
          // Lone Esc (real CSI/Alt sequences arrive with their following bytes
          // in the same chunk). Treat a trailing Esc as a halt keypress.
          this.halt();
          return;
        }
        const c1 = s[i + 1];
        if (c1 === "[") {
          let j = i + 2;
          while (
            j < s.length &&
            !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)
          )
            j++;
          if (j >= s.length) break; // incomplete CSI — wait
          const final = s[j];
          const params = s.slice(i + 2, j);
          this.onCsi(params, final);
          i = j + 1;
        } else if (c1 === "\r" || c1 === "\n") {
          this.onEnter(true); // Alt/Option + Enter → newline
          i += 2;
        } else {
          this.onAlt(c1);
          i += 2;
        }
        continue;
      }

      if (ch === "\r" || ch === "\n") {
        this.onEnter(false);
        i += 1;
        continue;
      }

      if (code === 0x7f || code === 0x08) {
        this.deleteBackward();
        this.renderEcho();
        i += 1;
        continue;
      }

      if (code < 0x20) {
        this.onCtrl(ch);
        i += 1;
        continue;
      }

      // Printable.
      this.insertText(ch);
      this.renderEcho();
      i += 1;
    }
  };
}