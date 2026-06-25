import { z } from "zod";
import puppeteer from "puppeteer";
import { promises as fs } from "fs";
import * as path from "path";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "browser_control",
  description: "Controls a persistent headless browser session to navigate, click, type, screenshot, or extract content.",
  parameters: z.object({
    action: z.enum(["navigate", "click", "type", "screenshot", "get_content", "close"])
      .describe("The action to perform in the browser."),
    url: z.string().optional()
      .describe("The target URL (required for 'navigate')."),
    selector: z.string().optional()
      .describe("CSS selector for elements (required for 'click' or 'type')."),
    text: z.string().optional()
      .describe("The text content to input (required for 'type')."),
    waitForSelector: z.string().optional()
      .describe("Optional CSS selector to wait for after performing the action."),
  }),
  execute: async ({ action, url, selector, text, waitForSelector }) => {
    const wsPath = path.resolve(".sessions", "browser_ws.txt");
    let browser: puppeteer.Browser | null = null;
    let wsUrl = "";

    try {
      wsUrl = await fs.readFile(wsPath, "utf8");
    } catch (e) {
      // File does not exist yet
    }

    // Try connecting to existing browser
    if (wsUrl) {
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: wsUrl });
      } catch (e) {
        // Failed to connect, will launch a new one below
      }
    }

    // Launch a new browser if none connected
    if (!browser) {
      browser = await puppeteer.launch({
        headless: config.browserHeadless,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      wsUrl = browser.wsEndpoint();
      await fs.mkdir(path.dirname(wsPath), { recursive: true });
      await fs.writeFile(wsPath, wsUrl, "utf8");
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
          await page.goto(url, { waitUntil: "networkidle2" });
          resultText = `Successfully navigated to ${url}. Current URL: ${page.url()}`;
          break;
        }
        case "click": {
          if (!selector) throw new Error("Selector is required for 'click' action.");
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          resultText = `Successfully clicked element matching selector '${selector}'.`;
          break;
        }
        case "type": {
          if (!selector || text === undefined) {
            throw new Error("Selector and text are required for 'type' action.");
          }
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.type(selector, text);
          resultText = `Successfully typed text into element matching selector '${selector}'.`;
          break;
        }
        case "screenshot": {
          const screenshotPath = path.resolve(".sessions", "browser_screenshot.png");
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
        } catch (e) {
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
        } catch (e) {}
      }
      return `Error in browser control: ${error.message}`;
    }
  },
};
