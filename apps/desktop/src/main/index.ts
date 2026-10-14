import path from "node:path";
import { Notification, app, clipboard, shell, type Tray } from "electron";
import { ClipboardWatcher } from "./clipboard-watcher";
import { AppController } from "./controller";
import { EVENT_CHANNEL, broadcast, registerIpc } from "./ipc";
import { appIconPath, extensionSourceDir, ffmpegPath, trayIconPath } from "./paths";
import { createTray } from "./tray";
import { WindowManager } from "./windows";

if (process.env.TURBODL_USER_DATA) app.setPath("userData", process.env.TURBODL_USER_DATA);

let controller: AppController | null = null;
let windows: WindowManager | null = null;
let tray: Tray | null = null;
let watcher: ClipboardWatcher | null = null;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => windows?.showMain());
  app.on("activate", () => windows?.showMain());
  app.on("window-all-closed", () => {
    // keep running in the tray
  });
  app.on("before-quit", (event) => {
    watcher?.stop();
    if (windows) windows.quitting = true;
    if (shuttingDown || !controller) return;
    event.preventDefault();
    shuttingDown = true;
    void controller.shutdown().finally(() => app.quit());
  });
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  if (process.platform === "win32") app.setAppUserModelId("com.turbodl.app");
  const wm = new WindowManager({
    preload: path.join(__dirname, "../preload/index.js"),
    icon: appIconPath(),
    closeToTray: () => controller?.settings.closeToTray ?? true,
    onDialogClosed: (pendingId) => controller?.cancelPending(pendingId),
    onMainClosed: () => app.quit(),
  });
  windows = wm;
  const c = new AppController({
    version: app.getVersion(),
    userDataDir: app.getPath("userData"),
    downloadsDir: app.getPath("downloads"),
    documentsDir: app.getPath("documents"),
    extensionSourceDir: extensionSourceDir(),
    ffmpegPath: ffmpegPath(),
    ui: {
      broadcast: (event) => broadcast(EVENT_CHANNEL, event),
      openPending: (item) => wm.openDialog(item.pendingId, item.type === "media" ? "media" : "new"),
      closePending: (pendingId) => wm.closeDialog(pendingId),
      showMain: () => wm.showMain(),
      notifyCompleted: (record) => {
        if (!c.settings.notifyOnComplete || !Notification.isSupported()) return;
        const note = new Notification({ title: "Download complete", body: record.filename, icon: appIconPath() });
        note.on("click", () => shell.showItemInFolder(path.join(record.dir, record.filename)));
        note.show();
      },
      setLaunchAtLogin: (enabled) => app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] }),
      quit: () => app.quit(),
    },
  });
  controller = c;
  registerIpc(c);
  await c.init();
  watcher = new ClipboardWatcher({ read: () => clipboard.readText(), onText: (text) => void c.handleClipboardText(text) });
  watcher.start();
  tray = createTray({
    icon: trayIconPath(),
    onShow: () => wm.showMain(),
    onPauseAll: () => c.manager.stopAll(),
    onQuit: () => app.quit(),
  });
  const hidden = process.argv.includes("--hidden") || app.getLoginItemSettings().wasOpenedAtLogin;
  if (!hidden) wm.showMain();
  void tray;
}
