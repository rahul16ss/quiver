import { z } from "zod";
import puppeteer, { Browser } from "puppeteer";
import { promises as fs } from "fs";
import * as path from "path";
import { Tool } from "../registry.js";
import { config } from "../config.js";
import { getProjectSessionsDir } from "../paths.js";

/**
 * SSRF protection: blocks navigation to private/internal IP ranges.
 * Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable (default: enabled).
 */
function isPrivateUrl(urlStr: string): boolean {
  if (process.env.QUIVER_BLOCK_PRIVATE_IPS === "0") return false;
  try {
    const parsed = new URL(urlStr);
    const hostname = parsed.hostname;
    if (
      hostname === "localhost" ||
      hostname.startsWith("127.") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const tool: Tool = {
  name: "browser_control",
  description:
    "Controls a persistent browser session to navigate, click, type, screenshot, or extract content. Pass headless: false to show the browser window (e.g. for manual sign-in). Defaults to headless mode via BROWSER_HEADLESS env var.",
  parameters: z.object({
    action: z
      .enum(["navigate", "click", "type", "screenshot", "get_content", "close"])
      .describe("The action to perform in the browser."),
    url: z
      .string()
      .optional()
      .describe("The target URL (required for 'navigate')."),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for elements (required for 'click' or 'type')."),
    text: z
      .string()
      .optional()
      .describe("The text content to input (required for 'type')."),
    waitForSelector: z
      .string()
      .optional()
      .describe(
        "Optional CSS selector to wait for after performing the action.",
      ),
    headless: z
      .boolean()
      .optional()
      .describe(
        "Override headless mode for this session. Set to false to show the browser window (e.g. for manual sign-in). If omitted, uses BROWSER_HEADLESS env var.",
      ),
  }),
  execute: async ({
    action,
    url,
    selector,
    text,
    waitForSelector,
    headless,
  }) => {
    const wsPath = path.join(getProjectSessionsDir(), "browser_ws.txt");
    let browser: Browser | null = null;
    let wsUrl = "";

    try {
      wsUrl = await fs.readFile(wsPath, "utf8");
    } catch {
      // File does not exist yet
    }

    // Try connecting to existing browser
    if (wsUrl) {
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      } catch {
        // Failed to connect, will launch a new one below
      }
    }

    // Launch a new browser if none connected
    if (!browser) {
      const useHeadless = headless ?? config.browserHeadless;
      browser = await puppeteer.launch({
        headless: useHeadless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      wsUrl = browser.wsEndpoint();
      await fs.mkdir(path.dirname(wsPath), { recursive: true });
      // Write with restricted permissions (0600) to prevent other users from reading the WS endpoint
      await fs.writeFile(wsPath, wsUrl, { encoding: "utf8", mode: 0o600 });
    }

    try {
      if (action === "close") {
        await browser.close();
        await fs.unlink(wsPath).catch(() => {});
        return "Persistent browser session closed successfully.";
      }

      const pages = await browser.pages();
      const page = pages.length > 0 ? pages[0] : await browser.newPage();

      // Standard viewport
      await page.setViewport({ width: 1280, height: 800 });

      let resultText = "";

      switch (action) {
        case "navigate": {
          if (!url) throw new Error("URL is required for 'navigate' action.");
          // SSRF protection
          if (isPrivateUrl(url)) {
            throw new Error(
              `URL '${url}' points to a private/internal network address. Blocked for security. Set QUIVER_BLOCK_PRIVATE_IPS=0 to disable.`,
            );
          }
          await page.goto(url, { waitUntil: "networkidle2" });
          resultText = `Successfully navigated to ${url}. Current URL: ${page.url()}`;
          break;
        }
        case "click": {
          if (!selector)
            throw new Error("Selector is required for 'click' action.");
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          resultText = `Successfully clicked element matching selector '${selector}'.`;
          break;
        }
        case "type": {
          if (!selector || text === undefined) {
            throw new Error(
              "Selector and text are required for 'type' action.",
            );
          }
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.type(selector, text);
          resultText = `Successfully typed text into element matching selector '${selector}'.`;
          break;
        }
        case "screenshot": {
          const screenshotPath = path.join(
            getProjectSessionsDir(),
            "browser_screenshot.png",
          );
          await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
          await page.screenshot({ path: screenshotPath });
          resultText = `Screenshot successfully saved to local file: file://${screenshotPath}`;
          break;
        }
        case "get_content": {
          const content = await page.evaluate(() => document.body.innerText);
          resultText = `Page Content (URL: ${page.url()}):\n\n${content}`;
          break;
        }
      }

      if (waitForSelector) {
        try {
          await page.waitForSelector(waitForSelector, { timeout: 5000 });
          resultText += ` (Completed waiting for selector '${waitForSelector}')`;
        } catch {
          resultText += ` (Warning: Timeout waiting for selector '${waitForSelector}')`;
        }
      }

      // Disconnect so the browser remains running in background
      browser.disconnect();
      return resultText;
    } catch (error: any) {
      if (browser) {
        try {
          browser.disconnect();
        } catch {
          // Browser may already be disconnected
        }
      }
      return `Error in browser control: ${error.message}`;
    }
  },
};
