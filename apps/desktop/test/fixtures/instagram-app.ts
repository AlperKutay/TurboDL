import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { AppEvent, BrowserCookie, PendingItem } from "@turbodl/shared";
import { AppController, type ControllerUi, type InstagramDeps } from "../../src/main/controller";

/** The cookies a sign-in to Instagram leaves. */
export const SESSION: BrowserCookie[] = [
  { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
  { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
];

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** The app's windows stood in for: every event it broadcasts is kept. */
export class FakeUi implements ControllerUi {
  events: AppEvent[] = [];
  broadcast(e: AppEvent) {
    this.events.push(e);
  }
  openPending(_item: PendingItem) {}
  closePending() {}
  showMain() {}
  notifyCompleted() {}
  setLaunchAtLogin() {}
  quit() {}
}

/**
 * The app over Instagram stand-ins, everything it keeps under `root`: user data in `user`, downloads in `dl`, the
 * bridge on a free port. The caller shuts it down.
 */
export async function startApp(root: string, ui: ControllerUi, instagram: InstagramDeps): Promise<AppController> {
  const userData = path.join(root, "user");
  mkdirSync(userData, { recursive: true });
  writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ baseDir: path.join(root, "dl"), bridgePort: await freePort() }));
  const extensionDir = path.join(root, "ext");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, "manifest.json"), "{}");
  const controller = new AppController({
    version: "0.0.1",
    userDataDir: userData,
    downloadsDir: path.join(root, "Downloads"),
    documentsDir: path.join(root, "Documents"),
    extensionSourceDir: extensionDir,
    ffmpegPath: null,
    ui,
    launch: { file: "turbodl-test", args: ["--hidden"] },
    mediaTools: { ensure: async () => ({ ytdlp: "unused", deno: null, ffmpeg: null }), updateIfStale: async () => undefined },
    instagram,
  });
  await controller.init();
  return controller;
}
