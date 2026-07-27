/**
 * Terminal markdown renderer for streamed assistant output (UX: Seeing).
 *
 * Hand-rolled line-buffered streaming renderer. Handles headings (level-aware),
 * bold/italic/strike/inline-code/links (URL preserved), blockquotes, ordered/
 * unordered lists (indent-aware for nesting), horizontal rules, GFM tables,
 * and fenced code blocks with a left rail. Long lines wrap at the terminal
 * width via wrap-ansi so nothing overflows.
 *
 * Design tenets (aligned with the spec's trust pillars & accessibility):
 *  - **Content-preserving.** Markdown markers are stripped/translated, the
 *    text they wrap is always emitted — nothing is ever dropped. Unclosed or
 *    ambiguous constructs fall through to verbatim output.
 *  - **Line-buffered streaming.** Lines render as they complete (on `\n`), a
 *    partial line is held until the next newline / `flush()` (US-2.2).
 *  - **Color is optional.** All color goes through `theme()` (cli_ui), which
 *    honours NO_COLOR / non-TTY / FORCE_COLOR. Structural transforms
 *    (stripping `**`, framing code blocks, list indentation) are layout, not
 *    color, so they still apply in monochrome.
 *  - **TTY-gated at the call site.** The CLI only instantiates this when
 *    stdout is a TTY (interactive), so piped / JSON / CI output stays raw.
 */

import { theme, type QuiverTheme, supportsColor } from "./cli_ui.js";
import wrapAnsi from "wrap-ansi";
import stringWidth from "string-width";

type WriteStream = NodeJS.WriteStream;

export class TerminalMarkdownRenderer {
  private readonly stream: WriteStream;
  private readonly t: QuiverTheme;
  private buffer = "";
  private inCode = false;
  private codeLang = "";
  /** Pending GFM table rows (collected then rendered when the table ends). */
  private tableRows: { cells: string[]; align: ("left" | "center" | "right")[] | null }[] = [];

  constructor(stream: WriteStream = process.stdout) {
    this.stream = stream;
    this.t = theme(stream);
  }

  private get width(): number {
    const cols = this.stream.columns && this.stream.columns > 0 ? this.stream.columns : 80;
    return Math.max(40, cols - 2);
  }

  /** Feed a chunk of streamed text. Completed lines are rendered immediately;
   *  any trailing partial line is buffered until the next newline / flush(). */
  push(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.renderLine(line);
    }
  }

  /** Emit any buffered partial line at end-of-stream. */
  flush(): void {
    if (this.tableRows.length > 0) {
      this.flushTable();
    }
    if (this.buffer.length > 0 || this.inCode) {
      this.renderLine(this.buffer);
      this.buffer = "";
      if (this.inCode) {
        this.stream.write(this.t.muted("  └") + "\n");
        this.inCode = false;
        this.codeLang = "";
      }
    }
  }

  private renderLine(line: string): void {
    // ── Inside a fenced code block ──
    if (this.inCode) {
      if (/^```/.test(line.trimStart())) {
        this.stream.write(this.t.muted("  └") + "\n");
        this.inCode = false;
        this.codeLang = "";
        return;
      }
      // Preserve verbatim; no wrapping inside code fences.
      this.stream.write(this.t.muted("  │ ") + this.t.cyan(line) + "\n");
      return;
    }

    // ── GFM table row collection ──
    // A table is: a header row, a delimiter row (|---|---|), then body rows.
    // We collect until a blank line / non-table line, then flush.
    if (this.tableRows.length > 0) {
      if (line.trim() === "" || !/\|/.test(line)) {
        this.flushTable();
      } else {
        const isDelim = /^\s*\|?\s*:?-{2,}/.test(line);
        if (!isDelim && this.tableRows.length >= 1) {
          const cells = this.splitTableRow(line);
          this.tableRows.push({ cells, align: null });
          return;
        }
        return;
      }
    }

    // ── Opening fence ──
    const fence = line.match(/^```(\w[\w-]*)?\s*$/);
    if (fence) {
      this.inCode = true;
      this.codeLang = fence[1] ?? "";
      const label = this.codeLang || "code";
      this.stream.write(this.t.muted(`  ┌ ${label}`) + "\n");
      return;
    }

    // ── Block elements ──
    let m: RegExpMatchArray | null;

    // Headings — level-aware weight (h1 bold cyan, h2 bold, h3 dim bold, h4+ dim)
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const level = m[1].length;
      const text = m[2].replace(/\s+#+\s*$/, "");
      const inline = this.inline(text);
      if (level === 1) this.stream.write(this.t.bold(this.t.cyan(inline)) + "\n");
      else if (level === 2) this.stream.write(this.t.bold(inline) + "\n");
      else if (level === 3) this.stream.write(this.t.bold(this.t.dim(inline)) + "\n");
      else this.stream.write(this.t.dim(inline) + "\n");
      return;
    }

    if ((m = line.match(/^\s{0,3}>\s?(.*)$/))) {
      const text = m[1];
      this.stream.write(
        this.t.muted("  │ ") + this.t.dim(this.t.italic(this.inline(text))) + "\n",
      );
      return;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      this.stream.write(this.t.muted("  " + "─".repeat(Math.min(40, this.width - 2))) + "\n");
      return;
    }

    // Lists — indent-aware (every 2 spaces of indent = one nesting level)
    if ((m = line.match(/^(\s*)([-*+])\s+(.*)$/))) {
      const indent = m[1];
      const level = Math.floor(indent.length / 2);
      const text = m[3];
      const bullet = level === 0 ? this.t.cyan("•") : this.t.muted("◦");
      this.stream.write(
        `${indent}${bullet} ${this.inlineAndWrap(text, indent.length + 2)}\n`,
      );
      return;
    }
    if ((m = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      const indent = m[1];
      const num = m[2];
      const text = m[3];
      this.stream.write(
        `${indent}${this.t.muted(`${num}.`)} ${this.inlineAndWrap(text, indent.length + num.length + 2)}\n`,
      );
      return;
    }

    // GFM table start — header row with a following delimiter row is detected
    // only when flush() processes the delimiter; here we just collect if it
    // looks like a table row and we're not already collecting.
    if (/\|/.test(line) && this.tableRows.length === 0 && line.trim().length > 0) {
      const cells = this.splitTableRow(line);
      // Heuristic: a table header has at least one pipe and at least 1 cell.
      if (cells.length >= 1) {
        this.tableRows.push({ cells, align: null });
        return;
      }
    }

    // Task list checkboxes — [ ] / [x]
    if ((m = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/))) {
      const indent = m[1];
      const checked = m[2].toLowerCase() === "x";
      const text = m[3];
      const box = checked ? this.t.success("✓") : this.t.muted("◻");
      this.stream.write(`${indent}${box} ${this.inline(text)}\n`);
      return;
    }

    // Plain paragraph line — wrap long lines at the terminal width.
    if (line.trim().length > 0) {
      this.stream.write(this.inlineAndWrap(line, 0) + "\n");
      return;
    }
    // Empty line preserves spacing.
    this.stream.write("\n");
  }

  /** Inline markdown + wrap to width, preserving the indent for continuation. */
  private inlineAndWrap(text: string, indent: number): string {
    const styled = this.inline(text);
    const wrapWidth = Math.max(20, this.width - indent);
    const wrapped = wrapAnsi(styled, wrapWidth, { hard: true });
    const pad = " ".repeat(indent);
    return wrapped.split("\n").map((l, i) => i === 0 ? l : pad + l).join("\n");
  }

  /** GFM table row split (handles leading/trailing pipes, escaped pipes). */
  private splitTableRow(line: string): string[] {
    let s = line.trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
    return s.split(/\s*\|\s*/).map((c) => c.trim());
  }

  private flushTable(): void {
    const rows = this.tableRows;
    this.tableRows = [];
    if (rows.length === 0) return;
    const colCount = Math.max(...rows.map((r) => r.cells.length));
    // Pad rows to colCount
    const norm: string[][] = rows.map((r) => {
      const c = [...r.cells];
      while (c.length < colCount) c.push("");
      return c;
    });
    // Compute column widths (display width, ANSI-stripped via stringWidth on
    // the unstyled text — approximate but stable for ASCII-heavy tables).
    const widths: number[] = [];
    for (let c = 0; c < colCount; c++) {
      widths[c] = Math.max(3, ...norm.map((r) => stringWidth(r[c] || "")));
    }
    const sep = "│";
    const renderRow = (cells: string[], isHeader: boolean) => {
      const out = cells.map((cell, i) => {
        const s = this.inline(cell);
        const pad = " ".repeat(Math.max(0, widths[i] - stringWidth(cell)));
        const left = isHeader ? this.t.bold(s) : s;
        return ` ${left}${pad} `;
      }).join(sep);
      this.stream.write("  " + sep + out + sep + "\n");
    };
    // Header
    renderRow(norm[0], true);
    // Separator
    this.stream.write("  " + sep + widths.map((w) => "─".repeat(w + 2)).join(sep) + sep + "\n");
    // Body
    for (let i = 1; i < norm.length; i++) renderRow(norm[i], false);
  }

  /** Apply inline markdown formatting (code, bold, italic, strike, links).
   *  Links render as `text (url)` so the URL is preserved (the old renderer
   *  dropped it). Anything unmatched is emitted verbatim — content is never
   *  lost. */
  private inline(text: string): string {
    if (!text) return text;
    const pattern =
      /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*]+\*)|(_[^_]+_)/g;
    let out = "";
    let last = 0;
    let mm: RegExpExecArray | null;
    while ((mm = pattern.exec(text))) {
      out += text.slice(last, mm.index);
      last = mm.index + mm[0].length;
      const tok = mm[0];
      if (tok.startsWith("`")) {
        out += this.t.cyan(tok.slice(1, -1));
      } else if (tok.startsWith("**")) {
        out += this.t.bold(tok.slice(2, -2));
      } else if (tok.startsWith("__")) {
        out += this.t.bold(tok.slice(2, -2));
      } else if (tok.startsWith("~~")) {
        out += this.t.strikethrough(tok.slice(2, -2));
      } else if (tok.startsWith("[")) {
        const lm = tok.match(/^\[([^\]]*)\]\(([^)]+)\)$/);
        if (lm) {
          const label = lm[1] || lm[2];
          const url = lm[2];
          // Show the label underlined; append the URL dim if it differs.
          if (label === url || label.length === 0) {
            out += this.t.underline(url);
          } else {
            out += this.t.underline(label) + this.t.muted(` (${url})`);
          }
        } else {
          out += tok;
        }
      } else if (tok.startsWith("*")) {
        out += this.t.italic(tok.slice(1, -1));
      } else if (tok.startsWith("_")) {
        out += this.t.italic(tok.slice(1, -1));
      } else {
        out += tok;
      }
    }
    out += text.slice(last);
    return out;
  }
}