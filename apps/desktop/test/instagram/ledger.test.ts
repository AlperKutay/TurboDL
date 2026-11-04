import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SavedPost } from "@turbodl/shared";
import { LedgerStore, allowsEarlyStop, postDone, wantedItems, type BackupLedger } from "../../src/main/instagram/ledger";

const EMPTY: BackupLedger = { saved: [], failedPosts: [], signInPosts: [], done: { image: [], video: [] }, reachedEnd: { image: false, video: false } };
const BOTH = ["image", "video"] as const;
/** done marks for both kinds */
const doneSets = (image: string[], video: string[] = image) => ({ image: new Set(image), video: new Set(video) });

let folder = "";
afterEach(() => {
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = "";
});
const store = () => {
  folder = mkdtempSync(path.join(os.tmpdir(), "turbodl-ledger-"));
  return new LedgerStore(path.join(folder, "instagram-backups"));
};

describe("LedgerStore", () => {
  it("keeps what a backup saved, between runs", () => {
    const ledgers = store();
    const ledger: BackupLedger = { saved: ["11", "12"], failedPosts: ["2"], signInPosts: ["3"], done: { image: ["1", "4"], video: ["1"] }, reachedEnd: { image: true, video: false } };
    ledgers.save("102", ledger);
    expect(ledgers.load("102")).toEqual(ledger);
  });

  it("starts empty when there is no ledger yet, or it can't be read", () => {
    const ledgers = store();
    expect(ledgers.load("103")).toEqual(EMPTY);
    ledgers.save("104", EMPTY);
    writeFileSync(path.join(folder, "instagram-backups", "104.json"), "{not json");
    expect(ledgers.load("104")).toEqual(EMPTY);
  });

  it("reads a ledger written before posts were remembered by their id: none done or shown only signed in", () => {
    const ledgers = store();
    ledgers.save("105", EMPTY);
    writeFileSync(path.join(folder, "instagram-backups", "105.json"), JSON.stringify({ saved: ["11"], failedPosts: ["2"], reachedEnd: true }));
    expect(ledgers.load("105")).toEqual({ saved: ["11"], failedPosts: ["2"], signInPosts: [], done: { image: [], video: [] }, reachedEnd: { image: true, video: true } });
  });

  it("reads a ledger written before kinds were kept: its marks count for photos and videos", () => {
    const ledgers = store();
    ledgers.save("106", EMPTY);
    const file = path.join(folder, "instagram-backups", "106.json");
    writeFileSync(file, JSON.stringify({ saved: ["11"], donePosts: ["p1"], reachedEnd: true, failedPosts: [], signInPosts: [] }));
    const ledger = ledgers.load("106");
    expect(ledger).toEqual({ saved: ["11"], failedPosts: [], signInPosts: [], done: { image: ["p1"], video: ["p1"] }, reachedEnd: { image: true, video: true } });
    // one that never reached the end reached it for neither kind
    writeFileSync(file, JSON.stringify({ saved: ["11"], donePosts: ["p1"], reachedEnd: false, failedPosts: [], signInPosts: [] }));
    expect(ledgers.load("106").reachedEnd).toEqual({ image: false, video: false });
    // written back, it has only the new shape
    ledgers.save("106", ledger);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8"))).sort()).toEqual(["done", "failedPosts", "reachedEnd", "saved", "signInPosts"]);
  });

  it("names the file safely whatever the id holds", () => {
    const ledgers = store();
    ledgers.save("a/b:c", { ...EMPTY, saved: ["1"] });
    expect(existsSync(path.join(folder, "instagram-backups", "a_b_c.json"))).toBe(true);
    ledgers.remove("a/b:c");
    expect(ledgers.load("a/b:c").saved).toEqual([]);
  });
});

describe("the ledger's rules", () => {
  it("stops early only after a complete pass that left nothing failed", () => {
    const end = { image: true, video: true };
    expect(allowsEarlyStop({ ...EMPTY, reachedEnd: end }, BOTH)).toBe(true);
    expect(allowsEarlyStop({ ...EMPTY }, BOTH)).toBe(false);
    expect(allowsEarlyStop({ ...EMPTY, failedPosts: ["1"], reachedEnd: end }, BOTH)).toBe(false);
    // a post only signed-in visitors see isn't a failure
    expect(allowsEarlyStop({ ...EMPTY, signInPosts: ["1"], reachedEnd: end }, BOTH)).toBe(true);
  });

  it("stops early for the kinds asked only after a complete pass with each of them", () => {
    const photos = { ...EMPTY, reachedEnd: { image: true, video: false } };
    expect(allowsEarlyStop(photos, ["image"])).toBe(true);
    expect(allowsEarlyStop(photos, ["video"])).toBe(false);
    expect(allowsEarlyStop(photos, BOTH)).toBe(false);
  });

  it("counts a post done when every one of its items is saved", () => {
    const post: SavedPost = { id: "1", items: [{ kind: "image", url: "https://x/1.jpg", mediaId: "11" }, { kind: "video", url: "https://x/2.mp4", mediaId: "12" }] };
    expect(postDone(post, BOTH, doneSets([]), new Set(["11"]))).toBe(false);
    expect(postDone(post, BOTH, doneSets([]), new Set(["11", "12"]))).toBe(true);
    // a single photo without an id of its own is saved under the post's
    const single: SavedPost = { id: "5", items: [{ kind: "image", url: "https://x/5.jpg" }] };
    expect(postDone(single, BOTH, doneSets([]), new Set(["5"]))).toBe(true);
  });

  it("counts a post done by its id, before its items are read", () => {
    const cover: SavedPost = { id: "9", code: "C9", items: [], unread: true };
    expect(postDone(cover, BOTH, doneSets(["9"]), new Set())).toBe(true);
    expect(postDone(cover, BOTH, doneSets(["8"]), new Set())).toBe(false);
    // nothing to save is never done by its items
    expect(postDone(cover, BOTH, doneSets([]), new Set(["9"]))).toBe(false);
  });

  it("keeps only the items of the kinds asked", () => {
    const photo = { kind: "image" as const, url: "https://x/1.jpg", mediaId: "11" };
    const clip = { kind: "video" as const, url: "https://x/2.mp4", mediaId: "12" };
    const post: SavedPost = { id: "1", items: [photo, clip] };
    expect(wantedItems(post, ["image"])).toEqual([photo]);
    expect(wantedItems(post, ["video"])).toEqual([clip]);
    expect(wantedItems(post, BOTH)).toEqual([photo, clip]);
  });

  it("counts a post done for the kinds asked: by its id for each of them, or by their items", () => {
    const post: SavedPost = { id: "1", items: [{ kind: "image", url: "https://x/1.jpg", mediaId: "11" }, { kind: "video", url: "https://x/2.mp4", mediaId: "12" }] };
    // done for photos only: a run asking for videos too isn't done with it
    expect(postDone(post, ["image"], doneSets(["1"], []), new Set())).toBe(true);
    expect(postDone(post, BOTH, doneSets(["1"], []), new Set())).toBe(false);
    expect(postDone(post, ["video"], doneSets(["1"], []), new Set())).toBe(false);
    // the photo saved is all a photos-only run needs
    expect(postDone(post, ["image"], doneSets([]), new Set(["11"]))).toBe(true);
    expect(postDone(post, ["video"], doneSets([]), new Set(["11"]))).toBe(false);
    // none of the kinds asked: nothing to save, done
    const reel: SavedPost = { id: "2", items: [{ kind: "video", url: "https://x/2.mp4" }] };
    expect(postDone(reel, ["image"], doneSets([]), new Set())).toBe(true);
    // a post with no items at all still never is
    expect(postDone({ id: "3", items: [] }, ["image"], doneSets([]), new Set())).toBe(false);
  });
});
