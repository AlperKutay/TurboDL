import path from "node:path";
import type { MediaFormatOption } from "@turbodl/shared";

export const PROGRESS_PREFIX = "TDLPROG";
export const FILE_PREFIX = "TDLFILE";
export const DEFAULT_FORMAT = "bv*+ba/b";
const AUDIO_FORMAT = "ba/b";

export interface YtdlpArgsInput {
  url: string;
  outputDir: string;
  formatSelector: string;
  audioOnly: boolean;
  headers: Record<string, string>;
  ffmpegPath: string | null;
  denoPath: string | null;
  connections: number;
}

function headerArgs(headers: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(headers)) if (value) out.push("--add-headers", `${key}:${value}`);
  return out;
}

export function buildDownloadArgs(i: YtdlpArgsInput): string[] {
  const args = [
    "--newline",
    "--no-colors",
    "--no-playlist",
    "--windows-filenames",
    "--no-mtime",
    "-N",
    String(Math.max(1, Math.min(16, i.connections))),
    "--progress-template",
    `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`,
    "--print",
    `after_move:${FILE_PREFIX} %(filepath)s`,
    "-o",
    path.join(i.outputDir, "%(title).150B.%(ext)s"),
    "-f",
    i.formatSelector,
  ];
  if (i.audioOnly) args.push("-x", "--audio-format", "mp3");
  else args.push("--merge-output-format", "mp4");
  if (i.ffmpegPath) args.push("--ffmpeg-location", i.ffmpegPath);
  if (i.denoPath) args.push("--js-runtimes", `deno:${i.denoPath}`);
  args.push(...headerArgs(i.headers), "--", i.url);
  return args;
}

export function buildInfoArgs(url: string, denoPath: string | null, headers: Record<string, string>): string[] {
  const args = ["-J", "--no-playlist", "--no-warnings"];
  if (denoPath) args.push("--js-runtimes", `deno:${denoPath}`);
  args.push(...headerArgs(headers), "--", url);
  return args;
}

export interface YtdlpProgress {
  downloaded: number;
  total: number | null;
  speed: number | null;
  eta: number | null;
}

function num(value: string | undefined): number | null {
  if (!value || value === "NA" || value === "None") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseProgressLine(line: string): YtdlpProgress | null {
  const text = line.trim();
  if (!text.startsWith(`${PROGRESS_PREFIX} `)) return null;
  const [, downloaded, total, estimate, speed, eta] = text.split(/\s+/);
  const done = num(downloaded);
  if (done === null) return null;
  return { downloaded: done, total: num(total) ?? num(estimate), speed: num(speed), eta: num(eta) };
}

export function parseFileLine(line: string): string | null {
  const text = line.replace(/[\r\n]+$/, "");
  return text.startsWith(`${FILE_PREFIX} `) ? text.slice(FILE_PREFIX.length + 1) : null;
}

export function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const error = [...lines].reverse().find((l) => l.startsWith("ERROR:"));
  return (error ?? lines[lines.length - 1] ?? "yt-dlp failed.").replace(/^ERROR:\s*/, "");
}

export function heightSelector(h: number): string {
  return `bv*[height<=${h}][ext=mp4]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/b`;
}

export function formatOptionsFromInfo(info: unknown): { title: string; options: MediaFormatOption[] } {
  const obj = (info && typeof info === "object" ? info : {}) as { title?: unknown; formats?: unknown };
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title : "video";
  const formats = Array.isArray(obj.formats) ? obj.formats : [];
  const heights = new Set<number>();
  for (const f of formats) {
    if (!f || typeof f !== "object") continue;
    const { height, vcodec } = f as { height?: unknown; vcodec?: unknown };
    if (typeof height === "number" && height > 0 && vcodec !== "none") heights.add(height);
  }
  const options: MediaFormatOption[] = [...heights]
    .sort((a, b) => b - a)
    .map((h) => ({ id: `h${h}`, label: `${h}p${h >= 2160 ? " (4K)" : ""}`, formatSelector: heightSelector(h), audioOnly: false }));
  if (options.length === 0) options.push({ id: "best", label: "Best quality", formatSelector: DEFAULT_FORMAT, audioOnly: false });
  options.push({ id: "audio", label: "Audio only (MP3)", formatSelector: AUDIO_FORMAT, audioOnly: true });
  return { title, options };
}
