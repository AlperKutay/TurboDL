import type { DownloadRecord, MediaFormatOption } from "@turbodl/shared";
import { headersFor, type FragmentPlan } from "../engine/fragments";
import { HttpError, isAbortError, request } from "../engine/http";
import { withCookieFile } from "./cookies";
import { bestAudio, dashOptions, parseMpd, type DashRepresentation } from "./dash";
import { audioFor, bestVariant, hlsOptions, lowestVariant, parseHls, pickVariant, variantKey, type HlsMedia } from "./hls";
import type { TrackRole } from "./mux";
import { AUDIO_ONLY, SINGLE_OPTION } from "./quality";
import type { ToolPaths } from "./tools";
import { loginHint, needsLogin } from "./ytdlp";
import { fetchMediaInfo, type YtdlpCommand } from "./ytdlp-task";

export interface TrackPlan {
  id: string;
  role: TrackRole;
  ext: string;
  headers: Record<string, string>;
  /** the Cookie header only goes to this host */
  cookieHost?: string;
  source: { kind: "file"; url: string; size: number | null; chunkSize?: number } | { kind: "fragments"; plan: FragmentPlan };
}

export type Resolved = { type: "tracks"; tracks: TrackPlan[] } | { type: "fallback" };

export const DRM_MESSAGE = "This video is DRM-protected and cannot be downloaded.";
export const STREAM_DRM_MESSAGE = "This stream is DRM-protected and cannot be downloaded.";
const GONE = "The selected quality is no longer available.";
const LIVE = "This is a live stream; TurboDL records it with yt-dlp.";
const UNSUPPORTED = "TurboDL cannot download this stream format itself; it is downloaded with yt-dlp.";
const EMPTY = "No downloadable video or audio was found in this stream.";
const MAX_MANIFEST = 20 * 1024 * 1024;

export async function fetchText(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<{ text: string; url: string }> {
  const res = await request(url, { headers, signal, timeoutMs: 20000 });
  if (res.status >= 400) {
    res.body.destroy();
    throw new HttpError(res.status);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of res.body as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > MAX_MANIFEST) {
      res.body.destroy();
      throw new Error("The playlist is too large.");
    }
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), url: res.finalUrl };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function stringHeaders(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
}

const COOKIE_ATTRIBUTES = new Set(["domain", "path", "expires", "max-age", "secure", "httponly", "samesite"]);

/** yt-dlp's per-format cookies ("a=1; Domain=.x; Path=/; Secure; b=2") as a Cookie header. */
export function cookieHeaderFromYtdlp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const pairs = value
    .split(";")
    .map((p) => p.trim())
    .filter((p) => {
      const eq = p.indexOf("=");
      return eq > 0 && !COOKIE_ATTRIBUTES.has(p.slice(0, eq).toLowerCase());
    });
  return pairs.length > 0 ? pairs.join("; ") : null;
}

function roleOf(f: Record<string, unknown>): TrackRole {
  if (f.vcodec === "none") return "audio";
  if (f.acodec === "none") return "video";
  return "av";
}

function hlsTrack(id: string, role: TrackRole, media: HlsMedia, headers: Record<string, string>, cookieHost: string | undefined): TrackPlan {
  return { id, role, ext: media.fmp4 ? "mp4" : "ts", headers, cookieHost, source: { kind: "fragments", plan: media.plan } };
}

export async function tracksFromYtdlpInfo(info: unknown, signal?: AbortSignal): Promise<Resolved> {
  const obj = (info && typeof info === "object" ? info : {}) as Record<string, any>;
  if (obj.is_live) return { type: "fallback" };
  if (obj.has_drm || obj._has_drm) throw new Error(DRM_MESSAGE);
  const formats: Record<string, any>[] = Array.isArray(obj.requested_formats) && obj.requested_formats.length > 0 ? obj.requested_formats : [obj];
  const tracks: TrackPlan[] = [];
  for (const f of formats) {
    if (f.has_drm || f._has_drm) throw new Error(DRM_MESSAGE);
    if (typeof f.url !== "string") return { type: "fallback" };
    const headers = stringHeaders(f.http_headers);
    const cookie = cookieHeaderFromYtdlp(f.cookies);
    if (cookie) headers.Cookie = cookie;
    const id = String(f.format_id ?? tracks.length);
    const role = roleOf(f);
    const protocol = String(f.protocol ?? "https");
    if (protocol === "https" || protocol === "http") {
      const chunkSize = positive(f.downloader_options?.http_chunk_size);
      tracks.push({
        id,
        role,
        ext: String(f.ext || "mp4"),
        headers,
        cookieHost: hostOf(f.url),
        source: { kind: "file", url: f.url, size: positive(f.filesize), ...(chunkSize ? { chunkSize } : {}) },
      });
    } else if (protocol === "m3u8_native" || protocol === "m3u8") {
      const { text, url } = await fetchText(f.url, headers, signal);
      const pl = parseHls(text, url);
      if (pl.type !== "media" || pl.media.live) return { type: "fallback" };
      if (pl.media.drm) throw new Error(DRM_MESSAGE);
      tracks.push(hlsTrack(id, role, pl.media, headers, hostOf(url)));
    } else {
      return { type: "fallback" };
    }
  }
  return tracks.length > 0 ? { type: "tracks", tracks } : { type: "fallback" };
}

export async function resolveHls(origin: { url: string; variant: string | null }, headers: Record<string, string>, signal?: AbortSignal): Promise<Resolved> {
  const cookieHost = hostOf(origin.url);
  const first = await fetchText(origin.url, headers, signal);
  const pl = parseHls(first.text, first.url);
  /** null: the playlist turned out to be live */
  const media = async (id: string, role: TrackRole, url: string): Promise<TrackPlan | null> => {
    const loaded = await fetchText(url, headersFor(headers, url, cookieHost), signal);
    const p = parseHls(loaded.text, loaded.url);
    if (p.type !== "media") throw new Error(UNSUPPORTED);
    if (p.media.drm) throw new Error(STREAM_DRM_MESSAGE);
    return p.media.live ? null : hlsTrack(id, role, p.media, headers, cookieHost);
  };
  if (pl.type === "media") {
    if (pl.media.drm) throw new Error(STREAM_DRM_MESSAGE);
    if (pl.media.live) return { type: "fallback" };
    return { type: "tracks", tracks: [hlsTrack("media", "av", pl.media, headers, cookieHost)] };
  }
  const master = pl.master;
  const tracks: (TrackPlan | null)[] = [];
  if (origin.variant === AUDIO_ONLY.formatSelector) {
    const best = bestVariant(master);
    const audio = best ? audioFor(master, best) : null;
    if (audio?.url) tracks.push(await media(`a:${audio.groupId}:${audio.name}`, "audio", audio.url));
    else {
      const low = lowestVariant(master);
      if (!low) throw new Error(GONE);
      tracks.push(await media(`v:${variantKey(low)}`, "av", low.url));
    }
  } else {
    const variant = origin.variant ? pickVariant(master, origin.variant) : bestVariant(master);
    if (!variant) throw new Error(GONE);
    const audio = audioFor(master, variant);
    tracks.push(await media(`v:${variantKey(variant)}`, audio ? "video" : "av", variant.url));
    if (audio?.url) tracks.push(await media(`a:${audio.groupId}:${audio.name}`, "audio", audio.url));
  }
  if (tracks.some((t) => t === null)) return { type: "fallback" };
  return { type: "tracks", tracks: tracks as TrackPlan[] };
}

function dashExt(r: DashRepresentation): string {
  if (r.mimeType.includes("webm")) return "webm";
  return r.kind === "audio" ? "m4a" : "mp4";
}

function dashTrack(r: DashRepresentation, role: TrackRole, headers: Record<string, string>, cookieHost: string | undefined): TrackPlan | null {
  if (r.protected) throw new Error(STREAM_DRM_MESSAGE);
  if (!r.source) return null;
  if (r.source.kind === "file") {
    return { id: r.id, role, ext: dashExt(r), headers: headersFor(headers, r.source.url, cookieHost), source: { kind: "file", url: r.source.url, size: null } };
  }
  return { id: r.id, role, ext: dashExt(r), headers, cookieHost, source: { kind: "fragments", plan: r.source.plan } };
}

export async function resolveDash(
  origin: { url: string; video: string | null; audio: string | null },
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Resolved> {
  const { text, url } = await fetchText(origin.url, headers, signal);
  const m = parseMpd(text, url);
  if (m.live || m.multiPeriod) return { type: "fallback" };
  const cookieHost = hostOf(origin.url);
  const audio = origin.audio ? (m.representations.find((r) => r.kind === "audio" && r.id === origin.audio) ?? null) : bestAudio(m);
  if (origin.audio && !audio) throw new Error(GONE);
  const tracks: (TrackPlan | null)[] = [];
  if (origin.video) {
    const video = m.representations.find((r) => r.kind === "video" && r.id === origin.video);
    if (!video) throw new Error(GONE);
    tracks.push(dashTrack(video, audio ? "video" : "av", headers, cookieHost));
  }
  if (audio) tracks.push(dashTrack(audio, "audio", headers, cookieHost));
  if (tracks.length === 0) throw new Error(GONE);
  if (tracks.some((t) => t === null)) return { type: "fallback" };
  return { type: "tracks", tracks: tracks as TrackPlan[] };
}

/** Qualities of a captured HLS/DASH item, read by TurboDL itself. */
export async function streamOptions(kind: "hls" | "dash", url: string, headers: Record<string, string>): Promise<MediaFormatOption[]> {
  const loaded = await fetchText(url, headers);
  if (kind === "hls") {
    const pl = parseHls(loaded.text, loaded.url);
    if (pl.type === "master") return hlsOptions(pl.master);
    if (pl.media.drm) throw new Error(STREAM_DRM_MESSAGE);
    if (pl.media.live) throw new Error(LIVE);
    return [SINGLE_OPTION, AUDIO_ONLY];
  }
  const m = parseMpd(loaded.text, loaded.url);
  if (m.live) throw new Error(LIVE);
  if (m.multiPeriod) throw new Error(UNSUPPORTED);
  if (m.representations.some((r) => r.protected)) throw new Error(STREAM_DRM_MESSAGE);
  const options = dashOptions(m);
  if (options.length === 0) throw new Error(EMPTY);
  return options;
}

export interface ResolverDeps {
  tools: () => Promise<ToolPaths>;
  command?: YtdlpCommand;
}

export function createResolver(deps: ResolverDeps): (record: DownloadRecord, signal: AbortSignal) => Promise<Resolved> {
  return async (record, signal) => {
    const origin = record.stream?.origin;
    if (!origin) throw new Error("Stream information is missing.");
    if (origin.type === "hls") return resolveHls(origin, record.headers, signal);
    if (origin.type === "dash") return resolveDash(origin, record.headers, signal);
    const paths = await deps.tools();
    const headers = { ...record.headers };
    delete headers.Cookie;
    let info: unknown;
    try {
      info = await withCookieFile(origin.cookies, (cookieFile) =>
        fetchMediaInfo(paths, origin.pageUrl, headers, { command: deps.command, cookieFile, formatSelector: origin.formatSelector, signal }),
      );
    } catch (err) {
      if (isAbortError(err)) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(needsLogin(reason) ? loginHint(reason, Boolean(origin.cookies?.length)) : reason);
    }
    return tracksFromYtdlpInfo(info, signal);
  };
}
