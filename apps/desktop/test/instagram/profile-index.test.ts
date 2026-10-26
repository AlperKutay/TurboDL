import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstagramProfile } from "@turbodl/shared";
import { LedgerStore } from "../../src/main/instagram/ledger";
import { ProfileIndex } from "../../src/main/instagram/profile-index";

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

const person = (id: string, username: string): InstagramProfile => ({ id, username, fullName: `Name ${username}`, isPrivate: false, following: true, picture: `https://cdn.example/${id}.jpg`, postCount: 9 });

function setup() {
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-profiles-"));
  const ledgers = new LedgerStore(path.join(root, "instagram-backups"));
  return { ledgers, index: new ProfileIndex(path.join(root, "instagram-profiles.json"), ledgers) };
}

describe("ProfileIndex", () => {
  it("lists backed-up profiles newest run first, with what their backups saved", () => {
    const { ledgers, index } = setup();
    index.record(person("51", "first.one"), 1000);
    index.record(person("52", "second.one"), 2000);
    ledgers.save("profile-51", { saved: ["a", "b"], failedPosts: [], reachedEnd: true, donePosts: [], signInPosts: [] });
    ledgers.save("highlights-51", { saved: ["c"], failedPosts: [], reachedEnd: true, donePosts: [], signInPosts: [] });
    expect(index.list()).toEqual([
      { id: "52", username: "second.one", fullName: "Name second.one", picture: "https://cdn.example/52.jpg", lastRun: 2000, saved: 0 },
      { id: "51", username: "first.one", fullName: "Name first.one", picture: "https://cdn.example/51.jpg", lastRun: 1000, saved: 3 },
    ]);
  });

  it("keeps one entry per account, with its latest name and run", () => {
    const { index } = setup();
    index.record(person("51", "old.name"), 1000);
    index.record(person("51", "new.name"), 3000);
    expect(index.list().map((e) => [e.username, e.lastRun])).toEqual([["new.name", 3000]]);
  });

  it("forgets a profile and what its backups saved, and nothing else", () => {
    const { ledgers, index } = setup();
    index.record(person("51", "first.one"), 1000);
    index.record(person("52", "second.one"), 2000);
    ledgers.save("profile-51", { saved: ["a"], failedPosts: [], reachedEnd: true, donePosts: [], signInPosts: [] });
    ledgers.save("highlights-51", { saved: ["c"], failedPosts: [], reachedEnd: true, donePosts: [], signInPosts: [] });
    ledgers.save("profile-52", { saved: ["z"], failedPosts: [], reachedEnd: true, donePosts: [], signInPosts: [] });
    index.remove("51");
    expect(index.list().map((e) => e.id)).toEqual(["52"]);
    expect([ledgers.load("profile-51").saved, ledgers.load("highlights-51").saved, ledgers.load("profile-52").saved]).toEqual([[], [], ["z"]]);
  });
});
