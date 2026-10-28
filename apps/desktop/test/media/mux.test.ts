import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canSkipMux, mux, muxArgs } from "../../src/main/media/mux";
import { FFMPEG, ff, makeClips, streamsOf, type Clips } from "../fixtures/media";

let dir: string;
let clips: Clips;
const signal = () => new AbortController().signal;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-mux-"));
  clips = makeClips(path.join(dir, "clips"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("muxArgs", () => {
  it("maps a video and an audio track into mp4 without re-encoding", () => {
    expect(muxArgs([{ path: "v", role: "video", ext: "mp4" }, { path: "a", role: "audio", ext: "m4a" }], "out", "mp4")).toEqual([
      "-hide_banner", "-loglevel", "error", "-y", "-i", "v", "-i", "a", "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "mp4", "out",
    ]);
  });

  it("fixes AAC from TS for mp4 and keeps optional streams of a muxed track", () => {
    const args = muxArgs([{ path: "s", role: "av", ext: "ts" }], "out", "mp4");
    expect(args).toContain("aac_adtstoasc");
    expect(args.join(" ")).toContain("-map 0:v:0? -map 0:a:0?");
    expect(muxArgs([{ path: "s", role: "av", ext: "ts" }], "out", "matroska")).not.toContain("aac_adtstoasc");
  });

  it("encodes mp3 for audio only", () => {
    expect(muxArgs([{ path: "a", role: "audio", ext: "m4a" }], "out", "mp3").slice(4)).toEqual(["-i", "a", "-vn", "-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", "out"]);
  });

  it("skips ffmpeg only for a single progressive mp4 with sound", () => {
    expect(canSkipMux([{ path: "x", role: "av", ext: "mp4" }], "mp4", false)).toBe(true);
    expect(canSkipMux([{ path: "x", role: "av", ext: "mp4" }], "mp4", true)).toBe(false);
    expect(canSkipMux([{ path: "x", role: "av", ext: "webm" }], "mp4", false)).toBe(false);
    expect(canSkipMux([{ path: "x", role: "audio", ext: "m4a" }], "mp3", false)).toBe(false);
  });
});

describe("mux with the bundled ffmpeg", () => {
  it("joins video and audio into one mp4", async () => {
    const v = path.join(dir, "v.mp4");
    const a = path.join(dir, "a.m4a");
    writeFileSync(v, clips.video);
    writeFileSync(a, clips.audio);
    const out = path.join(dir, "joined.turbodl-mux");
    expect(await mux(FFMPEG, [{ path: v, role: "video", ext: "mp4" }, { path: a, role: "audio", ext: "m4a" }], out, "mp4", signal())).toBe("mp4");
    expect(streamsOf(out)).toEqual(["Video: h264", "Audio: aac"]);
  });

  it("remuxes a TS track to mp4", async () => {
    const ts = path.join(dir, "joined.ts");
    ff(["-i", path.join(clips.hls.av, "index.m3u8"), "-c", "copy", ts]);
    const out = path.join(dir, "ts.turbodl-mux");
    expect(await mux(FFMPEG, [{ path: ts, role: "av", ext: "ts" }], out, "mp4", signal())).toBe("mp4");
    expect(streamsOf(out)).toEqual(["Video: h264", "Audio: aac"]);
  });

  it("converts audio to mp3", async () => {
    const a = path.join(dir, "a2.m4a");
    writeFileSync(a, clips.audio);
    const out = path.join(dir, "song.turbodl-mux");
    expect(await mux(FFMPEG, [{ path: a, role: "audio", ext: "m4a" }], out, "mp3", signal())).toBe("mp3");
    expect(streamsOf(out)).toEqual(["Audio: mp3"]);
  });

  it("falls back to mkv when mp4 cannot hold the audio", async () => {
    const v = path.join(dir, "v3.mp4");
    writeFileSync(v, clips.video);
    const wav = path.join(dir, "adpcm.wav");
    ff(["-f", "lavfi", "-i", "sine", "-t", "1", "-c:a", "adpcm_ima_wav", wav]);
    const out = path.join(dir, "odd.turbodl-mux");
    expect(await mux(FFMPEG, [{ path: v, role: "video", ext: "mp4" }, { path: wav, role: "audio", ext: "wav" }], out, "mp4", signal())).toBe("mkv");
    expect(streamsOf(out)).toEqual(["Video: h264", "Audio: adpcm_ima_wav"]);
  });

  it("explains a missing ffmpeg and a failed join", async () => {
    await expect(mux(null, [], path.join(dir, "x"), "mp4", signal())).rejects.toThrow("ffmpeg not found");
    const bad = path.join(dir, "bad.mp4");
    writeFileSync(bad, "not a video");
    await expect(mux(FFMPEG, [{ path: bad, role: "audio", ext: "mp4" }], path.join(dir, "y"), "mp3", signal())).rejects.toThrow("Joining failed");
  });

  it("stops ffmpeg when paused", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(mux(FFMPEG, [{ path: "x", role: "av", ext: "mp4" }], path.join(dir, "z"), "mp4", controller.signal)).rejects.toThrow("Cancelled");
  });
});
