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
 */

import { promptLine, promptUser } from "../multiline.js";
import { suspendLiveInput, resumeLiveInput } from "../live_input.js";

/**
 * Ask a question via single-line input.
 * Returns the user's trimmed answer.
 */
export async function askQuestion(prompt: string): Promise<string> {
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
  return promptUser(null, prompt);
}