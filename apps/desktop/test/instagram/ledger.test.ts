import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SavedPost } from "@turbodl/shared";
import { LedgerStore, allowsEarlyStop, isDone } from "../../src/main/instagram/ledger";

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
    ledgers.save("102", { saved: ["11", "12"], failedPosts: ["2"], reachedEnd: true });
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12"], failedPosts: ["2"], reachedEnd: true });
  });

  it("starts empty when there is no ledger yet, or it can't be read", () => {
    const ledgers = store();
    expect(ledgers.load("103")).toEqual({ saved: [], failedPosts: [], reachedEnd: false });
    ledgers.save("104", { saved: [], failedPosts: [], reachedEnd: false });
    writeFileSync(path.join(folder, "instagram-backups", "104.json"), "{not json");
    expect(ledgers.load("104")).toEqual({ saved: [], failedPosts: [], reachedEnd: false });
  });

  it("names the file safely whatever the id holds", () => {
    const ledgers = store();
    ledgers.save("a/b:c", { saved: ["1"], failedPosts: [], reachedEnd: false });
    expect(existsSync(path.join(folder, "instagram-backups", "a_b_c.json"))).toBe(true);
    ledgers.remove("a/b:c");
    expect(ledgers.load("a/b:c").saved).toEqual([]);
  });
});

describe("the ledger's rules", () => {
  it("stops early only after a complete pass that left nothing failed", () => {
    expect(allowsEarlyStop({ saved: [], failedPosts: [], reachedEnd: true })).toBe(true);
    expect(allowsEarlyStop({ saved: [], failedPosts: [], reachedEnd: false })).toBe(false);
    expect(allowsEarlyStop({ saved: [], failedPosts: ["1"], reachedEnd: true })).toBe(false);
  });

  it("counts a post done when every one of its items is saved", () => {
    const post: SavedPost = { id: "1", items: [{ kind: "image", url: "https://x/1.jpg", mediaId: "11" }, { kind: "video", url: "https://x/2.mp4", mediaId: "12" }] };
    expect(isDone({ saved: ["11"], failedPosts: [], reachedEnd: false }, post)).toBe(false);
    expect(isDone({ saved: ["11", "12"], failedPosts: [], reachedEnd: false }, post)).toBe(true);
  });
});
