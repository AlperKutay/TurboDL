import { categorize, classifyMedia, sanitizeFilename, splitExt, type Category, type MediaFormatOption, type NewDownload } from "@turbodl/shared";
import { HttpError } from "../engine/http";
import type { ProbeResult } from "../engine/probe";
import type { DownloadManager } from "../manager";
import { pageDownload, pickFormat, streamDownload } from "../media/new-download";
import { formatOptionsFromInfo, loginHint, needsLogin } from "../media/ytdlp";
import { followDownloads } from "./follow-downloads";
import type { Gate } from "./gate";
import type { JobRecord } from "./job-record";

/** What a file, page or stream job needs from the app. */
export interface WebJobDeps {
  manager: DownloadManager;
  probe(url: string): Promise<ProbeResult>;
  /** yt-dlp's -J for a page (tools made ready first); throws with yt-dlp's message */
  mediaInfo(pageUrl: string): Promise<unknown>;
  streamOptions(kind: "hls" | "dash", url: string): Promise<MediaFormatOption[]>;
  categoryDir(category: Category): string;
  /** the places web jobs share for probing and asking yt-dlp or a stream's playlist; a job holds one until its download is made */
  slots: Gate;
}

type FailReason = "notFound" | "unsupported" | "signInRequired" | "error";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(job: JobRecord, reason: FailReason, error: string): void {
  job.end({ state: "failed", reason, error });
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

/**
 * Turns a file, page or stream link into one download and follows it to its end. Its probe and its yt-dlp or playlist
 * read wait for a place among the web jobs' few (`slots`); the place is let go before the download is added.
 */
export async function runWebJob(job: JobRecord, deps: WebJobDeps): Promise<void> {
  job.start();
  let release: () => void;
  try {
    release = await deps.slots.take(job.signal);
  } catch {
    // cancelled while it waited for a place
    job.end({ state: "cancelled" });
    return;
  }
  let item: NewDownload | null;
  try {
    item = await prepare(job, deps);
  } finally {
    release();
  }
  if (!item) return;

  let id: string;
  try {
    id = deps.manager.add(item, "now").id;
  } catch (err) {
    fail(job, "error", message(err));
    return;
  }
  const outcome = await followDownloads(deps.manager, [id], job);
  if (outcome.type === "completed") job.end({ state: "done" });
  else if (outcome.type === "error") fail(job, "error", outcome.message);
  else if (outcome.type === "stopped") job.end({ state: "cancelled", reason: "stopped", error: outcome.message });
  else job.end({ state: "cancelled" });
}

/** The job's download, made from the link's probe and, for a page or a stream, its qualities; null once the job has ended. */
async function prepare(job: JobRecord, deps: WebJobDeps): Promise<NewDownload | null> {
  const { url, name, options } = job.request;
  const cancelled = () => job.signal.aborted && (job.end({ state: "cancelled" }), true);
  const dirFor = (category: Category) => job.request.dir || deps.categoryDir(category);

  /** the quality the job asked for, as a download named and placed as the job asks; null once the job has failed */
  const pickMedia = (formats: MediaFormatOption[], build: (option: MediaFormatOption, dir: string) => NewDownload): NewDownload | null => {
    const picked = pickFormat(formats, { audio: options?.audio, maxHeight: options?.maxHeight });
    if (!picked) {
      fail(job, "unsupported", options?.audio ? "This video has no audio-only choice." : "No quality to download.");
      return null;
    }
    if (picked.warning) job.warn(picked.warning);
    const made = build(picked.option, dirFor(picked.option.audioOnly ? "music" : "video"));
    if (name) made.filename = mediaName(name, made);
    return made;
  };

  // cancelled the moment its place came
  if (cancelled()) return null;

  // probe
  let info: ProbeResult;
  try {
    info = await deps.probe(url);
  } catch (err) {
    if (cancelled()) return null;
    if (err instanceof HttpError && (err.status === 404 || err.status === 410)) fail(job, "notFound", err.message);
    else fail(job, "error", message(err));
    return null;
  }
  if (cancelled()) return null;

  const kind = classifyMedia({ url, contentType: info.mime ?? undefined });
  if (kind === "hls" || kind === "dash") {
    job.setKind("media");
    let formats: MediaFormatOption[];
    try {
      formats = await deps.streamOptions(kind, url);
    } catch (err) {
      if (cancelled()) return null;
      fail(job, "unsupported", message(err));
      return null;
    }
    if (cancelled()) return null;
    return pickMedia(formats, (option, dir) => streamDownload({ url, pageUrl: url, kind, title: streamTitle(url), option, dir, headers: {} }));
  }
  if (info.mime === "text/html") {
    job.setKind("media");
    let page: unknown;
    try {
      page = await deps.mediaInfo(url);
    } catch (err) {
      if (cancelled()) return null;
      const reason = message(err);
      if (needsLogin(reason)) fail(job, "signInRequired", loginHint(reason, false));
      else fail(job, "unsupported", reason);
      return null;
    }
    if (cancelled()) return null;
    const { title, options: formats } = formatOptionsFromInfo(page);
    return pickMedia(formats, (option, dir) => pageDownload({ pageUrl: url, title, option, dir, headers: {} }));
  }
  const filename = sanitizeFilename(name || info.filename || "download");
  const category = categorize(filename, info.mime);
  return { kind: "http", url, filename, dir: dirFor(category), category, size: info.size, resumable: info.resumable, headers: {} };
}
