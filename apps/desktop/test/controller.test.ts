import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SavedError, type AppEvent, type BrowserCookie, type InstagramItem, type InstagramProfile, type PendingItem, type SavedPost } from "@turbodl/shared";
import { AppController, type ControllerUi, type InstagramDeps } from "../src/main/controller";
import type { FindOutcome } from "../src/main/instagram/finder";
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

async function start(settings: Record<string, unknown> = {}, ffmpegPath: string | null = null, instagram?: InstagramDeps): Promise<AppController> {
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
    instagram,
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

describe("Instagram links", () => {
  const sessionJar: BrowserCookie[] = [
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
  ];
  const memoryCrypt = { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() };

  /** Instagram stood in for: what a page shows and what a sign-in gives. */
  function fakeInstagram(outcome: (signal?: AbortSignal) => FindOutcome | Promise<FindOutcome>, signIn: BrowserCookie[] | null = null) {
    const finds: { code: string; cookies: string[] }[] = [];
    const signInPages: (string | undefined)[] = [];
    let signIns = 0;
    const deps: InstagramDeps = {
      find: async (link, cookies, signal) => {
        finds.push({ code: link.kind === "post" ? link.code : link.kind, cookies: cookies.map((c) => c.name) });
        return outcome(signal);
      },
      signIn: async (at) => {
        signIns++;
        signInPages.push(at);
        return signIn;
      },
      crypt: memoryCrypt,
      agent: "TestAgent/1",
    };
    return { deps, finds, signIns: () => signIns, signInPages };
  }

  const items = () => ({
    type: "items" as const,
    items: [
      { kind: "image" as const, url: server.url("/ig/photo.jpg"), mediaId: "3800000000000000001" },
      { kind: "video" as const, url: server.url("/ig/clip.mp4"), mediaId: "3800000000000000002" },
    ],
  });

  beforeEach(() => {
    server.setFile("/ig/photo.jpg", { data: Buffer.alloc(1500, 3), contentType: "image/jpeg" });
    server.setFile("/ig/clip.mp4", { data: Buffer.alloc(2500, 4), contentType: "video/mp4" });
  });

  async function waitDone(c: AppController, count: number) {
    for (let i = 0; i < 100 && c.manager.list().filter((d) => d.status === "completed").length < count; i++) await new Promise((r) => setTimeout(r, 50));
  }

  it("opens a post link in the Instagram picker without fetching the page itself", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    const res = await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/?igsh=x", source: "context-menu", cookieJar: sessionJar });
    expect(res).toEqual({ accepted: true });
    const pending = ui.opened[0];
    expect(pending).toMatchObject({ type: "instagram", link: { kind: "post", code: "C1abcDEF" }, defaultDir: path.join(root, "dl", "Instagram") });
    expect(server.requests).toHaveLength(0);
  });

  it("takes the extension's cookie jar as the Instagram session", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/reel/C2reel/", source: "context-menu", cookieJar: sessionJar });
    await c.findInstagram(ui.opened[0].pendingId);
    expect(ig.finds).toEqual([{ code: "C2reel", cookies: ["sessionid", "csrftoken"] }]);
  });

  it("adds one download per pick, named by Instagram's id, with the CDN's headers and no cookies", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    const id = ui.opened[0].pendingId;
    expect((await c.findInstagram(id)).type).toBe("items");
    expect(await c.confirmInstagram(id, [1], "now")).toEqual({ ok: true });
    const [record] = c.manager.list();
    expect(record).toMatchObject({ filename: "3800000000000000002.mp4", dir: path.join(root, "dl", "Instagram"), category: "video" });
    expect(c.manager.get(record.id)?.headers).toEqual({ Referer: "https://www.instagram.com/", "User-Agent": "TestAgent/1" });
    expect(ui.closed).toEqual([id]);
    await waitDone(c, 1);
    expect(readFileSync(path.join(root, "dl", "Instagram", "3800000000000000002.mp4")).length).toBe(2500);
  });

  it("downloads every item when none is picked", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "manual", cookieJar: sessionJar });
    const id = ui.opened[0].pendingId;
    await c.findInstagram(id);
    await c.confirmInstagram(id, [], "now");
    expect(c.manager.list().map((d) => d.filename).sort()).toEqual(["3800000000000000001.jpg", "3800000000000000002.mp4"]);
  });

  it("gives each link its own picker; closing one leaves the other", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    const [first, second] = ui.opened.map((p) => p.pendingId);
    expect(first).not.toBe(second);
    c.cancelPending(first);
    expect(await c.findInstagram(first)).toEqual({ type: "gone" });
    expect((await c.findInstagram(second)).type).toBe("items");
  });

  it("reads a public post without a session, as Instagram shows it to anyone", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/reel/C2reel/", source: "manual" });
    expect((await c.findInstagram(ui.opened[0].pendingId)).type).toBe("items");
    expect(ig.finds).toEqual([{ code: "C2reel", cookies: [] }]);
    expect(ig.signIns()).toBe(0);
  });

  it("asks to sign in when Instagram shows the page only to signed-in visitors, and signing in lets it be read", async () => {
    let reads = 0;
    const ig = fakeInstagram(() => (reads++ === 0 ? { type: "signedOut" } : items()), sessionJar);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/stories/highlights/17900000000000002/", source: "manual" });
    const id = ui.opened[0].pendingId;
    expect(await c.findInstagram(id)).toEqual({ type: "signedOut" });
    expect(await c.instagramSignIn()).toBe(true);
    expect((await c.findInstagram(id)).type).toBe("items");
    expect(ig.finds.map((f) => f.cookies)).toEqual([[], ["sessionid", "csrftoken"]]);
    expect(ig.signIns()).toBe(1);
  });

  it("calls the page off when its picker is closed", async () => {
    let aborted = false;
    const ig = fakeInstagram(
      (signal) =>
        new Promise<FindOutcome>((resolve) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({ type: "nothing" });
          });
        }),
    );
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    const id = ui.opened[0].pendingId;
    const search = c.findInstagram(id);
    await new Promise((r) => setTimeout(r, 20));
    c.cancelPending(id);
    expect(await search).toEqual({ type: "gone" });
    expect(aborted).toBe(true);
  });

  it("answers nothing, not a stuck picker, when reading the page fails", async () => {
    const ig = fakeInstagram(() => {
      throw new Error("no window");
    });
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    expect(await c.findInstagram(ui.opened[0].pendingId)).toEqual({ type: "nothing" });
  });

  it("opens the sign-in window on Instagram's check page when that is where the page landed", async () => {
    const at = "https://www.instagram.com/challenge/xyz/";
    const ig = fakeInstagram(() => ({ type: "signedOut", at }), sessionJar);
    const c = await start({}, null, ig.deps);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/p/C1abcDEF/", source: "context-menu", cookieJar: sessionJar });
    const id = ui.opened[0].pendingId;
    expect(await c.findInstagram(id)).toEqual({ type: "signedOut", at });
    await c.instagramSignIn(id);
    expect(ig.signInPages).toEqual([at]);
  });

  it("declines Instagram pages it doesn't read yet instead of handing them to yt-dlp", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    for (const url of ["https://www.instagram.com/explore/", "https://www.instagram.com/direct/inbox/", "https://www.instagram.com/"]) {
      const res = await c.handleDownloadRequest({ url, source: "context-menu", cookieJar: sessionJar });
      expect(res.accepted, url).toBe(false);
    }
    expect(ui.opened).toHaveLength(0);
    expect(server.requests).toHaveLength(0);
  });

  it("sends an Instagram page from the media button to the picker too", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleMediaRequest({ pageUrl: "https://www.instagram.com/reel/C2reel/", title: "x", items: [], cookieJar: sessionJar });
    expect(ui.opened[0]).toMatchObject({ type: "instagram", link: { kind: "post", code: "C2reel" } });
  });

  it("keeps the Instagram session from yt-dlp on the media button's Instagram pages it doesn't read", async () => {
    const ig = fakeInstagram(items);
    const c = await start({}, null, ig.deps);
    await c.handleMediaRequest({ pageUrl: "https://www.instagram.com/explore/", title: "x", items: [], cookieJar: sessionJar });
    expect(ui.opened[0]).toMatchObject({ type: "media", cookieJar: [] });
  });
});

describe("Instagram Saved", () => {
  const sessionJar: BrowserCookie[] = [
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
  ];
  const picture = (name: string) => ({ candidates: [{ url: server.url(`/ig/${name}.jpg`), width: 640, height: 640 }] });
  const photo = (pk: string) => ({ pk, code: `C${pk}`, image_versions2: picture(pk) });
  const video = (pk: string) => ({ pk, code: `C${pk}`, image_versions2: picture(`${pk}-cover`), video_versions: [{ url: server.url(`/ig/${pk}.mp4`), width: 640, height: 640 }] });
  const carousel = (pk: string, ...children: object[]) => ({ pk, code: `C${pk}`, image_versions2: picture(pk), carousel_media: children });

  /** Instagram's saved feeds stood in for: every feed answers these posts on one page. */
  function fakeSaved(o: { posts?: object[]; collections?: { id: string; name: string; count?: number; isAll: boolean }[]; limitFirst?: boolean } = {}) {
    const asked: string[] = [];
    /** each request with the fake clock's time when it was sent */
    const times: { url: string; at: number }[] = [];
    let feeds = 0;
    const waits: number[] = [];
    let now = 0;
    let signOuts = 0;
    const posts = o.posts ?? [carousel("3", photo("31"), video("32")), photo("1")];
    const deps: InstagramDeps = {
      find: async () => ({ type: "nothing" }),
      signIn: async () => null,
      crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
      agent: "TestAgent/1",
      get: async (url) => {
        asked.push(url);
        times.push({ url, at: now });
        if (url.endsWith("/web_form_data/")) return { status: 200, body: JSON.stringify({ form_data: { username: "sample.user" }, status: "ok" }) };
        if (o.limitFirst && feeds++ === 0) return { status: 429, body: "" };
        return { status: 200, body: JSON.stringify({ items: posts.map((media) => ({ media })), more_available: false, status: "ok" }) };
      },
      collections: async () => o.collections ?? [{ id: "100", name: "All posts", count: 40, isAll: true }, { id: "102", name: "Trips", count: 2, isAll: false }],
      wait: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      now: () => now,
      signOut: async () => {
        signOuts++;
      },
    };
    return {
      deps,
      asked,
      times,
      waits,
      signOuts: () => signOuts,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  beforeEach(() => {
    for (const name of ["1", "3", "31", "32-cover", "41-cover", "42", "43"]) server.setFile(`/ig/${name}.jpg`, { data: Buffer.alloc(800, 5), contentType: "image/jpeg" });
    server.setFile("/ig/32.mp4", { data: Buffer.alloc(1600, 6), contentType: "video/mp4" });
  });

  async function signedIn(deps: InstagramDeps) {
    const c = await start({}, null, deps);
    c.instagramSession.take(sessionJar);
    return c;
  }

  async function backupEnds(c: AppController) {
    for (let i = 0; i < 200 && c.snapshot().instagramBackup?.state === "running"; i++) await new Promise((r) => setTimeout(r, 25));
    return c.snapshot().instagramBackup;
  }

  it("shows the signed-in account's username, and asks Instagram nothing without a session", async () => {
    const saved = fakeSaved();
    const c = await start({}, null, saved.deps);
    expect(await c.instagramAccount()).toEqual({ signedIn: false });
    expect(saved.asked).toHaveLength(0);
    c.instagramSession.take(sessionJar);
    expect(await c.instagramAccount()).toEqual({ signedIn: true, username: "sample.user" });
  });

  it("forgets the session on sign-out", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await c.instagramSignOut();
    expect(await c.instagramAccount()).toEqual({ signedIn: false });
    expect(saved.signOuts()).toBe(1);
  });

  it("never asks for saved pages closer than 1.5 s apart", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await Promise.all([c.savedPage({ kind: "all" }), c.savedPage({ kind: "all" })]);
    expect(saved.waits).toEqual([1500]);
  });

  it("opens picked posts in the picker, their items in pick order, without reading a page", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    const answer = await c.savedPage({ kind: "all" });
    expect(answer.type === "page" && answer.page.posts.map((p) => p.id)).toEqual(["3", "1"]);
    expect(await c.openSavedPicks(["1", "3"])).toEqual({ ok: true });
    const pending = ui.opened[0];
    expect(pending).toMatchObject({ type: "instagram", link: { kind: "saved", username: "sample.user" }, defaultDir: path.join(root, "dl", "Instagram") });
    const found = await c.findInstagram(pending.pendingId);
    expect(found.type === "items" && found.items.map((i) => i.mediaId)).toEqual(["1", "31", "32"]);
  });

  it("backs up only the owner's collections, one at a time", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    expect((await c.startBackup("100")).ok).toBe(false);
    expect(await c.startBackup("102")).toEqual({ ok: true });
    expect(await c.startBackup("102")).toEqual({ ok: false, error: "A backup is already running." });
    await c.stopBackup();
  });

  it("backs a collection up into its folder and reports its progress", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    await c.startBackup("102");
    expect(await backupEnds(c)).toMatchObject({ state: "finished", name: "Trips", done: 2, left: 0, saved: 3 });
    expect(readFileSync(path.join(root, "dl", "Instagram", "Saved", "Trips", "32.mp4")).length).toBe(1600);
    expect(existsSync(path.join(root, "dl", "Instagram", "Saved", "Trips", "31.jpg"))).toBe(true);
    expect(ui.events.some((e) => e.type === "instagramBackup" && e.backup?.state === "running")).toBe(true);
  });

  it("names a collection's folder safely", async () => {
    const saved = fakeSaved({ collections: [{ id: "105", name: "Trips: 2024/25?", isAll: false }] });
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    await c.startBackup("105");
    await backupEnds(c);
    const folders = readdirSync(path.join(root, "dl", "Instagram", "Saved"));
    expect(folders).toHaveLength(1);
    expect(folders[0]).not.toMatch(/[:/?]/);
  });

  it("estimates a backup from the posts loaded so far", async () => {
    const saved = fakeSaved({
      posts: [carousel("3", video("31"), photo("32")), carousel("4", video("41"), photo("42"), photo("43"))],
      collections: [{ id: "102", name: "Trips", count: 10, isAll: false }],
    });
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    await c.savedPage({ kind: "collection", id: "102" });
    const plan = await c.backupPlan("102");
    expect(plan).toMatchObject({ count: 10, bytes: (10 * (2 * 8_000_000 + 3 * 600_000)) / 2, large: false, resumes: false });
    expect(plan.freeBytes).toBeGreaterThan(0);
  });

  it("spaces every saved-feed request 1.5 s apart, a backup's and the grid's alike", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    await c.startBackup("102");
    await c.savedPage({ kind: "all" });
    await backupEnds(c);
    const feeds = saved.times.filter((t) => t.url.includes("/feed/"));
    expect(feeds).toHaveLength(2);
    expect(feeds[1].at - feeds[0].at).toBeGreaterThanOrEqual(1500);
  });

  it("sends only the latest feed's request when the grid switched feeds before the others were sent", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    await Promise.all([c.savedPage({ kind: "collection", id: "102" }), c.savedPage({ kind: "collection", id: "103" }), c.savedPage({ kind: "all" })]);
    expect(saved.asked.filter((u) => u.includes("/feed/"))).toEqual(["https://www.instagram.com/api/v1/feed/saved/posts/"]);
  });

  it("asks Instagram nothing for a while after it asked to slow down, neither for the grid nor for a backup", async () => {
    const saved = fakeSaved({ limitFirst: true });
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    expect((await c.savedPage({ kind: "all" })).type).toBe("rateLimited");
    const sent = saved.asked.length;
    expect((await c.savedPage({ kind: "all" })).type).toBe("rateLimited");
    expect((await c.startBackup("102")).ok).toBe(false);
    expect(saved.asked.length).toBe(sent);
    saved.advance(2 * 60_000);
    expect((await c.savedPage({ kind: "all" })).type).toBe("page");
  });

  it("waits, when quitting, for a backup's item in flight to be dropped", async () => {
    let cleaned = false;
    const saved = fakeSaved();
    saved.deps.fetch = (_url, _file, { signal }) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () =>
          setTimeout(() => {
            cleaned = true;
            reject(new Error("Cancelled."));
          }, 50),
        ),
      );
    const c = await signedIn(saved.deps);
    await c.savedCollections(true);
    await c.startBackup("102");
    await new Promise((r) => setTimeout(r, 30));
    await c.shutdown();
    controller = null;
    expect(cleaned).toBe(true);
  });

  it("opens Saved for a saved link, taking the browser's session", async () => {
    const saved = fakeSaved();
    const c = await start({}, null, saved.deps);
    expect(await c.handleDownloadRequest({ url: "https://www.instagram.com/sample.user/saved/", source: "context-menu", cookieJar: sessionJar })).toEqual({ accepted: true });
    expect(ui.shown).toBe(1);
    expect(ui.events).toContainEqual({ type: "openSaved" });
    expect(c.instagramSession.signedIn()).toBe(true);
    expect(ui.opened).toHaveLength(0);
  });
});

describe("Instagram profiles", () => {
  const sessionJar: BrowserCookie[] = [
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
  ];
  const person = (id: string, username: string, o: Partial<InstagramProfile> = {}): InstagramProfile => ({
    id,
    username,
    fullName: "Sample User",
    isPrivate: false,
    following: false,
    picture: "https://cdn.example/sample.jpg",
    postCount: 3,
    ...o,
  });
  const photo = (id: string): SavedPost => ({ id, cover: server.url(`/ig/${id}.jpg`), items: [{ kind: "image", url: server.url(`/ig/${id}.jpg`), mediaId: id }] });

  /** Profile pages stood in for: each username's profile, its pages of posts, its highlights. */
  function fakeProfiles(profiles: Record<string, { profile: InstagramProfile; pages: SavedPost[][] }>, o: { hangFetch?: boolean } = {}) {
    let now = 0;
    const opened: string[] = [];
    const closed: string[] = [];
    /** each page asked of a profile, with the fake clock's time */
    const asked: { username: string; cursor?: string; at: number }[] = [];
    const fetched: string[] = [];
    const deps: InstagramDeps = {
      find: async () => ({ type: "nothing" }),
      signIn: async () => null,
      crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
      agent: "TestAgent/1",
      get: async (url) => {
        asked.push({ username: "saved", cursor: url, at: now });
        return { status: 200, body: JSON.stringify({ items: [], more_available: false, status: "ok" }) };
      },
      wait: async (ms) => {
        now += ms;
      },
      now: () => now,
      fetch: async (url, file, { signal }) => {
        fetched.push(url);
        if (o.hangFetch) await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled."))));
        writeFileSync(file, "x");
      },
      openProfile: (username) => {
        opened.push(username);
        const found = profiles[username];
        return {
          profile: async () => {
            if (!found) throw new SavedError("badAnswer");
            return found.profile;
          },
          highlights: [{ id: "17900000000000002", title: "Summer" }],
          limited: false,
          page: async (cursor) => {
            asked.push({ username, cursor, at: now });
            const k = cursor ? Number(cursor) : 0;
            return { posts: found?.pages[k] ?? [], ...(found && k + 1 < found.pages.length ? { next: String(k + 1) } : {}) };
          },
          close: () => closed.push(username),
        };
      },
    };
    return { deps, opened, closed, asked, fetched };
  }

  /** sample.user: posts 1 and 2 on the first page, 3 on the second */
  let SAMPLE: { profile: InstagramProfile; pages: SavedPost[][] };

  beforeEach(() => {
    for (const id of ["1", "2", "3"]) server.setFile(`/ig/${id}.jpg`, { data: Buffer.alloc(700, 9), contentType: "image/jpeg" });
    SAMPLE = { profile: person("5100000000000000001", "sample.user"), pages: [[photo("1"), photo("2")], [photo("3")]] };
  });

  async function signedIn(deps: InstagramDeps) {
    const c = await start({}, null, deps);
    c.instagramSession.take(sessionJar);
    return c;
  }

  async function backupEnds(c: AppController) {
    for (let i = 0; i < 200 && c.snapshot().instagramBackup?.state === "running"; i++) await new Promise((r) => setTimeout(r, 25));
    return c.snapshot().instagramBackup;
  }

  it("opens a profile link in Profiles, and a post under a username in the picker", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await start({}, null, ig.deps);
    for (const url of ["https://www.instagram.com/sample.user/", "https://instagram.com/sample.user/reels/", "https://www.instagram.com/Sample.User/tagged/?igsh=x"]) {
      expect(await c.handleDownloadRequest({ url, source: "manual", cookieJar: sessionJar })).toEqual({ accepted: true });
    }
    expect(ui.events.filter((e) => e.type === "openProfile")).toEqual([
      { type: "openProfile", username: "sample.user" },
      { type: "openProfile", username: "sample.user" },
      { type: "openProfile", username: "sample.user" },
    ]);
    expect(ui.shown).toBe(3);
    expect(c.instagramSession.signedIn()).toBe(true);
    await c.handleDownloadRequest({ url: "https://www.instagram.com/sample.user/p/C1abcDEF/", source: "manual" });
    await c.handleDownloadRequest({ url: "https://www.instagram.com/sample.user/reel/C2reel/", source: "manual" });
    expect(ui.opened.map((p) => p.type === "instagram" && p.link.kind)).toEqual(["post", "post"]);
  });

  it("opens a profile's page without a session too (as signed-out visitors see it)", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await start({}, null, ig.deps);
    expect((await c.profileLoad("sample.user")).type).toBe("profile");
    expect(ig.opened).toEqual(["sample.user"]);
  });

  it("answers the profile and its highlights from its page", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    expect(await c.profileLoad("sample.user")).toEqual({ type: "profile", profile: SAMPLE.profile, highlights: [{ id: "17900000000000002", title: "Summer" }] });
    expect((await c.profileLoad("nobody")).type).toBe("failed");
  });

  it("asks nothing more of a private profile it doesn't follow", async () => {
    const ig = fakeProfiles({ "shut.door": { profile: person("52", "shut.door", { isPrivate: true }), pages: [[photo("1")]] } });
    const c = await signedIn(ig.deps);
    await c.profileLoad("shut.door");
    expect(await c.profilePage("shut.door")).toEqual({ type: "page", page: { posts: [] } });
    expect(ig.asked).toEqual([]);
  });

  it("paces a profile's next pages with the saved feeds, 1.5 s apart", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    // back to back (the stand-in clock moves only when something waits)
    await c.profilePage("sample.user", "1");
    await c.savedPage({ kind: "all" });
    expect(ig.asked).toHaveLength(2);
    expect(Math.abs(ig.asked[1].at - ig.asked[0].at)).toBeGreaterThanOrEqual(1500);
  });

  it("opens picked posts in the picker, into the profile's own folder", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.profilePage("sample.user");
    expect(await c.openProfilePicks("sample.user", ["2", "1"])).toEqual({ ok: true });
    const pending = ui.opened[0];
    expect(pending).toMatchObject({ type: "instagram", link: { kind: "profile", username: "sample.user" }, defaultDir: path.join(root, "dl", "Instagram", "sample.user") });
    const found = await c.findInstagram(pending.pendingId);
    expect(found.type === "items" && found.items.map((i) => i.mediaId)).toEqual(["2", "1"]);
  });

  it("backs a profile up into its username's folder, keyed by the account's number, and lists it", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    expect(await c.startProfileBackup("sample.user")).toEqual({ ok: true });
    expect(await backupEnds(c)).toMatchObject({ state: "finished", name: "sample.user", done: 3, saved: 3 });
    expect(readdirSync(path.join(root, "dl", "Instagram", "sample.user")).sort()).toEqual(["1.jpg", "2.jpg", "3.jpg"]);
    expect(existsSync(path.join(root, "user", "instagram-backups", "profile-5100000000000000001.json"))).toBe(true);
    expect(await c.instagramProfiles()).toMatchObject([{ id: "5100000000000000001", username: "sample.user", saved: 3 }]);
  });

  it("keeps a renamed account's ledger: nothing is fetched again", async () => {
    const renamed = { profile: person("5100000000000000001", "renamed.user"), pages: SAMPLE.pages };
    const ig = fakeProfiles({ "sample.user": SAMPLE, "renamed.user": renamed });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    await backupEnds(c);
    const fetchedBefore = ig.fetched.length;
    await c.profileLoad("renamed.user");
    await c.startProfileBackup("renamed.user");
    expect(await backupEnds(c)).toMatchObject({ state: "finished", name: "renamed.user" });
    expect(ig.fetched.length).toBe(fetchedBefore);
    expect(await c.instagramProfiles()).toMatchObject([{ username: "renamed.user" }]);
  });

  it("runs one backup at a time, Saved's and profiles' alike", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE }, { hangFetch: true });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    expect(await c.startProfileBackup("sample.user")).toEqual({ ok: false, error: "A backup is already running." });
    expect((await c.startBackup("102")).ok).toBe(false);
    await c.stopBackup();
  });

  it("keeps a backed-up profile's page open until its backup ends, even when another profile opens", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE, "other.user": { profile: person("53", "other.user"), pages: [[]] } }, { hangFetch: true });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    await c.profileLoad("other.user");
    expect(ig.closed).toEqual([]);
    await c.stopBackup();
    await new Promise((r) => setTimeout(r, 20));
    expect(ig.closed).toEqual(["sample.user"]);
  });

  it("continues the last backup, of whatever kind, even after its profile was left", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE, "other.user": { profile: person("53", "other.user"), pages: [[]] } }, { hangFetch: true });
    const c = await signedIn(ig.deps);
    expect(await c.continueBackup()).toEqual({ ok: false, error: "There is no backup to continue." });
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    await c.profileLoad("other.user");
    await c.stopBackup();
    expect(await c.continueBackup()).toEqual({ ok: true });
    expect(c.snapshot().instagramBackup).toMatchObject({ state: "running", name: "sample.user" });
    await c.stopBackup();
  });

  it("keeps a link's request to open a screen until the main window takes it, once", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await start({}, null, ig.deps);
    expect(await c.takeOpenRequest()).toBeNull();
    await c.handleDownloadRequest({ url: "https://www.instagram.com/sample.user/", source: "context-menu", cookieJar: sessionJar });
    expect(await c.takeOpenRequest()).toEqual({ section: "profiles", username: "sample.user" });
    expect(await c.takeOpenRequest()).toBeNull();
    await c.handleDownloadRequest({ url: "https://www.instagram.com/sample.user/saved/", source: "context-menu" });
    expect(await c.takeOpenRequest()).toEqual({ section: "saved" });
  });

  it("doesn't download a picked post again that is already in the profile's folder", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    await backupEnds(c);
    await c.profilePage("sample.user");
    await c.openProfilePicks("sample.user", ["1", "2"]);
    const all = ui.opened[0].pendingId;
    await c.findInstagram(all);
    expect(await c.confirmInstagram(all, [], "now")).toEqual({ ok: false, error: "These are already in Instagram › sample.user." });
    expect(c.manager.list()).toHaveLength(0);
    rmSync(path.join(root, "dl", "Instagram", "sample.user", "2.jpg"));
    await c.openProfilePicks("sample.user", ["1", "2"]);
    const some = ui.opened[1].pendingId;
    await c.findInstagram(some);
    expect(await c.confirmInstagram(some, [], "now")).toEqual({ ok: true });
    expect(c.manager.list().map((d) => d.filename)).toEqual(["2.jpg"]);
  });

  it("forgets a profile from the list along with its ledger", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    await c.startProfileBackup("sample.user");
    await backupEnds(c);
    await c.removeInstagramProfile("5100000000000000001");
    expect(await c.instagramProfiles()).toEqual([]);
    expect(existsSync(path.join(root, "user", "instagram-backups", "profile-5100000000000000001.json"))).toBe(false);
  });
});

describe("Instagram highlights", () => {
  const sessionJar: BrowserCookie[] = [
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
  ];
  const PROFILE: InstagramProfile = { id: "5100000000000000001", username: "sample.user", fullName: "Sample User", isPrivate: false, following: true, postCount: 3 };
  const TRAY = [
    { id: "17900000000000002", title: "Summer", cover: "https://cdn.example/h2.jpg" },
    { id: "17900000000000003", title: "Winter", cover: "https://cdn.example/h3.jpg" },
  ];
  const story = (id: string): InstagramItem => ({ kind: "image", url: server.url(`/ig/${id}.jpg`), mediaId: id });

  /** A profile with two highlights; `stories` is what each highlight's page shows (changeable between runs). */
  function fakeHighlights(stories: Record<string, InstagramItem[] | null | "signedOut">) {
    let now = 0;
    const read: { id: string; at: number }[] = [];
    const fetched: string[] = [];
    const deps: InstagramDeps = {
      find: async (link) => {
        if (link.kind !== "highlight") return { type: "nothing" };
        read.push({ id: link.id, at: now });
        const shown = stories[link.id];
        if (shown === "signedOut") return { type: "signedOut" };
        return shown && shown.length > 0 ? { type: "items", items: shown } : { type: "nothing" };
      },
      signIn: async () => null,
      crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
      agent: "TestAgent/1",
      wait: async (ms) => {
        now += ms;
      },
      now: () => now,
      fetch: async (url, file) => {
        fetched.push(url);
        writeFileSync(file, "x");
      },
      openProfile: () => ({
        profile: async () => PROFILE,
        highlights: TRAY,
        limited: false,
        page: async () => ({ posts: [] }),
        close: () => undefined,
      }),
    };
    return { deps, read, fetched };
  }

  beforeEach(() => {
    for (const id of ["s1", "s2", "s3", "s4"]) server.setFile(`/ig/${id}.jpg`, { data: Buffer.alloc(600, 2), contentType: "image/jpeg" });
  });

  async function opened(deps: InstagramDeps) {
    const c = await start({}, null, deps);
    c.instagramSession.take(sessionJar);
    await c.profileLoad("sample.user");
    return c;
  }

  async function backupEnds(c: AppController) {
    for (let i = 0; i < 200 && c.snapshot().instagramBackup?.state === "running"; i++) await new Promise((r) => setTimeout(r, 25));
    return c.snapshot().instagramBackup;
  }

  const FOLDER = () => path.join(root, "dl", "Instagram", "sample.user", "Highlights");

  it("opens the picked highlights' stories in the picker, in pick order, into the highlights folder", async () => {
    const hl = fakeHighlights({ "17900000000000002": [story("s1"), story("s2")], "17900000000000003": [story("s3")] });
    const c = await opened(hl.deps);
    expect(await c.loadHighlight("sample.user", "17900000000000003")).toEqual({ type: "stories", count: 1 });
    expect(await c.loadHighlight("sample.user", "17900000000000002")).toEqual({ type: "stories", count: 2 });
    expect(await c.openHighlightPicks("sample.user", ["17900000000000003", "17900000000000002"])).toEqual({ ok: true });
    const pending = ui.opened[0];
    expect(pending).toMatchObject({ type: "instagram", defaultDir: FOLDER() });
    const found = await c.findInstagram(pending.pendingId);
    expect(found.type === "items" && found.items.map((i) => i.mediaId)).toEqual(["s3", "s1", "s2"]);
  });

  it("skips a highlight that shows nothing, and says so when none could be read", async () => {
    const hl = fakeHighlights({ "17900000000000002": [story("s1")], "17900000000000003": null });
    const c = await opened(hl.deps);
    expect(await c.loadHighlight("sample.user", "17900000000000003")).toEqual({ type: "nothing" });
    await c.loadHighlight("sample.user", "17900000000000002");
    await c.openHighlightPicks("sample.user", ["17900000000000003", "17900000000000002"]);
    const found = await c.findInstagram(ui.opened[0].pendingId);
    expect(found.type === "items" && found.items.map((i) => i.mediaId)).toEqual(["s1"]);
    expect(await c.openHighlightPicks("sample.user", ["17900000000000003"])).toEqual({ ok: false, error: "Couldn't read these highlights." });
  });

  it("answers signed out when a highlight's page is Instagram's sign-in page", async () => {
    const hl = fakeHighlights({ "17900000000000002": "signedOut" });
    const c = await opened(hl.deps);
    expect(await c.loadHighlight("sample.user", "17900000000000002")).toEqual({ type: "signedOut" });
  });

  it("reads highlights one at a time, in the account's pace", async () => {
    const hl = fakeHighlights({ "17900000000000002": [story("s1")], "17900000000000003": [story("s3")] });
    const c = await opened(hl.deps);
    await c.loadHighlight("sample.user", "17900000000000002");
    await c.loadHighlight("sample.user", "17900000000000003");
    expect(hl.read[1].at - hl.read[0].at).toBeGreaterThanOrEqual(1500);
  });

  it("backs every highlight up into its folder, by story, counting highlights", async () => {
    const hl = fakeHighlights({ "17900000000000002": [story("s1"), story("s2")], "17900000000000003": [story("s3")] });
    const c = await opened(hl.deps);
    expect(await c.startHighlightsBackup("sample.user")).toEqual({ ok: true });
    expect(await backupEnds(c)).toMatchObject({ state: "finished", kind: "highlights", name: "sample.user · Highlights", done: 2, left: 0, saved: 3 });
    expect(readdirSync(FOLDER()).sort()).toEqual(["s1.jpg", "s2.jpg", "s3.jpg"]);
    expect(existsSync(path.join(root, "user", "instagram-backups", "highlights-5100000000000000001.json"))).toBe(true);
    expect(await c.instagramProfiles()).toMatchObject([{ username: "sample.user", saved: 3 }]);
  });

  it("goes through every highlight on a later run and saves only a new story", async () => {
    const stories: Record<string, InstagramItem[] | null> = { "17900000000000002": [story("s1")], "17900000000000003": [story("s3")] };
    const hl = fakeHighlights(stories);
    const c = await opened(hl.deps);
    await c.startHighlightsBackup("sample.user");
    await backupEnds(c);
    stories["17900000000000002"] = [story("s1"), story("s4")];
    const before = hl.fetched.length;
    const readBefore = hl.read.length;
    await c.startHighlightsBackup("sample.user");
    expect(await backupEnds(c)).toMatchObject({ state: "finished", saved: 1 });
    expect(hl.fetched.slice(before)).toEqual([server.url("/ig/s4.jpg")]);
    expect(hl.read.slice(readBefore).map((r) => r.id)).toEqual(["17900000000000002", "17900000000000003"]);
  });

  it("counts a highlight that shows nothing as failed and tries it again next run", async () => {
    const stories: Record<string, InstagramItem[] | null> = { "17900000000000002": [story("s1")], "17900000000000003": null };
    const hl = fakeHighlights(stories);
    const c = await opened(hl.deps);
    await c.startHighlightsBackup("sample.user");
    expect(await backupEnds(c)).toMatchObject({ state: "finished", done: 1, failed: 1 });
    stories["17900000000000003"] = [story("s3")];
    await c.startHighlightsBackup("sample.user");
    expect(await backupEnds(c)).toMatchObject({ state: "finished", done: 2, failed: 0, saved: 1 });
  });

  it("stops the backup as signed out when a highlight's page asks to sign in", async () => {
    const hl = fakeHighlights({ "17900000000000002": [story("s1")], "17900000000000003": "signedOut" });
    const c = await opened(hl.deps);
    await c.startHighlightsBackup("sample.user");
    expect(await backupEnds(c)).toMatchObject({ state: "signedOut", saved: 1 });
  });
});

describe("Instagram signed out, and a folder per account", () => {
  const sessionJar: BrowserCookie[] = [
    { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
  ];
  const PROFILE: InstagramProfile = { id: "5100000000000000001", username: "sample.user", fullName: "Sample User", isPrivate: false, following: false };
  const cover = (id: string, code: string): SavedPost => ({ id, code, cover: `https://cdn.example/${id}.jpg`, items: [], unread: true, mediaType: 8 });
  const item = (id: string, owner = "sample.user"): InstagramItem => ({ kind: "image", url: server.url(`/ig/${id}.jpg`), mediaId: id, owner });

  /** A public profile seen signed out (covers only), and post or highlight pages that show `pages[code or id]`. */
  function fakeSignedOut(pages: Record<string, InstagramItem[]>) {
    const opened: { username: string; cookies: string[] }[] = [];
    const read: string[] = [];
    const deps: InstagramDeps = {
      find: async (link) => {
        const key = link.kind === "post" ? link.code : link.kind === "highlight" ? link.id : link.kind;
        read.push(key);
        const found = pages[key];
        return found ? { type: "items", items: found } : { type: "nothing" };
      },
      signIn: async () => null,
      crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
      agent: "TestAgent/1",
      wait: async () => undefined,
      fetch: async (_url, file) => writeFileSync(file, "x"),
      openProfile: (username, cookies) => {
        opened.push({ username, cookies: cookies.map((c) => c.name) });
        return {
          profile: async () => PROFILE,
          highlights: [{ id: "17900000000000002", title: "Summer" }],
          limited: true,
          page: async () => ({ posts: [cover("p1", "C1"), cover("p2", "C2")] }),
          close: () => undefined,
        };
      },
    };
    return { deps, opened, read };
  }

  beforeEach(() => {
    for (const id of ["a", "b", "c"]) server.setFile(`/ig/${id}.jpg`, { data: Buffer.alloc(300, 1), contentType: "image/jpeg" });
  });

  it("opens a public profile without a session, as Instagram shows it to signed-out visitors", async () => {
    const so = fakeSignedOut({});
    const c = await start({}, null, so.deps);
    expect(await c.profileLoad("sample.user")).toEqual({ type: "profile", profile: PROFILE, highlights: [{ id: "17900000000000002", title: "Summer" }], limited: true });
    expect(so.opened).toEqual([{ username: "sample.user", cookies: [] }]);
  });

  it("reads picked posts from their own pages when only their covers are known, skipping those that show nothing", async () => {
    const so = fakeSignedOut({ C1: [item("a"), item("b")] });
    const c = await start({}, null, so.deps);
    await c.profileLoad("sample.user");
    await c.profilePage("sample.user");
    expect(await c.openProfilePicks("sample.user", ["p2", "p1"])).toEqual({ ok: true });
    expect(so.read).toEqual(["C2", "C1"]);
    const found = await c.findInstagram(ui.opened[0].pendingId);
    expect(found.type === "items" && found.items.map((i) => i.mediaId)).toEqual(["a", "b"]);
    expect(await c.openProfilePicks("sample.user", ["p2"])).toEqual({ ok: false, error: "Couldn't read these posts." });
  });

  it("asks to sign in before backing up a profile seen signed out", async () => {
    const so = fakeSignedOut({});
    const c = await start({}, null, so.deps);
    await c.profileLoad("sample.user");
    const signIn = { ok: false, error: "Sign in to Instagram to back up a profile." };
    expect(await c.startProfileBackup("sample.user")).toEqual(signIn);
    expect(await c.startHighlightsBackup("sample.user")).toEqual(signIn);
  });

  it("puts a link's items in their account's folder, highlights under it, and in Instagram when that is switched off", async () => {
    const so = fakeSignedOut({ C1abcDEF: [item("a", "someone")], "17900000000000009": [item("b", "someone")] });
    const c = await start({}, null, so.deps);
    c.instagramSession.take(sessionJar);
    const pick = async (url: string) => {
      ui.opened = [];
      await c.handleDownloadRequest({ url, source: "manual" });
      const id = ui.opened[0].pendingId;
      await c.findInstagram(id);
      await c.confirmInstagram(id, [], "later");
      return c.manager.list().map((d) => d.dir);
    };
    expect(await pick("https://www.instagram.com/p/C1abcDEF/")).toEqual([path.join(root, "dl", "Instagram", "someone")]);
    expect(await pick("https://www.instagram.com/stories/highlights/17900000000000009/")).toContain(path.join(root, "dl", "Instagram", "someone", "Highlights"));
    await c.updateSettings({ instagramByAccount: false });
    c.manager.remove(c.manager.list().map((d) => d.id), false);
    expect(await pick("https://www.instagram.com/p/C1abcDEF/")).toEqual([path.join(root, "dl", "Instagram")]);
  });
});
