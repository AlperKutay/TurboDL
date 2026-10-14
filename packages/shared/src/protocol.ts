export const APP_NAME = "TurboDL";
export const APP_ID = "turbodl";
export const DEFAULT_BRIDGE_PORT = 47123;
/** Derived from the public key in apps/extension/manifest.json ("key"). */
export const EXTENSION_ID = "fnkkncklkbdmaphmmddfmbcjkllejhea";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** Native messaging host the extension uses to start the app (see apps/desktop/resources/native-host). */
export const NATIVE_HOST_NAME = "com.turbodl.host";

export type CaptureSource = "intercept" | "context-menu" | "media" | "manual" | "clipboard";

/** A browser cookie with the fields yt-dlp's Netscape cookie file needs. */
export interface BrowserCookie {
  /** ".youtube.com" (also sent to subdomains) or "www.youtube.com" (this host only) */
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  /** unix seconds; 0 = session cookie */
  expires: number;
  name: string;
  value: string;
}

export interface DownloadRequest {
  url: string;
  referrer?: string;
  cookies?: string;
  userAgent?: string;
  filename?: string;
  fileSize?: number;
  mime?: string;
  source: CaptureSource;
  /** the browser's cookies for `url`, used if the link turns out to be a video page */
  cookieJar?: BrowserCookie[];
}

export type MediaKind = "file" | "hls" | "dash";

export interface MediaItem {
  url: string;
  kind: MediaKind;
  contentType?: string;
  size?: number;
  cookies?: string;
}

export interface MediaRequest {
  pageUrl: string;
  title: string;
  items: MediaItem[];
  cookies?: string;
  /** the browser's cookies for `pageUrl`, used only when the video needs a login */
  cookieJar?: BrowserCookie[];
  referrer?: string;
  userAgent?: string;
}

export interface BridgeConfig {
  captureEnabled: boolean;
  captureExtensions: string[];
  minCaptureSize: number;
}

export interface PingResponse {
  app: typeof APP_ID;
  version: string;
}

export type DownloadResponse = { accepted: true } | { accepted: false; reason: string };
