import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Notification, app, clipboard, safeStorage, shell, type Tray } from "electron";
import { ClipboardWatcher } from "./clipboard-watcher";
import { clientLaunch } from "./api-file";
import { applyAutostart, autostartFile } from "./autostart";
import { AppController } from "./controller";
import { chromeAgent } from "./instagram/agent";
import { DEMO_COOKIE, demoInstagram } from "./instagram/demo";
import { InstagramFinder } from "./instagram/finder";
import { loadCollections } from "./instagram/collections";
import { ProfileFeed } from "./instagram/profile-feed";
import { ElectronInstagramPage, allowTestSite, instagramSession } from "./instagram/page";
import { signInToInstagram } from "./instagram/signin";
import { EVENT_CHANNEL, broadcast, registerIpc } from "./ipc";
import { writeCliLauncher } from "./cli-install";
import { isBackgroundLaunch, registerNativeHost } from "./native-host";
import { CompletionNotifier, notificationIdentity, revealDownload } from "./notifications";
import { appIconPath, cliLauncherExe, cliScript, extensionSourceDir, ffmpegPath, nativeHostScript, trayIconPath } from "./paths";
import { createTray } from "./tray";
import { WindowManager } from "./windows";

if (process.env.TURBODL_USER_DATA) app.setPath("userData", process.env.TURBODL_USER_DATA);
/** A made-up Instagram for the e2e tests; only with an isolated profile. */
const instagramDemoBase = process.env.TURBODL_USER_DATA ? process.env.TURBODL_INSTAGRAM_DEMO_BASE : undefined;
/** The demo started without its session, as signed-out visitors see Instagram; only with an isolated profile. */
const instagramDemoSignedOut = Boolean(instagramDemoBase) && process.env.TURBODL_INSTAGRAM_DEMO_SIGNED_OUT === "1";
/** A local stand-in for Instagram's pages, read by the real hidden pages, for the e2e tests; only with an isolated profile. */
const instagramTestSite = process.env.TURBODL_USER_DATA ? process.env.TURBODL_INSTAGRAM_SITE : undefined;
if (instagramTestSite) allowTestSite(instagramTestSite);
const identity = notificationIdentity({ isPackaged: app.isPackaged, isolated: Boolean(process.env.TURBODL_USER_DATA) });

let controller: AppController | null = null;
let windows: WindowManager | null = null;
let tray: Tray | null = null;
let watcher: ClipboardWatcher | null = null;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (!isBackgroundLaunch(argv)) windows?.showMain();
  });
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
  if (process.platform === "win32") app.setAppUserModelId(identity.appUserModelId);
  const notifier = new CompletionNotifier({
    platform: process.platform,
    enabled: () => identity.enabled && (controller?.settings.notifyOnComplete ?? false) && Notification.isSupported(),
    create: (options) => new Notification(options as Electron.NotificationConstructorOptions),
    reveal: (file) => void revealDownload(file, { exists: existsSync, showItemInFolder: (p) => shell.showItemInFolder(p), openPath: (p) => shell.openPath(p) }),
    icon: appIconPath(),
  });
  // a click on a toast reaches us here even after a restart (the app is then started with -Embedding)
  if (process.platform === "win32" && identity.enabled) Notification.handleActivation((details) => notifier.handleActivation(details.arguments));
  const wm = new WindowManager({
    preload: path.join(__dirname, "../preload/index.js"),
    icon: appIconPath(),
    closeToTray: () => controller?.settings.closeToTray ?? true,
    onDialogClosed: (pendingId) => controller?.cancelPending(pendingId),
    onMainClosed: () => app.quit(),
  });
  windows = wm;
  const launch = clientLaunch({ platform: process.platform, execPath: process.execPath, isPackaged: app.isPackaged, appPath: app.getAppPath(), env: process.env });
  /** Launch at login: Electron does it on Windows and macOS; on Linux it is an autostart entry (never from a test run). */
  const setLaunchAtLogin = (enabled: boolean): void => {
    if (process.platform !== "linux") {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ["--hidden"] });
      return;
    }
    if (process.env.TURBODL_USER_DATA) return;
    try {
      applyAutostart({ enabled, file: autostartFile(process.env, app.getPath("home")), launch });
    } catch (err) {
      console.warn("Could not update the autostart entry:", err);
    }
  };
  const c = new AppController({
    version: app.getVersion(),
    launch,
    userDataDir: app.getPath("userData"),
    downloadsDir: app.getPath("downloads"),
    documentsDir: app.getPath("documents"),
    extensionSourceDir: extensionSourceDir(),
    ffmpegPath: ffmpegPath(),
    ui: {
      broadcast: (event) => broadcast(EVENT_CHANNEL, event),
      openPending: (item) => wm.openDialog(item.pendingId, item.type === "download" ? "new" : item.type),
      closePending: (pendingId) => wm.closeDialog(pendingId),
      showMain: () => wm.showMain(),
      notifyCompleted: (record) => notifier.show(path.join(record.dir, record.filename)),
      setLaunchAtLogin,
      quit: () => app.quit(),
    },
    instagram: instagramDemoBase
      ? demoInstagram(instagramDemoBase)
      : {
          find: (link, cookies, signal) =>
            new InstagramFinder(() => new ElectronInstagramPage(cookies), {
              report: instagramReport(),
              site: instagramTestSite,
              signedIn: cookies.some((c) => c.name === "sessionid" && c.value),
            }).find(link, signal),
          signIn: (at) => signInToInstagram(at),
          collections: (username, cookies) => loadCollections(() => new ElectronInstagramPage(cookies), username, { site: instagramTestSite }),
          signOut: () => instagramSession().clearStorageData(),
          openProfile: (username, cookies) =>
            new ProfileFeed(new ElectronInstagramPage(cookies), username, { site: instagramTestSite, signedIn: cookies.some((c) => c.name === "sessionid" && c.value) }),
          crypt: {
            available: () => safeStorage.isEncryptionAvailable(),
            encrypt: (text) => safeStorage.encryptString(text),
            decrypt: (data) => safeStorage.decryptString(data),
          },
          agent: chromeAgent(app.userAgentFallback),
        },
  });
  // test runs: the demo (unless asked to start signed out), or the real pages against a stand-in site, start signed in
  if ((instagramDemoBase && !instagramDemoSignedOut) || instagramTestSite) c.instagramSession.take([DEMO_COOKIE]);
  controller = c;
  registerIpc(c);
  // let the extension start TurboDL; test runs (TURBODL_USER_DATA) must not touch the real browser registration
  if (app.isPackaged && !process.env.TURBODL_USER_DATA) {
    void registerNativeHost({
      platform: process.platform,
      userDataDir: app.getPath("userData"),
      homeDir: app.getPath("home"),
      execPath: process.execPath,
      hostScript: nativeHostScript(),
      env: process.env,
    }).catch((err: unknown) => console.warn("Could not register the browser launcher:", err));
    try {
      writeCliLauncher({ platform: process.platform, userDataDir: app.getPath("userData"), execPath: process.execPath, script: cliScript(), launcherExe: cliLauncherExe(), env: process.env });
    } catch (err) {
      console.warn("Could not write the turbodl launcher:", err);
    }
  }
  await c.init();
  // a moved or newer AppImage rewrites the entry
  if (process.platform === "linux" && app.isPackaged) setLaunchAtLogin(c.settings.launchAtLogin);
  watcher = new ClipboardWatcher({ read: () => clipboard.readText(), onText: (text) => void c.handleClipboardText(text) });
  watcher.start();
  tray = createTray({
    icon: trayIconPath(),
    onShow: () => wm.showMain(),
    onPauseAll: () => c.manager.stopAll(),
    onQuit: () => app.quit(),
  });
  const hidden = isBackgroundLaunch(process.argv) || (process.platform !== "linux" && app.getLoginItemSettings().wasOpenedAtLogin);
  if (!hidden) wm.showMain();
  void tray;
}

/** TURBODL_INSTAGRAM_REPORTS=<folder>: what an Instagram page held when nothing was found on it, for debugging. */
function instagramReport(): ((url: string, documents: string[]) => void) | undefined {
  const dir = process.env.TURBODL_INSTAGRAM_REPORTS;
  if (!dir) return undefined;
  return (url, documents) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${Date.now()}-instagram.json`), JSON.stringify({ url, documents }, null, 1));
  };
}
