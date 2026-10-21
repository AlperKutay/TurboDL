import type { InstagramItem, InstagramLink } from "./instagram";
import type { BrowserCookie, CaptureSource, MediaItem } from "./protocol";

export type Category = "video" | "music" | "programs" | "archives" | "documents" | "images" | "other";
export type DownloadStatus = "queued" | "scheduled" | "downloading" | "paused" | "completed" | "error";
export type DownloadKind = "http" | "ytdlp" | "stream";

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
  /** browser cookies handed to yt-dlp as a cookie file (login-only videos, hls/dash with cookies) */
  cookies?: BrowserCookie[];
}

/** Where a stream download gets its addresses; resolved again on every start (YouTube links expire). */
export type StreamOrigin =
  | { type: "ytdlp"; pageUrl: string; formatSelector: string; cookies?: BrowserCookie[] }
  /** variant: the chosen quality key, "audio" for audio only, null for a playlist without variants */
  | { type: "hls"; url: string; variant: string | null }
  /** representation ids; null video = audio only, null audio = the best audio */
  | { type: "dash"; url: string; video: string | null; audio: string | null };

export interface StreamTrackState {
  /** format id / representation id / playlist key: a different id means different content */
  id: string;
  role: "video" | "audio" | "av";
  ext: string;
  done: boolean;
  /** a single-file track: the inner HTTP download's record (parts, bytes) */
  file?: DownloadRecord;
  /** a fragmented track */
  frag?: { count: number; initDone: boolean; done: number; bytes: number };
}

export interface StreamInfo {
  origin: StreamOrigin;
  output: "mp4" | "mp3";
  /** filled on the first start */
  tracks: StreamTrackState[];
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
  stream?: StreamInfo;
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
  watchClipboard: boolean;
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
  stream?: StreamInfo;
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
  /** the browser's cookies for pageUrl */
  cookieJar: BrowserCookie[];
  /** set once yt-dlp needed the browser session for this page */
  useLogin: boolean;
}

/** An Instagram post, story or highlight link, read from its signed-in page and picked from in its own window. */
export interface PendingInstagram {
  type: "instagram";
  pendingId: string;
  pageUrl: string;
  link: InstagramLink;
  /** <baseDir>/Instagram */
  defaultDir: string;
}

export type PendingItem = PendingDownload | PendingMedia | PendingInstagram;

/** A collection backup as its progress panel shows it. */
export interface BackupView {
  targetId: string;
  name: string;
  state: "running" | "stopped" | "finished" | "signedOut" | "rateLimited" | "failed";
  error?: string;
  /** posts with every item saved, earlier runs' included */
  done: number;
  failed: number;
  /** posts still to go, when Instagram said how many there are */
  left?: number;
  /** items this run saved */
  saved: number;
  /** the post being saved now */
  cover?: string;
  /** of the item being fetched now, 0…1 */
  progress: number;
}

/** What the Instagram picker shows: the items, a sign-in to do, nothing found, or a request already closed. */
export type InstagramFindResult =
  | { type: "items"; items: InstagramItem[] }
  /** `at`: Instagram's check page the page landed on, where the sign-in window opens */
  | { type: "signedOut"; at?: string }
  | { type: "nothing" }
  | { type: "gone" };

export interface MediaFormatOption {
  id: string;
  label: string;
  formatSelector: string;
  audioOnly: boolean;
}

export type MediaChoice = { kind: "item"; index: number; option?: MediaFormatOption } | { kind: "format"; option: MediaFormatOption };

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
export type FormatsResult = { ok: true; title: string; options: MediaFormatOption[]; usedLogin: boolean } | { ok: false; error: string };
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
  probeStream(pendingId: string, index: number): Promise<FormatsResult>;
  confirmMedia(pendingId: string, choice: MediaChoice, decision: MediaDecision): Promise<Result>;
  findInstagram(pendingId: string): Promise<InstagramFindResult>;
  /** `indices` empty: every item */
  confirmInstagram(pendingId: string, indices: number[], mode: "now" | "later"): Promise<Result>;
  /** Opens Instagram's sign-in in TurboDL (on the check page this picker's page landed on); true once a session was kept. */
  instagramSignIn(pendingId?: string): Promise<boolean>;
  cancelCountdown(): Promise<void>;
  installExtension(): Promise<InstallResult>;
  copyText(text: string): Promise<void>;
  openReleasesPage(): Promise<void>;
  readClipboardText(): Promise<string>;
  closeWindow(): Promise<void>;
}
