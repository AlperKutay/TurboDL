import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SavedError, type InstagramItem, type InstagramPostInfo, type InstagramProfile, type PostDetails, type SavedPost } from "@turbodl/shared";
import type { AppController, InstagramDeps } from "../../src/main/controller";
import type { PostListOptions } from "../../src/main/instagram/profile-service";
import { FakeUi, SESSION, startApp } from "../fixtures/instagram-app";
import { PUBLIC_PROFILE, fakeProfiles, fakeSignedOut, signedOutCover, type DetailedPage } from "../fixtures/instagram-fakes";

const SLOW_DOWN = "Instagram asked TurboDL to slow down. Try again in a few minutes.";
const DONE = { type: "done", signInOnly: 0, empty: 0 };
const PAGES_CHANGED = { type: "refused", reason: "error", error: "TurboDL couldn't read 3 posts in a row from their pages; Instagram may have changed them, or is slow." };
const STALLED = { type: "refused", reason: "error", error: "Instagram kept answering the same posts; TurboDL stopped the list." };

let root: string;
let controller: AppController | null;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-posts-"));
  controller = null;
});
afterEach(async () => {
  await controller?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function start(instagram: InstagramDeps): Promise<AppController> {
  controller = await startApp(root, new FakeUi(), instagram);
  return controller;
}

async function signedIn(instagram: InstagramDeps): Promise<AppController> {
  const c = await start(instagram);
  c.instagramSession.take(SESSION);
  return c;
}

/** A profile's posts listed through the app's profile service: what it sent, and how the list ended. */
async function list(c: AppController, o: Partial<Omit<PostListOptions, "onPost">> = {}, username = "sample.user") {
  const posts: InstagramPostInfo[] = [];
  const outcome = await c["profiles"].listPosts(username, { signal: new AbortController().signal, ...o, onPost: (post) => posts.push(post) });
  return { posts, outcome, codes: posts.map((p) => p.code) };
}

/** Unix seconds at midnight UTC on that day of October 2026, and the same as ISO 8601. */
const day = (d: number) => Date.UTC(2026, 9, d) / 1000;
const iso = (d: number) => new Date(day(d) * 1000).toISOString();
const postUrl = (code: string) => `https://www.instagram.com/p/${code}/`;

/** Items as the finder reads them, with the fields a list leaves out (`thumbnail`, `owner`). */
const photo = (code: string): InstagramItem => ({ kind: "image", url: `https://cdn.example/${code}.jpg`, width: 1080, height: 1350, thumbnail: `https://cdn.example/${code}_320.jpg`, mediaId: `${code}-1`, owner: "sample.user" });
const clip = (code: string): InstagramItem => ({ kind: "video", url: `https://cdn.example/${code}.mp4`, width: 720, height: 1280, duration: 12.5, thumbnail: `https://cdn.example/${code}.jpg`, mediaId: `${code}-1`, owner: "sample.user" });
/** The same items as a list sends them. */
const sentPhoto = (code: string) => ({ kind: "image", url: `https://cdn.example/${code}.jpg`, mediaId: `${code}-1`, width: 1080, height: 1350 });
const sentClip = (code: string) => ({ kind: "video", url: `https://cdn.example/${code}.mp4`, mediaId: `${code}-1`, width: 720, height: 1280, duration: 12.5 });

/** A post's own page, signed out: one photo (or `items`), taken on that day, by sample.user unless the details say. */
const shown = (code: string, d: number, details: Partial<PostDetails> = {}, items: InstagramItem[] = [photo(code)]): DetailedPage => ({
  items,
  details: { takenAt: day(d), owner: "sample.user", taggedUsers: [], ...details },
});
/** A signed-out listing page: the posts' covers. */
const covers = (...codes: string[]): SavedPost[] => codes.map((code) => signedOutCover(`id-${code}`, code));
/** Post pages for these codes, taken on these days. */
const pagesOn = (days: Record<string, number>): Record<string, DetailedPage> => Object.fromEntries(Object.entries(days).map(([code, d]) => [code, shown(code, d)]));

/** sample.user as a signed-in visitor sees it. */
const person = (o: Partial<InstagramProfile> = {}): InstagramProfile => ({ id: "5100000000000000001", username: "sample.user", fullName: "Sample User", isPrivate: false, following: true, postCount: 5, ...o });
/** A post as a signed-in feed lists it: its items and details come along. */
const feedPost = (code: string, d: number, o: Partial<SavedPost> = {}): SavedPost => ({ id: `id-${code}`, code, cover: `https://cdn.example/${code}.jpg`, items: [photo(code)], takenAt: day(d), taggedUsers: [], ...o });
const feed = (pages: SavedPost[][], profile = person()) => fakeProfiles({ "sample.user": { profile, pages } });

/** A signed-in feed whose pages are `pages[cursor]` ("" for the first), cursors as given; it gives up after 10 pages. */
function cursored(pages: Record<string, { posts: SavedPost[]; next?: string }>) {
  const ig = feed([]);
  const open = ig.deps.openProfile!;
  ig.deps.openProfile = (username, cookies) => {
    const source = open(username, cookies);
    return {
      ...source,
      page: async (cursor, signal) => {
        await source.page(cursor, signal);
        if (ig.asked.length > 10) throw new Error("Asked too many pages.");
        return pages[cursor ?? ""] ?? { posts: [] };
      },
    };
  };
  return ig;
}

/** The post pages the app asks the finder for, by code. */
function postPagesRead(deps: InstagramDeps): string[] {
  const read: string[] = [];
  const find = deps.find;
  deps.find = (link, cookies, signal) => {
    if (link.kind === "post") read.push(link.code);
    return find(link, cookies, signal);
  };
  return read;
}

/** The same fake's finder answering `outcome` for one post's page (the page is still read). */
function answering(deps: InstagramDeps, code: string, outcome: "signInOnly" | "signedOut"): void {
  const find = deps.find;
  deps.find = async (link, cookies, signal) => {
    const found = await find(link, cookies, signal);
    return link.kind === "post" && link.code === code ? { type: outcome } : found;
  };
}

describe("ProfileService.listPosts", () => {
  it("lists a signed-out profile's posts newest first with their details and items", async () => {
    const so = fakeSignedOut(
      {
        C1: shown("C1", 20, { caption: "First light", taggedUsers: ["friend.one", "friend.two"] }),
        C2: shown("C2", 15, {}, [clip("C2")]),
        C3: shown("C3", 10, { owner: "partner.user" }, [photo("C3a"), photo("C3b")]),
      },
      { listing: [covers("C1", "C2"), covers("C3")] },
    );
    const c = await start(so.deps);
    const { posts, outcome } = await list(c);
    expect(outcome).toEqual(DONE);
    expect(posts).toEqual([
      { code: "C1", url: postUrl("C1"), takenAt: "2026-10-20T00:00:00.000Z", pinned: false, owner: "sample.user", caption: "First light", taggedUsers: ["friend.one", "friend.two"], items: [sentPhoto("C1")] },
      { code: "C2", url: postUrl("C2"), takenAt: "2026-10-15T00:00:00.000Z", pinned: false, owner: "sample.user", taggedUsers: [], items: [sentClip("C2")] },
      { code: "C3", url: postUrl("C3"), takenAt: "2026-10-10T00:00:00.000Z", pinned: false, owner: "partner.user", taggedUsers: [], items: [sentPhoto("C3a"), sentPhoto("C3b")] },
    ]);
    expect(so.read).toEqual(["C1", "C2", "C3"]);
    expect(so.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
  });

  it("ends at the first old unpinned post after the first 3 and doesn't read it", async () => {
    // signed in, the feed carries every post's time: nothing is read to find the old one; C3 holds the 3rd place
    const ig = feed([[feedPost("C1", 20), feedPost("C2", 15), feedPost("C3", 5)], [feedPost("C4", 4)], [feedPost("C5", 3)]]);
    const read = postPagesRead(ig.deps);
    const c = await signedIn(ig.deps);
    const { codes, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2", "C3"]);
    expect(read).toEqual([]);
    expect(ig.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
  });

  it("signed out, reads the first old post's page for its time, doesn't send it, and asks nothing after it", async () => {
    // the signed-out listing has no times: the old post's own page is the one read more (spec 5.2)
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18, C4: 5, C5: 3 }), { listing: [covers("C1", "C2", "C3"), covers("C4", "C5"), covers("C6")] });
    const c = await start(so.deps);
    const { codes, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2", "C3"]);
    expect(so.read).toEqual(["C1", "C2", "C3", "C4"]);
    expect(so.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
  });

  it("sends old pinned posts and still ends at the first old unpinned one", async () => {
    const ig = feed([[feedPost("C1", 1, { pinned: true }), feedPost("C2", 2, { pinned: true }), feedPost("C3", 20)], [feedPost("C4", 5), feedPost("C5", 4)]]);
    const read = postPagesRead(ig.deps);
    const c = await signedIn(ig.deps);
    const { posts, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(posts.map((p) => [p.code, p.pinned, p.takenAt])).toEqual([
      ["C1", true, iso(1)],
      ["C2", true, iso(2)],
      ["C3", false, iso(20)],
    ]);
    expect(read).toEqual([]);
  });

  it("without a pinned mark on the list, sends an old post among the first 3 and ends at the first old one after them", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 1, C2: 2, C3: 20, C4: 5, C5: 19 }), { listing: [covers("C1", "C2", "C3", "C4", "C5")] });
    const c = await start(so.deps);
    const { posts, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(posts.map((p) => [p.code, p.pinned])).toEqual([
      ["C1", false],
      ["C2", false],
      ["C3", false],
    ]);
    expect(so.read).toEqual(["C1", "C2", "C3", "C4"]);
  });

  it("with the feed's pinned mark, never ends at a pinned post, at any position", async () => {
    const ig = feed([[feedPost("C1", 20), feedPost("C2", 19), feedPost("C3", 18), feedPost("C4", 1, { pinned: true }), feedPost("C5", 2), feedPost("C6", 17)]]);
    const c = await signedIn(ig.deps);
    const { codes, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2", "C3", "C4"]);
  });

  it("takes the pinned mark a post's own page gives, and such a post doesn't end the list", async () => {
    // pages read with a session carry it; signed out none does
    const so = fakeSignedOut({ ...pagesOn({ C1: 20, C2: 19, C3: 18, C5: 2 }), C4: shown("C4", 1, { pinned: true }) }, { listing: [covers("C1", "C2", "C3", "C4", "C5")] });
    const c = await start(so.deps);
    const { posts, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(posts.map((p) => [p.code, p.pinned])).toEqual([
      ["C1", false],
      ["C2", false],
      ["C3", false],
      ["C4", true],
    ]);
    expect(so.read).toEqual(["C1", "C2", "C3", "C4", "C5"]);
  });

  it("signed in too, sends an old unmarked post among the first 3 and ends at the first old one after them", async () => {
    // the feed's pinned mark may be missing: the first 3 places are spared, marked or not
    const ig = feed([[feedPost("C1", 1), feedPost("C2", 20), feedPost("C3", 2), feedPost("C4", 3), feedPost("C5", 19)]]);
    const c = await signedIn(ig.deps);
    const { posts, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(posts.map((p) => [p.code, p.pinned])).toEqual([
      ["C1", false],
      ["C2", false],
      ["C3", false],
    ]);
  });

  it("sends a profile topped by 3 old posts with nothing new, and ends at the next old one, asking no further page", async () => {
    // signed out: no pinned mark, so the first 3 may be pinned; the 4th old post ends the list
    const so = fakeSignedOut(pagesOn({ C1: 1, C2: 2, C3: 3, C4: 4, C5: 5 }), { listing: [covers("C1", "C2", "C3"), covers("C4", "C5"), covers("C6")] });
    const c = await start(so.deps);
    const { codes, outcome } = await list(c, { since: day(10) });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2", "C3"]);
    expect(so.read).toEqual(["C1", "C2", "C3", "C4"]);
    expect(so.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
    // signed in, the same profile with its pinned posts marked
    const ig = feed([[feedPost("C1", 1, { pinned: true }), feedPost("C2", 2, { pinned: true }), feedPost("C3", 3, { pinned: true })], [feedPost("C4", 4)], [feedPost("C5", 5)]]);
    await controller?.shutdown();
    const signed = await signedIn(ig.deps);
    expect(await list(signed, { since: day(10) })).toMatchObject({ codes: ["C1", "C2", "C3"], outcome: DONE });
    expect(ig.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
  });

  it("ends with an error when the listing cursor stops moving", async () => {
    const ig = cursored({ "": { posts: [feedPost("C1", 20)], next: "a" }, a: { posts: [feedPost("C2", 19)], next: "a" } });
    const c = await signedIn(ig.deps);
    const { codes, outcome } = await list(c);
    expect(outcome).toEqual(STALLED);
    expect(codes).toEqual(["C1", "C2"]);
    expect(ig.asked.map((a) => a.cursor)).toEqual([undefined, "a"]);
    expect(ig.closed).toEqual(["sample.user"]);
  });

  it("ends with an error when a next page brings no new posts", async () => {
    const ig = cursored({
      "": { posts: [feedPost("C1", 20), feedPost("C2", 19)], next: "a" },
      a: { posts: [feedPost("C2", 19), feedPost("C1", 20)], next: "b" },
      b: { posts: [feedPost("C3", 18)] },
    });
    const c = await signedIn(ig.deps);
    const { codes, outcome } = await list(c);
    expect(outcome).toEqual(STALLED);
    expect(codes).toEqual(["C1", "C2"]);
    expect(ig.asked.map((a) => a.cursor)).toEqual([undefined, "a"]);
  });

  it("ends done at an empty last page", async () => {
    const ig = cursored({ "": { posts: [feedPost("C1", 20)], next: "a" }, a: { posts: [] } });
    const c = await signedIn(ig.deps);
    expect(await list(c)).toMatchObject({ codes: ["C1"], outcome: DONE });
  });

  it("skips a post code it already took", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C1", "C2"), covers("C2", "C3")] });
    const c = await start(so.deps);
    const { codes, outcome } = await list(c, { known: new Set(["C2"]) });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2", "C3"]);
    expect(so.read).toEqual(["C1", "C3"]);
  });

  it("sends known posts as stubs without reading their pages, and they don't end the list", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    const c = await start(so.deps);
    const { posts, outcome } = await list(c, { known: new Set(["C1", "C2"]) });
    expect(outcome).toEqual(DONE);
    const stub = (code: string) => ({ code, url: postUrl(code), takenAt: null, pinned: false, owner: "sample.user", taggedUsers: [], known: true, items: [] });
    expect(posts).toEqual([stub("C1"), stub("C2"), { code: "C3", url: postUrl("C3"), takenAt: iso(18), pinned: false, owner: "sample.user", taggedUsers: [], items: [sentPhoto("C3")] }]);
    expect(so.read).toEqual(["C3"]);
  });

  it("with known and since, the stubs never end the list and the first unknown old post after position 3 does", async () => {
    const so = fakeSignedOut(pagesOn({ C5: 5, C6: 20 }), { listing: [covers("C1", "C2", "C3", "C4", "C5", "C6")] });
    const c = await start(so.deps);
    const { posts, outcome } = await list(c, { since: day(10), known: new Set(["C1", "C2", "C3", "C4"]) });
    expect(outcome).toEqual(DONE);
    expect(posts.map((p) => [p.code, p.known])).toEqual([
      ["C1", true],
      ["C2", true],
      ["C3", true],
      ["C4", true],
    ]);
    expect(so.read).toEqual(["C5"]);
  });

  it("keeps the feed's pinned mark on a known stub", async () => {
    const ig = feed([[feedPost("C1", 1, { pinned: true }), feedPost("C2", 20)]]);
    const c = await signedIn(ig.deps);
    const { posts } = await list(c, { known: new Set(["C1"]) });
    expect(posts[0]).toEqual({ code: "C1", url: postUrl("C1"), takenAt: null, pinned: true, owner: "sample.user", taggedUsers: [], known: true, items: [] });
  });

  it("stops after limit posts", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18, C4: 17, C5: 16 }), { listing: [covers("C1", "C2"), covers("C3", "C4", "C5")] });
    const c = await start(so.deps);
    const { codes, outcome } = await list(c, { limit: 2 });
    expect(outcome).toEqual(DONE);
    expect(codes).toEqual(["C1", "C2"]);
    expect(so.read).toEqual(["C1", "C2"]);
    // the next listing page isn't asked for either
    expect(so.asked).toHaveLength(1);
  });

  it("counts known stubs and pinned posts towards the limit", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    const c = await start(so.deps);
    expect(await list(c, { limit: 2, known: new Set(["C1"]) })).toMatchObject({ codes: ["C1", "C2"], outcome: DONE });
    expect(so.read).toEqual(["C2"]);
    const ig = feed([[feedPost("C1", 1, { pinned: true }), feedPost("C2", 20), feedPost("C3", 19)]]);
    await controller?.shutdown();
    expect(await list(await signedIn(ig.deps), { limit: 2 })).toMatchObject({ codes: ["C1", "C2"], outcome: DONE });
  });

  it("sends a post shown only to signed-in visitors without items and counts it", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    answering(so.deps, "C2", "signInOnly");
    const c = await start(so.deps);
    const { posts, outcome } = await list(c);
    expect(outcome).toEqual({ type: "done", signInOnly: 1, empty: 0 });
    expect(posts.map((p) => p.code)).toEqual(["C1", "C2", "C3"]);
    expect(posts[1]).toEqual({ code: "C2", url: postUrl("C2"), takenAt: null, pinned: false, owner: "sample.user", taggedUsers: [], signInOnly: true, items: [] });
  });

  it("skips a post whose page shows nothing twice and counts it", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    const c = await start(so.deps);
    const { codes, outcome } = await list(c);
    expect(outcome).toEqual({ type: "done", signInOnly: 0, empty: 1 });
    expect(codes).toEqual(["C1", "C3"]);
    expect(so.read).toEqual(["C1", "C2", "C2", "C3"]);
  });

  it("reads a page that showed nothing once more, in the read slot, and sends the post when it shows then", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    // C2's page is slow the first time
    const reads: number[] = [];
    const find = so.deps.find;
    so.deps.find = async (link, cookies, signal) => {
      const found = await find(link, cookies, signal);
      if (link.kind !== "post" || link.code !== "C2") return found;
      reads.push(so.deps.now!());
      return reads.length === 1 ? { type: "nothing" } : found;
    };
    const c = await start(so.deps);
    expect(await list(c)).toMatchObject({ codes: ["C1", "C2", "C3"], outcome: DONE });
    expect(so.read).toEqual(["C1", "C2", "C2", "C3"]);
    expect(reads[1] - reads[0]).toBeGreaterThanOrEqual(3000);
    expect(reads[1] - reads[0]).toBeLessThanOrEqual(6000);
  });

  it("counts a post whose page shows nothing towards neither the limit nor the pinned places", async () => {
    // C1 shows nothing: C2–C4 take the first 3 places, so the old C5 ends the list
    const so = fakeSignedOut(pagesOn({ C2: 1, C3: 2, C4: 3, C5: 4, C6: 20 }), { listing: [covers("C1", "C2", "C3", "C4", "C5", "C6")] });
    const c = await start(so.deps);
    expect(await list(c, { since: day(10) })).toMatchObject({ codes: ["C2", "C3", "C4"], outcome: { type: "done", signInOnly: 0, empty: 1 } });
    expect(so.read).toEqual(["C1", "C1", "C2", "C3", "C4", "C5"]);
    expect(await list(c, { limit: 2 })).toMatchObject({ codes: ["C2", "C3"], outcome: { type: "done", signInOnly: 0, empty: 1 } });
  });

  /** A post's own page with its items but no time. */
  const timeless = (code: string): DetailedPage => ({ items: [photo(code)], details: { owner: "sample.user", taggedUsers: [] } });

  it("ends with an error after 3 post pages in a row show nothing or carry no time", async () => {
    // C2 and C4 show nothing, C3 has no time
    const so = fakeSignedOut({ ...pagesOn({ C1: 20, C5: 18, C6: 17 }), C3: timeless("C3") }, { listing: [covers("C1", "C2", "C3"), covers("C4", "C5", "C6")] });
    const c = await start(so.deps);
    const { posts, outcome } = await list(c);
    expect(outcome).toEqual(PAGES_CHANGED);
    expect(posts.map((p) => [p.code, p.takenAt])).toEqual([
      ["C1", iso(20)],
      ["C3", null],
    ]);
    expect(so.read).toEqual(["C1", "C2", "C2", "C3", "C4", "C4"]);
    expect(so.closed).toEqual(["sample.user"]);
  });

  it("a post with a time resets the guard", async () => {
    const so = fakeSignedOut({ ...pagesOn({ C3: 20, C6: 18 }), C5: timeless("C5") }, { listing: [covers("C1", "C2", "C3", "C4", "C5", "C6")] });
    const c = await start(so.deps);
    expect(await list(c)).toMatchObject({ codes: ["C3", "C5", "C6"], outcome: { type: "done", signInOnly: 0, empty: 3 } });
    // each empty post is read twice, and counts once
    expect(so.read).toEqual(["C1", "C1", "C2", "C2", "C3", "C4", "C4", "C5", "C6"]);
  });

  it("counts neither known stubs nor posts shown only to signed-in visitors for the guard, nor lets them reset it", async () => {
    const so = fakeSignedOut(pagesOn({ C2: 20, C6: 18 }), { listing: [covers("C1", "C2", "C3", "C4", "C5", "C6", "C7")] });
    answering(so.deps, "C2", "signInOnly");
    const c = await start(so.deps);
    // C1 shows nothing, C2 is sign-in only, C3 known, C4 and C5 show nothing: the third read without a time is C5
    const { codes, outcome } = await list(c, { known: new Set(["C3"]) });
    expect(outcome).toEqual(PAGES_CHANGED);
    expect(codes).toEqual(["C2", "C3"]);
    expect(so.read).toEqual(["C1", "C1", "C2", "C4", "C4", "C5", "C5"]);
  });

  it("ends rateLimited on the login wall mid-list, keeping what it sent, and holds the pacer", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    answering(so.deps, "C2", "signedOut");
    const c = await start(so.deps);
    const { codes, outcome } = await list(c);
    expect(outcome).toEqual({ type: "refused", reason: "rateLimited", error: SLOW_DOWN });
    expect(codes).toEqual(["C1"]);
    expect(so.read).toEqual(["C1", "C2"]);
    expect(c["pacer"].held()).toBe(true);
    expect(so.closed).toEqual(["sample.user"]);
  });

  it("ends rateLimited and holds the pacer when the profile's page lands on the login wall signed out", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20 }));
    const open = so.deps.openProfile!;
    so.deps.openProfile = (username, cookies) => ({ ...open(username, cookies), profile: () => Promise.reject(new SavedError("signedOut")) });
    const c = await start(so.deps);
    expect(await list(c)).toMatchObject({ codes: [], outcome: { type: "refused", reason: "rateLimited", error: SLOW_DOWN } });
    expect(c["pacer"].held()).toBe(true);
    expect(so.closed).toEqual(["sample.user"]);
  });

  it("ends rateLimited when Instagram asks to slow down on a next page, holding the account", async () => {
    const ig = feed([[feedPost("C1", 20)], [feedPost("C2", 19)]]);
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => {
      const source = open(username, cookies);
      return { ...source, page: (cursor, signal) => (cursor ? Promise.reject(new SavedError("rateLimited")) : source.page(cursor, signal)) };
    };
    const c = await signedIn(ig.deps);
    expect(await list(c)).toMatchObject({ codes: ["C1"], outcome: { type: "refused", reason: "rateLimited", error: SLOW_DOWN } });
    expect(c["pacer"].held()).toBe(true);
  });

  it("asks nothing while Instagram's slow-down holds", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20 }));
    const c = await start(so.deps);
    c["pacer"].hold();
    expect(await list(c)).toMatchObject({ codes: [], outcome: { type: "refused", reason: "rateLimited", error: SLOW_DOWN } });
    expect(so.opened).toEqual([]);
    expect(so.read).toEqual([]);
  });

  it("refuses a private profile", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20 }), { profile: { ...PUBLIC_PROFILE, isPrivate: true } });
    const c = await start(so.deps);
    expect(await list(c)).toMatchObject({ codes: [], outcome: { type: "refused", reason: "private", error: "This account is private." } });
    expect(so.asked).toEqual([]);
    expect(so.read).toEqual([]);
    expect(so.closed).toEqual(["sample.user"]);
  });

  it("ends with an error, not notFound, for a profile Instagram doesn't show (it may only have been slow)", async () => {
    const ig = fakeProfiles({});
    const c = await start(ig.deps);
    const { outcome } = await list(c, {}, "Nobody.Here");
    expect(outcome).toEqual({ type: "refused", reason: "error", error: "Instagram didn't show the profile Nobody.Here; it may not exist, or the page was too slow." });
    expect(ig.closed).toEqual(["nobody.here"]);
  });

  it("answers signInRequired when Instagram signed the session out", async () => {
    const ig = feed([[feedPost("C1", 20)]]);
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => ({ ...open(username, cookies), profile: () => Promise.reject(new SavedError("signedOut")) });
    const c = await signedIn(ig.deps);
    expect((await list(c)).outcome).toEqual({ type: "refused", reason: "signInRequired", error: "Sign in to Instagram again." });
    expect(c["pacer"].held()).toBe(false);
  });

  it("uses the feed's items and details signed in, reading no post page", async () => {
    const ig = feed([[feedPost("C1", 20, { pinned: true, caption: "Pinned hello", taggedUsers: ["friend.one"], items: [photo("C1"), clip("C1v")] })], [feedPost("C2", 15)]]);
    const read = postPagesRead(ig.deps);
    const c = await signedIn(ig.deps);
    const { posts, outcome } = await list(c);
    expect(outcome).toEqual(DONE);
    expect(posts).toEqual([
      { code: "C1", url: postUrl("C1"), takenAt: iso(20), pinned: true, owner: "sample.user", caption: "Pinned hello", taggedUsers: ["friend.one"], items: [sentPhoto("C1"), sentClip("C1v")] },
      { code: "C2", url: postUrl("C2"), takenAt: iso(15), pinned: false, owner: "sample.user", taggedUsers: [], items: [sentPhoto("C2")] },
    ]);
    expect(read).toEqual([]);
    expect(ig.asked.map((a) => a.cursor)).toEqual([undefined, "1"]);
  });

  it("stops at once when cancelled, asking nothing more", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2"), covers("C3")] });
    const c = await start(so.deps);
    const calledOff = new AbortController();
    const posts: InstagramPostInfo[] = [];
    const outcome = await c["profiles"].listPosts("sample.user", {
      signal: calledOff.signal,
      // a stub would need no request: it isn't sent either
      known: new Set(["C2"]),
      onPost: (post) => {
        posts.push(post);
        calledOff.abort();
      },
    });
    expect(outcome).toEqual({ type: "cancelled" });
    expect(posts.map((p) => p.code)).toEqual(["C1"]);
    expect(so.read).toEqual(["C1"]);
    expect(so.asked).toHaveLength(1);
    expect(so.closed).toEqual(["sample.user"]);
  });

  it("stops when cancelled while the next page waits for the read slot", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19 }), { listing: [covers("C1", "C2")] });
    const calledOff = new AbortController();
    const posts: InstagramPostInfo[] = [];
    const wait = so.deps.wait!;
    so.deps.wait = (ms, signal) => {
      // the gap before post 2's page: the client goes away meanwhile
      if (posts.length > 0) calledOff.abort();
      return wait(ms, signal);
    };
    const c = await start(so.deps);
    const outcome = await c["profiles"].listPosts("sample.user", { signal: calledOff.signal, onPost: (post) => posts.push(post) });
    expect(outcome).toEqual({ type: "cancelled" });
    expect(so.read).toEqual(["C1"]);
  });

  it("opens no page when called off before it starts", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20 }));
    const c = await start(so.deps);
    const calledOff = new AbortController();
    calledOff.abort();
    expect(await c["profiles"].listPosts("sample.user", { signal: calledOff.signal, onPost: () => undefined })).toEqual({ type: "cancelled" });
    expect(so.opened).toEqual([]);
  });

  it("closes its own page when it ends and leaves the screen's open profile alone", async () => {
    const ig = feed([[feedPost("C1", 20), feedPost("C2", 19)]]);
    const c = await signedIn(ig.deps);
    expect((await c.profileLoad("sample.user")).type).toBe("profile");
    expect(await list(c)).toMatchObject({ codes: ["C1", "C2"], outcome: DONE });
    expect(ig.opened).toEqual(["sample.user", "sample.user"]);
    expect(ig.closed).toEqual(["sample.user"]);
    expect((await c.profilePage("sample.user")).type).toBe("page");
  });

  it("reads its pages one at a time in the shared read slot, 3–6 s apart", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2"), covers("C3")] });
    // the profile's page, C1, C2, the listing's next page, C3
    const reads: number[] = [];
    const open = so.deps.openProfile!;
    so.deps.openProfile = (username, cookies) => {
      reads.push(so.deps.now!());
      return open(username, cookies);
    };
    const find = so.deps.find;
    so.deps.find = (link, cookies, signal) => {
      reads.push(so.deps.now!());
      return find(link, cookies, signal);
    };
    const c = await start(so.deps);
    expect((await list(c)).outcome).toEqual(DONE);
    const next = so.asked.filter((a) => a.cursor !== undefined).map((a) => a.at);
    expect(next).toHaveLength(1);
    const all = [...reads, ...next].sort((x, y) => x - y);
    expect(all).toHaveLength(5);
    for (const k of [1, 2, 3, 4]) {
      expect(all[k] - all[k - 1]).toBeGreaterThanOrEqual(3000);
      expect(all[k] - all[k - 1]).toBeLessThanOrEqual(6000);
    }
  });

  it("reads each post's page in the read slot when a profile is seen signed out with a session", async () => {
    const so = fakeSignedOut(pagesOn({ C1: 20, C2: 19, C3: 18 }), { listing: [covers("C1", "C2", "C3")] });
    const reads: number[] = [];
    const find = so.deps.find;
    so.deps.find = (link, cookies, signal) => {
      reads.push(so.deps.now!());
      return find(link, cookies, signal);
    };
    const c = await signedIn(so.deps);
    expect(await list(c)).toMatchObject({ codes: ["C1", "C2", "C3"], outcome: DONE });
    for (const k of [1, 2]) expect(reads[k] - reads[k - 1]).toBeGreaterThanOrEqual(3000);
  });

  it("loads its profile's page in the read slot signed in too", async () => {
    const ig = feed([[feedPost("C1", 20)]]);
    const opened: number[] = [];
    const open = ig.deps.openProfile!;
    ig.deps.openProfile = (username, cookies) => {
      opened.push(ig.deps.now!());
      return open(username, cookies);
    };
    const c = await signedIn(ig.deps);
    await list(c);
    await list(c);
    expect(opened).toHaveLength(2);
    expect(opened[1] - opened[0]).toBeGreaterThanOrEqual(3000);
    expect(opened[1] - opened[0]).toBeLessThanOrEqual(6000);
  });
});

describe("ProfileService.readPostInfo", () => {
  const signal = () => new AbortController().signal;

  it("reads one post link with its details", async () => {
    const so = fakeSignedOut({ C9: shown("C9", 12, { caption: "Solo", taggedUsers: ["friend.one"], owner: "someone" }, [clip("C9")]) });
    const c = await start(so.deps);
    expect(await c["profiles"].readPostInfo("C9", signal())).toEqual({
      code: "C9",
      url: postUrl("C9"),
      takenAt: iso(12),
      pinned: false,
      owner: "someone",
      caption: "Solo",
      taggedUsers: ["friend.one"],
      items: [sentClip("C9")],
    });
    expect(so.read).toEqual(["C9"]);
  });

  it("keeps the page's pinned mark, and answers signInOnly or null for a post it can't show", async () => {
    const so = fakeSignedOut({ C8: shown("C8", 12, { pinned: true }), C7: shown("C7", 11) });
    answering(so.deps, "C7", "signInOnly");
    const c = await start(so.deps);
    expect(await c["profiles"].readPostInfo("C8", signal())).toMatchObject({ code: "C8", pinned: true });
    expect(await c["profiles"].readPostInfo("C7", signal())).toBe("signInOnly");
    expect(await c["profiles"].readPostInfo("C6", signal())).toBeNull();
  });

  it("throws rateLimited and holds the pacer when the post's page lands on the login wall", async () => {
    const so = fakeSignedOut({ C9: shown("C9", 12) });
    answering(so.deps, "C9", "signedOut");
    const c = await start(so.deps);
    await expect(c["profiles"].readPostInfo("C9", signal())).rejects.toMatchObject({ kind: "rateLimited" });
    expect(c["pacer"].held()).toBe(true);
  });
});
