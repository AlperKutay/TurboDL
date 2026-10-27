import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SavedPost } from "@turbodl/shared";
import { LedgerStore, allowsEarlyStop, postDone, type BackupLedger } from "../../src/main/instagram/ledger";

const EMPTY: BackupLedger = { saved: [], failedPosts: [], reachedEnd: false, donePosts: [], signInPosts: [] };

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
    ledgers.save("102", { saved: ["11", "12"], failedPosts: ["2"], reachedEnd: true, donePosts: ["1"], signInPosts: ["3"] });
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12"], failedPosts: ["2"], reachedEnd: true, donePosts: ["1"], signInPosts: ["3"] });
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
    expect(ledgers.load("105")).toEqual({ saved: ["11"], failedPosts: ["2"], reachedEnd: true, donePosts: [], signInPosts: [] });
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
    expect(allowsEarlyStop({ ...EMPTY, reachedEnd: true })).toBe(true);
    expect(allowsEarlyStop({ ...EMPTY, reachedEnd: false })).toBe(false);
    expect(allowsEarlyStop({ ...EMPTY, failedPosts: ["1"], reachedEnd: true })).toBe(false);
    // a post only signed-in visitors see isn't a failure
    expect(allowsEarlyStop({ ...EMPTY, signInPosts: ["1"], reachedEnd: true })).toBe(true);
  });

  it("counts a post done when every one of its items is saved", () => {
    const post: SavedPost = { id: "1", items: [{ kind: "image", url: "https://x/1.jpg", mediaId: "11" }, { kind: "video", url: "https://x/2.mp4", mediaId: "12" }] };
    expect(postDone(post, new Set(), new Set(["11"]))).toBe(false);
    expect(postDone(post, new Set(), new Set(["11", "12"]))).toBe(true);
    // a single photo without an id of its own is saved under the post's
    const single: SavedPost = { id: "5", items: [{ kind: "image", url: "https://x/5.jpg" }] };
    expect(postDone(single, new Set(), new Set(["5"]))).toBe(true);
  });

  it("counts a post done by its id, before its items are read", () => {
    const cover: SavedPost = { id: "9", code: "C9", items: [], unread: true };
    expect(postDone(cover, new Set(["9"]), new Set())).toBe(true);
    expect(postDone(cover, new Set(["8"]), new Set())).toBe(false);
    // nothing to save is never done by its items
    expect(postDone(cover, new Set(), new Set(["9"]))).toBe(false);
  });
});
