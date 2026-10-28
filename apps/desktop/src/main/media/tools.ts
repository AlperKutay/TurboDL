import { execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, promises as fsp, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError, request } from "../engine/http";
import { unzip } from "./unzip";

export interface ToolPaths {
  ytdlp: string;
  deno: string | null;
  ffmpeg: string | null;
}

export interface ToolManagerOptions {
  dir: string;
  ffmpegPath: string | null;
  platform?: NodeJS.Platform;
  arch?: string;
  ytdlpBaseUrl?: string;
  denoBaseUrl?: string;
  extractZip?: (zip: string, dest: string) => Promise<void>;
  runUpdate?: (ytdlpPath: string) => Promise<void>;
}

const YTDLP_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const DENO_BASE = "https://github.com/denoland/deno/releases/latest/download";
const WEEK = 7 * 24 * 3600 * 1000;

export function ytdlpAssetName(platform: NodeJS.Platform): string {
  if (platform === "win32") return "yt-dlp.exe";
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "linux") return "yt-dlp_linux";
  return "yt-dlp";
}

export function denoAssetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "win32") return "deno-x86_64-pc-windows-msvc.zip";
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `deno-${cpu}-apple-darwin.zip`;
  if (platform === "linux") return `deno-${cpu}-unknown-linux-gnu.zip`;
  return null;
}

/** bsdtar ships with Windows 10+ and macOS and can read zip files. */
export function tarCommand(): string {
  if (process.platform === "win32") return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  return "tar";
}

/** Linux uses TurboDL's own reader: GNU tar cannot read zip files. Windows and macOS use bsdtar. */
export function extractZip(zip: string, dest: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "linux") return unzip(zip, dest);
  return new Promise((resolve, reject) => {
    const child = spawn(tarCommand(), ["-xf", zip, "-C", dest], { windowsHide: true, stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Could not open the archive (tar exit code ${code}).`))));
  });
}

export async function downloadFile(url: string, dest: string): Promise<void> {
  const res = await request(url, { timeoutMs: 60000 });
  if (res.status >= 400) {
    res.body.destroy();
    throw new HttpError(res.status);
  }
  const tmp = `${dest}.download`;
  await pipeline(res.body, createWriteStream(tmp));
  await fsp.rename(tmp, dest);
}

function runYtdlpUpdate(ytdlpPath: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(ytdlpPath, ["-U"], { timeout: 120000, windowsHide: true }, () => resolve());
  });
}

export class ToolManager {
  private ensuring: Promise<ToolPaths> | null = null;

  constructor(private readonly o: ToolManagerOptions) {}

  private get platform(): NodeJS.Platform {
    return this.o.platform ?? process.platform;
  }

  private get arch(): string {
    return this.o.arch ?? process.arch;
  }

  get ytdlpPath(): string {
    return path.join(this.o.dir, this.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  }

  get denoPath(): string {
    return path.join(this.o.dir, "deno", this.platform === "win32" ? "deno.exe" : "deno");
  }

  /** Make sure yt-dlp (required) and deno (optional) exist; downloads them once. */
  ensure(onStatus?: (message: string) => void): Promise<ToolPaths> {
    if (!this.ensuring) {
      this.ensuring = this.doEnsure(onStatus).finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  async updateIfStale(maxAgeMs = WEEK): Promise<void> {
    if (!existsSync(this.ytdlpPath)) return;
    if (Date.now() - statSync(this.ytdlpPath).mtimeMs < maxAgeMs) return;
    await (this.o.runUpdate ?? runYtdlpUpdate)(this.ytdlpPath);
    const now = new Date();
    await fsp.utimes(this.ytdlpPath, now, now).catch(() => undefined);
  }

  private async doEnsure(onStatus?: (message: string) => void): Promise<ToolPaths> {
    await fsp.mkdir(this.o.dir, { recursive: true });
    if (!existsSync(this.ytdlpPath)) {
      onStatus?.("Preparing video tools: downloading yt-dlp…");
      await downloadFile(`${this.o.ytdlpBaseUrl ?? YTDLP_BASE}/${ytdlpAssetName(this.platform)}`, this.ytdlpPath);
      if (this.platform !== "win32") await fsp.chmod(this.ytdlpPath, 0o755);
    }
    let deno: string | null = existsSync(this.denoPath) ? this.denoPath : null;
    const asset = denoAssetName(this.platform, this.arch);
    if (!deno && asset) {
      try {
        onStatus?.("Preparing video tools: downloading Deno…");
        const zip = path.join(this.o.dir, asset);
        await downloadFile(`${this.o.denoBaseUrl ?? DENO_BASE}/${asset}`, zip);
        await fsp.mkdir(path.dirname(this.denoPath), { recursive: true });
        await (this.o.extractZip ?? ((z, d) => extractZip(z, d, this.platform)))(zip, path.dirname(this.denoPath));
        await fsp.rm(zip, { force: true });
        if (this.platform !== "win32" && existsSync(this.denoPath)) await fsp.chmod(this.denoPath, 0o755);
        deno = existsSync(this.denoPath) ? this.denoPath : null;
      } catch {
        deno = null;
      }
    }
    return { ytdlp: this.ytdlpPath, deno, ffmpeg: this.o.ffmpegPath };
  }
}
