/**
 * Terminal markdown renderer for streamed assistant output (UX: Seeing).
 *
 * The model emits raw markdown; this renders it to the terminal as the stream
 * arrives so the user reads formatted prose (headings, bold/italic, inline
 * code, framed code blocks, blockquotes, lists) instead of `**raw** markers.
 *
 * Design tenets (aligned with the spec's trust pillars & accessibility):
 *  - **Content-preserving.** Markdown *markers* are stripped/translated, the
 *    text they wrap is always emitted — nothing is ever dropped. Unclosed or
 *    ambiguous constructs fall through to verbatim output rather than being
 *    mangled.
 *  - **Line-buffered streaming.** Lines are rendered as they complete (on
 *    `\n`), preserving the live streaming feel (US-2.2). A partial line is
 *    held until it completes or the stream ends (`flush()`).
 *  - **Color is optional.** All color goes through `theme()` (cli_ui), which
 *    honours `NO_COLOR` / non-TTY / `FORCE_COLOR`. The structural transforms
 *    (stripping `**`, framing code blocks) are layout, not color, so they
 *    still apply in monochrome — matching how Claude Code renders markdown
 *    without color.
 *  - **TTY-gated at the call site.** The CLI only instantiates this when
 *    stdout is a TTY (interactive), so piped / JSON / CI output stays raw and
 *    machine-readable.
 */

import { theme, type QuiverTheme } from "./cli_ui.js";

type WriteStream = NodeJS.WriteStream;

export class TerminalMarkdownRenderer {
  private readonly stream: WriteStream;
  private readonly t: QuiverTheme;
  private buffer = "";
  private inCode = false;
  private codeLang = "";

  constructor(stream: WriteStream = process.stdout) {
    this.stream = stream;
    this.t = theme(stream);
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
    if (this.buffer.length > 0 || this.inCode) {
      // Render the trailing partial line, then close an open code fence so
      // the framing is balanced even if the model forgot the closing fence.
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
        // Closing fence — emit footer and resume normal rendering.
        this.stream.write(this.t.muted("  └") + "\n");
        this.inCode = false;
        this.codeLang = "";
        return;
      }
      // Code content: preserve verbatim (indentation, spacing) with a rail.
      this.stream.write(this.t.muted("  │ ") + this.t.cyan(line) + "\n");
      return;
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

    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const text = m[2].replace(/\s+#+\s*$/, ""); // strip trailing ###
      this.stream.write(this.t.bold(this.t.cyan(this.inline(text))) + "\n");
      return;
    }

    if ((m = line.match(/^\s{0,3}>\s?(.*)$/))) {
      const text = m[1];
      this.stream.write(
        this.t.muted("  │ ") + this.t.dim(this.t.italic(this.inline(text))) +
          "\n",
      );
      return;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      // Horizontal rule.
      this.stream.write(this.t.muted("  " + "─".repeat(40)) + "\n");
      return;
    }

    if ((m = line.match(/^(\s*)([-*+])\s+(.*)$/))) {
      const indent = m[1];
      const text = m[3];
      this.stream.write(
        `${indent}${this.t.cyan("•")} ${this.inline(text)}\n`,
      );
      return;
    }

    if ((m = line.match(/^(\s*)(\d+)\.\s+(.*)$/))) {
      const indent = m[1];
      const num = m[2];
      const text = m[3];
      this.stream.write(
        `${indent}${this.t.muted(`${num}.`)} ${this.inline(text)}\n`,
      );
      return;
    }

    // Plain paragraph line (incl. empty lines, which preserve spacing).
    this.stream.write(this.inline(line) + "\n");
  }

  /** Apply inline markdown formatting (code, bold, italic, strike, links).
   *  Anything unmatched is emitted verbatim — content is never lost. */
  private inline(text: string): string {
    if (!text) return text;
    // Tokenize in one pass so delimiters don't clobber each other. Order
    // matters: inline code first (so `**` inside `..` stays literal), then
    // bold, strike, links, then italic.
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
        // [text](url) -> underlined text (url dropped from the visible line)
        const lm = tok.match(/^\[([^\]]*)\]\(([^)]+\))$/);
        if (lm) out += this.t.underline(lm[1]);
        else out += tok; // malformed link — keep verbatim
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