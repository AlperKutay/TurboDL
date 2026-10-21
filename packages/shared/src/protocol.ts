export const APP_NAME = "TurboDL";
export const APP_ID = "turbodl";
export const DEFAULT_BRIDGE_PORT = 47123;
/** Derived from the public key in apps/extension/manifest.json ("key"). */
export const EXTENSION_ID = "fnkkncklkbdmaphmmddfmbcjkllejhea";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
/** Where installers and the Firefox add-on are published. */
export const RELEASES_URL = "https://github.com/AlperKutay/TurboDL/releases/latest";
/** Add-on id of the Firefox build of the extension. */
export const FIREFOX_EXTENSION_ID = "turbodl@turbodl.app";
const FIREFOX_ORIGIN = /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Firefox gives every installed add-on a random origin id per profile, so the app cannot pin it.
 * Web pages cannot send a moz-extension:// origin, so accepting the scheme keeps websites out.
 */
export function isFirefoxExtensionOrigin(origin: string | undefined): boolean {
  return typeof origin === "string" && FIREFOX_ORIGIN.test(origin);
}
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
  /** kept so a cookie put back into a browser session behaves as the site set it */
  httpOnly?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict" | "unspecified";
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
