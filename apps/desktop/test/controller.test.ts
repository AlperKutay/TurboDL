import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AppEvent, PendingItem } from "@turbodl/shared";
import { AppController, type ControllerUi } from "../src/main/controller";
import { FFMPEG, makeClips, serveFolder, type Clips } from "./fixtures/media";
import { startTestServer, type TestServer } from "./fixtures/test-server";

const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";
const FAKE_YTDLP = path.join(__dirname, "fixtures", "fake-ytdlp.mjs");

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

async function start(settings: Record<string, unknown> = {}, ffmpegPath: string | null = null): Promise<AppController> {
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
    ffmpegPath,
    ui,
    mediaTools: { ensure: async () => ({ ytdlp: "unused", deno: null, ffmpeg: null }), updateIfStale: async () => undefined },
    ytdlpCommand: () => ({ file: process.execPath, args: [FAKE_YTDLP] }),
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

  it("sends an HLS item to yt-dlp when no quality of it could be read", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Live", items: [{ url: "https://cdn.example/a.m3u8", kind: "hls", cookies: "c=2" }] });
    await c.confirmMedia(ui.opened[0].pendingId, { kind: "item", index: 0 }, { dir: path.join(root, "v"), mode: "later" });
    const rec = c.manager.list()[0];
    expect(rec).toMatchObject({ kind: "ytdlp", url: "https://cdn.example/a.m3u8", filename: "Live.mp4" });
    const stored = c.manager.get(rec.id)!;
    expect(stored.headers.Cookie).toBeUndefined();
    expect(stored.ytdlp?.cookies).toEqual([{ domain: "cdn.example", hostOnly: true, path: "/", secure: true, expires: 0, name: "c", value: "2" }]);
  });

  it("turns a chosen page quality into a stream download TurboDL fetches itself, without cookies", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Song", items: [], cookies: "secret=1" });
    const option = { id: "audio", label: "Audio only (MP3)", formatSelector: "ba/b", audioOnly: true };
    await c.confirmMedia(ui.opened[0].pendingId, { kind: "format", option }, { dir: path.join(root, "m"), mode: "later" });
    const rec = c.manager.list()[0];
    expect(rec).toMatchObject({ kind: "stream", url: "https://video.example/w", filename: "Song.mp3", category: "music" });
    expect(rec.stream).toBeUndefined();
    const stored = c.manager.get(rec.id)!;
    expect(stored.headers.Cookie).toBeUndefined();
    expect(stored.stream).toEqual({ origin: { type: "ytdlp", pageUrl: "https://video.example/w", formatSelector: "ba/b" }, output: "mp3", tracks: [] });
  });

  const LOGIN_JAR = [{ domain: "video.example", hostOnly: true, path: "/", secure: true, expires: 0, name: "session", value: "ok" }];
  const option = { id: "h720", label: "720p", formatSelector: "x", audioOnly: false };

  it("lists qualities without the browser session when the video does not need it", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Clip", items: [], cookieJar: LOGIN_JAR });
    const id = ui.opened[0].pendingId;
    expect(await c.probeMediaFormats(id)).toMatchObject({ ok: true, usedLogin: false });
    await c.confirmMedia(id, { kind: "format", option }, { dir: path.join(root, "v"), mode: "later" });
    expect(c.manager.get(c.manager.list()[0].id)?.stream?.origin).not.toHaveProperty("cookies");
  });

  it("uses the browser session only when the video asks for a login, and keeps it for the download", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/login", title: "Age restricted", items: [], cookieJar: LOGIN_JAR });
    const id = ui.opened[0].pendingId;
    const result = await c.probeMediaFormats(id);
    expect(result).toMatchObject({ ok: true, title: "Info", usedLogin: true });
    if (!result.ok) return;
    await c.confirmMedia(id, { kind: "format", option: result.options[0] }, { dir: path.join(root, "v"), mode: "later" });
    const view = c.manager.list()[0];
    const stored = c.manager.get(view.id)!;
    expect(stored.stream?.origin).toMatchObject({ type: "ytdlp", cookies: LOGIN_JAR });
    expect(view.stream).toBeUndefined();
  });

  it("explains what to do when a video needs a login and no browser session came with it", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/login", title: "", items: [] });
    const r = await c.probeMediaFormats(ui.opened[0].pendingId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("in your browser while signed in");
  });

  it("says so when even the browser session cannot open the video", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/login", title: "", items: [], cookieJar: [{ ...LOGIN_JAR[0], value: "expired" }] });
    const r = await c.probeMediaFormats(ui.opened[0].pendingId);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("with your browser session either");
  });

  it("does not use the browser session for other failures", async () => {
    const c = await start();
    await c.handleMediaRequest({ pageUrl: "https://video.example/error", title: "", items: [], cookieJar: LOGIN_JAR });
    expect(await c.probeMediaFormats(ui.opened[0].pendingId)).toEqual({ ok: false, error: "[generic] Unsupported URL: https://video.example/error" });
  });

  it("offers a copied download link in the confirmation window, even when confirmation is off", async () => {
    const c = await start({ confirmBeforeDownload: false });
    await c.handleClipboardText(`  ${server.url("/files/a.zip")} `);
    expect(ui.opened).toHaveLength(1);
    expect(ui.opened[0]).toMatchObject({ type: "download", source: "clipboard", item: { filename: "a.zip" } });
    await c.handleClipboardText(server.url("/files/a.zip"));
    expect(ui.opened).toHaveLength(1);
    c.confirmDownload(ui.opened[0].pendingId, { filename: "a.zip", dir: path.join(root, "x"), mode: "later" });
    await c.handleClipboardText(server.url("/files/a.zip"));
    expect(ui.opened).toHaveLength(1);
  });

  it("ignores copied text that is not a listed download link, pages and dead links", async () => {
    server.setFile("/fake.zip", { data: Buffer.from("<html></html>"), contentType: "text/html" });
    const c = await start();
    await c.handleClipboardText("merhaba");
    await c.handleClipboardText(server.url("/page"));
    await c.handleClipboardText(server.url("/fake.zip"));
    await c.handleClipboardText(server.url("/nope.zip"));
    expect(ui.opened).toHaveLength(0);
  });

  it("ignores a link TurboDL itself copied, such as 'Copy link' on a finished download", async () => {
    const c = await start();
    const own = server.url("/files/a.zip");
    c.noteOwnClipboardText(own);
    await c.handleClipboardText(own);
    expect(ui.opened).toHaveLength(0);
    // once something else was copied, the same link copied from a browser counts again
    await c.handleClipboardText("merhaba");
    await c.handleClipboardText(own);
    expect(ui.opened).toHaveLength(1);
  });

  it("does not watch the clipboard when switched off", async () => {
    const c = await start({ watchClipboard: false });
    await c.handleClipboardText(server.url("/files/a.zip"));
    expect(ui.opened).toHaveLength(0);
  });

  it("keeps the browser cookies of a right-clicked link that turns out to be a page", async () => {
    const c = await start();
    await c.handleDownloadRequest({ url: server.url("/page"), source: "context-menu", cookieJar: LOGIN_JAR });
    expect(ui.opened[0]).toMatchObject({ type: "media", pageUrl: server.url("/page"), cookieJar: LOGIN_JAR, useLogin: false });
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

  describe("own video engine", () => {
    let clipsDir: string;
    let clips: Clips;
    beforeAll(() => {
      clipsDir = mkdtempSync(path.join(os.tmpdir(), "turbodl-ctl-clips-"));
      clips = makeClips(clipsDir);
    });
    afterAll(() => {
      rmSync(clipsDir, { recursive: true, force: true });
    });

    it("downloads a page's chosen quality with TurboDL's engine and yt-dlp only for the addresses", async () => {
      server.setFile("/yt/v.mp4", { data: clips.video });
      server.setFile("/yt/a.m4a", { data: clips.audio });
      const info = {
        title: "Local Video",
        formats: [{ height: 240, vcodec: "avc1" }],
        requested_formats: [
          { format_id: "v1", protocol: "https", url: server.url("/yt/v.mp4"), ext: "mp4", vcodec: "avc1", acodec: "none", filesize: clips.video.length, downloader_options: { http_chunk_size: 16384 } },
          { format_id: "a1", protocol: "https", url: server.url("/yt/a.m4a"), ext: "m4a", vcodec: "none", acodec: "mp4a", filesize: clips.audio.length },
        ],
      };
      server.setFile("/yt/page.info.json", { data: Buffer.from(JSON.stringify(info)) });
      const c = await start({}, FFMPEG);
      await c.handleMediaRequest({ pageUrl: server.url("/yt/page"), title: "", items: [] });
      const id = ui.opened[0].pendingId;
      const formats = await c.probeMediaFormats(id);
      expect(formats).toMatchObject({ ok: true, title: "Local Video" });
      if (!formats.ok) return;
      expect(await c.confirmMedia(id, { kind: "format", option: formats.options[0] }, { dir: path.join(root, "v"), mode: "now" })).toEqual({ ok: true });
      for (let i = 0; i < 200 && c.manager.list()[0]?.status !== "completed"; i++) await new Promise((r) => setTimeout(r, 50));
      expect(c.manager.list()[0]).toMatchObject({ kind: "stream", status: "completed", filename: "Local Video.mp4" });
      expect(existsSync(path.join(root, "v", "Local Video.mp4"))).toBe(true);
      expect(server.requests.filter((r) => r.path === "/yt/v.mp4" && r.range && r.range !== "bytes=0-0").length).toBeGreaterThan(1);
    });

    it("lists the qualities of a captured HLS item and downloads the chosen one itself", async () => {
      serveFolder(server, clips.hls.av, "/live/av");
      server.setFile("/live/master.m3u8", { data: Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x240\nav/index.m3u8\n") });
      const c = await start({}, FFMPEG);
      await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Stream", items: [{ url: server.url("/live/master.m3u8"), kind: "hls", cookies: "c=1" }] });
      const id = ui.opened[0].pendingId;
      const r = await c.probeStream(id, 0);
      expect(r).toMatchObject({ ok: true, usedLogin: false });
      if (!r.ok) return;
      expect(r.options.map((o) => o.label)).toEqual(["240p · 0.7 Mbps", "Audio only (MP3)"]);
      expect(server.requests.find((q) => q.path === "/live/master.m3u8")?.headers.cookie).toBe("c=1");
      await c.confirmMedia(id, { kind: "item", index: 0, option: r.options[0] }, { dir: path.join(root, "v"), mode: "now" });
      const stored = c.manager.get(c.manager.list()[0].id)!;
      expect(stored.stream?.origin).toEqual({ type: "hls", url: server.url("/live/master.m3u8"), variant: "320x240@700000" });
      for (let i = 0; i < 200 && c.manager.list()[0]?.status !== "completed"; i++) await new Promise((res) => setTimeout(res, 50));
      expect(c.manager.list()[0]).toMatchObject({ status: "completed", filename: "Stream.mp4" });
    });

    it("lists DASH qualities and keeps audio-only DASH choices without a video id", async () => {
      server.setFile("/d/x.mpd", {
        data: Buffer.from(`<MPD type="static" mediaPresentationDuration="PT4S"><Period>
          <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate duration="2" media="$RepresentationID$/$Number$.m4s"/><Representation id="v720" bandwidth="3000000" height="720"/></AdaptationSet>
          <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate duration="2" media="$RepresentationID$/$Number$.m4s"/><Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`),
      });
      const c = await start();
      await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "Dash", items: [{ url: server.url("/d/x.mpd"), kind: "dash" }] });
      const id = ui.opened[0].pendingId;
      const r = await c.probeStream(id, 0);
      if (!r.ok) throw new Error(r.error);
      expect(r.options.map((o) => o.id)).toEqual(["v720", "audio"]);
      await c.confirmMedia(id, { kind: "item", index: 0, option: r.options[1] }, { dir: path.join(root, "v"), mode: "later" });
      const stored = c.manager.get(c.manager.list()[0].id)!;
      expect(stored).toMatchObject({ kind: "stream", filename: "Dash.mp3", category: "music" });
      expect(stored.stream).toMatchObject({ origin: { type: "dash", video: null, audio: null }, output: "mp3" });
    });

    it("explains why a stream item has no qualities", async () => {
      const c = await start();
      await c.handleMediaRequest({ pageUrl: "https://video.example/w", title: "", items: [{ url: server.url("/nope.m3u8"), kind: "hls" }, { url: server.url("/media/clip.mp4"), kind: "file" }] });
      const id = ui.opened[0].pendingId;
      expect(await c.probeStream(id, 0)).toMatchObject({ ok: false, error: expect.stringContaining("404") });
      expect(await c.probeStream(id, 1)).toEqual({ ok: false, error: "This item is not a stream." });
      expect(await c.probeStream("gone", 0)).toEqual({ ok: false, error: "This request no longer exists." });
    });
  });
});
