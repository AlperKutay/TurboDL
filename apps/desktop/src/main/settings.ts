import path from "node:path";
import { DEFAULT_BRIDGE_PORT, DEFAULT_CAPTURE_EXTENSIONS, type AfterAllAction, type Settings } from "@turbodl/shared";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const AFTER_ALL: AfterAllAction[] = ["none", "sleep", "shutdown", "quit"];

export function defaultSettings(downloadsDir: string): Settings {
  return {
    baseDir: path.join(downloadsDir, "TurboDL"),
    maxConnections: 8,
    maxConcurrent: 3,
    confirmBeforeDownload: true,
    captureEnabled: true,
    captureExtensions: [...DEFAULT_CAPTURE_EXTENSIONS],
    minCaptureSize: 0,
    launchAtLogin: false,
    bridgePort: DEFAULT_BRIDGE_PORT,
    closeToTray: true,
    notifyOnComplete: true,
    watchClipboard: true,
    scheduler: { enabled: false, startTime: "02:00", stopTime: null, afterAll: "none" },
  };
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeExtensions(list: unknown[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const ext = item.trim().toLowerCase().replace(/^\.+/, "");
    if (/^[a-z0-9]{1,10}$/.test(ext) && !out.includes(ext)) out.push(ext);
  }
  return out;
}

export function normalizeSettings(input: unknown, defaults: Settings): Settings {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const schedSrc = (src.scheduler && typeof src.scheduler === "object" ? src.scheduler : {}) as Record<string, unknown>;
  const d = defaults.scheduler;
  return {
    baseDir: typeof src.baseDir === "string" && src.baseDir.trim() ? src.baseDir : defaults.baseDir,
    maxConnections: clampInt(src.maxConnections, 1, 16, defaults.maxConnections),
    maxConcurrent: clampInt(src.maxConcurrent, 1, 10, defaults.maxConcurrent),
    confirmBeforeDownload: bool(src.confirmBeforeDownload, defaults.confirmBeforeDownload),
    captureEnabled: bool(src.captureEnabled, defaults.captureEnabled),
    captureExtensions: Array.isArray(src.captureExtensions) ? normalizeExtensions(src.captureExtensions) : defaults.captureExtensions,
    minCaptureSize: clampInt(src.minCaptureSize, 0, Number.MAX_SAFE_INTEGER, defaults.minCaptureSize),
    launchAtLogin: bool(src.launchAtLogin, defaults.launchAtLogin),
    bridgePort: clampInt(src.bridgePort, 1024, 65535, defaults.bridgePort),
    closeToTray: bool(src.closeToTray, defaults.closeToTray),
    notifyOnComplete: bool(src.notifyOnComplete, defaults.notifyOnComplete),
    watchClipboard: bool(src.watchClipboard, defaults.watchClipboard),
    scheduler: {
      enabled: bool(schedSrc.enabled, d.enabled),
      startTime: typeof schedSrc.startTime === "string" && TIME.test(schedSrc.startTime) ? schedSrc.startTime : d.startTime,
      stopTime:
        schedSrc.stopTime === null
          ? null
          : typeof schedSrc.stopTime === "string" && TIME.test(schedSrc.stopTime)
            ? schedSrc.stopTime
            : d.stopTime,
      afterAll: AFTER_ALL.includes(schedSrc.afterAll as AfterAllAction) ? (schedSrc.afterAll as AfterAllAction) : d.afterAll,
    },
  };
}

export function mergeSettings(current: Settings, patch: Partial<Settings>, defaults: Settings): Settings {
  return normalizeSettings(
    { ...current, ...patch, scheduler: { ...current.scheduler, ...(patch.scheduler ?? {}) } },
    defaults,
  );
}
