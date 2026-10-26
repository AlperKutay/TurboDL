import type { BrowserCookie, MediaFormatOption, NewDownload, StreamOrigin } from "@turbodl/shared";
import { sanitizeFilename } from "@turbodl/shared";

/** The quality a job takes: MP3 with `audio`, the highest not above `maxHeight`, else the best. */
export function pickFormat(options: MediaFormatOption[], o: { audio?: boolean; maxHeight?: number }): { option: MediaFormatOption; warning?: string } | null {
  if (o.audio) {
    const option = options.find((x) => x.audioOnly);
    return option ? { option } : null;
  }
  const video = options.filter((x) => !x.audioOnly);
  if (video.length === 0) return null;
  const tall = video.filter((x) => x.height !== undefined);
  if (o.maxHeight === undefined || tall.length === 0) return { option: video[0] };
  const fits = tall.find((x) => (x.height as number) <= o.maxHeight!);
  if (fits) return { option: fits };
  const option = tall[tall.length - 1];
  return { option, warning: `No quality at or below ${o.maxHeight}p; taking ${option.label}.` };
}

/** A page's chosen quality, fetched through yt-dlp's addresses (the media dialog's "format" choice). */
export function pageDownload(o: { pageUrl: string; title: string; option: MediaFormatOption; dir: string; headers: Record<string, string>; cookies?: BrowserCookie[] }): NewDownload {
  const audio = o.option.audioOnly;
  return {
    kind: "stream",
    url: o.pageUrl,
    pageUrl: o.pageUrl,
    filename: `${sanitizeFilename(o.title || "video")}.${audio ? "mp3" : "mp4"}`,
    dir: o.dir,
    category: audio ? "music" : "video",
    size: null,
    resumable: true,
    headers: o.headers,
    stream: {
      origin: { type: "ytdlp", pageUrl: o.pageUrl, formatSelector: o.option.formatSelector, ...(o.cookies ? { cookies: o.cookies } : {}) },
      output: audio ? "mp3" : "mp4",
      tracks: [],
    },
  };
}

/** An HLS or DASH address's chosen quality, read by TurboDL itself. */
export function streamDownload(o: { url: string; pageUrl: string; kind: "hls" | "dash"; title: string; option: MediaFormatOption; dir: string; headers: Record<string, string> }): NewDownload {
  const audio = o.option.audioOnly;
  const origin: StreamOrigin =
    o.kind === "hls"
      ? { type: "hls", url: o.url, variant: o.option.id === "media" ? null : o.option.formatSelector }
      : { type: "dash", url: o.url, video: audio ? null : o.option.formatSelector, audio: null };
  return {
    kind: "stream",
    url: o.url,
    pageUrl: o.pageUrl,
    filename: `${sanitizeFilename(o.title || "video")}.${audio ? "mp3" : "mp4"}`,
    dir: o.dir,
    category: audio ? "music" : "video",
    size: null,
    resumable: true,
    headers: o.headers,
    stream: { origin, output: audio ? "mp3" : "mp4", tracks: [] },
  };
}
