import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEvent, PendingItem } from "@turbodl/shared";
import { AppController, type ControllerUi } from "../src/main/controller";
import { startTestServer, type TestServer } from "./fixtures/test-server";

const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

function ping(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/v1/ping", headers: { Origin: ORIGIN } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

class FakeUi implements ControllerUi {
  events: AppEvent[] = [];
  opened: PendingItem[] = [];
  closed: string[] = [];
  shown = 0;
  broadcast(e: AppEvent) {
    this.events.push(e);
  }
  openPending(item: PendingItem) {
    this.opened.push(item);
  }
  closePending(id: string) {
    this.closed.push(id);
  }
  showMain() {
    this.shown++;
  }
  notifyCompleted() {}
  setLaunchAtLogin() {}
  quit() {}
}

let server: TestServer;
let root: string;
let controller: AppController | null;
let ui: FakeUi;

beforeEach(async () => {
  server = await startTestServer();
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-ctl-"));
  controller = null;
  ui = new FakeUi();
  server.setFile("/files/a.zip", { data: Buffer.alloc(2000, 7), contentType: "application/zip" });
  server.setFile("/media/clip.mp4", { data: Buffer.alloc(3000, 1), contentType: "video/mp4" });
  server.setFile("/page", { data: Buffer.from("<html></html>"), contentType: "text/html; charset=utf-8" });
});
afterEach(async () => {
  await controller?.shutdown();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(settings: Record<string, unknown> = {}): Promise<AppController> {
  const userData = path.join(root, "user");
  mkdirSync(userData, { recursive: true });
  const port = (settings.bridgePort as number | undefined) ?? (await freePort());
  writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ baseDir: path.join(root, "dl"), bridgePort: port, ...settings }));
  const extensionDir = path.join(root, "ext");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, "manifest.json"), "{}");
  controller = new AppController({
    version: "0.0.1",
    userDataDir: userData,
    downloadsDir: path.join(root, "Downloads"),
    documentsDir: path.join(root, "Documents"),
    extensionSourceDir: extensionDir,
    ffmpegPath: null,
    ui,
  });
  await controller.init();
  return controller;
}

describe("AppController", () => {
  it("asks for confirmation, then queues with the chosen name and mode", async () => {
    const c = await start();
    const res = await c.handleDownloadRequest({ url: server.url("/files/a.zip"), source: "intercept", cookies: "s=1", referrer: "https://site.example/" });
    expect(res).toEqual({ accepted: true });
    const pending = ui.opened[0];
    expect(pending.type).toBe("download");
    if (pending.type !== "download") return;
    expect(pending.item).toMatchObject({
      filename: "a.zip",
      category: "archives",
      size: 2000,
      dir: path.join(root, "dl", "Archives"),
      headers: { Cookie: "s=1", Referer: "https://site.example/" },
    });
    expect(c.confirmDownload(pending.pendingId, { filename: "b.zip", dir: path.join(root, "x"), mode: "later" })).toEqual({ ok: true });
    expect(c.manager.list()[0]).toMatchObject({ filename: "b.zip", status: "scheduled", dir: path.join(root, "x") });
    expect(ui.closed).toEqual([pending.pendingId]);
    expect(c.getPending(pending.pendingId)).toBeNull();
  });

  it("downloads straight away when confirmation is off", async () => {
    const c = await start({ confirmBeforeDownload: false });
    await c.handleDownloadRequest({ url: server.url("/files/a.zip"), source: "intercept" });
    expect(ui.opened).toHaveLength(0);
    for (let i = 0; i < 100 && c.manager.list()[0]?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 50));
    expect(c.manager.list()[0].status).toBe("completed");
    expect(readFileSync(path.join(root, "dl", "Archives", "a.zip")).length).toBe(2000);
  });

  it("declines links that cannot be fetched so Chrome keeps the download", async () => {
    const c = await start();
    const res = await c.handleDownloadRequest({ url: server.url("/nope.zip"), source: "intercept" });
    expect(res.accepted).toBe(false);
    if (!res.accepted) expect(res.reason).toContain("404");
  });

  it("declines an intercepted download whose link only returns a web page, so Chrome keeps it", async () => {
    const c = await start();
    const res = await c.handleDownloadRequest({ url: server.url("/page"), source: "intercept" });
    expect(res.accepted).toBe(false);
    expect(ui.opened).toHaveLength(0);
    expect(c.manager.list()).toHaveLength(0);
  });

  it("opens the media dialog for a manually added web page", async () => {
    const c = await start();
    expect(await c.addUrl(server.url("/page"))).toEqual({ ok: true });
    expect(ui.opened[0]).toMatchObject({ type: "media", pageUrl: server.url("/page"), items: [] });
    expect(await c.addUrl("ftp://x")).toMatchObject({ ok: false });
  });

  it("turns a detected media file into an http download named after the page title", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Nice: Clip", items: [{ url: server.url("/media/clip.mp4"), kind: "file" }] });
    const p = ui.opened[0];
    expect(await c.confirmMedia(p.pendingId, { kind: "item", index: 0 }, { dir: path.join(root, "v"), mode: "later" })).toEqual({ ok: true });
    expect(c.manager.list()[0]).toMatchObject({ kind: "http", filename: "Nice_ Clip.mp4", category: "video", size: 3000 });
  });

  it("sends HLS items to yt-dlp", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Live", items: [{ url: "https://cdn.example/a.m3u8", kind: "hls", cookies: "c=2" }] });
    await c.confirmMedia(ui.opened[0].pendingId, { kind: "item", index: 0 }, { dir: path.join(root, "v"), mode: "later" });
    const rec = c.manager.list()[0];
    expect(rec).toMatchObject({ kind: "ytdlp", url: "https://cdn.example/a.m3u8", filename: "Live.mp4" });
    expect(c.manager.get(rec.id)?.headers.Cookie).toBe("c=2");
  });

  it("downloads a chosen quality from the page without cookies", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Song", items: [], cookies: "secret=1" });
    const option = { id: "audio", label: "Audio only (MP3)", formatSelector: "ba/b", audioOnly: true };
    await c.confirmMedia(ui.opened[0].pendingId, { kind: "format", option }, { dir: path.join(root, "m"), mode: "later" });
    const rec = c.manager.list()[0];
    expect(rec).toMatchObject({ kind: "ytdlp", url: "https://video.example/w", filename: "Song.mp3", category: "music", ytdlp: { formatSelector: "ba/b", audioOnly: true } });
    expect(c.manager.get(rec.id)?.headers.Cookie).toBeUndefined();
  });

  it("reports a busy bridge port and recovers when the port changes", async () => {
    const blocker = net.createServer();
    const busy = await freePort();
    await new Promise<void>((r) => blocker.listen(busy, "127.0.0.1", () => r()));
    try {
      const c = await start({ bridgePort: busy });
      expect(c.snapshot().bridge).toMatchObject({ ok: false, port: busy });
      expect(c.snapshot().bridge.error).toContain(String(busy));
      const next = await freePort();
      await c.updateSettings({ bridgePort: next });
      expect(c.snapshot().bridge).toEqual({ ok: true, port: next });
      expect(await ping(next)).toBe(200);
      expect(ui.events.some((e) => e.type === "settings")).toBe(true);
    } finally {
      blocker.close();
    }
  });

  it("copies the extension to Documents", async () => {
    const c = await start();
    const res = await c.installExtension();
    expect(res.ok).toBe(true);
    if (res.ok) expect(existsSync(path.join(res.path, "manifest.json"))).toBe(true);
  });
});
