import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramItem, InstagramLink, Job, JobEvent, JobRequest, PostDetails } from "@turbodl/shared";
import type { AppController, InstagramDeps } from "../../src/main/controller";
import type { InstagramJobDeps } from "../../src/main/jobs/instagram-job";
import { JobRecord } from "../../src/main/jobs/job-record";
import { runPostsJob } from "../../src/main/jobs/posts-job";
import { FakeUi, SESSION, startApp } from "../fixtures/instagram-app";
import { fakeSignedOut, signedOutCover, type DetailedPage } from "../fixtures/instagram-fakes";

const SLOW_DOWN = "Instagram asked TurboDL to slow down. Try again in a few minutes.";
const UNSUPPORTED = "Post lists take profile, post and reel links.";
const PROFILE = "https://www.instagram.com/sample.user/";
const POST = "https://www.instagram.com/p/C9/";

let root: string;
let controller: AppController | null;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-postsjob-"));
  controller = null;
});
afterEach(async () => {
  vi.useRealTimers();
  await controller?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function start(instagram: InstagramDeps): Promise<AppController> {
  controller = await startApp(root, new FakeUi(), instagram);
  return controller;
}

const day = (d: number) => Date.UTC(2026, 9, d) / 1000;
const photo = (code: string): InstagramItem => ({ kind: "image", url: `https://cdn.example/${code}.jpg`, width: 1080, height: 1350, mediaId: `${code}-1`, owner: "sample.user" });
const shown = (code: string, d: number, details: Partial<PostDetails> = {}): DetailedPage => ({ items: [photo(code)], details: { takenAt: day(d), owner: "sample.user", taggedUsers: [], ...details } });
const pagesOn = (days: Record<string, number>): Record<string, DetailedPage> => Object.fromEntries(Object.entries(days).map(([code, d]) => [code, shown(code, d)]));
const covers = (...codes: string[]) => codes.map((code) => signedOutCover(`id-${code}`, code));

/** Runs a posts-only job through the app, following its events from the start. */
async function run(c: AppController, url: string, options: JobRequest["options"] = {}): Promise<{ job: Job; events: JobEvent[] }> {
  const { id } = c.jobs.create({ url, options: { postsOnly: true, ...options } });
  const events: JobEvent[] = [];
  c.jobs.subscribe(id, (e) => events.push(e));
  const job = (await c.jobs.ended(id))!;
  return { job, events };
}
const postCodes = (events: JobEvent[]) => events.flatMap((e) => (e.type === "post" ? [e.post.code] : []));

/** The job's deps as the app builds them, for a job driven by hand. */
function depsOf(c: AppController): InstagramJobDeps {
  return {
    session: c.instagramSession,
    find: async () => ({ type: "nothing" }),
    profiles: c["profiles"],
    saved: c["saved"],
    backups: c["backups"],
    pacer: c["pacer"],
    lane: c["lane"],
    manager: c.manager,
    settings: () => c.settings,
    agent: "TestAgent/1",
  };
}

/** Post pages that never answer until the job is called off (a list that is still reading). */
function hanging(deps: InstagramDeps, read: string[]): void {
  deps.find = (link, _cookies, signal) => {
    if (link.kind === "post") read.push(link.code);
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled."))));
  };
}

/** The same fake's finder answering `outcome` for one post's page. */
function answering(deps: InstagramDeps, code: string, outcome: "signInOnly" | "signedOut"): void {
  const find = deps.find;
  deps.find = async (link, cookies, signal) => (link.kind === "post" && link.code === code ? { type: outcome } : find(link, cookies, signal));
}

describe("posts-only jobs", () => {
  it("a posts-only profile job emits each post and ends done, saving nothing", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2"), covers("C3")] });
    const c = await start(so.deps);
    const { job, events } = await run(c, PROFILE);
    expect(job).toMatchObject({ kind: "instagramProfile", state: "done", files: [], warnings: [], failedItems: 0, progress: { done: 3 } });
    expect(postCodes(events)).toEqual(["C1", "C2", "C3"]);
    expect(events.at(-1)?.type).toBe("end");
    expect(c.manager.list()).toEqual([]);
    expect(c["backups"].target()).toBeFalsy();
  });

  it("passes since, limit and known to the list", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 5, C4: 4, C5: 3 }), { listing: [covers("C1", "C2", "C3", "C4", "C5")] });
    const c = await start(so.deps);
    const { events } = await run(c, PROFILE, { since: new Date(day(10) * 1000).toISOString(), known: ["C1"], limit: 2 });
    expect(events.flatMap((e) => (e.type === "post" ? [[e.post.code, e.post.known === true]] : []))).toEqual([
      ["C1", true],
      ["C2", false],
    ]);
    expect(so.read).toEqual(["C2"]);
  });

  it("a posts-only post link emits its one post", async () => {
    const so = fakeSignedOut({ C9: shown("C9", 12, { caption: "Solo" }) });
    const c = await start(so.deps);
    const { job, events } = await run(c, POST);
    expect(job).toMatchObject({ state: "done", files: [], progress: { done: 1 } });
    expect(events.filter((e) => e.type === "post")).toMatchObject([{ post: { code: "C9", caption: "Solo" } }]);
    expect(c.manager.list()).toEqual([]);
  });

  it("a posts-only post link fails with an error, not notFound, when Instagram shows nothing (it may only have been slow), and signInRequired when it needs a sign-in", async () => {
    const so = fakeSignedOut({});
    const c = await start(so.deps);
    expect((await run(c, POST)).job).toMatchObject({ state: "failed", reason: "error", error: "Instagram showed nothing at this link; it may not exist, or the page was too slow." });
    answering(so.deps, "C9", "signInOnly");
    expect((await run(c, POST)).job).toMatchObject({ state: "failed", reason: "signInRequired", error: "Instagram shows this post only to signed-in visitors." });
  });

  it("a posts-only post link ends rateLimited on the login wall", async () => {
    const so = fakeSignedOut({});
    answering(so.deps, "C9", "signedOut");
    const c = await start(so.deps);
    expect((await run(c, POST)).job).toMatchObject({ state: "failed", reason: "rateLimited", error: SLOW_DOWN });
  });

  it("a posts-only post link ends signInRequired when the session expired", async () => {
    const so = fakeSignedOut({});
    answering(so.deps, "C9", "signedOut");
    const c = await start(so.deps);
    c.instagramSession.take(SESSION);
    expect((await run(c, POST)).job).toMatchObject({ state: "failed", reason: "signInRequired", error: "Sign in to Instagram to read this link." });
  });

  it("a posts-only story link fails unsupported", async () => {
    const so = fakeSignedOut({});
    const c = await start(so.deps);
    const { job } = await run(c, "https://www.instagram.com/stories/sample.user/3000000000000000001/");
    expect(job).toMatchObject({ state: "failed", reason: "unsupported", error: UNSUPPORTED });
    expect(so.opened).toEqual([]);
    expect(so.read).toEqual([]);
  });

  it("a posts-only file link fails unsupported and downloads nothing", async () => {
    const so = fakeSignedOut({});
    const c = await start(so.deps);
    const { job } = await run(c, "https://example.com/a.zip");
    expect(job).toMatchObject({ state: "failed", reason: "unsupported", error: UNSUPPORTED });
    expect(c.manager.list()).toEqual([]);
  });

  it("ends done but limited with the warning when posts need a sign-in", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    answering(so.deps, "C2", "signInOnly");
    const c = await start(so.deps);
    const { job, events } = await run(c, PROFILE);
    expect(job).toMatchObject({ state: "done", limited: true, reason: "signInRequired", warnings: ["1 post is shown only to signed-in visitors; sign in to save them."] });
    expect(postCodes(events)).toEqual(["C1", "C2", "C3"]);
  });

  it("warns about posts that showed nothing and counts them as failed items, the sign-in warning first", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20 }), { listing: [covers("C1", "C2")] });
    const c = await start(so.deps);
    expect((await run(c, PROFILE)).job).toMatchObject({ state: "done", failedItems: 1, warnings: ["1 post showed nothing and was skipped."] });
    await controller?.shutdown();
    const so2 = fakeSignedOut(pagesOn({ C1: 20 }), { listing: [covers("C1", "C2", "C3", "C4")] });
    answering(so2.deps, "C3", "signInOnly");
    const c2 = await start(so2.deps);
    expect((await run(c2, PROFILE)).job).toMatchObject({
      state: "done",
      limited: true,
      failedItems: 2,
      warnings: ["1 post is shown only to signed-in visitors; sign in to save them.", "2 posts showed nothing and were skipped."],
    });
  });

  it("ends rateLimited on the login wall and ends the lane's waiting jobs with it", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19 }), { listing: [covers("C1", "C2")] });
    answering(so.deps, "C2", "signedOut");
    const c = await start(so.deps);
    const slowDown = vi.spyOn(c["lane"], "slowDown");
    const { job, events } = await run(c, PROFILE);
    expect(job).toMatchObject({ state: "failed", reason: "rateLimited", error: SLOW_DOWN, progress: { done: 1 } });
    expect(postCodes(events)).toEqual(["C1"]);
    expect(slowDown).toHaveBeenCalled();
    expect(c["pacer"].held()).toBe(true);
    // while the slow-down holds, a later list asks nothing
    const read = so.read.length;
    expect((await run(c, POST)).job).toMatchObject({ state: "failed", reason: "rateLimited" });
    expect(so.read).toHaveLength(read);
  });

  it("is cancelled after 60 s with nobody following, and asks Instagram nothing more", async () => {
    const read: string[] = [];
    const so = fakeSignedOut({}, { listing: [covers("C1", "C2")] });
    hanging(so.deps, read);
    const c = await start(so.deps);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const job = new JobRecord("j1", { url: PROFILE, options: { postsOnly: true } }, "instagramProfile", Date.now);
    const unfollow = job.subscribe(() => undefined);
    const running = runPostsJob(job, { kind: "profile", username: "sample.user" } as InstagramLink, depsOf(c), { unfollowedMs: 1000 });
    await vi.advanceTimersByTimeAsync(500);
    expect(job.view().state).toBe("running");
    unfollow();
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(job.view()).toMatchObject({ state: "cancelled", warnings: ["Nobody followed the list for 60 s; it was stopped."] });
    expect(read).toEqual(["C1"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toEqual(["C1"]);
  });

  it("doesn't read anything until someone follows", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C9: 12 }), { listing: [covers("C1")] });
    const c = await start(so.deps);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const profile = new JobRecord("j1", { url: PROFILE, options: { postsOnly: true } }, "instagramProfile", Date.now);
    const post = new JobRecord("j2", { url: POST, options: { postsOnly: true } }, "instagramPost", Date.now);
    const running = [
      runPostsJob(profile, { kind: "profile", username: "sample.user" } as InstagramLink, depsOf(c), { unfollowedMs: 1000 }),
      runPostsJob(post, { kind: "post", code: "C9" } as InstagramLink, depsOf(c), { unfollowedMs: 1000 }),
    ];
    await vi.advanceTimersByTimeAsync(500);
    // waiting in running, where the no-follower rule watches it
    expect([profile.view().state, post.view().state]).toEqual(["running", "running"]);
    expect(so.opened).toEqual([]);
    expect(so.read).toEqual([]);
    // nobody ever came: cancelled 60 s (here 1 s) after it was made, having asked Instagram nothing
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(running);
    for (const job of [profile, post]) expect(job.view()).toMatchObject({ state: "cancelled", warnings: ["Nobody followed the list for 60 s; it was stopped."], progress: { done: 0 } });
    expect(so.opened).toEqual([]);
    expect(so.read).toEqual([]);
  });

  it("starts once a follower subscribes", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19 }), { listing: [covers("C1", "C2")] });
    const c = await start(so.deps);
    const job = new JobRecord("j1", { url: PROFILE, options: { postsOnly: true } }, "instagramProfile", Date.now);
    const running = runPostsJob(job, { kind: "profile", username: "sample.user" } as InstagramLink, depsOf(c));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(so.opened).toEqual([]);
    const events: JobEvent[] = [];
    job.subscribe((e) => events.push(e));
    await running;
    expect(job.view()).toMatchObject({ state: "done", progress: { done: 2 } });
    expect(postCodes(events)).toEqual(["C1", "C2"]);
    expect(so.read).toEqual(["C1", "C2"]);
  });

  it("keeps running while someone follows", async () => {
    const read: string[] = [];
    const so = fakeSignedOut({}, { listing: [covers("C1")] });
    hanging(so.deps, read);
    const c = await start(so.deps);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const job = new JobRecord("j1", { url: PROFILE, options: { postsOnly: true } }, "instagramProfile", Date.now);
    job.subscribe(() => undefined);
    const running = runPostsJob(job, { kind: "profile", username: "sample.user" } as InstagramLink, depsOf(c), { unfollowedMs: 1000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(job.view()).toMatchObject({ state: "running", warnings: [] });
    job.cancel();
    await running;
    expect(job.view().state).toBe("cancelled");
  });

  it("a client cancel stops the list at once", async () => {
    const read: string[] = [];
    const so = fakeSignedOut({}, { listing: [covers("C1", "C2")] });
    hanging(so.deps, read);
    const c = await start(so.deps);
    const { id } = c.jobs.create({ url: PROFILE, options: { postsOnly: true } });
    c.jobs.subscribe(id, () => undefined);
    for (let i = 0; i < 100 && read.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(read).toEqual(["C1"]);
    c.jobs.cancel(id);
    expect(await c.jobs.ended(id)).toMatchObject({ state: "cancelled" });
    expect(read).toEqual(["C1"]);
    expect(c.manager.list()).toEqual([]);
  });
});
