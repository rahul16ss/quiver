import { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow;
}

export function setSettingsWindow(win: BrowserWindow | null): void {
  settingsWindow = win;
}

export function closeSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
    settingsWindow = null;
  }
}

export function focusSettingsWindow(): boolean {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return true;
  }
  return false;
}
