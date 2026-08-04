import { app, BrowserWindow } from "electron";
import * as path from "path";
import { CSP_POLICY } from "./main/csp.ts";
import { registerIpcHandlers } from "./main/ipc.ts";
import { createWindow } from "./main/windows.ts";
import { cleanupAgentOnQuit, cleanupAgentOnWindowClose } from "./main/agent-bridge.ts";
import { UI_DIR } from "./main/paths.ts";

// Set application name early so it registers properly with OS Dock and menus
app.setName("Quiver");

export { CSP_POLICY } from "./main/csp.ts";
export { registerIpcHandlers } from "./main/ipc.ts";
export type { QuiverConfig, ProviderConfig } from "./main/config.ts";

app.whenReady().then(async () => {
  app.setName("Quiver");

  if (process.platform === "darwin" && app.dock) {
    try {
      app.dock.setIcon(path.join(UI_DIR, "renderer", "icon.png"));
    } catch (e) {
      console.error("Failed to set dock icon:", e);
    }
  }

  const { Menu } = await import("electron");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Quiver", submenu: [
      { role: "about", label: "About Quiver" },
      { type: "separator" },
      { role: "quit", label: "Quit Quiver" },
    ]},
    { label: "Edit", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ]},
    { label: "View", submenu: [
      { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
      { role: "togglefullscreen" },
    ]},
  ]));

  const { session } = await import("electron");
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CSP_POLICY],
      },
    });
  });

  registerIpcHandlers();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  cleanupAgentOnWindowClose();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  cleanupAgentOnQuit();
});
