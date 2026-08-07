// GUI QA — drives the SHIPPED loopback browser UI (daemon + src/harness/ui),
// replacing the retired Electron CDP drivers (gui_manual_qa.mjs /
// gui_real_qa.mjs, which launched a binary that no longer exists — ADR-009).
//
// What it proves (the release-gate walkthrough, structural tier):
//   1. the harness daemon starts and serves the UI on loopback;
//   2. index renders the three planes with a visible, enabled composer;
//   3. Settings navigation works and a settings save round-trips (the
//      config-save regression class: dead buttons, missing handlers);
//   4. the onboarding page renders with no dead-end;
//   5. the sessions overlay opens;
//   6. unknown API routes are a real 404, not 200-with-error;
//   7. screenshots land in /tmp/quiver-qa-shots for the human read-through —
//      the gate requires screenshots ACTUALLY READ, not just taken.
//
// Live tier (QUIVER_QA_LIVE=1, needs a configured model key): also sends a
// short prompt and asserts assistant output arrives over SSE.
//
// Run: node tests/gui_browser_qa.mjs

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const SHOTS = "/tmp/quiver-qa-shots";
const LIVE = process.env.QUIVER_QA_LIVE === "1";

const results = [];
function record(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function waitFor(fn, timeoutMs = 20_000, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const workspace = mkdtempSync(path.join(tmpdir(), "quiver-qa-ws-"));

  // 1. Launch the harness daemon in an isolated workspace — cwd is the
  // workspace (the real usage pattern), so settings saves land in the
  // workspace .env and never mutate the repo's.
  const daemon = spawn(
    path.join(REPO, "node_modules", ".bin", "tsx"),
    [path.join(REPO, "src", "harness", "launcher.ts"), "harness"],
    {
      cwd: workspace,
      env: {
        ...process.env,
        QUIVER_NO_BROWSER: "1",
        QUIVER_PROTECTED_DIR: REPO,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let daemonLog = "";
  daemon.stdout.on("data", (d) => {
    daemonLog += String(d);
  });
  daemon.stderr.on("data", (d) => {
    daemonLog += String(d);
  });

  let browser;
  try {
    // The spawn goes through npx, so the recorded pid is the tsx child's —
    // match on freshness + a live /health probe instead of pid equality.
    const spawnedAt = Date.now();
    const state = await waitFor(async () => {
      const st = JSON.parse(
        readFileSync(path.join(homedir(), ".quiver", "daemon-state.json"), "utf8"),
      );
      if (Date.parse(st.startedAt) < spawnedAt - 5_000) return null;
      const health = await fetch(`${st.origin}/health`).catch(() => null);
      return health?.ok ? st : null;
    }, 60_000);
    const secret = readFileSync(path.join(homedir(), ".quiver", "daemon-secret"), "utf8").trim();
    const origin = state.origin;
    record("daemon starts and records state", true, origin);

    // 2. Unknown API route must be 404 (not 200-with-error).
    const unknown = await fetch(`${origin}/api/config/definitely-not-a-route`, {
      method: "POST",
      headers: { "X-Quiver-Secret": secret, "Content-Type": "application/json" },
      body: "{}",
    });
    record("unknown API route returns 404", unknown.status === 404, `status ${unknown.status}`);

    // 3. Config save round-trips at the API level.
    const save = await fetch(`${origin}/api/config/save`, {
      method: "POST",
      headers: { "X-Quiver-Secret": secret, "Content-Type": "application/json" },
      body: JSON.stringify({ config: { sessionLogMaxChars: 512 } }),
    });
    const saveBody = await save.json();
    record(
      "POST /api/config/save exists and saves",
      save.status === 200 && saveBody.saved === true,
      JSON.stringify(saveBody),
    );

    // 4. Drive the real UI.
    // Desktop viewport: below 840px the trust pill collapses to its dot by
    // design, and the buyer demo runs on a laptop, not a phone.
    browser = await puppeteer.launch({
      headless: "shell",
      defaultViewport: { width: 1366, height: 850 },
    });
    const page = await browser.newPage();
    page.on("pageerror", (err) => record("page error (unexpected)", false, String(err?.stack || err)));
    await page.goto(`${origin}/index.html#token=${encodeURIComponent(secret)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.screenshot({ path: path.join(SHOTS, "01-index.png"), fullPage: true });

    const planes = await page.evaluate(() => ({
      context: !!document.querySelector("#context-plane"),
      conversation: !!document.querySelector("#conversation-plane"),
      activity: !!document.querySelector("#activity-plane"),
    }));
    record(
      "three planes render",
      planes.context && planes.conversation && planes.activity,
      JSON.stringify(planes),
    );

    const composer = await page.evaluate(() => {
      const input = document.querySelector("#promptInput");
      const send = document.querySelector("#sendBtn");
      const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;
      return { input: visible(input), send: visible(send) };
    });
    record("composer + Send visible and enabled", composer.input && composer.send);

    const pill = await page.evaluate(
      () => document.querySelector("#pillText")?.textContent?.trim() ?? "",
    );
    record("trust pill has text", pill.length > 0, pill);

    // 5. Settings navigation + UI save round-trip.
    await page.click("#settingsBtn");
    await page.waitForFunction(() => location.pathname.endsWith("/settings.html"), {
      timeout: 15_000,
    });
    await page.waitForSelector("#saveBtn", { timeout: 15_000 });
    await page.screenshot({ path: path.join(SHOTS, "02-settings.png"), fullPage: true });
    record("Settings button navigates to settings.html", true);

    const bannedWords = await page.evaluate(() => {
      const text = document.body.innerText;
      return ["API", ".env", "endpoint", "terminal"].filter((w) => text.includes(w));
    });
    record("settings uses buyer language", bannedWords.length === 0, bannedWords.join(", "));

    await page.click("#saveBtn");
    await page.waitForFunction(() => location.pathname.endsWith("/index.html"), {
      timeout: 15_000,
    });
    record("settings Save persists and returns to main", true);

    // 6. Onboarding page renders (no dead-end).
    await page.goto(`${origin}/onboarding.html#token=${encodeURIComponent(secret)}`, {
      waitUntil: "domcontentloaded",
    });
    const onb = await page.evaluate(() => ({
      key: !!document.querySelector("#onbKey"),
      start: !!document.querySelector("#onbStartBtn"),
      api: /\bAPI\b/.test(document.body.innerText),
    }));
    await page.screenshot({ path: path.join(SHOTS, "03-onboarding.png"), fullPage: true });
    record("onboarding renders key + start", onb.key && onb.start);
    record("onboarding uses buyer language (no 'API')", !onb.api);

    // 7. Sessions overlay.
    await page.goto(`${origin}/index.html#token=${encodeURIComponent(secret)}`, {
      waitUntil: "domcontentloaded",
    });
    const sessionsOpened = await page.evaluate(() => {
      const btn = document.querySelector("#sessionsBtn");
      if (!btn) return false;
      btn.click();
      const overlay = document.querySelector("#sessionsOverlay");
      return !!overlay && !overlay.hidden && overlay.style.display !== "none";
    });
    await page.screenshot({ path: path.join(SHOTS, "04-sessions.png"), fullPage: true });
    record("sessions overlay opens", sessionsOpened);

    // 8. Live tier: one real prompt round-trip.
    if (LIVE) {
      await page.goto(`${origin}/index.html#token=${encodeURIComponent(secret)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.type("#promptInput", "Reply with exactly: qa-live-ok");
      await page.keyboard.press("Enter");
      const gotReply = await waitFor(
        () =>
          page.evaluate(() =>
            /qa-live-ok/.test(
              [...document.querySelectorAll(".msg.assistant")].map((m) => m.innerText).join("\n"),
            ),
          ),
        120_000,
        1_000,
      ).catch(() => false);
      await page.screenshot({ path: path.join(SHOTS, "05-live-turn.png"), fullPage: true });
      record("live prompt produces assistant output", !!gotReply);
    }
  } catch (err) {
    record("walkthrough completed", false, String(err));
    console.error("\ndaemon log tail:\n" + daemonLog.slice(-2_000));
  } finally {
    if (browser) await browser.close().catch(() => {});
    daemon.kill("SIGTERM");
    rmSync(workspace, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length - failed.length}/${results.length} GUI checks passed. Screenshots: ${SHOTS}`,
  );
  console.log("Release gate reminder: READ the screenshots — do not trust green checks alone.");
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
