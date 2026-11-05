import { formatBytes, formatDuration, formatSpeed, profileName } from "@turbodl/shared";
import type { ApiInfo, Job, JobReason, ProfileListView } from "@turbodl/shared";
import { isPlanWarning } from "../jobs/instagram-job";
import type { Keyboard } from "./types";

/** Telegram's limit for one message, in characters. */
export const MAX_TEXT = 4096;

export const HELP = [
  "Send TurboDL one of these:",
  "- a username (nasa or @nasa) or an Instagram profile link: back the profile up",
  "- several usernames in one message, or a .txt with one profile per line: back up a list",
  "- any other link (Instagram post, reel or story, YouTube, a file): download it",
  "",
  "Commands:",
  "/status - what is running and the Instagram sign-in",
  "/stop - stop a download or the list",
  "/list - show the profile list",
  "/help - this text",
].join("\n");

export const PAIRED = "This chat now controls TurboDL.";
export const SAVED_REFUSED = "Saved collections can't be backed up from Telegram yet; use the TurboDL app.";
export const SEND_SOMETHING = "Send a username, a link or a .txt.";
export const EXPIRED = "This expired; send it again.";
export const NOTHING_RUNNING = "Nothing is running.";
export const NO_LIST = "There is no list.";
export const RESTARTED_PROFILE = "TurboDL restarted before this finished. Send it again; it skips what it already saved.";
export const RESTARTED_LINK = "TurboDL restarted. This download goes on in TurboDL, but the bot can't follow it any more.";
export const RESTARTED_UNSTARTED = "TurboDL restarted before this started. Send it again.";
export const LIST_CLOSED = "The list was closed.";
export const CANCELLED = "Cancelled.";
export const STOP_WHAT = "What should TurboDL stop?";
export const LIST_TOO_LARGE = "This file is too large for a list of profiles (over 1 MB).";
export const FILE_NOT_RECEIVED = "TurboDL couldn't get the file from Telegram; send it again.";

const STATUS_JOBS_MAX = 10;
const LIST_ROWS_SHOWN = 5;

/** Cuts text to `max` UTF-16 units with a trailing `…`, never leaving half of a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function cut(text: string): string {
  return clip(text, MAX_TEXT);
}

export function jobLabel(job: Pick<Job, "url" | "kind">): string {
  if (job.kind === "instagramProfile") {
    const name = profileName(job.url);
    if (name) return `@${name} profile backup`;
  }
  try {
    const u = new URL(job.url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? `${u.hostname} ${decodeURIComponent(last)}` : u.hostname;
  } catch {
    return clip(job.url, 60);
  }
}

function counts(job: Job): string[] {
  const { done, total, bytes, totalBytes, speed } = job.progress;
  const out: string[] = [];
  if (total !== undefined) out.push(`${done}/${total}`);
  else if (done > 0) out.push(String(done));
  if (bytes !== undefined) {
    const size = totalBytes !== undefined ? `${formatBytes(bytes)} of ${formatBytes(totalBytes)}` : formatBytes(bytes);
    out.push(speed ? `${size}, ${formatSpeed(speed)}` : size);
  }
  return out;
}

export function jobText(job: Job, label: string): string {
  const lines = [clip(label, 200), job.state === "queued" ? "Queued" : "Running"];
  lines.push(...counts(job));
  if (job.progress.note) lines.push(clip(job.progress.note, 300));
  return cut(lines.join("\n"));
}

const REASONS: Record<JobReason, string> = {
  signInRequired: "Instagram needs a sign-in for this; sign in to Instagram in TurboDL.",
  rateLimited: "Instagram asked TurboDL to slow down; try again later.",
  private: "This account is private.",
  notFound: "This was not found.",
  unsupported: "TurboDL can't download this.",
  stopped: "Stopped.",
  error: "Something went wrong.",
};

export function reasonText(job: Job): string {
  if (job.reason && job.reason !== "error") return REASONS[job.reason];
  return cut(job.error || REASONS.error);
}

export function jobFinalText(job: Job, label: string, existing: number): string {
  const head = clip(label, 200);
  if (job.state === "done") return cut(`${head}\n${saved(job, existing)}`);
  if (job.state === "cancelled") return cut(`${head}\nStopped.`);
  return cut(`${head}\nFailed: ${reasonText(job)}`);
}

/** The last words of a job's message when a restart took the job away: true of a backup and of a download alike. */
export function jobRestartedText(label: string): string {
  return `${clip(label, 200)}\nTurboDL restarted.`;
}

function saved(job: Job, existing: number): string {
  const n = job.files.length;
  const there = existing > 0 ? ` (${existing} already there)` : "";
  return `${n} ${n === 1 ? "file" : "files"} saved${there}`;
}

function folderOf(file: string): string {
  const i = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return i > 0 ? file.slice(0, i) : file;
}

export function jobSummary(job: Job, label: string, existing: number): string {
  const name = clip(label, 200);
  if (job.state === "failed") return cut(`Failed: ${name} - ${reasonText(job)}`);
  if (job.state === "cancelled") return cut(`Stopped: ${name}`);
  const failed = job.failedItems > 0 ? ` with ${job.failedItems} failed ${job.failedItems === 1 ? "item" : "items"}` : "";
  const folder = job.files.length > 0 ? `\nFolder: ${folderOf(job.files[0])}` : "";
  return cut(`Done${failed}: ${name} — ${saved(job, existing)}.${leftOut(job)}${folder}`);
}

/**
 * A job done without some of its parts (signed out, or with warnings) says so: "Done" alone would hide it. The backup's
 * plan, told as a warning when it starts, isn't one; of the others, the last says it, as in a profile list's row.
 */
function leftOut(job: Job): string {
  const warning = job.warnings.filter((w) => !isPlanWarning(w)).at(-1);
  if (warning !== undefined) return `\nSome parts were left out: ${clip(warning, 200)}`;
  return job.limited ? "\nSome parts were left out." : "";
}

const STATE_WORDS: Record<ProfileListView["state"], string> = {
  running: "running",
  waiting: "waiting for the next profile",
  slowedDown: "slowed down by Instagram",
  stopped: "stopped",
  signedOut: "stopped: signed out",
  rateLimited: "stopped: Instagram asked to slow down",
  finished: "finished",
};

function finishedRows(list: ProfileListView) {
  return list.rows.filter((r) => r.state === "done" || r.state === "skipped" || r.state === "failed");
}

export function listText(list: ProfileListView, now: number): string {
  const finished = finishedRows(list);
  const failed = list.rows.filter((r) => r.state === "failed").length;
  const skipped = list.rows.filter((r) => r.state === "skipped").length;
  const lines = [`List: ${clip(list.name, 100)} - ${STATE_WORDS[list.state]}`];
  let counted = `${finished.length}/${list.rows.length} profiles`;
  const extra = [failed ? `${failed} failed` : "", skipped ? `${skipped} skipped` : ""].filter(Boolean);
  if (extra.length) counted += ` (${extra.join(", ")})`;
  lines.push(counted);
  if (list.message) lines.push(clip(list.message, 300));
  const current = list.rows.find((r) => r.state === "running");
  if (current) {
    const p = list.progress;
    const prog = p ? ` ${p.total !== undefined ? `${p.done}/${p.total}` : p.done}${p.note ? ` - ${clip(p.note, 100)}` : ""}` : "";
    lines.push(`Now: @${current.username}${prog}`);
  }
  if ((list.state === "waiting" || list.state === "slowedDown") && list.nextAt !== undefined) {
    lines.push(`Next profile in ${formatDuration(Math.max(0, (list.nextAt - now) / 1000))}`);
  }
  const last = finished.slice(-LIST_ROWS_SHOWN);
  if (last.length) {
    lines.push("", "Last finished:");
    for (const r of last) {
      const mark = r.state === "done" ? "done" : r.state;
      lines.push(`@${r.username} - ${mark}${r.note ? `: ${clip(r.note, 100)}` : ""}`);
    }
  }
  return cut(lines.join("\n"));
}

export function listKeyboard(list: ProfileListView): Keyboard | null {
  switch (list.state) {
    case "running":
    case "waiting":
    case "slowedDown":
      return [[{ text: "Stop", callback_data: "sl" }]];
    case "stopped":
    case "rateLimited":
    case "signedOut":
      return [[{ text: "Continue", callback_data: "lc" }, { text: "Close", callback_data: "lx" }]];
    case "finished":
      return [[{ text: "Close", callback_data: "lx" }]];
  }
}

export function listRestartedText(list: ProfileListView): string {
  return cut(`TurboDL restarted; the list stopped at ${finishedRows(list).length}/${list.rows.length}.`);
}

export function statusText(s: {
  version: string;
  instagram: ApiInfo["instagram"];
  jobs: { label: string; job: Job }[];
  list: ProfileListView | null;
}): string {
  const lines = [`TurboDL ${s.version}`];
  lines.push(s.instagram.signedIn ? `Instagram: signed in${s.instagram.username ? ` as @${s.instagram.username}` : ""}` : "Instagram: signed out");
  if (s.jobs.length === 0) lines.push("No downloads running.");
  else {
    lines.push("", "Downloads:");
    for (const { label, job } of s.jobs.slice(0, STATUS_JOBS_MAX)) {
      const detail = [job.state === "queued" ? "queued" : "running", ...counts(job)].join(", ");
      lines.push(`${clip(label, 100)} - ${detail}`);
    }
    if (s.jobs.length > STATUS_JOBS_MAX) lines.push(`and ${s.jobs.length - STATUS_JOBS_MAX} more`);
  }
  if (s.list) lines.push("", `List ${clip(s.list.name, 100)}: ${STATE_WORDS[s.list.state]}, ${finishedRows(s.list).length}/${s.list.rows.length} profiles`);
  return cut(lines.join("\n"));
}

export function stopKeyboard(jobs: { label: string; job: Job }[], listActive: boolean): Keyboard | null {
  const live = jobs.filter(({ job }) => job.state === "queued" || job.state === "running");
  if (live.length === 0 && !listActive) return null;
  const rows: Keyboard = live.slice(0, STATUS_JOBS_MAX).map(({ label, job }) => [{ text: `Stop ${clip(label, 40)}`, callback_data: `s:${job.id}` }]);
  if (listActive) rows.push([{ text: "Stop list", callback_data: "sl" }]);
  rows.push([{ text: "Stop all", callback_data: "sa" }]);
  return rows;
}

export function jobKeyboard(jobId: string): Keyboard {
  return [[{ text: "Stop", callback_data: `s:${jobId}` }]];
}

/** Offered when a new list can't start because the old one is still there. */
export const SHOW_LIST_KEYBOARD: Keyboard = [[{ text: "Show list", callback_data: "lv" }]];

/** A link the app refused to take as a job. */
export function notStartedText(url: string, error: string): string {
  return cut(`TurboDL couldn't start ${clip(url, 200)}: ${error}`);
}
