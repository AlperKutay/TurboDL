import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { TestServer } from "./test-server";

export const FFMPEG = createRequire(__filename)("ffmpeg-static") as string;

function ff(args: string[]): void {
  execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { windowsHide: true });
}

const VIDEO = ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25"];
const AUDIO = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100"];
const H264 = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "12"];

function hls(folder: string, inputs: string[], codecs: string[]): string {
  mkdirSync(folder, { recursive: true });
  ff([...inputs, "-t", "2", ...codecs, "-f", "hls", "-hls_time", "0.5", "-hls_playlist_type", "vod", "-hls_segment_filename", path.join(folder, "seg%d.ts"), path.join(folder, "index.m3u8")]);
  return folder;
}

export interface Clips {
  dir: string;
  /** 2 s, 320x240 h264, no audio */
  video: Buffer;
  /** 2 s aac */
  audio: Buffer;
  /** HLS (TS) folders: muxed, video only, audio only */
  hls: { av: string; v: string; a: string };
}

/** Small real media made with the bundled ffmpeg. */
export function makeClips(dir: string): Clips {
  mkdirSync(dir, { recursive: true });
  const v = path.join(dir, "v.mp4");
  const a = path.join(dir, "a.m4a");
  ff([...VIDEO, "-t", "2", ...H264, "-an", v]);
  ff([...AUDIO, "-t", "2", "-c:a", "aac", a]);
  return {
    dir,
    video: readFileSync(v),
    audio: readFileSync(a),
    hls: {
      av: hls(path.join(dir, "hls-av"), [...VIDEO, ...AUDIO], [...H264, "-c:a", "aac"]),
      v: hls(path.join(dir, "hls-v"), VIDEO, [...H264, "-an"]),
      a: hls(path.join(dir, "hls-a"), AUDIO, ["-vn", "-c:a", "aac"]),
    },
  };
}

/** "Video: h264", "Audio: aac" … for each stream ffmpeg finds in `file`. */
export function streamsOf(file: string): string[] {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file], { encoding: "utf8", windowsHide: true });
  return [...r.stderr.matchAll(/Stream #\d+:\d+.*?: (Video|Audio): (\w+)/g)].map((m) => `${m[1]}: ${m[2]}`);
}

/** Serves every file of `folder` at `<prefix>/<name>`. */
export function serveFolder(server: TestServer, folder: string, prefix: string): void {
  for (const name of readdirSync(folder)) {
    const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
    server.setFile(`${prefix}/${name}`, { data: readFileSync(path.join(folder, name)), contentType: type });
  }
}
