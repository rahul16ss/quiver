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
  execute: async ({ question, header, choices }) => {
    // In non-interactive mode, we can't ask — return a message
    if (
      process.env.QUIVER_OUTPUT_MODE === "json" ||
      process.env.QUIVER_OUTPUT_MODE === "quiet"
    ) {
      return `Question asked but cannot wait for answer in non-interactive mode. Question: ${question}. Choices: ${choices?.join(", ") || "N/A"}. Please re-run in interactive mode or provide the answer in your prompt.`;
    }

    // Dynamic import to avoid loading readline in non-interactive contexts
    const readline = await import("readline");
    const { Agent } = await import("../agent.js");
    const activeRl = Agent.activeSessionReadline;

    const label = header || "Question";

    console.log(`\n  ┌── ${label} ──────────────────────────`);
    console.log(`  │  ${question}`);

    if (choices && choices.length > 0) {
      console.log(`  │`);
      for (let i = 0; i < choices.length; i++) {
        console.log(`  │  [${i + 1}] ${choices[i]}`);
      }
      console.log(`  │  [0] Type a custom answer`);
      console.log(`  └──────────────────────────────────────`);

      if (activeRl) {
        return new Promise((resolve) => {
          activeRl.question(`  > `, (answer) => {
            const trimmed = answer.trim();
            const choiceIdx = parseInt(trimmed, 10);
            if (
              !isNaN(choiceIdx) &&
              choiceIdx >= 1 &&
              choiceIdx <= choices.length
            ) {
              resolve(`User selected: ${choices[choiceIdx - 1]}`);
            } else if (trimmed) {
              resolve(`User answered: ${trimmed}`);
            } else {
              resolve("User did not provide an answer.");
            }
          });
        });
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise((resolve) => {
        rl.question(`  > `, (answer) => {
          rl.close();
          const trimmed = answer.trim();
          const choiceIdx = parseInt(trimmed, 10);
          if (
            !isNaN(choiceIdx) &&
            choiceIdx >= 1 &&
            choiceIdx <= choices.length
          ) {
            resolve(`User selected: ${choices[choiceIdx - 1]}`);
          } else if (trimmed) {
            resolve(`User answered: ${trimmed}`);
          } else {
            resolve("User did not provide an answer.");
          }
        });
      });
    } else {
      console.log(`  └──────────────────────────────────────`);

      if (activeRl) {
        return new Promise((resolve) => {
          activeRl.question(`  > `, (answer) => {
            const trimmed = answer.trim();
            resolve(
              trimmed
                ? `User answered: ${trimmed}`
                : "User did not provide an answer.",
            );
          });
        });
      }

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      return new Promise((resolve) => {
        rl.question(`  > `, (answer) => {
          rl.close();
          const trimmed = answer.trim();
          resolve(
            trimmed
              ? `User answered: ${trimmed}`
              : "User did not provide an answer.",
          );
        });
      });
    }
  },
};
