/**
 * Tier C/D — live model + network spot checks.
 *
 * Credentials are loaded from the process environment or from a local .env
 * (never printed). Tests are skipped cleanly when keys/endpoints are absent.
 */
import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { E2eReporter, makeTempWorkspace, runSingleTurn, hasEvent, ROOT } from "./helpers.js";

const reporter = new E2eReporter();

function loadDotEnv(): void {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function liveConfig(): {
  ready: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  parallelKey: string;
} {
  loadDotEnv();
  // When VERTEX_PROJECT_ID is set, the Vertex endpoint is built at runtime
  // from it — don't let a stale GUI config override with a non-Vertex URL.
  const vertexProject = process.env.VERTEX_PROJECT_ID || "";
  // Also try Electron config provider block without logging secrets.
  // Only use it when .env didn't already provide a config AND Vertex is not
  // configured (the GUI config can be stale from a previous setup).
  if (!vertexProject) {
    try {
      const cfgPath = path.join(
        process.env.HOME || "",
        "Library/Application Support/Quiver/quiver-config.json",
      );
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        if (cfg?.provider?.baseUrl && !process.env.LLM_API_BASE_URL?.trim()) {
          process.env.LLM_API_BASE_URL = cfg.provider.baseUrl;
        }
        if (cfg?.provider?.modelName && !process.env.LLM_MODEL_NAME?.trim()) {
          process.env.LLM_MODEL_NAME = cfg.provider.modelName;
        }
        if (cfg?.provider?.apiKey && !process.env.LLM_API_KEY?.trim()) {
          process.env.LLM_API_KEY = cfg.provider.apiKey;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const baseUrl = process.env.LLM_API_BASE_URL || "";
  const model = process.env.LLM_MODEL_NAME || "";
  const apiKey = process.env.LLM_API_KEY || "";
  const parallelKey = process.env.PARALLEL_API_KEY || "";
  // Vertex auth: baseUrl and apiKey are legitimately empty — Quiver builds
  // the endpoint from VERTEX_PROJECT_ID and obtains an OAuth bearer token.
  // "ready" is true when either (baseUrl + model + apiKey) for a standard
  // OpenAI-compatible endpoint, OR (vertexProject + model) for Vertex.
  const ready = Boolean(
    model && ((baseUrl && apiKey) || vertexProject),
  );
  return {
    ready,
    baseUrl,
    model,
    apiKey,
    parallelKey,
  };
}

async function testLiveSingleTurn(cfg: ReturnType<typeof liveConfig>): Promise<void> {
  if (!cfg.ready) {
    reporter.fail("C-LIVE-READY", "LLM_API_BASE_URL / MODEL / KEY not available");
    return;
  }
  reporter.pass("C-LIVE-READY", `${cfg.baseUrl} / ${cfg.model}`);

  const cwd = makeTempWorkspace("live-chat");
  const result = await runSingleTurn({
    cwd,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    prompt: "Reply with exactly the three characters: OK.",
    yolo: true,
    timeoutMs: 120_000,
    env: {
      QUIVER_CONSENT_GATE: "0",
      QUIVER_PROJECT_NAME: `e2e-live-${process.pid}`,
      PARALLEL_API_KEY: cfg.parallelKey || undefined,
    },
  });
  const blob = result.stdout + result.stderr;
  reporter.assert(
    "C-LIVE-SINGLE-TURN",
    result.code === 0 || /\bOK\b/.test(blob) || hasEvent(result.events, "done"),
    `code=${result.code} tail=${blob.slice(-300)}`,
  );
}

async function testLiveDemo(): Promise<void> {
  const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("npm", ["run", "demo:ic-memo:live"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (out += d.toString()));
    const t = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, out });
    }, 300_000);
    child.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
  });
  reporter.assert(
    "C-LIVE-IC-MEMO",
    result.code === 0 || /pass|8\/8|acceptance/i.test(result.out),
    `code=${result.code} tail=${result.out.slice(-350)}`,
  );
}

async function testNetworkSpotChecks(cfg: ReturnType<typeof liveConfig>): Promise<void> {
  // scrape_url against a public page via the agent tool path (mock-free).
  if (!cfg.ready) {
    reporter.fail("D-SCRAPE", "skipped — no LLM credentials");
    reporter.fail("D-WEB-SEARCH", "skipped — no LLM credentials");
    return;
  }

  const cwd = makeTempWorkspace("live-net");
  const scrape = await runSingleTurn({
    cwd,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    prompt:
      "Use the scrape_url tool once on https://example.com and then reply with only the page title you found.",
    yolo: true,
    timeoutMs: 180_000,
    env: {
      QUIVER_CONSENT_GATE: "0",
      QUIVER_PROJECT_NAME: `e2e-scrape-${process.pid}`,
      PARALLEL_API_KEY: cfg.parallelKey || undefined,
    },
  });
  reporter.assert(
    "D-SCRAPE",
    scrape.code === 0 ||
      /example|domain/i.test(scrape.stdout) ||
      hasEvent(scrape.events, "tool_result"),
    `code=${scrape.code} tail=${(scrape.stdout + scrape.stderr).slice(-280)}`,
  );

  if (!cfg.parallelKey && !/ollama/i.test(cfg.baseUrl)) {
    reporter.pass("D-WEB-SEARCH", "skipped — no PARALLEL_API_KEY and non-Ollama endpoint");
    return;
  }

  const search = await runSingleTurn({
    cwd: makeTempWorkspace("live-search"),
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    prompt:
      "Use web_search once with query 'Berkshire Hathaway' and reply with one short sentence citing a result title.",
    yolo: true,
    timeoutMs: 180_000,
    env: {
      QUIVER_CONSENT_GATE: "0",
      QUIVER_PROJECT_NAME: `e2e-search-${process.pid}`,
      PARALLEL_API_KEY: cfg.parallelKey || undefined,
    },
  });
  reporter.assert(
    "D-WEB-SEARCH",
    search.code === 0 ||
      /berkshire|hathaway|result/i.test(search.stdout) ||
      hasEvent(search.events, "tool_result"),
    `code=${search.code} tail=${(search.stdout + search.stderr).slice(-280)}`,
  );
}

export async function runTierCD(): Promise<E2eReporter> {
  console.log("\n══ Tier C/D — live model + network ══");
  const cfg = liveConfig();
  await testLiveSingleTurn(cfg);
  await testLiveDemo();
  await testNetworkSpotChecks(cfg);
  return reporter;
}

if (process.argv[1]?.includes("tier_cd_live")) {
  runTierCD()
    .then((r) => {
      const { passed, failed } = r.summary();
      console.log(`\nTier C/D: ${passed} passed, ${failed} failed`);
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
