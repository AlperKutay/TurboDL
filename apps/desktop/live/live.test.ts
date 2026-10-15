import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DownloadRecord, StreamOrigin } from "@turbodl/shared";
import { createResolver, streamOptions } from "../src/main/media/resolve";
import { StreamTask } from "../src/main/media/stream-task";
import { heightSelector } from "../src/main/media/ytdlp";
import { FFMPEG, streamsOf } from "../test/fixtures/media";

const TOOLS = process.env.TURBODL_TOOLS ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "Library", "Application Support"), "TurboDL", "tools");
const YTDLP = path.join(TOOLS, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const DENO = path.join(TOOLS, "deno", process.platform === "win32" ? "deno.exe" : "deno");
const dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-live-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const resolver = createResolver({ tools: async () => ({ ytdlp: YTDLP, deno: existsSync(DENO) ? DENO : null, ffmpeg: FFMPEG }) });

function record(name: string, origin: StreamOrigin, output: "mp4" | "mp3" = "mp4"): DownloadRecord {
  return {
    id: name, kind: "stream", url: "", filename: `${name}.${output}`, dir, category: "video", size: null, received: 0, status: "queued",
    headers: {}, resumable: true, segments: [], viaScheduler: false, createdAt: 0, stream: { origin, output, tracks: [] },
  };
}

async function download(rec: DownloadRecord): Promise<{ file: string; seconds: number }> {
  const t0 = Date.now();
  await new StreamTask(rec, { connections: () => 8, ffmpegPath: FFMPEG, resolve: resolver, fallback: () => { throw new Error("unexpected fallback"); } }).start();
  expect(rec.error).toBeUndefined();
  expect(rec.status).toBe("completed");
  return { file: path.join(dir, rec.filename), seconds: (Date.now() - t0) / 1000 };
}

/** Decodes the whole file; throws on corrupt data. */
function decodes(file: string): void {
  execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { windowsHide: true, timeout: 300_000 });
}

describe.skipIf(!existsSync(YTDLP))("YouTube through yt-dlp addresses and TurboDL's engine", () => {
  it("downloads Big Buck Bunny 1080p faster than or as fast as yt-dlp itself", async () => {
    const page = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
    const ours = await download(record("bbb-turbodl", { type: "ytdlp", pageUrl: page, formatSelector: heightSelector(1080) }));
    expect(streamsOf(ours.file)).toEqual(expect.arrayContaining([expect.stringMatching(/^Video: /), expect.stringMatching(/^Audio: /)]));
    const t0 = Date.now();
    execFileSync(YTDLP, ["--no-warnings", "--no-part", "-f", heightSelector(1080), "--merge-output-format", "mp4", "--ffmpeg-location", FFMPEG, "--js-runtimes", `deno:${DENO}`, "-o", path.join(dir, "bbb-ytdlp.%(ext)s"), "--", page], { windowsHide: true, timeout: 600_000 });
    const theirs = (Date.now() - t0) / 1000;
    console.log(`[live] TurboDL ${ours.seconds.toFixed(1)} s, ${(statSync(ours.file).size / 1048576).toFixed(0)} MB; yt-dlp ${theirs.toFixed(1)} s`);
    expect(ours.seconds).toBeLessThanOrEqual(theirs * 1.25);
  });
});

describe("public HLS/DASH test streams", () => {
  it("Mux HLS (TS variants)", async () => {
    const url = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    const options = await streamOptions("hls", url, {});
    const low = options.filter((o) => !o.audioOnly).at(-1)!;
    const { file } = await download(record("mux", { type: "hls", url, variant: low.formatSelector }));
    expect(streamsOf(file)).toEqual(expect.arrayContaining(["Video: h264", "Audio: aac"]));
    decodes(file);
  });

  it("Apple fMP4 HLS with separate audio and byte ranges", async () => {
    const url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
    const options = await streamOptions("hls", url, {});
    const low = options.filter((o) => !o.audioOnly).at(-1)!;
    const { file } = await download(record("apple", { type: "hls", url, variant: low.formatSelector }));
    expect(streamsOf(file)).toEqual(expect.arrayContaining(["Video: h264", "Audio: aac"]));
    decodes(file);
  });

  it("Akamai DASH (numbered SegmentTemplate)", async () => {
    const url = "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd";
    const options = await streamOptions("dash", url, {});
    const low = options.filter((o) => !o.audioOnly).at(-1)!;
    const { file } = await download(record("akamai", { type: "dash", url, video: low.formatSelector, audio: null }));
    expect(streamsOf(file)).toEqual(expect.arrayContaining(["Video: h264", "Audio: aac"]));
    decodes(file);
  });
});
