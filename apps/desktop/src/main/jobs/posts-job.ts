import { SavedError, type InstagramLink } from "@turbodl/shared";
import { SLOW_DOWN } from "../instagram/pacer";
import { POST_SIGN_IN_ONLY, SIGN_IN_TO_READ, fail, type InstagramJobDeps } from "./instagram-job";
import type { JobRecord } from "./job-record";

/** How long a list runs with no client following its events before it is stopped. */
export const UNFOLLOWED_MS = 60_000;
export const POSTS_UNSUPPORTED = "Post lists take profile, post and reel links.";
const NOBODY_FOLLOWING = "Nobody followed the list for 60 s; it was stopped.";
/** a post link whose page showed nothing: as for profiles, a slow page must not read as one that doesn't exist */
const NOTHING_SHOWN = "Instagram showed nothing at this link; it may not exist, or the page was too slow.";

/**
 * A posts-only job: a profile's posts, or one post, sent as `post` events as they are read, saving nothing. The
 * profile service takes the read slot and the pace itself, so it is called directly. Nothing is read before a client
 * follows the job's events (no post can be sent unseen), and a list nobody follows is stopped.
 */
export async function runPostsJob(job: JobRecord, link: InstagramLink, deps: InstagramJobDeps, o: { unfollowedMs?: number; now?: () => number } = {}): Promise<void> {
  if (link.kind !== "profile" && link.kind !== "post") return job.end({ state: "failed", reason: "unsupported", error: POSTS_UNSUPPORTED });
  if (deps.pacer.held()) return fail(job, deps, "rateLimited", SLOW_DOWN);
  const stopWatching = watchFollowers(job, o.unfollowedMs ?? UNFOLLOWED_MS, o.now ?? Date.now);
  try {
    // running while it waits, where the no-follower rule watches it
    job.start();
    await job.followed();
    if (job.signal.aborted) return job.end({ state: "cancelled" });
    if (link.kind === "profile") await listProfile(job, link.username, deps);
    else await onePost(job, link.code, deps);
  } finally {
    stopWatching();
  }
}

async function listProfile(job: JobRecord, username: string, deps: InstagramJobDeps): Promise<void> {
  const { since, limit, known } = job.request.options ?? {};
  const sinceMs = since === undefined ? NaN : Date.parse(since);
  const outcome = await deps.profiles.listPosts(username, {
    ...(Number.isNaN(sinceMs) ? {} : { since: Math.floor(sinceMs / 1000) }),
    ...(limit !== undefined ? { limit } : {}),
    ...(known ? { known: new Set(known) } : {}),
    signal: job.signal,
    onPost: (post) => job.post(post),
  });
  if (outcome.type === "cancelled") return job.end({ state: "cancelled" });
  if (outcome.type === "refused") return fail(job, deps, outcome.reason, outcome.error);
  const { signInOnly, empty } = outcome;
  // clients see the posts left out in `failedItems`
  for (let i = 0; i < empty; i++) job.failItem();
  if (signInOnly > 0) job.warn(`${signInOnly === 1 ? "1 post is" : `${signInOnly} posts are`} shown only to signed-in visitors; sign in to save them.`);
  if (empty > 0) job.warn(empty === 1 ? "1 post showed nothing and was skipped." : `${empty} posts showed nothing and were skipped.`);
  job.end(signInOnly > 0 ? { state: "done", limited: true } : { state: "done" });
}

async function onePost(job: JobRecord, code: string, deps: InstagramJobDeps): Promise<void> {
  let post;
  try {
    post = await deps.profiles.readPostInfo(code, job.signal);
  } catch (err) {
    if (job.signal.aborted) return job.end({ state: "cancelled" });
    if (err instanceof SavedError && err.kind === "rateLimited") return fail(job, deps, "rateLimited", SLOW_DOWN);
    if (err instanceof SavedError && err.kind === "signedOut") return fail(job, deps, "signInRequired", SIGN_IN_TO_READ);
    throw err;
  }
  if (job.signal.aborted) return job.end({ state: "cancelled" });
  if (post === null) return fail(job, deps, "error", NOTHING_SHOWN);
  if (post === "signInOnly") return fail(job, deps, "signInRequired", POST_SIGN_IN_ONLY);
  job.post(post);
  job.end({ state: "done" });
}

/** Stops the job like a cancel once nobody has followed it for `ms`; returns the stop of the watching. */
function watchFollowers(job: JobRecord, ms: number, now: () => number): () => void {
  const every = Math.max(1, Math.min(1000, Math.floor(ms / 4)));
  let lastFollowed = now();
  const timer = setInterval(() => {
    if (job.followers > 0) lastFollowed = now();
    else if (now() - lastFollowed >= ms) {
      clearInterval(timer);
      job.warn(NOBODY_FOLLOWING);
      job.cancel();
    }
  }, every);
  timer.unref?.();
  return () => clearInterval(timer);
}
