import path from "node:path";
import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";

export interface WindowManagerOptions {
  preload: string;
  icon: string;
  closeToTray: () => boolean;
  onDialogClosed: (pendingId: string) => void;
  onMainClosed: () => void;
}

export class WindowManager {
  quitting = false;
  private main: BrowserWindow | null = null;
  private readonly dialogs = new Map<string, BrowserWindow>();

  constructor(private readonly o: WindowManagerOptions) {}

  showMain(): void {
    if (this.main && !this.main.isDestroyed()) {
      if (this.main.isMinimized()) this.main.restore();
      this.main.show();
      this.main.focus();
      return;
    }
    const win = this.create({ width: 1120, height: 700, minWidth: 780, minHeight: 440, title: "TurboDL" });
    win.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      if (this.o.closeToTray()) win.hide();
      else this.o.onMainClosed();
    });
    win.on("closed", () => {
      this.main = null;
    });
    this.load(win, "/");
    this.main = win;
  }

  openDialog(pendingId: string, kind: "new" | "media"): void {
    const media = kind === "media";
    const win = this.create({
      width: media ? 640 : 580,
      height: media ? 560 : 420,
      minWidth: 480,
      minHeight: 360,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      title: media ? "Download video" : "New download",
    });
    win.on("closed", () => {
      this.dialogs.delete(pendingId);
      this.o.onDialogClosed(pendingId);
    });
    this.load(win, `/${kind}/${pendingId}`);
    this.dialogs.set(pendingId, win);
  }

  closeDialog(pendingId: string): void {
    const win = this.dialogs.get(pendingId);
    if (win && !win.isDestroyed()) win.close();
  }

  private create(options: BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({
      ...options,
      show: false,
      icon: this.o.icon,
      autoHideMenuBar: true,
      webPreferences: { preload: this.o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    return win;
  }

  private load(win: BrowserWindow, route: string): void {
    const devUrl = process.env.ELECTRON_RENDERER_URL;
    if (devUrl) void win.loadURL(`${devUrl}#${route}`);
    else void win.loadFile(path.join(__dirname, "../renderer/index.html"), { hash: route });
  }
}
