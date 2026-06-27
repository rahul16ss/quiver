import readline from "readline";
import picocolors from "picocolors";

// Multiline input support.
// End a line with backslash (\) then press Enter to continue on a new line.
// Press Enter on a line without a trailing backslash to submit.
// Works in ALL terminals (Warp, iTerm2, Terminal.app, kitty, foot, etc.)
// because it relies on readline's own input processing.

function isMultilineSupported(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function promptUser(
  rl: readline.Interface,
  promptText: string,
): Promise<string | null> {
  if (!isMultilineSupported()) {
    return new Promise((resolve) => {
      let settled = false;
      const onClose = () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      };
      rl.once("close", onClose);
      rl.question(promptText, (answer: string) => {
        if (!settled) {
          settled = true;
          rl.removeListener("close", onClose);
          resolve(answer);
        }
      });
    });
  }

  return promptUserMultiline(rl, promptText);
}

function promptUserMultiline(
  rl: readline.Interface,
  promptText: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let accumulated = "";
    const continuationPrompt = picocolors.gray("… ");

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      rl.removeListener("line", onLine);
      rl.removeListener("close", onClose);
      rl.setPrompt(promptText);
      resolve(value);
    };

    const onClose = () => finish(null);

    const onLine = (line: string) => {
      if (line.endsWith("\\")) {
        accumulated += line.slice(0, -1) + "\n";
        rl.setPrompt(continuationPrompt);
        rl.prompt();
        return;
      }
      accumulated += line;
      finish(accumulated);
    };

    rl.on("line", onLine);
    rl.once("close", onClose);
    rl.setPrompt(promptText);
    rl.prompt();
  });
}
