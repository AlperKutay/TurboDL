import { describe, expect, it } from "vitest";
import collectionPage from "./fixtures/instagram-collection-page.json?raw";
import collections1 from "./fixtures/instagram-collections-1.json?raw";
import collections2 from "./fixtures/instagram-collections-2.json?raw";
import savedPageFixture from "./fixtures/instagram-saved-page.json?raw";
import { SavedError, savedCollections, savedPage, savedPost, savedUsername } from "./saved";

/** The SavedError a call throws, or undefined. */
function failure(call: () => unknown): Pick<SavedError, "kind" | "status"> | undefined {
  try {
    call();
  } catch (err) {
    if (err instanceof SavedError) return { kind: err.kind, status: err.status };
    throw err;
  }
  return undefined;
}

describe("saved feeds", () => {
  it("reads All's posts in order with each item's id, and the next page's cursor", () => {
    const page = savedPage(savedPageFixture, 200);
    expect(page.posts.map((p) => p.id)).toEqual(["3700000000000000001", "3700000000000000002", "3700000000000000003"]);
    expect(page.posts.map((p) => p.code)).toEqual(["DS1post", "DS2reel", "DS3photo"]);
    expect(page.posts[0].items.map((i) => i.mediaId)).toEqual(["3700000000000000011", "3700000000000000012"]);
    // a single photo or video goes by the post's own id
    expect(page.posts[1].items.map((i) => i.mediaId)).toEqual(["3700000000000000002"]);
    expect(page.posts.every((p) => p.cover)).toBe(true);
    expect(page.next).toBe("QVFE+/next=page_2");
  });

  it("gives a collection's numeric pk the same id as All's string one, and no cursor on the last page", () => {
    const page = savedPage(collectionPage, 200);
    expect(page.posts.map((p) => p.id)).toEqual(["3700000000000000002", "3700000000000000004"]);
    expect(page.posts[0].items[0].mediaId).toBe("3700000000000000002");
    expect(page.next).toBeUndefined();
  });

  it("carries a post's caption and tagged users from its v1 node", () => {
    const media = {
      pk: "3700000000000000009",
      code: "DS9tags",
      taken_at: 1790000000,
      caption: { text: "Saved hello" },
      usertags: { in: [{ user: { username: "friend_one" } }, { user: { username: "friend_two" } }] },
      image_versions2: { candidates: [{ url: "https://cdn.example/s9.jpg", width: 1080, height: 1080 }] },
    };
    expect(savedPost(media)).toMatchObject({ takenAt: 1790000000, caption: "Saved hello", taggedUsers: ["friend_one", "friend_two"] });
  });

  it("keeps a carousel's photo and video children apart", () => {
    expect(savedPage(savedPageFixture, 200).posts[0].items.map((i) => i.kind)).toEqual(["image", "video"]);
  });

  it("classifies Instagram pushing back, first rule first", () => {
    const answer = (fields: object) => JSON.stringify({ status: "fail", ...fields });
    expect(failure(() => savedPage("", 429))).toEqual({ kind: "rateLimited", status: undefined });
    expect(failure(() => savedPage(answer({ message: "Please wait a few minutes before you try again.", require_login: true }), 400))?.kind).toBe("rateLimited");
    expect(failure(() => savedPage(answer({ message: "feedback_required" }), 400))?.kind).toBe("rateLimited");
    expect(failure(() => savedPage(answer({ spam: true }), 200))?.kind).toBe("rateLimited");
    expect(failure(() => savedPage(answer({}), 401))?.kind).toBe("signedOut");
    expect(failure(() => savedPage(answer({}), 403))?.kind).toBe("signedOut");
    expect(failure(() => savedPage(answer({ require_login: true }), 400))?.kind).toBe("signedOut");
    expect(failure(() => savedPage(answer({ message: "login_required" }), 400))?.kind).toBe("signedOut");
    expect(failure(() => savedPage("<!DOCTYPE html><html>Log in</html>", 200))?.kind).toBe("signedOut");
    expect(failure(() => savedPage("oops", 500))).toEqual({ kind: "http", status: 500 });
    expect(failure(() => savedPage(answer({ message: "something else" }), 200))?.kind).toBe("badAnswer");
  });

  it("reads the account's username from the edit-profile form", () => {
    expect(savedUsername(JSON.stringify({ form_data: { username: "sample.user" }, status: "ok" }), 200)).toBe("sample.user");
    expect(failure(() => savedUsername(JSON.stringify({ form_data: { username: "" }, status: "ok" }), 200))?.kind).toBe("badAnswer");
  });
});

describe("saved collections", () => {
  it("lists All first, then the owner's collections, without audio or repeats, across the page's documents", () => {
    const found = savedCollections([collections1, collections2]);
    expect(found.list.map((c) => [c.id, c.name, c.count, c.isAll])).toEqual([
      ["100", "All posts", 40, true],
      ["102", "Trips", 12, false],
      ["103", "Recipes", undefined, false],
      ["104", "Music", 3, false],
    ]);
    expect(found.list[0].cover).toContain("all_320.jpg");
    expect(found.list[1].cover).toContain("trips_");
    expect(found.hasMore).toBe(false);
    expect(savedCollections([collections1]).hasMore).toBe(true);
  });

  it("keeps a saved post's time, caption and tagged users", () => {
    const page = savedPage(savedPageFixture, 200);
    expect(page.posts[0].takenAt).toBe(1790000000);
    expect(page.posts.every((p) => Array.isArray(p.taggedUsers))).toBe(true);
    expect(page.posts[0].taggedUsers).toEqual([]);
  });
});
