// View every QA screenshot through the local Gemma 3 vision model.
import { readdirSync, readFileSync } from "fs";
const DIR = "/tmp/quiver-qa-shots";
const PROMPT = "You are a meticulous software QA reviewer. This is a screenshot of the Quiver desktop app — a local-first AI work assistant for business users (analysts, researchers). Describe what you see: the overall layout, each visible panel/area and its contents, the key text/labels, and the current state. Then call out anything that looks broken, misaligned, empty where it shouldn't be, overlapping, cut-off, low-contrast, or like a rough edge or bug. Be specific and concise (max ~120 words).";
const files = readdirSync(DIR).filter((f) => f.endsWith(".png")).sort();
const out = [];
for (const f of files) {
  const b64 = readFileSync(DIR + "/" + f).toString("base64");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 120000);
  try {
    const r = await fetch("http://localhost:11434/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gemma3:4b", messages: [{ role: "user", content: PROMPT, images: [b64] }], stream: false, options: { temperature: 0.2 } }),
      signal: ctrl.signal,
    });
    const d = await r.json();
    const desc = (d?.message?.content || "(no description)").trim();
    out.push("=== " + f + " ===\n" + desc);
    console.log("=== " + f + " ===\n" + desc + "\n");
  } catch (e) {
    out.push("=== " + f + " ===\n(VISION ERROR: " + e.message + ")");
    console.log("=== " + f + " === (error: " + e.message + ")");
  } finally {
    clearTimeout(to);
  }
}
import { writeFileSync } from "fs";
writeFileSync("/tmp/quiver-vision-review.txt", out.join("\n\n"));
console.log("\n[sision review saved to /tmp/quiver-vision-review.txt]");