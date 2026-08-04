/**
 * Process-wide sink for agent UI events from tools that are not on the Agent
 * instance (e.g. evidence approve_source). Agent.promptTurn registers the
 * turn's onEvent; tools emit through emitAgentUiEvent.
 */

export type AgentUiEvent = {
  type: string;
  data?: Record<string, unknown>;
};

type Sink = (event: AgentUiEvent) => void;

let sink: Sink | null = null;

export function setAgentUiEventSink(next: Sink | null): void {
  sink = next;
}

export function emitAgentUiEvent(event: AgentUiEvent): void {
  try {
    sink?.(event);
  } catch {
    // UI sink failures must not crash the tool path.
  }
}
