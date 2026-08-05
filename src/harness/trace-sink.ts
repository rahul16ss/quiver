/**
 * TraceSink — Phase 1 (ADR-010).
 *
 * Local/customer-controlled by default. Never sends prompts, documents,
 * source excerpts or tool results to a SaaS. This in-memory implementation is
 * the default for tests and CI; a real deployment wires an OpenTelemetry
 * exporter. LangSmith is an explicit, redacted customer option only.
 */

import { randomUUID } from "crypto";
import type { TraceSink, TraceSpan } from "./interfaces.js";

interface TraceEvent {
  spanId: string;
  name: string;
  attrs?: Record<string, unknown>;
}

export class LocalTraceSink implements TraceSink {
  readonly redactsContent = true;
  private spans: TraceSpan[] = [];
  private events: TraceEvent[] = [];

  startSpan(name: string, attrs: Record<string, unknown> = {}): TraceSpan {
    const span: TraceSpan = { spanId: randomUUID(), name, attrs: this.redact(attrs) };
    this.spans.push(span);
    return span;
  }

  event(span: TraceSpan, name: string, attrs: Record<string, unknown> = {}): void {
    this.events.push({ spanId: span.spanId, name, attrs: this.redact(attrs) });
  }

  endSpan(span: TraceSpan, attrs: Record<string, unknown> = {}): void {
    Object.assign(span.attrs, this.redact(attrs));
  }

  /** Test/inspection accessor — metadata only, content redacted. */
  snapshot(): { spans: TraceSpan[]; events: TraceEvent[] } {
    return {
      spans: this.spans.map((s) => ({ ...s })),
      events: this.events.map((e) => ({ ...e })),
    };
  }

  /** Redact any content-bearing key before it is recorded. */
  private redact(attrs: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      if (/prompt|content|document|excerpt|tool_?result|message|text/i.test(k)) {
        out[k] = "[redacted]";
      } else {
        out[k] = v;
      }
    }
    return out;
  }
}