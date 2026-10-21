import { existsSync } from "node:fs";
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type OpenDialogOptions } from "electron";
import { RELEASES_URL, type DownloadDecision, type MediaChoice, type MediaDecision, type SavedSource, type Settings } from "@turbodl/shared";
import type { AppController } from "./controller";

export const EVENT_CHANNEL = "turbodl:event";

/** A feed as the renderer names it; anything else is All. */
function savedSource(v: unknown): SavedSource {
  const o = v as { kind?: unknown; id?: unknown } | null;
  return o?.kind === "collection" && typeof o.id === "string" ? { kind: "collection", id: o.id } : { kind: "all" };
}

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
  handle("probeStream", (id: string, index: number) => c.probeStream(String(id), Number(index)));
  handle("confirmMedia", (id: string, choice: MediaChoice, decision: MediaDecision) => c.confirmMedia(id, choice, decision));
  handle("findInstagram", (id: string) => c.findInstagram(String(id)));
  handle("confirmInstagram", (id: string, indices: unknown, mode: unknown) =>
    c.confirmInstagram(String(id), Array.isArray(indices) ? indices.map(Number).filter(Number.isInteger) : [], mode === "later" ? "later" : "now"),
  );
  handle("instagramSignIn", (id: unknown) => c.instagramSignIn(typeof id === "string" ? id : undefined));
  handle("instagramAccount", () => c.instagramAccount());
  handle("instagramSignOut", () => c.instagramSignOut());
  handle("savedCollections", (refresh: unknown) => c.savedCollections(refresh === true));
  handle("savedPage", (source: unknown, cursor: unknown) => c.savedPage(savedSource(source), typeof cursor === "string" ? cursor : undefined));
  handle("openSavedPicks", (ids: unknown) => c.openSavedPicks(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []));
  handle("backupPlan", (id: unknown) => c.backupPlan(String(id)));
  handle("startBackup", (id: unknown) => c.startBackup(String(id)));
  handle("stopBackup", () => c.stopBackup());
  const name = (v: unknown) => (typeof v === "string" ? v : "");
  handle("profileLoad", (username: unknown) => c.profileLoad(name(username)));
  handle("profilePage", (username: unknown, cursor: unknown) => c.profilePage(name(username), typeof cursor === "string" ? cursor : undefined));
  handle("openProfilePicks", (username: unknown, ids: unknown) =>
    c.openProfilePicks(name(username), Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []),
  );
  handle("profileBackupPlan", (username: unknown) => c.profileBackupPlan(name(username)));
  handle("startProfileBackup", (username: unknown) => c.startProfileBackup(name(username)));
  handle("instagramProfiles", () => c.instagramProfiles());
  handle("removeInstagramProfile", (id: unknown) => c.removeInstagramProfile(name(id)));
  handle("closeProfile", (username: unknown) => c.closeProfile(name(username)));
  handle("takeOpenRequest", () => c.takeOpenRequest());
  handle("cancelCountdown", () => c.cancelCountdown());
  handle("installExtension", async () => {
    const result = await c.installExtension();
    if (result.ok) await shell.openPath(result.path);
    return result;
  });
  handle("copyText", (text: string) => {
    c.noteOwnClipboardText(String(text));
    return clipboard.writeText(String(text));
  });
  handle("readClipboardText", () => clipboard.readText());
  handle("openReleasesPage", () => shell.openExternal(RELEASES_URL));
  ipcMain.handle("turbodl:closeWindow", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
}

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}
