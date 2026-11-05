import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, mergeSettings, normalizeExtensions, normalizeSettings } from "./settings";

const defaults = defaultSettings("/home/u/Downloads");

describe("settings", () => {
  it("has sensible defaults", () => {
    expect(defaults.baseDir).toBe(path.join("/home/u/Downloads", "TurboDL"));
    expect(defaults).toMatchObject({ maxConnections: 8, maxConcurrent: 3, bridgePort: 47123, confirmBeforeDownload: true });
    expect(defaults.scheduler).toEqual({ enabled: false, startTime: "02:00", stopTime: null, afterAll: "none" });
    expect(defaults.captureExtensions).toContain("zip");
  });

  it("clamps numbers and rejects bad values", () => {
    const s = normalizeSettings(
      { maxConnections: 99, maxConcurrent: 0, bridgePort: 80, baseDir: "  ", minCaptureSize: -5, closeToTray: "yes" },
      defaults,
    );
    expect(s.maxConnections).toBe(16);
    expect(s.maxConcurrent).toBe(1);
    expect(s.bridgePort).toBe(1024);
    expect(s.baseDir).toBe(defaults.baseDir);
    expect(s.minCaptureSize).toBe(0);
    expect(s.closeToTray).toBe(defaults.closeToTray);
  });

  it("watches the clipboard unless switched off", () => {
    expect(defaults.watchClipboard).toBe(true);
    expect(normalizeSettings({ watchClipboard: false }, defaults).watchClipboard).toBe(false);
    expect(normalizeSettings({ watchClipboard: "no" }, defaults).watchClipboard).toBe(true);
  });

  it("puts Instagram downloads in a folder per account unless switched off", () => {
    expect(defaults.instagramByAccount).toBe(true);
    expect(normalizeSettings({ instagramByAccount: false }, defaults).instagramByAccount).toBe(false);
    expect(normalizeSettings({ instagramByAccount: "no" }, defaults).instagramByAccount).toBe(true);
  });

  it("saves everything of a profile unless told otherwise", () => {
    expect(defaults.instagramSave).toEqual({ posts: true, highlights: true, tagged: true, photos: true, videos: true });
    expect(normalizeSettings({ instagramSave: { posts: "x", videos: false } }, defaults).instagramSave).toEqual({ posts: true, highlights: true, tagged: true, photos: true, videos: false });
  });

  it("waits two to five minutes between a list's profiles unless the range is valid", () => {
    expect(defaults.listWait).toEqual({ min: 2, max: 5 });
    expect(normalizeSettings({ listWait: { min: 9, max: 1 } }, defaults).listWait).toEqual({ min: 2, max: 5 });
    expect(normalizeSettings({ listWait: { min: 0, max: 30 } }, defaults).listWait).toEqual({ min: 0, max: 30 });
    expect(normalizeSettings({ listWait: "x" }, defaults).listWait).toEqual({ min: 2, max: 5 });
  });

  it("validates scheduler times", () => {
    const s = normalizeSettings({ scheduler: { enabled: true, startTime: "25:00", stopTime: "07:30", afterAll: "explode" } }, defaults);
    expect(s.scheduler).toEqual({ enabled: true, startTime: "02:00", stopTime: "07:30", afterAll: "none" });
  });

  it("normalizes extension lists", () => {
    expect(normalizeExtensions([".ZIP", "zip", " mp4 ", "bad ext!", 5])).toEqual(["zip", "mp4"]);
  });

  it("merges partial patches, including partial scheduler patches", () => {
    const merged = mergeSettings(defaults, { maxConnections: 4, scheduler: { afterAll: "shutdown" } as never }, defaults);
    expect(merged.maxConnections).toBe(4);
    expect(merged.scheduler).toEqual({ ...defaults.scheduler, afterAll: "shutdown" });
    const cleared = mergeSettings({ ...defaults, scheduler: { ...defaults.scheduler, stopTime: "06:00" } }, { scheduler: { stopTime: null } as never }, defaults);
    expect(cleared.scheduler.stopTime).toBeNull();
  });

  it("telegram defaults to off with no chat", () => {
    expect(defaultSettings("/home/u/Downloads").telegram).toEqual({ enabled: false, chatId: null });
  });

  it("telegram normalises", () => {
    expect(normalizeSettings({ telegram: { enabled: "yes", chatId: -5 } }, defaults).telegram).toEqual(defaults.telegram);
    expect(normalizeSettings({ telegram: { enabled: true, chatId: 123456789 } }, defaults).telegram).toEqual({ enabled: true, chatId: 123456789 });
    for (const chatId of [1.5, "42", 2 ** 53]) expect(normalizeSettings({ telegram: { enabled: true, chatId } }, defaults).telegram.chatId).toBeNull();
  });

  it("mergeSettings merges telegram", () => {
    const merged = mergeSettings({ ...defaults, telegram: { enabled: true, chatId: 7 } }, { telegram: { enabled: false } as never }, defaults);
    expect(merged.telegram).toEqual({ enabled: false, chatId: 7 });
  });
});
