import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SavedError, type InstagramItem, type InstagramProfile, type Job, type JobEvent, type JobRequest, type SavedPost } from "@turbodl/shared";
import type { AppController, InstagramDeps } from "../../src/main/controller";
import { FakeUi, SESSION, startApp } from "../fixtures/instagram-app";
import { fakeProfiles, fakeSignedOut, savedGet, signedOutCover } from "../fixtures/instagram-fakes";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const SLOW_DOWN = "Instagram asked TurboDL to slow down. Try again in a few minutes.";

let server: TestServer;
let root: string;
let controller: AppController | null;
let ui: FakeUi;

beforeEach(async () => {
  server = await startTestServer();
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-igjob-"));
  controller = null;
  ui = new FakeUi();
  for (const id of ["a", "b", "c"]) server.setFile(`/ig/${id}.jpg`, { data: Buffer.alloc(300, 1), contentType: "image/jpeg" });
});
afterEach(async () => {
  await controller?.shutdown();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(instagram: InstagramDeps): Promise<AppController> {
  controller = await startApp(root, ui, instagram);
  return controller;
}

async function signedIn(instagram: InstagramDeps): Promise<AppController> {
  const c = await start(instagram);
  c.instagramSession.take(SESSION);
  return c;
}

/** Runs a job to its end. */
async function run(c: AppController, request: JobRequest): Promise<Job> {
  const { id } = c.jobs.create(request);
  return (await c.jobs.ended(id))!;
}

/** Lets everything that is ready run (no timer passes). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Waits for `check` to hold, a bounded while. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
}

/** A clock that moves only when the test moves it: each wait ends at its own time, the earliest first. */
function steppedClock() {
  let now = 0;
  const timers: { due: number; resolve(): void }[] = [];
  return {
    now: () => now,
    wait: (ms: number) => new Promise<void>((resolve) => timers.push({ due: now + ms, resolve })),
    /** ends the earliest wait, the clock moved to its time */
    step(): void {
      timers.sort((x, y) => x.due - y.due);
      const next = timers.shift();
      if (!next) return;
      now = Math.max(now, next.due);
      next.resolve();
    },
  };
}

/** A fetch that holds every item until `open()` (a backup that runs until the test lets it end). */
function heldFetch(deps: InstagramDeps): { open(): void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const fetch = deps.fetch!;
  deps.fetch = async (url, file, o) => {
    await gate;
    return fetch(url, file, o);
  };
  return { open };
}

const item = (id: string, owner = "someone"): InstagramItem => ({ kind: "image", url: server.url(`/ig/${id}.jpg`), mediaId: id, owner });
const person = (id: string, username: string, o: Partial<InstagramProfile> = {}): InstagramProfile => ({ id, username, fullName: "Sample User", isPrivate: false, following: true, postCount: 3, ...o });
const photo = (id: string): SavedPost => ({ id, cover: `https://cdn.example/${id}.jpg`, items: [{ kind: "image", url: `https://cdn.example/${id}.jpg`, mediaId: id }] });
/** sample.user: posts 1 and 2 on the first page, 3 on the second */
const SAMPLE = () => ({ profile: person("5100000000000000001", "sample.user"), pages: [[photo("1"), photo("2")], [photo("3")]] });
const OTHER = () => ({ profile: person("5100000000000000002", "other.user", { postCount: 1 }), pages: [[photo("4")]] });
const THIRD = () => ({ profile: person("5100000000000000003", "third.user", { postCount: 1 }), pages: [[photo("5")]] });
const IGNORED = "Instagram downloads go to TurboDL's Instagram folders; dir and name are ignored.";
const sorted = (list: string[]) => [...list].sort();
const dl = (...parts: string[]) => path.join(root, "dl", "Instagram", ...parts);

describe("Instagram link jobs", () => {
  const POST = "https://www.instagram.com/p/C1abcDEF/";

  it("downloads a post link's items into the account's folder and reports their paths", async () => {
    const so = fakeSignedOut({ C1abcDEF: [item("a"), item("b")] });
    const c = await start(so.deps);
    const job = await run(c, { url: POST });
    expect(job).toMatchObject({ kind: "instagramPost", state: "done", warnings: [], failedItems: 0 });
    expect(sorted(job.files)).toEqual([dl("someone", "a.jpg"), dl("someone", "b.jpg")]);
    expect(readFileSync(dl("someone", "a.jpg")).length).toBe(300);
    expect(c.manager.get(c.manager.list()[0].id)?.headers).toEqual({ Referer: "https://www.instagram.com/", "User-Agent": "TestAgent/1" });
    expect(so.read).toEqual(["C1abcDEF"]);
  });

  it("ignores dir and name for Instagram, with a warning", async () => {
    const so = fakeSignedOut({ C1abcDEF: [item("a")] });
    const c = await start(so.deps);
    const job = await run(c, { url: POST, dir: path.join(root, "elsewhere"), name: "mine.jpg" });
    expect(job).toMatchObject({ state: "done", warnings: [IGNORED], files: [dl("someone", "a.jpg")] });
    expect(existsSync(path.join(root, "elsewhere"))).toBe(false);
  });

  it("answers a re-run of a post link from the files already there, downloading nothing", async () => {
    const so = fakeSignedOut({ C1abcDEF: [item("a"), item("b")] });
    const c = await start(so.deps);
    const first = await run(c, { url: POST });
    const downloads = c.manager.list().length;
    const { id } = c.jobs.create({ url: POST });
    const events: JobEvent[] = [];
    c.jobs.subscribe(id, (e) => events.push(e));
    const again = (await c.jobs.ended(id))!;
    expect(again.state).toBe("done");
    expect(sorted(again.files)).toEqual(sorted(first.files));
    expect(events.filter((e) => e.type === "file")).toEqual([
      { type: "file", path: dl("someone", "a.jpg"), existing: true, jobId: id },
      { type: "file", path: dl("someone", "b.jpg"), existing: true, jobId: id },
    ]);
    expect(c.manager.list()).toHaveLength(downloads);
  });

  it("fails notFound when the link shows nothing, and signInRequired when the page asks a session to sign in again", async () => {
    const so = fakeSignedOut({});
    so.deps.find = async (link) => (link.kind === "post" && link.code === "Chidden" ? { type: "signedOut" } : { type: "nothing" });
    const c = await start(so.deps);
    expect(await run(c, { url: POST })).toMatchObject({ state: "failed", reason: "notFound", error: "Instagram showed nothing at this link." });
    // with a session, a page landing on sign-in means the session expired
    c.instagramSession.take(SESSION);
    expect(await run(c, { url: "https://www.instagram.com/p/Chidden/" })).toMatchObject({ state: "failed", reason: "signInRequired", error: "Sign in to Instagram to read this link." });
    expect(c["pacer"].held()).toBe(false);
  });

  it("ends rateLimited and holds the account when a link read without a session lands on Instagram's login wall", async () => {
    const so = fakeSignedOut({ "17900000000000009": [item("b")] });
    const find = so.deps.find;
    so.deps.find = async (link, cookies, signal) => {
      await find(link, cookies, signal);
      return { type: "signedOut" };
    };
    const c = await start(so.deps);
    const highlight = "https://www.instagram.com/stories/highlights/17900000000000009/";
    expect(await run(c, { url: highlight })).toMatchObject({ kind: "instagramHighlight", state: "failed", reason: "rateLimited", error: SLOW_DOWN });
    expect(c["pacer"].held()).toBe(true);
    // the next link loads no page while it holds
    expect(await run(c, { url: POST })).toMatchObject({ state: "failed", reason: "rateLimited", error: SLOW_DOWN });
    expect(so.read).toEqual(["17900000000000009"]);
  });

  it("spaces the pages jobs read 3–6 s apart", async () => {
    const clock = steppedClock();
    const so = fakeSignedOut({ C1: [item("a")], C2: [item("b")], C3: [item("c")] });
    const reads: number[] = [];
    const find = so.deps.find;
    so.deps.find = async (link, cookies, signal) => {
      reads.push(clock.now());
      return find(link, cookies, signal);
    };
    so.deps.now = clock.now;
    so.deps.wait = clock.wait;
    const c = await start(so.deps);
    const ids = ["C1", "C2", "C3"].map((code) => c.jobs.create({ url: `https://www.instagram.com/p/${code}/` }).id);
    let ended = false;
    void Promise.all(ids.map((id) => c.jobs.ended(id))).then(() => (ended = true));
    for (let i = 0; i < 300 && !ended; i++) {
      await new Promise((r) => setTimeout(r, 5));
      clock.step();
    }
    expect(ended).toBe(true);
    expect(reads).toHaveLength(3);
    for (const k of [1, 2]) {
      expect(reads[k] - reads[k - 1]).toBeGreaterThanOrEqual(3000);
      expect(reads[k] - reads[k - 1]).toBeLessThanOrEqual(6000);
    }
  });

  it("loads the pages jobs read one at a time, each 3–6 s after the last one ended", async () => {
    const clock = steppedClock();
    const so = fakeSignedOut({ C1: [item("a")], C2: [item("b")], C3: [item("c")] });
    const reads: { start: number; end: number }[] = [];
    let loading = 0;
    let most = 0;
    const find = so.deps.find;
    // each page takes 7 s to load (under the finder's 12 s), longer than any gap: gaps counted from a read's start fail
    so.deps.find = async (link, cookies, signal) => {
      const read = { start: clock.now(), end: 0 };
      reads.push(read);
      most = Math.max(most, ++loading);
      await clock.wait(7000);
      loading--;
      read.end = clock.now();
      return find(link, cookies, signal);
    };
    so.deps.now = clock.now;
    so.deps.wait = clock.wait;
    const c = await start(so.deps);
    const ids = ["C1", "C2", "C3"].map((code) => c.jobs.create({ url: `https://www.instagram.com/p/${code}/` }).id);
    let ended = false;
    void Promise.all(ids.map((id) => c.jobs.ended(id))).then(() => (ended = true));
    for (let i = 0; i < 300 && !ended; i++) {
      await new Promise((r) => setTimeout(r, 5));
      clock.step();
    }
    expect(ended).toBe(true);
    expect(reads).toHaveLength(3);
    expect(most).toBe(1);
    for (const k of [1, 2]) {
      expect(reads[k].start - reads[k - 1].end).toBeGreaterThanOrEqual(3000);
      expect(reads[k].start - reads[k - 1].end).toBeLessThanOrEqual(6000);
    }
  });

  it("reads a link while a backup runs, without waiting for it", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() }, { hangFetch: true });
    ig.deps.find = async (link) => (link.kind === "post" ? { type: "items", items: [item("a")] } : { type: "nothing" });
    const c = await signedIn(ig.deps);
    const backup = c.jobs.create({ url: "https://www.instagram.com/sample.user/" });
    await until(() => c.snapshot().instagramBackup?.state === "running");
    expect(await run(c, { url: POST })).toMatchObject({ state: "done", files: [dl("someone", "a.jpg")] });
    expect(c.jobs.get(backup.id)?.state).toBe("running");
    c.jobs.cancel(backup.id);
    expect((await c.jobs.ended(backup.id))?.state).toBe("cancelled");
  });

  it("reads a highlight link without a session, and needs one for a story link", async () => {
    const so = fakeSignedOut({ "17900000000000009": [item("b")] });
    const c = await start(so.deps);
    const story = "https://www.instagram.com/stories/someone/3800000000000000001/";
    const highlight = "https://www.instagram.com/stories/highlights/17900000000000009/";
    expect(await run(c, { url: story })).toMatchObject({ state: "failed", reason: "signInRequired", error: "Sign in to Instagram to read this link." });
    expect(so.read).toEqual([]);
    expect(await run(c, { url: highlight })).toMatchObject({ kind: "instagramHighlight", state: "done", files: [dl("someone", "Highlights", "b.jpg")] });
    expect(so.read).toEqual(["17900000000000009"]);
  });

  it("fails signInRequired for a post only signed-in visitors see, read signed out", async () => {
    const so = fakeSignedOut({});
    so.deps.find = async () => ({ type: "signInOnly" });
    const c = await start(so.deps);
    expect(await run(c, { url: POST })).toMatchObject({ state: "failed", reason: "signInRequired", error: "Instagram shows this post only to signed-in visitors." });
  });
});

describe("Instagram profile jobs", () => {
  const PROFILE_URL = "https://www.instagram.com/sample.user/";
  const story = (id: string): InstagramItem => ({ kind: "image", url: `https://cdn.example/${id}.jpg`, mediaId: id });

  it("backs a profile up, then its highlights, into their folders", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() });
    ig.deps.find = async (link) => (link.kind === "highlight" ? { type: "items", items: [story("s1"), story("s2")] } : { type: "nothing" });
    const c = await signedIn(ig.deps);
    const job = await run(c, { url: PROFILE_URL, options: { highlights: true } });
    expect(job).toMatchObject({ kind: "instagramProfile", state: "done", failedItems: 0 });
    expect(job.files).toEqual([dl("sample.user", "1.jpg"), dl("sample.user", "2.jpg"), dl("sample.user", "3.jpg"), dl("sample.user", "Highlights", "s1.jpg"), dl("sample.user", "Highlights", "s2.jpg")]);
    expect(job.warnings).toHaveLength(1);
    expect(job.warnings[0]).toMatch(/^Backing up 3 posts/);
    expect(readdirSync(dl("sample.user", "Highlights")).sort()).toEqual(["s1.jpg", "s2.jpg"]);
    const kinds = ui.events.flatMap((e) => (e.type === "instagramBackup" && e.backup ? [e.backup.kind] : []));
    expect([...new Set(kinds)]).toEqual(["profile", "highlights"]);
  });

  it("reports nothing of its backup before it is running", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() });
    const c = await signedIn(ig.deps);
    const { id } = c.jobs.create({ url: PROFILE_URL });
    const events: JobEvent[] = [];
    c.jobs.subscribe(id, (e) => events.push(e));
    expect(await c.jobs.ended(id)).toMatchObject({ state: "done" });
    const running = events.findIndex((e) => e.type === "state" && e.state === "running");
    expect(running).toBeGreaterThanOrEqual(0);
    expect(events.some((e) => e.type === "progress")).toBe(true);
    expect(events.slice(0, running).filter((e) => e.type === "file" || e.type === "progress")).toEqual([]);
  });

  it("ends failed, its saved files listed, when a backup couldn't save every post", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() });
    ig.deps.find = async (link) => (link.kind === "highlight" ? { type: "items", items: [story("s1")] } : { type: "nothing" });
    const fetch = ig.deps.fetch!;
    ig.deps.fetch = async (url, file, o) => {
      if (url.endsWith("/2.jpg")) throw new Error("The file is gone.");
      return fetch(url, file, o);
    };
    const c = await signedIn(ig.deps);
    const job = await run(c, { url: PROFILE_URL, options: { highlights: true } });
    // the highlights still ran after the posts
    expect(job).toMatchObject({
      state: "failed",
      reason: "error",
      error: "1 post couldn't be saved; it's tried again on the next run.",
      failedItems: 1,
      files: [dl("sample.user", "1.jpg"), dl("sample.user", "3.jpg"), dl("sample.user", "Highlights", "s1.jpg")],
    });
  });

  it("waits its turn while a backup from the app's screens runs, then starts", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE(), "other.user": OTHER() });
    const held = heldFetch(ig.deps);
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    expect(await c.startProfileBackup("sample.user")).toEqual({ ok: true });
    const { id } = c.jobs.create({ url: "https://www.instagram.com/other.user/" });
    await flush();
    expect(c.jobs.get(id)?.state).toBe("queued");
    expect(ig.opened).toEqual(["sample.user"]);
    held.open();
    expect(await c.jobs.ended(id)).toMatchObject({ state: "done", files: [dl("other.user", "4.jpg")] });
    expect(ig.opened).toEqual(["sample.user", "other.user"]);
  });

  it("starts each backup after the jobs' gap, its profile's page being a page read too", async () => {
    const empty = (id: string, username: string) => ({ profile: person(id, username, { postCount: 0 }), pages: [[]] });
    const ig = fakeProfiles({ "a.user": empty("61", "a.user"), "b.user": empty("62", "b.user") });
    const opened: number[] = [];
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => {
      opened.push(ig.deps.now!());
      return open(username, cookies);
    };
    const c = await signedIn(ig.deps);
    const ids = ["a.user", "b.user"].map((u) => c.jobs.create({ url: `https://www.instagram.com/${u}/` }).id);
    expect((await Promise.all(ids.map((id) => c.jobs.ended(id)))).map((j) => j?.state)).toEqual(["done", "done"]);
    expect(opened).toHaveLength(2);
    expect(opened[1] - opened[0]).toBeGreaterThanOrEqual(3000);
    expect(opened[1] - opened[0]).toBeLessThanOrEqual(6000);
  });

  const PUBLIC_POSTS = () => ({ C1: [item("a", "sample.user"), item("b", "sample.user")], C2: [item("c", "sample.user")], C3: [item("d", "sample.user")] });
  const THREE_PAGES = () => [[signedOutCover("p1", "C1"), signedOutCover("p2", "C2")], [signedOutCover("p3", "C3")]];

  it("backs every post of a signed-out profile up, over several pages, and ends done", async () => {
    const so = fakeSignedOut(PUBLIC_POSTS(), { listing: THREE_PAGES() });
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL });
    expect(job).toMatchObject({ state: "done", failedItems: 0 });
    expect(job.limited).toBeUndefined();
    expect(sorted(job.files)).toEqual([dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg"), dl("sample.user", "c.jpg"), dl("sample.user", "d.jpg")]);
    expect(so.asked).toHaveLength(2);
  });

  /** A profile job run to its end, with the note of each progress it reported. */
  async function progressNotes(c: AppController) {
    const { id } = c.jobs.create({ url: PROFILE_URL });
    const seen: (string | undefined)[] = [];
    c.jobs.subscribe(id, (e) => e.type === "progress" && seen.push(e.progress.note));
    const job = (await c.jobs.ended(id))!;
    return { seen, job };
  }

  it("says in its progress, while it does, that a signed-out backup reads each post from its own page", async () => {
    const { seen, job } = await progressNotes(await start(fakeSignedOut(PUBLIC_POSTS(), { listing: THREE_PAGES() }).deps));
    expect(job.state).toBe("done");
    expect(seen).toContain("Signed out: reading each post from its own page");
    expect(job.progress.note).toBeUndefined();
  });

  it("has no note in its progress signed in, where the posts come with their items", async () => {
    const { seen, job } = await progressNotes(await signedIn(fakeProfiles({ "sample.user": SAMPLE() }).deps));
    expect(job.state).toBe("done");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((note) => note === undefined)).toBe(true);
  });

  it("backs a signed-out profile's highlights up too", async () => {
    const so = fakeSignedOut({ ...PUBLIC_POSTS(), "17900000000000002": [item("s1", "sample.user")] });
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL, options: { highlights: true } });
    expect(job).toMatchObject({ state: "done", failedItems: 0 });
    expect(job.limited).toBeUndefined();
    expect(job.warnings).toEqual([expect.stringMatching(/^Backing up every post/)]);
    expect(sorted(job.files)).toEqual([dl("sample.user", "Highlights", "s1.jpg"), dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg"), dl("sample.user", "c.jpg")]);
  });

  it("backs a signed-out profile's highlights up by themselves", async () => {
    const so = fakeSignedOut({ "17900000000000002": [item("s1", "sample.user")] });
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL, options: { highlightsOnly: true } });
    expect(job).toMatchObject({ state: "done", files: [dl("sample.user", "Highlights", "s1.jpg")], warnings: [] });
  });

  it("ends done and limited, the other posts saved, when Instagram shows a post only to signed-in visitors", async () => {
    const so = fakeSignedOut(PUBLIC_POSTS(), { listing: THREE_PAGES() });
    const find = so.deps.find;
    so.deps.find = (link, cookies, signal) => (link.kind === "post" && link.code === "C2" ? Promise.resolve({ type: "signInOnly" }) : find(link, cookies, signal));
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL });
    expect(job).toMatchObject({ state: "done", limited: true, reason: "signInRequired", failedItems: 0 });
    expect(job.warnings).toContain("1 post is shown only to signed-in visitors; sign in to save them.");
    expect(sorted(job.files)).toEqual([dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg"), dl("sample.user", "d.jpg")]);
  });

  it("still names the posts shown only to signed-in visitors when a signed-out backup also failed one", async () => {
    // C2 and C3 are shown only to signed-in visitors; C4's own page shows nothing
    const so = fakeSignedOut(PUBLIC_POSTS(), { listing: [[signedOutCover("p1", "C1"), signedOutCover("p2", "C2"), signedOutCover("p3", "C3")], [signedOutCover("p4", "C4")]] });
    const find = so.deps.find;
    so.deps.find = (link, cookies, signal) => (link.kind === "post" && (link.code === "C2" || link.code === "C3") ? Promise.resolve({ type: "signInOnly" }) : find(link, cookies, signal));
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL });
    expect(job).toMatchObject({ state: "failed", reason: "error", error: "1 post couldn't be saved; it's tried again on the next run.", failedItems: 1 });
    expect(job.limited).toBeUndefined();
    expect(job.warnings).toContain("2 posts are shown only to signed-in visitors; sign in to save them.");
    expect(sorted(job.files)).toEqual([dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg")]);
  });

  it("ends rateLimited when Instagram's login wall stops a signed-out backup, what was saved listed", async () => {
    const so = fakeSignedOut(PUBLIC_POSTS(), { listing: THREE_PAGES() });
    const open = so.deps.openProfile!;
    so.deps.openProfile = (username, cookies) => {
      const source = open(username, cookies);
      return { ...source, page: (cursor, signal) => (cursor ? Promise.reject(new SavedError("rateLimited")) : source.page(cursor, signal)) };
    };
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL });
    expect(job).toMatchObject({ state: "failed", reason: "rateLimited", error: SLOW_DOWN });
    expect(sorted(job.files)).toEqual([dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg"), dl("sample.user", "c.jpg")]);
    expect(c["pacer"].held()).toBe(true);
  });

  it("ends failed when a signed-out backup couldn't read every post, the rest saved", async () => {
    // C2's own page shows nothing
    const so = fakeSignedOut({ C1: [item("a", "sample.user"), item("b", "sample.user")] });
    const c = await start(so.deps);
    const job = await run(c, { url: PROFILE_URL });
    expect(job).toMatchObject({
      state: "failed",
      reason: "error",
      error: "1 post couldn't be saved; it's tried again on the next run.",
      failedItems: 1,
    });
    expect(sorted(job.files)).toEqual([dl("sample.user", "a.jpg"), dl("sample.user", "b.jpg")]);
  });

  it("fails private for a private profile it doesn't follow", async () => {
    const ig = fakeProfiles({ "shut.door": { profile: person("52", "shut.door", { isPrivate: true, following: false }), pages: [[photo("1")]] } });
    const c = await start(ig.deps);
    const url = "https://www.instagram.com/shut.door/";
    expect(await run(c, { url })).toMatchObject({ state: "failed", reason: "private", error: "This account is private." });
    c.instagramSession.take(SESSION);
    expect(await run(c, { url })).toMatchObject({ state: "failed", reason: "private", error: "This account is private." });
    expect(ig.fetched).toEqual([]);
  });

  it("ends done with a warning when a profile has no highlights to back up", async () => {
    const ig = fakeProfiles({ "no.highlights": { profile: person("54", "no.highlights"), pages: [[photo("1")]], highlights: [] } });
    const c = await signedIn(ig.deps);
    expect(await run(c, { url: "https://www.instagram.com/no.highlights/", options: { highlightsOnly: true } })).toMatchObject({
      state: "done",
      warnings: ["This profile has no highlights."],
      files: [],
    });
    expect(ig.fetched).toEqual([]);
  });

  it("ends stopped when the backup is stopped from the app, cancelled when the job is cancelled", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() }, { hangFetch: true });
    const c = await signedIn(ig.deps);
    const first = c.jobs.create({ url: PROFILE_URL });
    await until(() => c.jobs.get(first.id)?.state === "running");
    await c.stopBackup();
    expect(await c.jobs.ended(first.id)).toMatchObject({ state: "cancelled", reason: "stopped", error: "The backup was stopped in TurboDL." });
    const second = c.jobs.create({ url: PROFILE_URL });
    await until(() => c.jobs.get(second.id)?.state === "running");
    c.jobs.cancel(second.id);
    const ended = (await c.jobs.ended(second.id))!;
    expect(ended.state).toBe("cancelled");
    expect(ended.reason).toBeUndefined();
    expect(c.snapshot().instagramBackup?.state).toBe("stopped");
  });

  it("ends every queued Instagram job at once while Instagram's slow-down holds", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE(), "other.user": OTHER(), "third.user": THIRD() });
    const held = heldFetch(ig.deps);
    // the backup's next page is where Instagram asks to slow down
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => {
      const source = open(username, cookies);
      return { ...source, page: (cursor, signal) => (cursor ? Promise.reject(new SavedError("rateLimited")) : source.page(cursor, signal)) };
    };
    const c = await signedIn(ig.deps);
    const [a, b, d] = ["sample.user", "other.user", "third.user"].map((u) => c.jobs.create({ url: `https://www.instagram.com/${u}/` }).id);
    await until(() => c.jobs.get(a)?.state === "running");
    expect([c.jobs.get(b)?.state, c.jobs.get(d)?.state]).toEqual(["queued", "queued"]);
    held.open();
    const limited = { state: "failed", reason: "rateLimited", error: SLOW_DOWN };
    expect(await c.jobs.ended(a)).toMatchObject({ ...limited, files: [dl("sample.user", "1.jpg"), dl("sample.user", "2.jpg")] });
    expect(await c.jobs.ended(b)).toMatchObject(limited);
    expect(await c.jobs.ended(d)).toMatchObject(limited);
    expect(ig.opened).toEqual(["sample.user"]);
    // new ones while it holds ask Instagram nothing
    let finds = 0;
    ig.deps.find = async () => {
      finds++;
      return { type: "nothing" };
    };
    expect(await run(c, { url: "https://www.instagram.com/p/C1abcDEF/" })).toMatchObject(limited);
    expect(await run(c, { url: "https://www.instagram.com/other.user/" })).toMatchObject(limited);
    expect(await run(c, { url: "https://www.instagram.com/sample.user/saved/", options: { allCollections: true } })).toMatchObject(limited);
    expect(finds).toBe(0);
    expect(ig.opened).toEqual(["sample.user"]);
  });

  it("ends the jobs waiting in the lane at once when one ends rateLimited, and holds the account from then on", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE(), "other.user": OTHER(), "third.user": THIRD() });
    const open = ig.deps.openProfile!;
    // the first profile's page, a backup's start, answers "slow down"
    ig.deps.openProfile = (username, cookies) => {
      const source = open(username, cookies);
      return username === "sample.user" ? { ...source, profile: () => Promise.reject(new SavedError("rateLimited")) } : source;
    };
    const c = await signedIn(ig.deps);
    const ids = ["sample.user", "other.user", "third.user"].map((u) => c.jobs.create({ url: `https://www.instagram.com/${u}/` }).id);
    const ended = await Promise.all(ids.map((id) => c.jobs.ended(id)));
    expect(ended.map((j) => [j?.state, j?.reason])).toEqual([
      ["failed", "rateLimited"],
      ["failed", "rateLimited"],
      ["failed", "rateLimited"],
    ]);
    expect(ig.opened).toEqual(["sample.user"]);
    // the next job waits out Instagram's slow-down instead of asking again
    expect(c["pacer"].held()).toBe(true);
  });

  it("holds the account when the screen's profile page answers slow down", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE() });
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => ({ ...open(username, cookies), profile: () => Promise.reject(new SavedError("rateLimited")) });
    const c = await signedIn(ig.deps);
    expect(await c.profileLoad("sample.user")).toEqual({ type: "rateLimited" });
    expect(c["pacer"].held()).toBe(true);
  });

  it("never closes the profile open on the screen", async () => {
    const ig = fakeProfiles({ "sample.user": SAMPLE(), "other.user": OTHER() });
    const c = await signedIn(ig.deps);
    await c.profileLoad("sample.user");
    expect(await run(c, { url: PROFILE_URL })).toMatchObject({ state: "done" });
    expect(await run(c, { url: "https://www.instagram.com/other.user/" })).toMatchObject({ state: "done" });
    expect(ig.opened).toEqual(["sample.user", "other.user"]);
    expect(ig.closed).not.toContain("sample.user");
    expect((await c.profilePage("sample.user")).type).toBe("page");
  });
});

describe("Instagram Saved jobs", () => {
  const SAVED = "https://www.instagram.com/sample.user/saved/";
  const COLLECTIONS = [
    { id: "100", name: "All posts", count: 40, isAll: true },
    { id: "102", name: "Trips", count: 2, isAll: false },
    { id: "103", name: "Food", count: 12, isAll: false },
  ];
  const media = (pk: string) => ({ pk, code: `C${pk}`, image_versions2: { candidates: [{ url: `https://cdn.example/${pk}.jpg`, width: 640, height: 640 }] } });

  /** The account's Saved: All, Trips and Food, every feed answering posts 1 and 2. */
  function fakeSaved() {
    const ig = fakeProfiles({});
    const feeds: string[] = [];
    ig.deps.get = savedGet([media("1"), media("2")], { sent: (url) => url.includes("/feed/") && feeds.push(url) });
    ig.deps.collections = async () => COLLECTIONS;
    return { deps: ig.deps, feeds };
  }

  it("lists the collections and backs up nothing when none is picked", async () => {
    const saved = fakeSaved();
    const c = await start(saved.deps);
    expect(await run(c, { url: SAVED })).toMatchObject({ kind: "instagramSaved", state: "failed", reason: "signInRequired" });
    c.instagramSession.take(SESSION);
    const job = await run(c, { url: SAVED });
    expect(job).toMatchObject({ state: "failed", reason: "error" });
    expect(job.error).toContain("Trips (2 posts), Food (12 posts)");
    expect(job.error).not.toContain("All posts");
    expect(saved.feeds).toEqual([]);
    expect(c.snapshot().instagramBackup).toBeNull();
  });

  it("backs up the picked collections by name in turn", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    const job = await run(c, { url: SAVED, options: { collections: ["food", "TRIPS"] } });
    expect(job).toMatchObject({ state: "done", failedItems: 0 });
    const folder = (name: string) => dl("Saved", name);
    expect(job.files).toEqual([path.join(folder("Food"), "1.jpg"), path.join(folder("Food"), "2.jpg"), path.join(folder("Trips"), "1.jpg"), path.join(folder("Trips"), "2.jpg")]);
    expect(saved.feeds.map((u) => new URL(u).pathname)).toEqual(["/api/v1/feed/collection/103/posts/", "/api/v1/feed/collection/102/posts/"]);
  });

  it("backs up every own collection with allCollections, never All", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    expect(await run(c, { url: SAVED, options: { allCollections: true } })).toMatchObject({ state: "done" });
    expect(saved.feeds.map((u) => new URL(u).pathname)).toEqual(["/api/v1/feed/collection/102/posts/", "/api/v1/feed/collection/103/posts/"]);
    expect(readdirSync(dl("Saved")).sort()).toEqual(["Food", "Trips"]);
  });

  /** Saved whose account-name request Instagram answers "slow down". */
  function slowedName() {
    const saved = fakeSaved();
    const get = saved.deps.get!;
    saved.deps.get = (url, headers, signal) => (url.endsWith("/web_form_data/") ? Promise.resolve({ status: 429, body: "" }) : get(url, headers, signal));
    return saved;
  }

  it("ends rateLimited and holds the account when Instagram asks to slow down on the account's name", async () => {
    const saved = slowedName();
    const c = await signedIn(saved.deps);
    expect(await run(c, { url: SAVED, options: { allCollections: true } })).toMatchObject({ state: "failed", reason: "rateLimited", error: SLOW_DOWN });
    expect(c["pacer"].held()).toBe(true);
    expect(saved.feeds).toEqual([]);
    expect(c.snapshot().instagramBackup).toBeNull();
  });

  it("still shows the screen the collections it had when Instagram asks to slow down on the account's name, holding the account", async () => {
    const saved = slowedName();
    const userData = path.join(root, "user");
    mkdirSync(userData, { recursive: true });
    writeFileSync(path.join(userData, "instagram-collections.json"), JSON.stringify({ username: "sample.user", list: COLLECTIONS }));
    const c = await signedIn(saved.deps);
    expect(await c.savedCollections(true)).toEqual(COLLECTIONS);
    expect(c["pacer"].held()).toBe(true);
  });

  it("fails notFound for an unknown collection name, before starting any", async () => {
    const saved = fakeSaved();
    const c = await signedIn(saved.deps);
    expect(await run(c, { url: SAVED, options: { collections: ["Trips", "Nope"] } })).toMatchObject({ state: "failed", reason: "notFound", error: 'No collection named "Nope".' });
    expect(saved.feeds).toEqual([]);
    expect(c.snapshot().instagramBackup).toBeNull();
  });
});
