import { app, BrowserWindow } from "electron";
import * as path from "path";
import { isConfigured } from "./config.ts";
import { UI_DIR } from "./paths.ts";
import {
  getMainWindow,
  getSettingsWindow,
  setMainWindow,
  setSettingsWindow,
} from "./windows-state.ts";

async function fs2read(ws: typeof import("fs/promises"), p: string): Promise<string> {
  return ws.readFile(p, "utf8");
}

export async function createWindow(): Promise<void> {
  const configured = await isConfigured();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: "Quiver",
    show: false,
    icon: path.join(UI_DIR, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(UI_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setMainWindow(win);

  const windowStateFile = path.join(app.getPath("userData"), "window-state.json");
  try {
    const ws = await import("fs/promises");
    const saved = JSON.parse(await fs2read(ws, windowStateFile));
    if (saved && typeof saved.width === "number" && typeof saved.height === "number") {
      const screen = (await import("electron")).screen;
      const displays = screen.getAllDisplays();
      const onScreen = displays.some((d) => {
        const a = d.workArea;
        return saved.x >= a.x - 200 && saved.y >= a.y - 200 &&
          saved.x + saved.width <= a.x + a.width + 200 &&
          saved.y + saved.height <= a.y + a.height + 200;
      });
      const width = Math.max(800, Math.min(saved.width, 2400));
      const height = Math.max(600, Math.min(saved.height, 1800));
      win.setBounds({ x: onScreen ? saved.x : undefined, y: onScreen ? saved.y : undefined, width, height });
    }
  } catch {
    // no saved state — use defaults
  }
  const persistBounds = () => {
    const current = getMainWindow();
    if (!current) return;
    const b = current.getBounds();
    import("fs/promises").then((ws) => ws.writeFile(windowStateFile, JSON.stringify(b), "utf8")).catch(() => {});
  };
  win.on("resize", persistBounds);
  win.on("move", persistBounds);
  win.on("close", persistBounds);

  win.once("ready-to-show", () => {
    getMainWindow()?.show();
  });

  if (!configured) {
    win.loadFile(path.join(UI_DIR, "renderer", "onboarding.html"));
  } else {
    win.loadFile(path.join(UI_DIR, "renderer", "index.html"));
  }
}

export async function createSettingsWindow(): Promise<void> {
  const parent = getMainWindow();
  const win = new BrowserWindow({
    width: 720,
    height: 780,
    minWidth: 560,
    minHeight: 480,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    show: false,
    title: "Settings — Quiver",
    icon: path.join(UI_DIR, "renderer", "icon.png"),
    webPreferences: {
      preload: path.join(UI_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  setSettingsWindow(win);
  win.once("ready-to-show", () => getSettingsWindow()?.show());
  win.on("closed", () => {
    setSettingsWindow(null);
  });
  await win.loadFile(path.join(UI_DIR, "renderer", "settings.html"));
}

export function loadMainView(): void {
  const main = getMainWindow();
  const url = main?.webContents.getURL() || "";
  if (!/index\.html(?:\?|#|$)/.test(url)) {
    main?.loadFile(path.join(UI_DIR, "renderer", "index.html"));
  }
}

export function loadOnboardingView(): void {
  getMainWindow()?.loadFile(path.join(UI_DIR, "renderer", "onboarding.html"));
}
