import { existsSync } from "node:fs";
import path from "node:path";
import { formatBytes, type BackupPlan, type BackupView, type InstagramItem, type InstagramLink, type JobReason, type SavedCollection, type Settings } from "@turbodl/shared";
import type { Backups, StartResult } from "../instagram/backups";
import type { FindOutcome } from "../instagram/finder";
import { instagramFolder } from "../instagram/folders";
import { itemDownload } from "../instagram/item-download";
import { SLOW_DOWN, type InstagramPacer } from "../instagram/pacer";
import type { ProfileService } from "../instagram/profile-service";
import type { SavedService } from "../instagram/saved-service";
import type { InstagramSession } from "../instagram/session";
import type { DownloadManager } from "../manager";
import { followDownloads } from "./follow-downloads";
import { SLOWED_DOWN, type InstagramLane } from "./instagram-lane";
import type { JobRecord } from "./job-record";

/** What an Instagram job needs from the app. */
export interface InstagramJobDeps {
  session: InstagramSession;
  /** a link's items, with the session's cookies */
  find(link: InstagramLink, signal?: AbortSignal): Promise<FindOutcome>;
  profiles: ProfileService;
  saved: SavedService;
  backups: Backups;
  pacer: InstagramPacer;
  lane: InstagramLane;
  manager: DownloadManager;
  settings(): Settings;
  agent: string;
}

type Refusal = Extract<StartResult, { ok: false }>;
/** a page read's answer, or why nothing was asked */
type PageRead<T> = { read: T } | "held" | "calledOff";

const IGNORED = "Instagram downloads go to TurboDL's Instagram folders; dir and name are ignored.";
const SIGN_IN_TO_READ = "Sign in to Instagram to read this link.";
const HIGHLIGHTS_SIGN_IN = "Highlights need you signed in to Instagram.";
const NO_HIGHLIGHTS = "This profile has no highlights.";
const SIGN_IN_TO_SAVED = "Sign in to Instagram to back up Saved.";
const STOPPED = "The backup was stopped in TurboDL.";
/** what a start called off in the lane answers (the lane reads it as "cancelled") */
const CALLED_OFF: Refusal = { ok: false, error: "Cancelled.", reason: "error" };

/**
 * Runs an Instagram link as a job, into the app's Instagram folders: a post's, story's or highlight's items, a
 * profile's backups (posts, signed out too; highlights), Saved's collections. Every page it reads waits
 * for the jobs' read slot and the account's pace; nothing is asked while Instagram's slow-down holds.
 */
export async function runInstagramJob(job: JobRecord, link: InstagramLink, deps: InstagramJobDeps): Promise<void> {
  if (deps.pacer.held()) return fail(job, deps, "rateLimited", SLOW_DOWN);
  if (job.request.dir || job.request.name) job.warn(IGNORED);
  if (link.kind === "profile") return profileJob(job, link.username, deps);
  if (link.kind === "saved") return savedJob(job, deps);
  return linkJob(job, link, deps);
}

/** A post's, reel's, story's or highlight's items, into the folders the app's picker uses. */
async function linkJob(job: JobRecord, link: Exclude<InstagramLink, { kind: "profile" | "saved" }>, deps: InstagramJobDeps): Promise<void> {
  job.start();
  // stories and highlights show only to signed-in visitors: no page is loaded for nothing
  if (link.kind !== "post" && !deps.session.signedIn()) return fail(job, deps, "signInRequired", SIGN_IN_TO_READ);
  const outcome = await paced(job, deps, () => deps.find(link, job.signal));
  if (!outcome) return;
  if (outcome.type === "signedOut" || outcome.type === "signInOnly") return fail(job, deps, "signInRequired", SIGN_IN_TO_READ);
  if (outcome.type === "nothing") return fail(job, deps, "notFound", "Instagram showed nothing at this link.");
  const fallback = link.kind === "post" ? link.code : link.kind === "story" ? link.item : link.id;
  const where = { defaultDir: instagramFolder(deps.settings().baseDir), highlight: link.kind === "highlight", fallback };
  if (await saveItems(job, deps, outcome.items, where)) job.end({ state: "done" });
}

/** A profile: its posts' backup (signed out too, each post read from its own page), then its highlights' when asked. */
async function profileJob(job: JobRecord, username: string, deps: InstagramJobDeps): Promise<void> {
  const { profiles } = deps;
  const options = job.request.options ?? {};
  const highlightsOnly = options.highlightsOnly === true;
  const highlights = highlightsOnly || options.highlights === true;
  const signedIn = deps.session.signedIn();
  if (!signedIn && highlightsOnly) return fail(job, deps, "signInRequired", HIGHLIGHTS_SIGN_IN);
  let missedPosts = 0;
  if (!highlightsOnly) {
    const posts = await backup(job, deps, () => profiles.startBackup(username), async () => job.warn(planWarning(await profiles.plan(username))));
    if (posts === null) return;
    if (typeof posts !== "number") return refused(job, deps, posts);
    missedPosts = posts;
  }
  let missedHighlights = 0;
  if (highlights && !signedIn) job.warn(HIGHLIGHTS_SIGN_IN);
  else if (highlights) {
    const stories = await backup(job, deps, () => profiles.startHighlightsBackup(username));
    if (stories === null) return;
    if (typeof stories === "number") missedHighlights = stories;
    else if (stories.reason === "empty") job.warn(NO_HIGHLIGHTS);
    else return refused(job, deps, stories);
  }
  complete(job, deps, [
    [missedPosts, "post"],
    [missedHighlights, "highlight"],
  ]);
}

/** Saved: the account's own collections picked by name (or all of them), backed up one after another. */
async function savedJob(job: JobRecord, deps: InstagramJobDeps): Promise<void> {
  if (!deps.session.signedIn()) return fail(job, deps, "signInRequired", SIGN_IN_TO_SAVED);
  // the list comes from the account's saved page: a page read like any other
  const list = await paced(job, deps, () => deps.saved.collections(true));
  if (list === null) return;
  if (list === "signedOut") return fail(job, deps, "signInRequired", SIGN_IN_TO_SAVED);
  // a slow-down while it was read is answered with the list the app already had: nothing is backed up from that
  if (deps.pacer.held()) return fail(job, deps, "rateLimited", SLOW_DOWN);
  const own = list.filter((c) => !c.isAll);
  if (own.length === 0) return fail(job, deps, "notFound", "There are no collections of your own to back up.");
  const { collections: names = [], allCollections } = job.request.options ?? {};
  // never by accident: a collection may hold thousands of posts
  if (!allCollections && names.length === 0) {
    return fail(job, deps, "error", `Pick the collections to back up by name, or take them all. Your collections: ${own.map(described).join(", ")}.`);
  }
  const picked: SavedCollection[] = allCollections ? own : [];
  for (const name of allCollections ? [] : names) {
    const found = own.find((c) => c.name.toLowerCase() === name.toLowerCase() || c.id === name);
    if (!found) return fail(job, deps, "notFound", `No collection named "${name}".`);
    if (!picked.includes(found)) picked.push(found);
  }
  let missed = 0;
  for (const collection of picked) {
    const part = await backup(job, deps, () => deps.saved.startBackup(collection.id));
    if (part === null) return;
    if (typeof part !== "number") return refused(job, deps, part);
    missed += part;
  }
  complete(job, deps, [[missed, "post"]]);
}

/**
 * One backup of the job in the lane's turn, its start a page read in the jobs' read slot, followed to its end: how
 * many posts it couldn't save once it finished, the refusal when it didn't start, or null once the job has ended.
 */
async function backup(job: JobRecord, deps: InstagramJobDeps, start: () => Promise<StartResult>, started?: () => Promise<void>): Promise<number | Refusal | null> {
  const { backups, lane, pacer } = deps;
  const follower = new BackupFollower(job, backups);
  try {
    const result = await lane.backup(job, () =>
      // starting loads the profile's page (or the collection's first page soon after)
      lane
        .read<StartResult>(job.signal, async () => {
          if (pacer.held()) return SLOWED_DOWN;
          await pacer.pace(job.signal);
          if (pacer.held()) return SLOWED_DOWN;
          if (job.signal.aborted) return CALLED_OFF;
          follower.listen();
          const answer = await start();
          if (!answer.ok) follower.close();
          return answer;
        })
        .catch((err: unknown) => {
          // cancelled while it waited for the read slot
          if (job.signal.aborted) return CALLED_OFF;
          throw err;
        }),
    );
    if (result === "cancelled") {
      job.end({ state: "cancelled" });
      return null;
    }
    if (!result.ok) return result;
    // running before anything the backup reported is told
    job.start();
    follower.claim();
    await started?.();
    return finished(job, deps, await follower.settled());
  } finally {
    follower.close();
  }
}

/** How the job's backup ended: once finished, how many posts it couldn't save; null once the job has ended as the backup did. */
function finished(job: JobRecord, deps: InstagramJobDeps, view: BackupView | undefined): number | null {
  switch (view?.state) {
    case "finished":
      return view.failed;
    case "stopped":
      job.end(job.cancelledByClient ? { state: "cancelled" } : { state: "cancelled", reason: "stopped", error: STOPPED });
      return null;
    case "signedOut":
      fail(job, deps, "signInRequired", "Instagram signed TurboDL out. Sign in to Instagram again.");
      return null;
    case "rateLimited":
      fail(job, deps, "rateLimited", SLOW_DOWN);
      return null;
    default:
      fail(job, deps, "error", view?.error ?? "The backup failed.");
      return null;
  }
}

/**
 * One page a job reads: in the jobs' read slot (one page at a time, 3–6 s apart), in the account's pace, never while
 * Instagram's slow-down holds. Null once the job has ended (cancelled, or slowed down).
 */
async function paced<T>(job: JobRecord, deps: InstagramJobDeps, read: () => Promise<T>): Promise<T | null> {
  const { lane, pacer } = deps;
  let answer: PageRead<T>;
  try {
    answer = await lane.read<PageRead<T>>(job.signal, async () => {
      if (pacer.held()) return "held";
      await pacer.pace(job.signal);
      if (pacer.held()) return "held";
      if (job.signal.aborted) return "calledOff";
      return { read: await pacer.ask(read) };
    });
  } catch (err) {
    // cancelled while it waited for the read slot
    if (!job.signal.aborted) throw err;
    answer = "calledOff";
  }
  if (answer === "held") {
    fail(job, deps, "rateLimited", SLOW_DOWN);
    return null;
  }
  if (answer === "calledOff" || job.signal.aborted) {
    job.end({ state: "cancelled" });
    return null;
  }
  return answer.read;
}

/** Done when every part saved everything; otherwise failed, naming what is missing, its saved files still listed. */
function complete(job: JobRecord, deps: InstagramJobDeps, missed: [count: number, unit: string][]): void {
  const parts = missed.filter(([count]) => count > 0).map(([count, unit]) => counted(count, unit));
  if (parts.length === 0) return job.end({ state: "done" });
  const total = missed.reduce((sum, [count]) => sum + count, 0);
  fail(job, deps, "error", `${parts.join(" and ")} couldn't be saved; ${total === 1 ? "it's" : "they're"} tried again on the next run.`);
}

/** "1 post", "3 posts". */
function counted(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Items as single links save them: one already at its place is reported (`existing`), the rest downloaded now and
 * followed. False once the job has ended without them.
 */
async function saveItems(job: JobRecord, deps: InstagramJobDeps, items: InstagramItem[], where: { defaultDir: string; highlight: boolean; fallback: string }): Promise<boolean> {
  const settings = deps.settings();
  const target = { ...where, baseDir: settings.baseDir, byAccount: settings.instagramByAccount, pageUrl: job.request.url, agent: deps.agent };
  const ids: string[] = [];
  items.forEach((item, index) => {
    const download = itemDownload(item, index, target);
    const file = path.join(download.dir, download.filename);
    if (existsSync(file)) job.file(file, true);
    else ids.push(deps.manager.add(download, "now").id);
  });
  if (ids.length === 0) return true;
  const outcome = await followDownloads(deps.manager, ids, job);
  if (outcome.type === "completed") return true;
  if (outcome.type === "error") fail(job, deps, "error", outcome.message);
  else if (outcome.type === "stopped") job.end({ state: "cancelled", reason: "stopped", error: outcome.message });
  else job.end({ state: "cancelled" });
  return false;
}

/** A backup that didn't start ends the job with its reason ("busy" and "empty" are errors for a job). */
function refused(job: JobRecord, deps: InstagramJobDeps, refusal: Refusal): void {
  fail(job, deps, refusal.reason === "busy" || refusal.reason === "empty" ? "error" : refusal.reason, refusal.error);
}

/** Ends the job failed; Instagram's slow-down ends the jobs waiting in the lane with it. */
function fail(job: JobRecord, deps: InstagramJobDeps, reason: JobReason, error: string): void {
  if (reason === "rateLimited") deps.lane.slowDown();
  job.end({ state: "failed", reason, error });
}

/** The backup's plan as a warning: how many posts, how large, the free space, an earlier backup it continues. */
function planWarning(plan: BackupPlan): string {
  const parts = [plan.count !== undefined ? `Backing up ${plan.count} posts` : "Backing up every post"];
  if (plan.bytes !== undefined) parts.push(`about ${formatBytes(plan.bytes)}`);
  if (plan.freeBytes !== undefined) parts.push(`${formatBytes(plan.freeBytes)} free on the drive`);
  return `${parts.join(", ")}${plan.resumes ? "; it continues an earlier backup" : ""}.`;
}

/** `<name> (<count> posts)`, for the list a Saved job answers when no collection was picked. */
function described(collection: SavedCollection): string {
  return collection.count !== undefined ? `${collection.name} (${collection.count} posts)` : collection.name;
}

/** What a job hears of its own backup: from right before its start (a run reports at once), then only that run. */
class BackupFollower {
  private id: string | undefined;
  private early: { targetId: string; tell(): void }[] = [];
  private last: BackupView | undefined;
  private counted = 0;
  private unwatch: (() => void) | null = null;
  /** the job's run going on, as `claim()` found it */
  private run: Promise<void> = Promise.resolve();

  constructor(
    private readonly job: JobRecord,
    private readonly backups: Backups,
  ) {}

  /** Starts hearing the backups, right before the job's start is asked for; what came before is not its. */
  listen(): void {
    this.close();
    this.early = [];
    this.unwatch = this.backups.watch({
      view: (view) => this.hear(view.targetId, () => this.see(view)),
      file: (targetId, file, existing) => this.hear(targetId, () => this.job.file(file, existing)),
    });
  }

  /** The backup just started is the job's: what it reported so far, and all it reports from now on. */
  claim(): void {
    this.id = this.backups.target()?.id;
    this.run = this.backups.settled();
    const early = this.early;
    this.early = [];
    for (const heard of early) if (heard.targetId === this.id) heard.tell();
  }

  /** Waits for the job's backup to end, stopping it when the job is cancelled; its last view. */
  async settled(): Promise<BackupView | undefined> {
    const stop = () => {
      if (this.backups.target()?.id === this.id) void this.backups.stop();
    };
    this.job.signal.addEventListener("abort", stop);
    try {
      if (this.job.signal.aborted) stop();
      await this.run;
    } finally {
      this.job.signal.removeEventListener("abort", stop);
    }
    return this.last;
  }

  close(): void {
    this.unwatch?.();
    this.unwatch = null;
  }

  private hear(targetId: string, tell: () => void): void {
    if (this.id === undefined) this.early.push({ targetId, tell });
    else if (targetId === this.id) tell();
  }

  private see(view: BackupView): void {
    this.last = view;
    this.job.progress({ done: view.done, ...(view.left !== undefined ? { total: view.done + view.failed + view.left } : {}) });
    for (; this.counted < view.failed; this.counted++) this.job.failItem();
  }
}
