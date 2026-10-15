import path from "node:path";
import { pathToFileURL } from "node:url";

/** Windows identity of the installed app; must match electron-builder's appId (Start menu shortcut). */
export const APP_USER_MODEL_ID = "com.turbodl.app";

export interface NotificationIdentity {
  appUserModelId: string;
  enabled: boolean;
}

/**
 * On Windows, Electron registers a Start menu shortcut and a notification activator for the
 * AppUserModelID. Development and test runs get their own IDs so they never take over the
 * installed app's notifications; test runs (isolated profile) show no notifications at all.
 */
export function notificationIdentity(o: { isPackaged: boolean; isolated: boolean }): NotificationIdentity {
  if (o.isolated) return { appUserModelId: `${APP_USER_MODEL_ID}.test`, enabled: false };
  if (!o.isPackaged) return { appUserModelId: `${APP_USER_MODEL_ID}.dev`, enabled: true };
  return { appUserModelId: APP_USER_MODEL_ID, enabled: true };
}

const SHOW = "turbodl-show:";

/** Activation argument a Windows toast carries, so a click can open the file even after a restart. */
export function showArgument(file: string): string {
  return SHOW + encodeURIComponent(file);
}

export function fileFromArgument(arg: string): string | null {
  if (!arg.startsWith(SHOW)) return null;
  try {
    return decodeURIComponent(arg.slice(SHOW.length)) || null;
  } catch {
    return null;
  }
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function fileUrl(file: string): string {
  // Windows paths are written by hand so the result does not depend on the platform running this code
  if (/^[A-Za-z]:\\/.test(file)) return `file:///${encodeURI(file.replace(/\\/g, "/"))}`;
  return pathToFileURL(file).href;
}

export function toastXml(o: { title: string; body: string; launch: string; icon?: string }): string {
  const image = o.icon ? `<image placement="appLogoOverride" src="${xmlEscape(fileUrl(o.icon))}"/>` : "";
  return (
    `<toast launch="${xmlEscape(o.launch)}" activationType="foreground">` +
    `<visual><binding template="ToastGeneric">${image}<text>${xmlEscape(o.title)}</text><text>${xmlEscape(o.body)}</text></binding></visual>` +
    `</toast>`
  );
}

export interface RevealDeps {
  exists(p: string): boolean;
  showItemInFolder(p: string): void;
  openPath(p: string): unknown;
}

/** Select the file in Explorer/Finder; if it was moved or deleted, open its folder instead. */
export function revealDownload(file: string, deps: RevealDeps): "file" | "folder" | "none" {
  if (deps.exists(file)) {
    deps.showItemInFolder(file);
    return "file";
  }
  const dir = path.dirname(file);
  if (deps.exists(dir)) {
    deps.openPath(dir);
    return "folder";
  }
  return "none";
}

export interface NotificationLike {
  on(event: "click", listener: () => void): void;
  show(): void;
}

export interface NotifierOptions {
  platform: NodeJS.Platform;
  enabled: () => boolean;
  create: (options: Record<string, unknown>) => NotificationLike;
  reveal: (file: string) => void;
  icon?: string;
  /** how many recent notifications stay referenced, so their click events still fire */
  keep?: number;
}

const TITLE = "Download complete";

/** "Download complete" notifications whose click opens the downloaded file's folder. */
export class CompletionNotifier {
  private readonly recent: NotificationLike[] = [];

  constructor(private readonly o: NotifierOptions) {}

  get retained(): number {
    return this.recent.length;
  }

  show(file: string): void {
    if (!this.o.enabled()) return;
    const body = path.basename(file.replace(/\\/g, "/"));
    if (this.o.platform === "win32") {
      // the click arrives through Notification.handleActivation, also after a restart
      const note = this.o.create({ title: TITLE, body, toastXml: toastXml({ title: TITLE, body, launch: showArgument(file), icon: this.o.icon }) });
      note.show();
      return;
    }
    const note = this.o.create({ title: TITLE, body, ...(this.o.icon ? { icon: this.o.icon } : {}) });
    note.on("click", () => this.o.reveal(file));
    note.show();
    this.recent.push(note);
    if (this.recent.length > (this.o.keep ?? 20)) this.recent.shift();
  }

  handleActivation(arg: string): void {
    const file = fileFromArgument(arg);
    if (file) this.o.reveal(file);
  }
}
