import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import {
  CATEGORY_LABELS,
  EXTENSION_ORIGIN,
  categorize,
  clipboardLink,
  extensionFromMime,
  getExtension,
  sanitizeFilename,
  type AppEvent,
  type AppSnapshot,
  type BridgeConfig,
  type BridgeStatus,
  type Category,
  type CountdownState,
  type DownloadDecision,
  type DownloadRecord,
  type DownloadRequest,
  type DownloadResponse,
  type FormatsResult,
  type InstallResult,
  type MediaChoice,
  type MediaDecision,
  type MediaRequest,
  type NewDownload,
  type PendingItem,
  type Result,
  type Settings,
} from "@turbodl/shared";
import { createBridgeServer, type BridgeServer } from "./bridge-server";
import { HttpDownloadTask } from "./engine/download-task";
import { probe } from "./engine/probe";
import { DownloadManager, type StateFile } from "./manager";
import { cookiesFromHeader, withCookieFile } from "./media/cookies";
import { ToolManager, type ToolPaths } from "./media/tools";
import { DEFAULT_FORMAT, formatOptionsFromInfo, loginHint, needsLogin } from "./media/ytdlp";
import { YtdlpTask, fetchMediaInfo, type YtdlpCommand } from "./media/ytdlp-task";
import { runPowerAction, type PowerAction } from "./power";
import { Scheduler } from "./scheduler";
import { defaultSettings, mergeSettings, normalizeSettings } from "./settings";
import { JsonStore } from "./store";

export interface ControllerUi {
  broadcast(event: AppEvent): void;
  openPending(item: PendingItem): void;
  closePending(pendingId: string): void;
  showMain(): void;
  notifyCompleted(record: DownloadRecord): void;
  setLaunchAtLogin(enabled: boolean): void;
  quit(): void;
}

export type MediaTools = Pick<ToolManager, "ensure" | "updateIfStale">;

export interface ControllerOptions {
  version: string;
  userDataDir: string;
  downloadsDir: string;
  documentsDir: string;
  extensionSourceDir: string;
  ffmpegPath: string | null;
  ui: ControllerUi;
  allowedOrigin?: string;
  runPower?: (action: PowerAction) => void;
  /** test seam: replaces the yt-dlp/Deno downloader */
  mediaTools?: MediaTools;
  /** test seam: runs a stand-in instead of the real yt-dlp */
  ytdlpCommand?: YtdlpCommand;
}

export function buildHeaders(cookies?: string, referrer?: string, userAgent?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cookies) headers.Cookie = cookies;
  if (referrer) headers.Referer = referrer;
  if (userAgent) headers["User-Agent"] = userAgent;
  return headers;
}

function withoutCookie(headers: Record<string, string>): Record<string, string> {
  const copy = { ...headers };
  delete copy.Cookie;
  return copy;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

const HTTP_URL = /^https?:\/\//i;

export class AppController {
  settings: Settings;
  readonly manager: DownloadManager;
  readonly tools: MediaTools;
  private readonly defaults: Settings;
  private readonly settingsStore: JsonStore<Settings>;
  private readonly scheduler: Scheduler;
  private readonly pending = new Map<string, PendingItem>();
  private bridge: BridgeServer | null = null;
  private bridgeStatus: BridgeStatus = { ok: false, port: 0 };
  private countdown: CountdownState | null = null;

  constructor(private readonly o: ControllerOptions) {
    this.defaults = defaultSettings(o.downloadsDir);
    this.settingsStore = new JsonStore<Settings>(path.join(o.userDataDir, "settings.json"));
    this.settings = normalizeSettings(this.settingsStore.load(() => this.defaults), this.defaults);
    this.tools = o.mediaTools ?? new ToolManager({ dir: path.join(o.userDataDir, "tools"), ffmpegPath: o.ffmpegPath });
    this.manager = new DownloadManager({
      store: new JsonStore<StateFile>(path.join(o.userDataDir, "state.json")),
      settings: () => this.settings,
      createTask: (record) =>
        record.kind === "ytdlp"
          ? new YtdlpTask(record, {
              tools: (onStatus) => this.tools.ensure(onStatus),
              connections: () => this.settings.maxConnections,
              command: o.ytdlpCommand,
            })
          : new HttpDownloadTask(record, { maxConnections: () => this.settings.maxConnections }),
    });
    this.scheduler = new Scheduler({
      target: this.manager,
      settings: () => this.settings.scheduler,
      runAction: (action) => (action === "quit" ? this.o.ui.quit() : (this.o.runPower ?? runPowerAction)(action)),
      onCountdown: (state) => {
        const starting = state !== null && this.countdown === null;
        this.countdown = state;
        this.o.ui.broadcast({ type: "countdown", state });
        if (starting) this.o.ui.showMain();
      },
    });
    this.manager.on("update", (items) => this.o.ui.broadcast({ type: "downloads", items }));
    this.manager.on("removed", (ids) => this.o.ui.broadcast({ type: "removed", ids }));
    this.manager.on("completed", (record) => this.o.ui.notifyCompleted(record));
    this.manager.on("idle", () => this.scheduler.onIdle());
  }

  async init(): Promise<void> {
    this.manager.init();
    this.scheduler.start();
    await this.startBridge();
    void this.tools.updateIfStale().catch(() => undefined);
  }

  snapshot(): AppSnapshot {
    return {
      downloads: this.manager.list(),
      settings: this.settings,
      bridge: this.bridgeStatus,
      countdown: this.countdown,
      version: this.o.version,
    };
  }

  bridgeConfig(): BridgeConfig {
    return {
      captureEnabled: this.settings.captureEnabled,
      captureExtensions: this.settings.captureExtensions,
      minCaptureSize: this.settings.minCaptureSize,
    };
  }

  async handleDownloadRequest(req: DownloadRequest): Promise<DownloadResponse> {
    const headers = buildHeaders(req.cookies, req.referrer, req.userAgent);
    let info;
    try {
      info = await probe(req.url, headers, undefined, 15000);
    } catch (err) {
      return { accepted: false, reason: message(err) };
    }
    if (info.mime === "text/html") {
      // Chrome got a file but a plain GET gets a page (POST-only or one-time link): leave it to Chrome.
      if (req.source === "intercept" || req.source === "clipboard") return { accepted: false, reason: "This address returns a web page instead of a file." };
      await this.handleMediaRequest({
        pageUrl: req.url,
        title: "",
        items: [],
        cookies: req.cookies,
        cookieJar: req.cookieJar,
        referrer: req.referrer,
        userAgent: req.userAgent,
      });
      return { accepted: true };
    }
    const filename = sanitizeFilename(req.filename || info.filename || "download");
    const category = categorize(filename, info.mime ?? req.mime);
    const item: NewDownload = {
      kind: "http",
      url: req.url,
      filename,
      dir: this.categoryDir(category),
      category,
      size: info.size,
      resumable: info.resumable,
      headers,
    };
    if (req.source === "manual" || req.source === "clipboard" || this.settings.confirmBeforeDownload) {
      this.openPending({ type: "download", pendingId: newId(), source: req.source, item });
    } else {
      this.manager.add(item, "now");
    }
    return { accepted: true };
  }

  async handleMediaRequest(req: MediaRequest): Promise<void> {
    this.openPending({
      type: "media",
      pendingId: newId(),
      pageUrl: req.pageUrl,
      title: req.title,
      items: req.items,
      headers: buildHeaders(req.cookies, req.referrer ?? req.pageUrl, req.userAgent),
      defaultDir: this.categoryDir("video"),
      cookieJar: req.cookieJar ?? [],
      useLogin: false,
    });
  }

  async addUrl(url: string): Promise<Result> {
    const trimmed = url.trim();
    if (!HTTP_URL.test(trimmed)) return { ok: false, error: "Enter a valid http(s) address." };
    const res = await this.handleDownloadRequest({ url: trimmed, source: "manual" });
    return res.accepted ? { ok: true } : { ok: false, error: res.reason };
  }

  /** A link copied anywhere is always offered through the confirmation window. */
  async handleClipboardText(text: string): Promise<void> {
    if (!this.settings.watchClipboard) return;
    const url = clipboardLink(text, this.settings.captureExtensions);
    if (!url || this.isKnownUrl(url)) return;
    await this.handleDownloadRequest({ url, source: "clipboard" });
  }

  getPending(pendingId: string): PendingItem | null {
    return this.pending.get(pendingId) ?? null;
  }

  cancelPending(pendingId: string): void {
    this.pending.delete(pendingId);
  }

  confirmDownload(pendingId: string, decision: DownloadDecision): Result {
    const p = this.pending.get(pendingId);
    if (!p || p.type !== "download") return { ok: false, error: "This download no longer exists." };
    const filename = sanitizeFilename(decision.filename);
    const guessed = categorize(filename);
    this.manager.add(
      { ...p.item, filename, dir: decision.dir.trim() || p.item.dir, category: guessed === "other" ? p.item.category : guessed },
      decision.mode,
    );
    this.finishPending(pendingId);
    return { ok: true };
  }

  async probeMediaFormats(pendingId: string): Promise<FormatsResult> {
    const p = this.pending.get(pendingId);
    if (!p || p.type !== "media") return { ok: false, error: "This request no longer exists." };
    let paths: ToolPaths;
    try {
      paths = await this.tools.ensure();
    } catch (err) {
      return { ok: false, error: message(err) };
    }
    const headers = withoutCookie(p.headers);
    const fetchInfo = (cookieFile: string | null) => fetchMediaInfo(paths, p.pageUrl, headers, { command: this.o.ytdlpCommand, cookieFile });
    let info: unknown;
    try {
      info = await fetchInfo(null);
      p.useLogin = false;
    } catch (err) {
      const reason = message(err);
      if (!needsLogin(reason)) return { ok: false, error: reason };
      if (p.cookieJar.length === 0) return { ok: false, error: loginHint(reason, false) };
      try {
        // the site wants a signed-in user: only now hand yt-dlp the browser session
        info = await withCookieFile(p.cookieJar, fetchInfo);
        p.useLogin = true;
      } catch (retryErr) {
        const again = message(retryErr);
        return { ok: false, error: needsLogin(again) ? loginHint(again, true) : again };
      }
    }
    const { title, options } = formatOptionsFromInfo(info);
    p.title = title;
    return { ok: true, title, options, usedLogin: p.useLogin };
  }

  async confirmMedia(pendingId: string, choice: MediaChoice, decision: MediaDecision): Promise<Result> {
    const p = this.pending.get(pendingId);
    if (!p || p.type !== "media") return { ok: false, error: "This request no longer exists." };
    const dir = decision.dir.trim() || p.defaultDir;
    const base = sanitizeFilename(p.title || "video");
    let item: NewDownload;
    if (choice.kind === "format") {
      const audio = choice.option.audioOnly;
      item = {
        kind: "ytdlp",
        url: p.pageUrl,
        pageUrl: p.pageUrl,
        filename: `${base}.${audio ? "mp3" : "mp4"}`,
        dir,
        category: audio ? "music" : "video",
        size: null,
        resumable: false,
        headers: withoutCookie(p.headers),
        ytdlp: { formatSelector: choice.option.formatSelector, audioOnly: audio, ...(p.useLogin ? { cookies: p.cookieJar } : {}) },
      };
    } else {
      const media = p.items[choice.index];
      if (!media) return { ok: false, error: "The selected media was not found." };
      const headers = withoutCookie(p.headers);
      if (media.cookies) headers.Cookie = media.cookies;
      if (media.kind === "file") {
        let info;
        try {
          info = await probe(media.url, headers, undefined, 15000);
        } catch (err) {
          return { ok: false, error: message(err) };
        }
        const ext = getExtension(info.filename ?? "") || extensionFromMime(info.mime) || "mp4";
        const filename = `${base}.${ext}`;
        item = {
          kind: "http",
          url: media.url,
          pageUrl: p.pageUrl,
          filename,
          dir,
          category: categorize(filename),
          size: info.size,
          resumable: info.resumable,
          headers,
        };
      } else {
        const cookies = cookiesFromHeader(media.cookies, media.url);
        item = {
          kind: "ytdlp",
          url: media.url,
          pageUrl: p.pageUrl,
          filename: `${base}.mp4`,
          dir,
          category: "video",
          size: null,
          resumable: false,
          headers: withoutCookie(headers),
          ytdlp: { formatSelector: DEFAULT_FORMAT, audioOnly: false, ...(cookies.length > 0 ? { cookies } : {}) },
        };
      }
    }
    this.manager.add(item, decision.mode);
    this.finishPending(pendingId);
    return { ok: true };
  }

  async updateSettings(patch: Partial<Settings>): Promise<Settings> {
    const previous = this.settings;
    this.settings = mergeSettings(previous, patch, this.defaults);
    this.settingsStore.save(this.settings);
    if (previous.bridgePort !== this.settings.bridgePort) await this.restartBridge();
    if (previous.launchAtLogin !== this.settings.launchAtLogin) this.o.ui.setLaunchAtLogin(this.settings.launchAtLogin);
    this.manager.poke();
    this.o.ui.broadcast({ type: "settings", settings: this.settings });
    return this.settings;
  }

  refreshUrl(id: string, url: string): Result {
    const trimmed = url.trim();
    if (!HTTP_URL.test(trimmed)) return { ok: false, error: "Enter a valid http(s) address." };
    return this.manager.refreshUrl(id, trimmed) ? { ok: true } : { ok: false, error: "This download's link cannot be changed right now." };
  }

  /** Path of a completed file that still exists, else null. */
  filePath(id: string): string | null {
    const record = this.manager.get(id);
    if (!record || record.status !== "completed") return null;
    const full = path.join(record.dir, record.filename);
    return existsSync(full) ? full : null;
  }

  folderPath(id: string): string | null {
    return this.manager.get(id)?.dir ?? null;
  }

  cancelCountdown(): void {
    this.scheduler.cancelCountdown();
  }

  async installExtension(): Promise<InstallResult> {
    if (!existsSync(path.join(this.o.extensionSourceDir, "manifest.json"))) {
      return { ok: false, error: "Extension files not found. Build the extension first with `pnpm build`." };
    }
    const target = path.join(this.o.documentsDir, "TurboDL Extension");
    try {
      await fsp.rm(target, { recursive: true, force: true });
      await fsp.cp(this.o.extensionSourceDir, target, { recursive: true });
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    await this.manager.shutdown();
    this.settingsStore.flush();
    await this.bridge?.close();
    this.bridge = null;
  }

  private categoryDir(category: Category): string {
    return path.join(this.settings.baseDir, CATEGORY_LABELS[category]);
  }

  private isKnownUrl(url: string): boolean {
    for (const p of this.pending.values()) if (p.type === "download" && p.item.url === url) return true;
    return this.manager.list().some((d) => d.url === url && d.status !== "completed");
  }

  private openPending(item: PendingItem): void {
    this.pending.set(item.pendingId, item);
    this.o.ui.openPending(item);
  }

  private finishPending(pendingId: string): void {
    this.pending.delete(pendingId);
    this.o.ui.closePending(pendingId);
  }

  private async startBridge(): Promise<void> {
    const port = this.settings.bridgePort;
    const server = createBridgeServer({
      version: this.o.version,
      allowedOrigin: this.o.allowedOrigin ?? EXTENSION_ORIGIN,
      getConfig: () => this.bridgeConfig(),
      onDownload: (req) => this.handleDownloadRequest(req),
      onMedia: (req) => this.handleMediaRequest(req),
    });
    try {
      await server.listen(port);
      this.bridge = server;
      this.bridgeStatus = { ok: true, port };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.bridge = null;
      this.bridgeStatus = {
        ok: false,
        port,
        error:
          code === "EADDRINUSE"
            ? `Port ${port} is used by another program. Choose another port in Settings.`
            : `Could not start the browser bridge: ${message(err)}`,
      };
    }
    this.o.ui.broadcast({ type: "bridge", status: this.bridgeStatus });
  }

  private async restartBridge(): Promise<void> {
    await this.bridge?.close();
    this.bridge = null;
    await this.startBridge();
  }
}
