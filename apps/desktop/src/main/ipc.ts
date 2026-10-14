import { existsSync } from "node:fs";
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import type { DownloadDecision, MediaChoice, MediaDecision, Settings } from "@turbodl/shared";
import type { AppController } from "./controller";

export const EVENT_CHANNEL = "turbodl:event";

export function registerIpc(c: AppController): void {
  const handle = (name: string, fn: (...args: any[]) => unknown) => {
    ipcMain.handle(`turbodl:${name}`, (_event, ...args: unknown[]) => fn(...args));
  };

  handle("getSnapshot", () => c.snapshot());
  handle("addUrl", (url: string) => c.addUrl(String(url)));
  handle("pause", (ids: string[]) => c.manager.pause(ids));
  handle("resume", (ids: string[]) => c.manager.resume(ids));
  handle("remove", (ids: string[], deleteFiles: boolean) => c.manager.remove(ids, Boolean(deleteFiles)));
  handle("openFile", async (id: string) => {
    const file = c.filePath(id);
    if (file) await shell.openPath(file);
  });
  handle("showInFolder", async (id: string) => {
    const file = c.filePath(id);
    if (file) {
      shell.showItemInFolder(file);
      return;
    }
    const dir = c.folderPath(id);
    if (dir && existsSync(dir)) await shell.openPath(dir);
  });
  handle("refreshUrl", (id: string, url: string) => c.refreshUrl(id, String(url)));
  handle("startAll", () => c.manager.startAll());
  handle("stopAll", () => c.manager.stopAll());
  handle("updateSettings", (patch: Partial<Settings>) => c.updateSettings(patch));
  handle("chooseFolder", async (current?: string) => {
    const options: OpenDialogOptions = { defaultPath: current, properties: ["openDirectory", "createDirectory"] };
    const win = BrowserWindow.getFocusedWindow();
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle("getPending", (id: string) => c.getPending(id));
  handle("confirmDownload", (id: string, decision: DownloadDecision) => c.confirmDownload(id, decision));
  handle("cancelPending", (id: string) => c.cancelPending(id));
  handle("probeMediaFormats", (id: string) => c.probeMediaFormats(id));
  handle("confirmMedia", (id: string, choice: MediaChoice, decision: MediaDecision) => c.confirmMedia(id, choice, decision));
  handle("cancelCountdown", () => c.cancelCountdown());
  handle("installExtension", async () => {
    const result = await c.installExtension();
    if (result.ok) await shell.openPath(result.path);
    return result;
  });
  handle("copyText", (text: string) => clipboard.writeText(String(text)));
  handle("readClipboardText", () => clipboard.readText());
  ipcMain.handle("turbodl:closeWindow", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
