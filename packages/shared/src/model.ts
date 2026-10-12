import type { CaptureSource, MediaItem } from "./protocol";

export type Category = "video" | "music" | "programs" | "archives" | "documents" | "images" | "other";
export type DownloadStatus = "queued" | "scheduled" | "downloading" | "paused" | "completed" | "error";
export type DownloadKind = "http" | "ytdlp";

/** Byte range [start, end] (end inclusive); `received` counts bytes written from `start`. */
export interface Segment {
  start: number;
  end: number;
  received: number;
}

export interface YtdlpOptions {
  /** value passed to yt-dlp -f */
  formatSelector: string;
  audioOnly: boolean;
}

export interface DownloadRecord {
  id: string;
  kind: DownloadKind;
  url: string;
  pageUrl?: string;
  filename: string;
  dir: string;
  category: Category;
  size: number | null;
  received: number;
  status: DownloadStatus;
  error?: string;
  headers: Record<string, string>;
  resumable: boolean;
  etag?: string;
  lastModified?: string;
  segments: Segment[];
  ytdlp?: YtdlpOptions;
  /** started by the scheduler (used for stop time and after-all action) */
  viaScheduler: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface DownloadView extends DownloadRecord {
  speed: number;
  eta: number | null;
  connections: number;
  note?: string;
}

export type AfterAllAction = "none" | "sleep" | "shutdown" | "quit";

export interface SchedulerSettings {
  enabled: boolean;
  /** "HH:MM" */
  startTime: string;
  /** "HH:MM" or null */
  stopTime: string | null;
  afterAll: AfterAllAction;
}

export interface Settings {
  baseDir: string;
  maxConnections: number;
  maxConcurrent: number;
  confirmBeforeDownload: boolean;
  captureEnabled: boolean;
  captureExtensions: string[];
  minCaptureSize: number;
  launchAtLogin: boolean;
  bridgePort: number;
  closeToTray: boolean;
  notifyOnComplete: boolean;
  scheduler: SchedulerSettings;
}

export interface NewDownload {
  kind: DownloadKind;
  url: string;
  pageUrl?: string;
  filename: string;
  dir: string;
  category: Category;
  size: number | null;
  resumable: boolean;
  headers: Record<string, string>;
  ytdlp?: YtdlpOptions;
}

export interface PendingDownload {
  type: "download";
  pendingId: string;
  source: CaptureSource;
  item: NewDownload;
}

export interface PendingMedia {
  type: "media";
  pendingId: string;
  pageUrl: string;
  title: string;
  items: MediaItem[];
  headers: Record<string, string>;
  defaultDir: string;
}

export type PendingItem = PendingDownload | PendingMedia;

export interface MediaFormatOption {
  id: string;
  label: string;
  formatSelector: string;
  audioOnly: boolean;
}

export type MediaChoice = { kind: "item"; index: number } | { kind: "format"; option: MediaFormatOption };

export interface BridgeStatus {
  ok: boolean;
  port: number;
  error?: string;
}

export interface CountdownState {
  action: Exclude<AfterAllAction, "none">;
  secondsLeft: number;
}

export interface AppSnapshot {
  downloads: DownloadView[];
  settings: Settings;
  bridge: BridgeStatus;
  countdown: CountdownState | null;
  version: string;
}

export type AppEvent =
  | { type: "downloads"; items: DownloadView[] }
  | { type: "removed"; ids: string[] }
  | { type: "settings"; settings: Settings }
  | { type: "bridge"; status: BridgeStatus }
  | { type: "countdown"; state: CountdownState | null };

export type Result = { ok: true } | { ok: false; error: string };

export type DownloadDecision = { filename: string; dir: string; mode: "now" | "later" };
export type MediaDecision = { dir: string; mode: "now" | "later" };
export type FormatsResult = { ok: true; title: string; options: MediaFormatOption[] } | { ok: false; error: string };
export type InstallResult = { ok: true; path: string } | { ok: false; error: string };

/** API exposed to the renderer as window.turbodl */
export interface TurboApi {
  getSnapshot(): Promise<AppSnapshot>;
  onEvent(cb: (e: AppEvent) => void): () => void;
  addUrl(url: string): Promise<Result>;
  pause(ids: string[]): Promise<void>;
  resume(ids: string[]): Promise<void>;
  remove(ids: string[], deleteFiles: boolean): Promise<void>;
  openFile(id: string): Promise<void>;
  showInFolder(id: string): Promise<void>;
  refreshUrl(id: string, url: string): Promise<Result>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseFolder(current?: string): Promise<string | null>;
  getPending(pendingId: string): Promise<PendingItem | null>;
  confirmDownload(pendingId: string, decision: DownloadDecision): Promise<Result>;
  cancelPending(pendingId: string): Promise<void>;
  probeMediaFormats(pendingId: string): Promise<FormatsResult>;
  confirmMedia(pendingId: string, choice: MediaChoice, decision: MediaDecision): Promise<Result>;
  cancelCountdown(): Promise<void>;
  installExtension(): Promise<InstallResult>;
  copyText(text: string): Promise<void>;
  closeWindow(): Promise<void>;
}
