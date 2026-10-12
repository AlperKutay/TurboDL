import { extensionFromMime, getExtension } from "./categories";
import type { MediaItem, MediaKind } from "./protocol";

const HLS_TYPES = ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl"];
const DASH_TYPES = ["application/dash+xml"];
const SEGMENT_TYPES = ["video/mp2t", "video/iso.segment"];
const SEGMENT_EXTENSIONS = ["ts", "m4s", "m4f", "cmfv", "cmfa", "aac", "vtt", "key"];
const FILE_EXTENSIONS = ["mp4", "webm", "mkv", "mov", "m4v", "flv", "mp3", "m4a", "ogg", "opus", "wav", "flac"];
const IGNORED_HOSTS = ["googlevideo.com"];

export const MIN_MEDIA_FILE_SIZE = 512 * 1024;
export const MAX_MEDIA_PER_TAB = 30;

export interface MediaResponseInfo {
  url: string;
  contentType?: string;
  size?: number;
}

export function classifyMedia(info: MediaResponseInfo): MediaKind | null {
  let u: URL;
  try {
    u = new URL(info.url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (IGNORED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))) return null;
  const ext = getExtension(u.pathname);
  const type = (info.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (HLS_TYPES.includes(type) || ext === "m3u8") return "hls";
  if (DASH_TYPES.includes(type) || ext === "mpd") return "dash";
  if (SEGMENT_EXTENSIONS.includes(ext) || SEGMENT_TYPES.includes(type)) return null;
  const looksMedia = type.startsWith("video/") || type.startsWith("audio/") || FILE_EXTENSIONS.includes(ext);
  if (!looksMedia) return null;
  if (info.size !== undefined && info.size < MIN_MEDIA_FILE_SIZE) return null;
  return "file";
}

export function addMediaItem<T extends MediaItem>(list: T[], item: T, max = MAX_MEDIA_PER_TAB): T[] {
  const next = list.filter((m) => m.url !== item.url);
  next.push(item);
  return next.length > max ? next.slice(next.length - max) : next;
}

export function describeMedia(item: MediaItem): string {
  if (item.kind === "hls") return "HLS stream";
  if (item.kind === "dash") return "DASH stream";
  let ext = "";
  try {
    ext = getExtension(new URL(item.url).pathname);
  } catch {
    ext = "";
  }
  ext = ext || extensionFromMime(item.contentType);
  const audio = (item.contentType ?? "").startsWith("audio/") || ["mp3", "m4a", "ogg", "opus", "wav", "flac"].includes(ext);
  const label = audio ? "Audio file" : "Video file";
  return ext ? `${label} (${ext})` : label;
}
