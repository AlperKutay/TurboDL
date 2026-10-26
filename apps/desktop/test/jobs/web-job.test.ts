import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sanitizeFilename, type DownloadRecord, type JobRequest } from "@turbodl/shared";
import { HttpDownloadTask } from "../../src/main/engine/download-task";
import { probe } from "../../src/main/engine/probe";
import { JobRecord } from "../../src/main/jobs/job-record";
import { runWebJob, type WebJobDeps } from "../../src/main/jobs/web-job";
import { DownloadManager, type StateFile, type StateStore } from "../../src/main/manager";
import { streamOptions } from "../../src/main/media/resolve";
import { fetchMediaInfo } from "../../src/main/media/ytdlp-task";
import { defaultSettings } from "../../src/main/settings";
import type { TaskHandle } from "../../src/main/task";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const FAKE_YTDLP = path.join(__dirname, "..", "fixtures", "fake-ytdlp.mjs");

class MemoryStore implements StateStore {
  load(fallback: () => StateFile): StateFile {
    return fallback();
  }
  save(): void {}
  flush(): void {}
}

/** A stream or yt-dlp download that never finishes by itself; pausing ends it. */
class HeldTask implements TaskHandle {
  speed = 0;
  eta = null;
  connections = 0;
  note = undefined;
  private finish: (() => void) | null = null;
  constructor(readonly record: DownloadRecord) {}
  start(): Promise<void> {
    this.record.status = "downloading";
    return new Promise<void>((resolve) => (this.finish = resolve));
  }
  pause(): void {
    this.record.status = "paused";
    this.finish?.();
  }
}

let server: TestServer;
let root: string;
let manager: DownloadManager;

beforeEach(async () => {
  server = await startTestServer();
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-webjob-"));
  manager = new DownloadManager({
    store: new MemoryStore(),
    settings: () => ({ ...defaultSettings(root), maxConcurrent: 4 }),
    createTask: (record) => (record.kind === "http" ? new HttpDownloadTask(record, { maxConnections: () => 2, retryBaseMs: 10, idleTimeoutMs: 5000 }) : (new HeldTask(record) as unknown as TaskHandle)),
    tickMs: 20,
  });
  manager.init();
});
afterEach(async () => {
  await manager.shutdown();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function deps(): WebJobDeps {
  return {
    manager,
    probe: (url) => probe(url, {}, undefined, 15000),
    mediaInfo: (pageUrl) => fetchMediaInfo({ ytdlp: "unused", deno: null, ffmpeg: null }, pageUrl, {}, { command: () => ({ file: process.execPath, args: [FAKE_YTDLP] }), cookieFile: null }),
    streamOptions: (kind, url) => streamOptions(kind, url, {}),
    categoryDir: (category) => path.join(root, "cat", category),
  };
}

function newJob(request: Partial<JobRequest> & { url: string }): JobRecord {
  return new JobRecord("j1", request, "file", () => Date.now());
}

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function pageInfo(): void {
  const formats = [{ height: 1080, vcodec: "avc1" }, { height: 720, vcodec: "avc1" }];
  server.setFile("/yt/page.info.json", { data: Buffer.from(JSON.stringify({ title: "Local Video", formats })) });
  server.setFile("/yt/page", { data: Buffer.from("<html></html>"), contentType: "text/html; charset=utf-8" });
}

describe("runWebJob", () => {
  it("downloads a file into its category's folder and reports its path", async () => {
    server.setFile("/files/a.zip", { data: Buffer.alloc(2000, 7), contentType: "application/zip" });
    const job = newJob({ url: server.url("/files/a.zip") });
    await runWebJob(job, deps());
    const final = await job.ended;
    expect(final).toMatchObject({ state: "done", kind: "file", files: [path.join(root, "cat", "archives", "a.zip")] });
  });

  it("uses dir and a name made safe for a file name", async () => {
    server.setFile("/files/a.zip", { data: Buffer.alloc(2000, 7), contentType: "application/zip" });
    const out = path.join(root, "out");
    const job = newJob({ url: server.url("/files/a.zip"), dir: out, name: "a/b:c.zip" });
    await runWebJob(job, deps());
    const files = (await job.ended).files;
    expect(files).toEqual([path.join(out, sanitizeFilename("a/b:c.zip"))]);
    expect(path.dirname(files[0])).toBe(out);
    expect(path.basename(files[0])).not.toMatch(/[\\/:]/);
  });

  it("falls back to a usable name when the given one is empty, dots or a device name", async () => {
    server.setFile("/files/a.zip", { data: Buffer.alloc(2000, 7), contentType: "application/zip" });
    const out = path.join(root, "out");
    for (const name of ["..", "  ", "CON"]) {
      const job = newJob({ url: server.url("/files/a.zip"), dir: out, name });
      await runWebJob(job, deps());
      const file = (await job.ended).files[0];
      expect(path.dirname(file)).toBe(out);
      expect(path.basename(file)).toMatch(/^(download|_CON)/);
    }
  });

  it("makes a media name safe and keeps it inside dir", async () => {
    pageInfo();
    const out = path.join(root, "v");
    const names: Record<string, string> = { "..\\evil/x:y.mkv": ".._evil_x_y.mp4", "..": "download.mp4", CON: "_CON.mp4" };
    for (const [name, expected] of Object.entries(names)) {
      const job = newJob({ url: server.url("/yt/page"), dir: out, name });
      const run = runWebJob(job, deps());
      await until(() => manager.list().length === 1);
      const record = manager.get(manager.list()[0].id)!;
      expect(record.dir).toBe(out);
      expect(record.filename).not.toMatch(/[\\/:]/);
      expect(record.filename).toBe(expected);
      job.cancel();
      await run;
    }
  });

  it("fails notFound for a 404", async () => {
    const job = newJob({ url: server.url("/missing.zip") });
    await runWebJob(job, deps());
    expect(await job.ended).toMatchObject({ state: "failed", reason: "notFound" });
  });

  it("fails with a message when dir can't be created", async () => {
    server.setFile("/files/a.zip", { data: Buffer.alloc(2000, 7), contentType: "application/zip" });
    const blocker = path.join(root, "blocker");
    writeFileSync(blocker, "x");
    const job = newJob({ url: server.url("/files/a.zip"), dir: path.join(blocker, "sub") });
    await runWebJob(job, deps());
    const final = await job.ended;
    expect(final).toMatchObject({ state: "failed", reason: "error" });
    expect(final.error).toBeTruthy();
  });

  it("turns a page into one stream download of its best quality", async () => {
    pageInfo();
    const job = newJob({ url: server.url("/yt/page"), dir: path.join(root, "v") });
    const run = runWebJob(job, deps());
    await until(() => manager.list().length === 1);
    const record = manager.get(manager.list()[0].id)!;
    expect(record).toMatchObject({ kind: "stream", filename: "Local Video.mp4", dir: path.join(root, "v") });
    expect(record.stream?.origin).toMatchObject({ type: "ytdlp", pageUrl: server.url("/yt/page"), formatSelector: expect.stringContaining("height<=1080") });
    expect(job.view().kind).toBe("media");
    job.cancel();
    await run;
    expect(await job.ended).toMatchObject({ state: "cancelled" });
  });

  it("takes the highest quality not above maxHeight, and MP3 with audio", async () => {
    pageInfo();
    const small = newJob({ url: server.url("/yt/page"), options: { maxHeight: 720 }, name: "clip" });
    const smallRun = runWebJob(small, deps());
    await until(() => manager.list().length === 1);
    const first = manager.get(manager.list()[0].id)!;
    expect(first.filename).toBe("clip.mp4");
    expect(first.stream?.origin).toMatchObject({ formatSelector: expect.stringContaining("height<=720") });
    small.cancel();
    await smallRun;

    const audio = newJob({ url: server.url("/yt/page"), options: { audio: true }, name: "song.mp4" });
    const audioRun = runWebJob(audio, deps());
    await until(() => manager.list().length === 1);
    const second = manager.get(manager.list()[0].id)!;
    expect(second).toMatchObject({ filename: "song.mp3", category: "music" });
    expect(second.stream).toMatchObject({ output: "mp3" });
    audio.cancel();
    await audioRun;
  });

  it("fails unsupported with yt-dlp's message for a page it can't read", async () => {
    server.setFile("/error", { data: Buffer.from("<html></html>"), contentType: "text/html" });
    const job = newJob({ url: server.url("/error") });
    await runWebJob(job, deps());
    const final = await job.ended;
    expect(final).toMatchObject({ state: "failed", reason: "unsupported" });
    expect(final.error).toContain("Unsupported URL");
  });

  it("downloads an .m3u8 address as an HLS stream, not as a file", async () => {
    server.setFile("/live/master.m3u8", {
      data: Buffer.from("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x240\nav/index.m3u8\n"),
      contentType: "application/vnd.apple.mpegurl",
    });
    const job = newJob({ url: server.url("/live/master.m3u8"), dir: path.join(root, "v") });
    const run = runWebJob(job, deps());
    await until(() => manager.list().length === 1);
    const record = manager.get(manager.list()[0].id)!;
    expect(record).toMatchObject({ kind: "stream", filename: "master.mp4" });
    expect(record.stream?.origin.type).toBe("hls");
    expect(job.view().kind).toBe("media");
    job.cancel();
    await run;
  });
});
