/**
 * Shared prompt utility — single source of truth for ALL stdin interaction.
 *
 * Every prompt in the app goes through here — main input, approvals,
 * confirmations, questions. Uses @clack/prompts via multiline.ts.
 *
 * - askQuestion() — single-line prompt (approvals, confirmations, quick inputs)
 * - askQuestionRaw() — same but untrimmed (for whitespace-sensitive input)
 * - askMultiline() — multiline prompt (main REPL input)
 *
 * All single-line prompts suspend the live type-ahead input (see live_input.ts)
 * while they're open, so a tool approval can own the full screen + stdin, then
 * resume it when done. Outside of a run this is a no-op.
 *
 * Browser-UI seam (Phase 8, ADR-009): when a prompt resolver is installed
 * (setPromptResolver), all prompts route to it instead of readline — so the
 * loopback daemon can surface approvals/consent/main input to the browser UI
 * and await the user's response over HTTP/SSE. The CLI path does not install
 * a resolver and is unaffected.
 */

import { promptLine, promptUser } from "../multiline.js";
import { suspendLiveInput, resumeLiveInput } from "../live_input.js";

/**
 * A prompt resolver — when installed, every prompt is routed here. The resolver
 * receives the prompt text and a kind ("question" | "question-raw" | "multiline")
 * and returns the user's answer (or null for cancel/EOF). The browser bridge
 * installs this to forward prompts to the browser and await the response.
 */
export type PromptResolver = (
  prompt: string,
  kind: "question" | "question-raw" | "multiline",
) => Promise<string | null>;

let resolver: PromptResolver | null = null;

/** Install a prompt resolver (the browser-UI bridge). Pass null to clear. */
export function setPromptResolver(r: PromptResolver | null): void {
  resolver = r;
}

/** Whether a prompt resolver is installed (browser-UI mode). */
export function hasPromptResolver(): boolean {
  return resolver !== null;
}

/**
 * Ask a question via single-line input.
 * Returns the user's trimmed answer.
 */
export async function askQuestion(prompt: string): Promise<string> {
  if (resolver) {
    const ans = await resolver(prompt, "question");
    return (ans ?? "").trim();
  }
  suspendLiveInput();
  try {
    const answer = await promptLine(null, prompt);
    return answer.trim();
  } finally {
    resumeLiveInput();
  }
}

/**
 * Ask a question and return the raw (untrimmed) answer.
 * Useful when whitespace matters.
 */
export async function askQuestionRaw(prompt: string): Promise<string> {
  if (resolver) {
    return (await resolver(prompt, "question-raw")) ?? "";
  }
  suspendLiveInput();
  try {
    const answer = await promptLine(null, prompt);
    return answer;
  } finally {
    resumeLiveInput();
  }
}

/**
 * Multiline prompt — for the main REPL input.
 * Returns the user's input or null on cancel/EOF.
 */
export async function askMultiline(prompt: string): Promise<string | null> {
  if (resolver) {
    return resolver(prompt, "multiline");
  }
  return promptUser(null, prompt);
}