export const APP_NAME = "TurboDL";
export const APP_ID = "turbodl";
export const DEFAULT_BRIDGE_PORT = 47123;
/** Derived from the public key in apps/extension/manifest.json ("key"). */
export const EXTENSION_ID = "fnkkncklkbdmaphmmddfmbcjkllejhea";
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

export type CaptureSource = "intercept" | "context-menu" | "media" | "manual";

export interface DownloadRequest {
  url: string;
  referrer?: string;
  cookies?: string;
  userAgent?: string;
  filename?: string;
  fileSize?: number;
  mime?: string;
  source: CaptureSource;
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
