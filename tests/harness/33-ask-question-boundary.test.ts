/**
 * ask_question runtime-boundary regression.
 *
 * Provider tool-call arguments can bypass the nominal Zod schema at runtime.
 * The tool must fail closed on missing/non-string question text and must never
 * render the literal `undefined` in a prompt card. Valid noninteractive calls
 * return a truthful no-wait response. Deterministic exit; no stdin/network.
 */
import picocolors from "picocolors";
import { tool } from "../../src/tools/ask_question.js";
import { setPromptResolver } from "../../src/utils/prompt.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(picocolors.green(`   ✔ PASS  ${name}`)); }
  else { failed++; const msg = `${name}${detail ? ` — ${detail}` : ""}`; failures.push(msg); console.log(picocolors.red(`   ✗ FAIL  ${msg}`)); }
}

async function run() {
  const execute = tool.execute as (args: unknown) => Promise<string>;
  const malformed = await execute({ header: "Question" });
  check("ASK-MISSING-QUESTION-FAILS-CLOSED", /refused/i.test(malformed), malformed);
  check("ASK-MISSING-QUESTION-NO-UNDEFINED", !/undefined/i.test(malformed), malformed);

  const nullQuestion = await execute({ question: null });
  check("ASK-NULL-QUESTION-FAILS-CLOSED", /refused/i.test(nullQuestion), nullQuestion);
  check("ASK-NULL-QUESTION-NO-UNDEFINED", !/undefined/i.test(nullQuestion), nullQuestion);

  const oldMode = process.env.QUIVER_OUTPUT_MODE;
  process.env.QUIVER_OUTPUT_MODE = "json";
  try {
    const valid = await execute({ question: "Which source should be preferred?", choices: ["Filing", "Transcript"] });
    check("ASK-VALID-NONINTERACTIVE-TRUTHFUL", /cannot wait|question asked/i.test(valid), valid);
    check("ASK-VALID-NONINTERACTIVE-NO-UNDEFINED", !/undefined/i.test(valid), valid);
  } finally {
    if (oldMode === undefined) delete process.env.QUIVER_OUTPUT_MODE;
    else process.env.QUIVER_OUTPUT_MODE = oldMode;
  }

  // Browser resolver owns the question UI: the tool must not render a second
  // terminal card when the browser has installed the prompt resolver.
  let resolvedPrompt = "";
  setPromptResolver(async (prompt) => { resolvedPrompt = prompt; return "1"; });
  try {
    const browserAnswer = await execute({ question: "Choose the source", choices: ["Filing"] });
    check("ASK-BROWSER-RESOLVER-USED", resolvedPrompt === "  > " && /selected: Filing/i.test(browserAnswer), browserAnswer);
  } finally {
    setPromptResolver(null);
  }
}

await run();
if (failed > 0) { console.log(picocolors.red(`\n❌ ${failed} ask_question check(s) FAILED:\n${failures.join("\n")}`)); process.exit(1); }
console.log(picocolors.cyan(`\n  ✔ ${passed} ask_question checks passed.`));
