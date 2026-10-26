import { categorize, classifyMedia, sanitizeFilename, splitExt, type Category, type MediaFormatOption, type NewDownload } from "@turbodl/shared";
import { HttpError } from "../engine/http";
import type { ProbeResult } from "../engine/probe";
import type { DownloadManager } from "../manager";
import { pageDownload, pickFormat, streamDownload } from "../media/new-download";
import { formatOptionsFromInfo, loginHint, needsLogin } from "../media/ytdlp";
import { followDownloads } from "./follow-downloads";
import type { JobRecord } from "./job-record";

/** What a file, page or stream job needs from the app. */
export interface WebJobDeps {
  manager: DownloadManager;
  probe(url: string): Promise<ProbeResult>;
  /** yt-dlp's -J for a page (tools made ready first); throws with yt-dlp's message */
  mediaInfo(pageUrl: string): Promise<unknown>;
  streamOptions(kind: "hls" | "dash", url: string): Promise<MediaFormatOption[]>;
  categoryDir(category: Category): string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The download's own extension wins over the one in the name a client gave. */
function mediaName(name: string, download: NewDownload): string {
  const wanted = download.filename.slice(download.filename.lastIndexOf("."));
  const safe = sanitizeFilename(name);
  const [base, ext] = splitExt(safe);
  return ext.toLowerCase() === wanted ? safe : `${base}${wanted}`;
}

function streamTitle(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    let decoded = last;
    try {
      decoded = decodeURIComponent(last);
    } catch {
      // keep the raw segment
    }
    return splitExt(decoded)[0] || "video";
  } catch {
    return "video";
  }
}

/** Turns a file, page or stream link into one download and follows it to its end. */
export async function runWebJob(job: JobRecord, deps: WebJobDeps): Promise<void> {
  job.start();
  const { url, name, options } = job.request;
  const fail = (reason: "notFound" | "unsupported" | "signInRequired" | "error", error: string) => job.end({ state: "failed", reason, error });
  const cancelled = () => job.signal.aborted && (job.end({ state: "cancelled" }), true);
  const dirFor = (category: Category) => job.request.dir || deps.categoryDir(category);

  /** the quality the job asked for, as a download named and placed as the job asks; null once the job has failed */
  const pickMedia = (formats: MediaFormatOption[], build: (option: MediaFormatOption, dir: string) => NewDownload): NewDownload | null => {
    const picked = pickFormat(formats, { audio: options?.audio, maxHeight: options?.maxHeight });
    if (!picked) {
      fail("unsupported", options?.audio ? "This video has no audio-only choice." : "No quality to download.");
      return null;
    }
    if (picked.warning) job.warn(picked.warning);
    const made = build(picked.option, dirFor(picked.option.audioOnly ? "music" : "video"));
    if (name) made.filename = mediaName(name, made);
    return made;
  };

  // probe
  let info: ProbeResult;
  try {
    info = await deps.probe(url);
  } catch (err) {
    if (cancelled()) return;
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) fail("notFound", err.message);
    else fail("error", message(err));
    return;
  }
  if (cancelled()) return;

  let item: NewDownload;
  const kind = classifyMedia({ url, contentType: info.mime ?? undefined });
  if (kind === "hls" || kind === "dash") {
    job.setKind("media");
    let formats: MediaFormatOption[];
    try {
      formats = await deps.streamOptions(kind, url);
    } catch (err) {
      if (cancelled()) return;
      fail("unsupported", message(err));
      return;
    }
    if (cancelled()) return;
    const made = pickMedia(formats, (option, dir) => streamDownload({ url, pageUrl: url, kind, title: streamTitle(url), option, dir, headers: {} }));
    if (!made) return;
    item = made;
  } else if (info.mime === "text/html") {
    job.setKind("media");
    let page: unknown;
    try {
      page = await deps.mediaInfo(url);
    } catch (err) {
      if (cancelled()) return;
      const reason = message(err);
      if (needsLogin(reason)) fail("signInRequired", loginHint(reason, false));
      else fail("unsupported", reason);
      return;
    }
    if (cancelled()) return;
    const { title, options: formats } = formatOptionsFromInfo(page);
    const made = pickMedia(formats, (option, dir) => pageDownload({ pageUrl: url, title, option, dir, headers: {} }));
    if (!made) return;
    item = made;
  } else {
    const filename = sanitizeFilename(name || info.filename || "download");
    const category = categorize(filename, info.mime);
    item = { kind: "http", url, filename, dir: dirFor(category), category, size: info.size, resumable: info.resumable, headers: {} };
  }

  let id: string;
  try {
    id = deps.manager.add(item, "now").id;
  } catch (err) {
    fail("error", message(err));
    return;
  }
  const outcome = await followDownloads(deps.manager, [id], job);
  if (outcome.type === "completed") job.end({ state: "done" });
  else if (outcome.type === "error") fail("error", outcome.message);
  else if (outcome.type === "stopped") job.end({ state: "cancelled", reason: "stopped", error: outcome.message });
  else job.end({ state: "cancelled" });
}
