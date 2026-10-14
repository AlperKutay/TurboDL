import { existsSync } from "node:fs";
import path from "node:path";
import { app } from "electron";

function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources");
}

export function appIconPath(): string {
  return path.join(resourcesRoot(), "icons", "icon.png");
}

export function trayIconPath(): string {
  return path.join(resourcesRoot(), "icons", process.platform === "darwin" ? "trayTemplate.png" : "tray.png");
}

export function extensionSourceDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "extension") : path.join(app.getAppPath(), "..", "extension", "dist");
}

export function ffmpegPath(): string | null {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    return existsSync(bundled) ? bundled : null;
  }
  try {
    const dev = require("ffmpeg-static") as string | null;
    return dev && existsSync(dev) ? dev : null;
  } catch {
    return null;
  }
}

export function nativeHostScript(): string {
  return path.join(resourcesRoot(), "native-host", "host.cjs");
}
