import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  APP_ID,
  isFirefoxExtensionOrigin,
  type BridgeConfig,
  type BrowserCookie,
  type CaptureSource,
  type DownloadRequest,
  type DownloadResponse,
  type MediaItem,
  type MediaKind,
  type MediaRequest,
} from "@turbodl/shared";
import { handleApi, isApiPath, isHttpUrl, isObj, readBody, type ApiHandlers } from "./api-routes";

export interface BridgeHandlers {
  version: string;
  allowedOrigin: string;
  getConfig(): BridgeConfig;
  onDownload(req: DownloadRequest): Promise<DownloadResponse>;
  onMedia(req: MediaRequest): Promise<void>;
  /** The token-protected jobs API; its routes answer 404 when absent. */
  api?: ApiHandlers;
}

export interface BridgeServer {
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

const SOURCES: CaptureSource[] = ["intercept", "context-menu", "media", "manual"];
const KINDS: MediaKind[] = ["file", "hls", "dash"];

/** True when the Authorization header is `Bearer <token>`; compared in constant time. */
function hasToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? "");
  const wanted = Buffer.from(`Bearer ${token}`);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function optString(v: unknown, max = 16_000): string | undefined {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;
}

const MAX_COOKIES = 300;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DOMAIN = /^\.?[a-z0-9-]+(\.[a-z0-9-]+)*$/i;

function cleanText(v: unknown, min: number, max: number): string | null {
  return typeof v === "string" && v.length >= min && v.length <= max && !CONTROL_CHARS.test(v) ? v : null;
}

/** One cookie from the extension, or null when any field could corrupt the yt-dlp cookie file. */
export function parseCookie(v: unknown): BrowserCookie | null {
  if (!isObj(v)) return null;
  const domain = cleanText(v.domain, 1, 253);
  const cookiePath = cleanText(v.path, 1, 1024);
  const name = cleanText(v.name, 1, 256);
  const value = cleanText(v.value, 0, 8192);
  if (!domain || !DOMAIN.test(domain) || !cookiePath?.startsWith("/") || !name || value === null) return null;
  if (typeof v.hostOnly !== "boolean" || typeof v.secure !== "boolean") return null;
  if (typeof v.expires !== "number" || !Number.isFinite(v.expires) || v.expires < 0) return null;
  return {
    domain,
    hostOnly: v.hostOnly,
    path: cookiePath,
    secure: v.secure,
    expires: v.expires,
    name,
    value,
    ...(typeof v.httpOnly === "boolean" ? { httpOnly: v.httpOnly } : {}),
    ...(SAME_SITE.includes(v.sameSite as never) ? { sameSite: v.sameSite as NonNullable<BrowserCookie["sameSite"]> } : {}),
  };
}

const SAME_SITE: BrowserCookie["sameSite"][] = ["no_restriction", "lax", "strict", "unspecified"];

function parseCookieJar(v: unknown): BrowserCookie[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const jar = v.map(parseCookie).filter((c): c is BrowserCookie => c !== null).slice(0, MAX_COOKIES);
  return jar.length > 0 ? jar : undefined;
}

export function parseDownloadRequest(v: unknown): DownloadRequest | string {
  if (!isObj(v)) return "body";
  if (!isHttpUrl(v.url)) return "url";
  const out: DownloadRequest = {
    url: v.url,
    source: SOURCES.includes(v.source as CaptureSource) ? (v.source as CaptureSource) : "intercept",
  };
  const referrer = optString(v.referrer);
  const cookies = optString(v.cookies, 64_000);
  const userAgent = optString(v.userAgent, 1000);
  const filename = optString(v.filename, 1000);
  const mime = optString(v.mime, 200);
  if (referrer) out.referrer = referrer;
  if (cookies) out.cookies = cookies;
  if (userAgent) out.userAgent = userAgent;
  if (filename) out.filename = filename;
  if (mime) out.mime = mime;
  if (typeof v.fileSize === "number" && Number.isFinite(v.fileSize) && v.fileSize > 0) out.fileSize = v.fileSize;
  const cookieJar = parseCookieJar(v.cookieJar);
  if (cookieJar) out.cookieJar = cookieJar;
  return out;
}

function parseMediaItem(v: unknown): MediaItem | null {
  if (!isObj(v) || !isHttpUrl(v.url) || !KINDS.includes(v.kind as MediaKind)) return null;
  const item: MediaItem = { url: v.url, kind: v.kind as MediaKind };
  const contentType = optString(v.contentType, 200);
  const cookies = optString(v.cookies, 64_000);
  if (contentType) item.contentType = contentType;
  if (typeof v.size === "number" && Number.isFinite(v.size) && v.size > 0) item.size = v.size;
  if (cookies) item.cookies = cookies;
  return item;
}

export function parseMediaRequest(v: unknown): MediaRequest | string {
  if (!isObj(v)) return "body";
  if (!isHttpUrl(v.pageUrl)) return "pageUrl";
  const items = Array.isArray(v.items)
    ? v.items.map(parseMediaItem).filter((i): i is MediaItem => i !== null).slice(0, 50)
    : [];
  const out: MediaRequest = { pageUrl: v.pageUrl, title: typeof v.title === "string" ? v.title.slice(0, 300) : "", items };
  const cookies = optString(v.cookies, 64_000);
  const referrer = optString(v.referrer);
  const userAgent = optString(v.userAgent, 1000);
  if (cookies) out.cookies = cookies;
  if (referrer) out.referrer = referrer;
  if (userAgent) out.userAgent = userAgent;
  const cookieJar = parseCookieJar(v.cookieJar);
  if (cookieJar) out.cookieJar = cookieJar;
  return out;
}

export function createBridgeServer(h: BridgeHandlers): BridgeServer {
  let port = 0;

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    // the pinned Chromium extension, or the Firefox build (whose origin id is random per profile)
    const allowed = origin === h.allowedOrigin || isFirefoxExtensionOrigin(origin);
    const corsOrigin = allowed && origin ? origin : h.allowedOrigin;
    const send = (status: number, body: unknown) => {
      if (res.headersSent) return;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": corsOrigin,
        Vary: "Origin",
      });
      res.end(JSON.stringify(body));
    };

    const handle = async () => {
      const host = req.headers.host ?? "";
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, { error: "host" });
      const path = (req.url ?? "").split("?")[0];
      if (h.api && isApiPath(path) && (req.method === "GET" || req.method === "POST")) {
        // clients without a browser send no Origin; a website's Origin is refused even with the token
        if ((origin !== undefined && !allowed) || !hasToken(req.headers.authorization, h.api.token())) {
          return send(403, { error: "token" });
        }
        return handleApi(req, res, path, h.api);
      }
      if (!allowed) return send(403, { error: "origin" });
      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }

      // Chrome omits Origin on GETs from an extension, so the extension uses POST; GET stays for tools.
      const read = req.method === "GET" || req.method === "POST";
      if (read && path === "/v1/ping") return send(200, { app: APP_ID, version: h.version });
      if (read && path === "/v1/config") return send(200, h.getConfig());
      if (req.method === "POST" && (path === "/v1/downloads" || path === "/v1/media")) {
        if (!String(req.headers["content-type"] ?? "").includes("application/json")) return send(415, { error: "content-type" });
        const body = await readBody(req);
        if (body === null) return send(413, { error: "too large" });
        let json: unknown;
        try {
          json = JSON.parse(body);
        } catch {
          return send(400, { error: "json" });
        }
        if (path === "/v1/downloads") {
          const parsed = parseDownloadRequest(json);
          if (typeof parsed === "string") return send(400, { error: parsed });
          const result = await h.onDownload(parsed);
          return send(result.accepted ? 202 : 422, result);
        }
        const parsed = parseMediaRequest(json);
        if (typeof parsed === "string") return send(400, { error: parsed });
        await h.onMedia(parsed);
        return send(202, { accepted: true });
      }
      send(404, { error: "not found" });
    };

    handle().catch((err: unknown) => send(500, { error: err instanceof Error ? err.message : String(err) }));
  });

  return {
    listen(p: number) {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        server.once("error", onError);
        server.listen(p, "127.0.0.1", () => {
          server.off("error", onError);
          port = (server.address() as AddressInfo).port;
          resolve(port);
        });
      });
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
