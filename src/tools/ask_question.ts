import { z } from "zod";
import { Tool } from "../registry.js";

/**
 * AskUserQuestion — ask the user a question during execution.
 * Used when the agent needs clarification, a decision, or user preference.
 * This is better than guessing when the choice is ambiguous or has significant consequences.
 *
 * In interactive mode, this prompts the user via readline.
 * In JSON mode, this emits an event for the GUI to render a question UI.
 * In quiet mode, this returns a default answer if provided, or an error.
 */

export const tool: Tool = {
  name: "ask_question",
  description:
    "Asks the user a question during execution. Use this when you need clarification, a decision between options, or user preference before proceeding. " +
    "Do NOT use this for things you can reasonably infer — prefer making reasonable assumptions. " +
    "Only use this when the choice is genuinely ambiguous and has significant consequences (e.g., choosing between architectural approaches, confirming a destructive action, or asking about user preferences). " +
    "Each question includes a header, the question text, and optional choices. The user can select from the provided choices or type a custom answer.",
  parameters: z.object({
    question: z.string().describe("The question text to present to the user."),
    header: z
      .string()
      .optional()
      .describe("A short header/label for the question. Default: 'Question'."),
    choices: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of predefined choices. The user can select one or type a custom answer. If omitted, the user types a free-form answer.",
      ),
  }),
  execute: async (args: unknown) => {
    // Zod validates normal registry calls, but tool arguments can also arrive
    // through provider/tool-call boundaries that are only structurally typed.
    // Fail closed here too: never render `undefined` (or an empty question)
    // into the terminal/browser prompt.
    const parsed = args as { question?: unknown; header?: unknown; choices?: unknown };
    if (typeof parsed.question !== "string" || parsed.question.trim().length === 0) {
      return "ask_question refused: question text is missing or invalid; no prompt was shown.";
    }
    const question = parsed.question;
    const header = typeof parsed.header === "string" ? parsed.header : undefined;
    const choices = Array.isArray(parsed.choices)
      ? parsed.choices.filter((choice): choice is string => typeof choice === "string")
      : undefined;

    // In non-interactive mode, we can't ask — return a message
    if (
      process.env.QUIVER_OUTPUT_MODE === "json" ||
      process.env.QUIVER_OUTPUT_MODE === "quiet"
    ) {
      return `Question asked but cannot wait for answer in non-interactive mode. Question: ${question}. Choices: ${choices?.join(", ") || "N/A"}. Please re-run in interactive mode or provide the answer in your prompt.`;
    }

    const { hasPromptResolver } = await import("../utils/prompt.js");
    // Browser mode owns the question surface. Do not also render a terminal
    // card: the old dual surface produced `Question: undefined` in the CLI
    // while the browser was the active experience plane.
    if (!hasPromptResolver()) {
      const label = header || "Question";
      const { card } = await import("../cli_ui.js");
      const body = [question];
      if (choices && choices.length > 0) {
        body.push("");
        for (let i = 0; i < choices.length; i++) {
          body.push(`[${i + 1}] ${choices[i]}`);
        }
        body.push("[0] Type a custom answer");
      }
      card({ title: label, body, accent: "brand" });
    }

    if (choices && choices.length > 0) {
      const { askQuestionRaw } = await import("../utils/prompt.js");
      const answer = await askQuestionRaw(`  > `);
      const trimmed = answer.trim();
      const choiceIdx = parseInt(trimmed, 10);
      if (!isNaN(choiceIdx) && choiceIdx >= 1 && choiceIdx <= choices.length) {
        return `User selected: ${choices[choiceIdx - 1]}`;
      } else if (trimmed) {
        return `User answered: ${trimmed}`;
      } else {
        return "User did not provide an answer.";
      }
    } else {
      const { askQuestionRaw } = await import("../utils/prompt.js");
      const answer = await askQuestionRaw(`  > `);
      const trimmed = answer.trim();
      return trimmed
        ? `User answered: ${trimmed}`
        : "User did not provide an answer.";
    }
  },
};
