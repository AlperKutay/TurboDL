import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord, StreamOrigin } from "@turbodl/shared";
import { resolveHls, type Resolved, type TrackPlan } from "../../src/main/media/resolve";
import { StreamTask, streamTempFiles, trackFileName, type StreamTaskOptions } from "../../src/main/media/stream-task";
import type { TaskHandle } from "../../src/main/task";
import { FFMPEG, makeClips, serveFolder, streamsOf, type Clips } from "../fixtures/media";
import { startTestServer, type TestServer } from "../fixtures/test-server";

let clipsDir: string;
let clips: Clips;
let server: TestServer;
let dir: string;
beforeAll(() => {
  clipsDir = mkdtempSync(path.join(os.tmpdir(), "turbodl-clips-"));
  clips = makeClips(clipsDir);
});
afterAll(() => {
  rmSync(clipsDir, { recursive: true, force: true });
});
beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-stream-"));
  server.setFile("/v.mp4", { data: clips.video });
  server.setFile("/a.m4a", { data: clips.audio });
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = (r: DownloadRecord): DownloadRecord => JSON.parse(JSON.stringify(r));

function record(origin: StreamOrigin = { type: "ytdlp", pageUrl: "https://video.example/w", formatSelector: "bv*+ba/b" }, output: "mp4" | "mp3" = "mp4"): DownloadRecord {
  return {
    id: "s1", kind: "stream", url: "https://video.example/w", filename: output === "mp3" ? "Clip.mp3" : "Clip.mp4", dir, category: "video",
    size: null, received: 0, status: "queued", headers: {}, resumable: true, segments: [], viaScheduler: false, createdAt: 0,
    stream: { origin, output, tracks: [] },
  };
}

function fileTrack(id: string, role: TrackPlan["role"], urlPath: string, ext: string, size: number | null, chunkSize?: number): TrackPlan {
  return { id, role, ext, headers: { "User-Agent": "UA-test" }, source: { kind: "file", url: server.url(urlPath), size, ...(chunkSize ? { chunkSize } : {}) } };
}

function options(resolve: StreamTaskOptions["resolve"], extra: Partial<StreamTaskOptions> = {}): StreamTaskOptions {
  return {
    connections: () => 4,
    ffmpegPath: FFMPEG,
    resolve,
    fallback: () => {
      throw new Error("no fallback expected");
    },
    retryBaseMs: 10,
    idleTimeoutMs: 5000,
    ...extra,
  };
}

const twoTracks = (chunk?: number): Resolved => ({
  type: "tracks",
  tracks: [fileTrack("v1", "video", "/v.mp4", "mp4", clips.video.length, chunk), fileTrack("a1", "audio", "/a.m4a", "m4a", clips.audio.length)],
});

describe("StreamTask", () => {
  it("downloads a video and an audio track and joins them into one mp4", async () => {
    const rec = record();
    await new StreamTask(rec, options(async () => twoTracks(16 * 1024))).start();
    expect(rec.status).toBe("completed");
    expect(rec.filename).toBe("Clip.mp4");
    expect(streamsOf(path.join(dir, "Clip.mp4"))).toEqual(["Video: h264", "Audio: aac"]);
    expect(readdirSync(dir)).toEqual(["Clip.mp4"]);
    expect(rec.stream?.tracks).toEqual([]);
    expect(rec.size).toBe(rec.received);
    const videoRanges = server.requests.filter((r) => r.path === "/v.mp4" && r.range && r.range !== "bytes=0-0");
    expect(videoRanges.length).toBeGreaterThan(1);
    expect(server.requests.find((r) => r.path === "/v.mp4")?.headers["user-agent"]).toBe("UA-test");
  });

  it("downloads HLS through the real resolver: video and separate audio playlists, remuxed to mp4", async () => {
    serveFolder(server, clips.hls.v, "/hls/v");
    serveFolder(server, clips.hls.a, "/hls/a");
    server.setFile("/hls/master.m3u8", {
      data: Buffer.from('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ses",DEFAULT=YES,URI="a/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x240,AUDIO="aud"\nv/index.m3u8\n'),
    });
    const rec = record({ type: "hls", url: server.url("/hls/master.m3u8"), variant: "320x240@700000" });
    await new StreamTask(rec, options((r, signal) => resolveHls(r.stream!.origin as { url: string; variant: string | null }, r.headers, signal))).start();
    expect({ status: rec.status, error: rec.error }).toEqual({ status: "completed", error: undefined });
    expect(streamsOf(path.join(dir, "Clip.mp4"))).toEqual(["Video: h264", "Audio: aac"]);
    expect(readdirSync(dir)).toEqual(["Clip.mp4"]);
  });

  it("converts audio only to mp3", async () => {
    const rec = record(undefined, "mp3");
    await new StreamTask(rec, options(async () => ({ type: "tracks", tracks: [fileTrack("a1", "audio", "/a.m4a", "m4a", clips.audio.length)] }))).start();
    expect(rec.status).toBe("completed");
    expect(rec.filename).toBe("Clip.mp3");
    expect(streamsOf(path.join(dir, "Clip.mp3"))).toEqual(["Audio: mp3"]);
  });

  it("keeps a single progressive mp4 as it is, without ffmpeg", async () => {
    const rec = record();
    await new StreamTask(rec, options(async () => ({ type: "tracks", tracks: [fileTrack("18", "av", "/v.mp4", "mp4", clips.video.length)] }), { ffmpegPath: null })).start();
    expect(rec.status).toBe("completed");
    expect(rec.size).toBe(clips.video.length);
  });

  it("resumes a paused track with the fresh address of the same format", async () => {
    server.setFile("/slow-v.mp4", { data: clips.video, throttle: 20 * 1024 });
    server.setFile("/fresh-v.mp4", { data: clips.video });
    const rec = record();
    const first: Resolved = { type: "tracks", tracks: [fileTrack("v1", "video", "/slow-v.mp4", "mp4", clips.video.length), fileTrack("a1", "audio", "/a.m4a", "m4a", clips.audio.length)] };
    const task = new StreamTask(rec, options(async () => first, { connections: () => 1 }));
    const running = task.start();
    while ((rec.stream?.tracks[0]?.file?.received ?? 0) < 4096) await wait(20);
    task.pause();
    await running;
    expect(rec.status).toBe("paused");
    const partial = rec.stream!.tracks[0].file!.received;
    expect(partial).toBeGreaterThan(0);
    expect(rec.received).toBe(partial);

    const restored = clone(rec);
    const fresh: Resolved = { type: "tracks", tracks: [fileTrack("v1", "video", "/fresh-v.mp4", "mp4", clips.video.length), fileTrack("a1", "audio", "/a.m4a", "m4a", clips.audio.length)] };
    await new StreamTask(restored, options(async () => fresh)).start();
    expect(restored.status).toBe("completed");
    expect(streamsOf(path.join(dir, "Clip.mp4"))).toEqual(["Video: h264", "Audio: aac"]);
    const freshStarts = server.requests.filter((r) => r.path === "/fresh-v.mp4" && r.range && r.range !== "bytes=0-0").map((r) => Number(/bytes=(\d+)-/.exec(r.range!)![1]));
    expect(Math.min(...freshStarts)).toBeGreaterThanOrEqual(partial - 64 * 1024);
  });

  it("starts the tracks over when the resolved formats changed", async () => {
    server.setFile("/slow-v.mp4", { data: clips.video, throttle: 20 * 1024 });
    const rec = record();
    const task = new StreamTask(rec, options(async () => ({ type: "tracks", tracks: [fileTrack("v1", "video", "/slow-v.mp4", "mp4", clips.video.length)] }), { connections: () => 1 }));
    const running = task.start();
    while ((rec.stream?.tracks[0]?.file?.received ?? 0) === 0) await wait(20);
    task.pause();
    await running;
    const restored = clone(rec);
    await new StreamTask(restored, options(async () => twoTracks())).start();
    expect(restored.status).toBe("completed");
    expect(streamsOf(path.join(dir, "Clip.mp4"))).toEqual(["Video: h264", "Audio: aac"]);
    expect(readdirSync(dir)).toEqual(["Clip.mp4"]);
  });

  it("hands streams TurboDL does not handle to yt-dlp's own downloader", async () => {
    const rec = record({ type: "ytdlp", pageUrl: "https://video.example/live", formatSelector: "best", cookies: [{ domain: "video.example", hostOnly: true, path: "/", secure: true, expires: 0, name: "s", value: "1" }] });
    let handed: DownloadRecord | null = null;
    const fallback = (r: DownloadRecord): TaskHandle => {
      handed = r;
      return {
        record: r, speed: 0, eta: null, connections: 1, note: undefined,
        start: async () => {
          r.received = 50;
          r.size = 50;
          r.filename = "Live stream.mp4";
          r.status = "completed";
          r.completedAt = 1;
        },
        pause: () => undefined,
      };
    };
    await new StreamTask(rec, options(async () => ({ type: "fallback" }), { fallback })).start();
    expect(handed).toMatchObject({ kind: "ytdlp", url: "https://video.example/live", ytdlp: { formatSelector: "best", audioOnly: false, cookies: [{ name: "s" }] } });
    expect(rec).toMatchObject({ status: "completed", filename: "Live stream.mp4", size: 50, received: 50, kind: "stream" });
  });

  it("reports DRM and other resolver errors", async () => {
    const rec = record();
    await new StreamTask(rec, options(async () => {
      throw new Error("This video is DRM-protected and cannot be downloaded.");
    })).start();
    expect(rec).toMatchObject({ status: "error", error: "This video is DRM-protected and cannot be downloaded." });
  });

  it("fails with the server's message when a track is gone", async () => {
    const rec = record();
    await new StreamTask(rec, options(async () => ({ type: "tracks", tracks: [fileTrack("v1", "video", "/missing.mp4", "mp4", null)] }))).start();
    expect(rec.status).toBe("error");
    expect(rec.error).toContain("404");
  });

  it("shows what it is doing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const rec = record();
    const task = new StreamTask(rec, options(async () => {
      await gate;
      return twoTracks();
    }));
    const running = task.start();
    await wait(10);
    expect(task.note).toBe("Getting video addresses…");
    release();
    await running;
    expect(task.note).toBeUndefined();
  });

  it("lists every temp file of a stream download", () => {
    const rec = record();
    rec.stream!.tracks = [
      { id: "v", role: "video", ext: "mp4", done: false, file: { ...rec, id: "t0", kind: "http", filename: trackFileName("Clip.mp4", 0), stream: undefined } },
      { id: "a", role: "audio", ext: "ts", done: false, frag: { count: 3, initDone: false, done: 1, bytes: 10 } },
    ];
    expect(streamTempFiles(rec).map((f) => path.basename(f)).sort()).toEqual(
      ["Clip.mp4.turbodl-mux", "Clip.mp4.turbodl-t0", "Clip.mp4.turbodl-t0.turbodl", "Clip.mp4.turbodl-t1", "Clip.mp4.turbodl-t1.turbodl"].sort(),
    );
    expect(existsSync(dir)).toBe(true);
  });
});
