import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DownloadRecord } from "@turbodl/shared";
import { abortError } from "../engine/http";
import type { TaskHandle } from "../task";
import { withCookieFile } from "./cookies";
import type { ToolPaths } from "./tools";
import { DEFAULT_FORMAT, buildDownloadArgs, buildInfoArgs, lastErrorLine, loginHint, needsLogin, parseFileLine, parseProgressLine } from "./ytdlp";

/** yt-dlp is Python: force UTF-8 so non-ASCII file names survive a legacy code page console. */
export const YTDLP_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };

export type YtdlpCommand = (paths: ToolPaths) => { file: string; args: string[] };
const defaultCommand: YtdlpCommand = (paths) => ({ file: paths.ytdlp, args: [] });

export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export interface YtdlpTaskOptions {
  tools: (onStatus: (message: string) => void) => Promise<ToolPaths>;
  connections: () => number;
  command?: YtdlpCommand;
}

interface RunResult {
  code: number | null;
  stderr: string;
  filePath: string | null;
}

export class YtdlpTask implements TaskHandle {
  note: string | undefined;
  speed = 0;
  eta: number | null = null;
  private child: ChildProcess | null = null;
  private pauseRequested = false;

  constructor(
    readonly record: DownloadRecord,
    private readonly opts: YtdlpTaskOptions,
  ) {}

  get connections(): number {
    return this.child ? 1 : 0;
  }

  pause(): void {
    this.pauseRequested = true;
    if (this.child) killTree(this.child);
  }

  async start(): Promise<void> {
    const rec = this.record;
    this.pauseRequested = false;
    rec.status = "downloading";
    rec.error = undefined;
    try {
      const paths = await this.opts.tools((message) => {
        this.note = message;
      });
      this.note = undefined;
      if (this.pauseRequested) {
        rec.status = "paused";
        return;
      }
      await fsp.mkdir(rec.dir, { recursive: true });
      const cookies = rec.ytdlp?.cookies;
      const result = await withCookieFile(cookies, (cookieFile) => {
        const args = buildDownloadArgs({
          url: rec.url,
          outputDir: rec.dir,
          formatSelector: rec.ytdlp?.formatSelector ?? DEFAULT_FORMAT,
          audioOnly: rec.ytdlp?.audioOnly ?? false,
          headers: rec.headers,
          ffmpegPath: paths.ffmpeg,
          denoPath: paths.deno,
          connections: this.opts.connections(),
          cookieFile,
        });
        const cmd = (this.opts.command ?? defaultCommand)(paths);
        return this.run(cmd.file, [...cmd.args, ...args]);
      });
      if (this.pauseRequested) {
        rec.status = "paused";
        return;
      }
      if (result.code !== 0) {
        const reason = lastErrorLine(result.stderr);
        rec.status = "error";
        rec.error = needsLogin(reason) ? loginHint(reason, Boolean(cookies?.length)) : reason;
        return;
      }
      if (result.filePath) {
        rec.filename = path.basename(result.filePath);
        rec.dir = path.dirname(result.filePath);
      }
      try {
        const stat = await fsp.stat(path.join(rec.dir, rec.filename));
        rec.size = stat.size;
        rec.received = stat.size;
      } catch {
        rec.size = rec.received;
      }
      rec.status = "completed";
      rec.completedAt = Date.now();
    } catch (err) {
      if (this.pauseRequested) rec.status = "paused";
      else {
        rec.status = "error";
        rec.error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.child = null;
      this.speed = 0;
      this.eta = null;
      this.note = undefined;
    }
  }

  private run(file: string, args: string[]): Promise<RunResult> {
    const rec = this.record;
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, ...YTDLP_ENV },
      });
      this.child = child;
      let stderr = "";
      let filePath: string | null = null;
      let finishedParts = 0;
      let lastDownloaded = 0;
      let lastTotal = 0;

      createInterface({ input: child.stdout! }).on("line", (line) => {
        const p = parseProgressLine(line);
        if (p) {
          if (p.downloaded < lastDownloaded) finishedParts += lastTotal || lastDownloaded;
          lastDownloaded = p.downloaded;
          lastTotal = p.total ?? 0;
          rec.received = finishedParts + p.downloaded;
          rec.size = p.total !== null ? finishedParts + p.total : null;
          this.speed = p.speed ?? 0;
          this.eta = p.eta;
          return;
        }
        const f = parseFileLine(line);
        if (f) filePath = f;
      });
      child.stderr!.on("data", (d: Buffer) => {
        stderr = (stderr + d.toString("utf8")).slice(-8000);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr, filePath }));
    });
  }
}

export interface MediaInfoOptions {
  command?: YtdlpCommand;
  cookieFile?: string | null;
  /** -f: makes yt-dlp report `requested_formats` with their addresses */
  formatSelector?: string;
  signal?: AbortSignal;
}

export function fetchMediaInfo(paths: ToolPaths, url: string, headers: Record<string, string>, opts: MediaInfoOptions = {}): Promise<unknown> {
  const cmd = (opts.command ?? defaultCommand)(paths);
  return new Promise((resolve, reject) => {
    execFile(
      cmd.file,
      [...cmd.args, ...buildInfoArgs(url, paths.deno, headers, opts.cookieFile, opts.formatSelector)],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 180000, env: { ...process.env, ...YTDLP_ENV }, encoding: "utf8", signal: opts.signal },
      (err, stdout, stderr) => {
        if (err) {
          if (opts.signal?.aborted) {
            reject(abortError());
            return;
          }
          reject(new Error(lastErrorLine(String(stderr))));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Could not read yt-dlp's output."));
        }
      },
    );
  });
}
