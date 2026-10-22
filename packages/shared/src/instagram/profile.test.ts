import { describe, expect, it } from "vitest";
import lockedPage from "./fixtures/instagram-profile-locked.json?raw";
import nextAnswer from "./fixtures/instagram-profile-next.json?raw";
import profilePage from "./fixtures/instagram-profile-page.json?raw";
import { highlightsTray, isLocked, profileIn, profilePosts, profilePostsAnswer, signedOutProfileView } from "./profile";
import { SavedError } from "./saved";

/** The page's documents, each its own JSON text (the fixture is an array of them). */
const page = JSON.parse(profilePage) as string[];
const locked = JSON.parse(lockedPage) as string[];

function failure(call: () => unknown): string | undefined {
  try {
    call();
  } catch (err) {
    if (err instanceof SavedError) return err.kind;
    throw err;
  }
  return undefined;
}

describe("profile pages", () => {
  it("reads the shared profile from its page", () => {
    expect(profileIn(page, "sample.user")).toEqual({
      id: "5100000000000000001",
      username: "sample.user",
      fullName: "Sample User",
      isPrivate: false,
      following: false,
      picture: "https://cdn.example/sample.jpg",
      postCount: 30,
    });
    expect(profileIn(page, "Sample.User")?.id).toBe("5100000000000000001");
  });

  it("never takes the signed-in account or a suggested one for the profile", () => {
    expect(profileIn(page, "viewer.account")).toBeUndefined();
    expect(profileIn(page, "other.user")?.postCount).toBeUndefined();
    expect(profileIn(page, "nobody")).toBeUndefined();
  });

  it("reads the posts of every connection in order, each once, the cursor from the last", () => {
    const posts = profilePosts(page);
    expect(posts?.posts.map((p) => p.code)).toEqual(["C0001", "C0002", "C0003", "C0004"]);
    expect(posts?.posts.map((p) => p.pinned ?? false)).toEqual([true, false, false, false]);
    expect(posts?.posts[1].items[0].kind).toBe("video");
    expect([posts?.cursor, posts?.hasNext]).toEqual(["cursor-2", true]);
  });

  it("leaves the home feed out", () => {
    const home = page.filter((d) => d.includes("xdt_api__v1__feed__timeline__connection"));
    expect(home).toHaveLength(1);
    expect(profilePosts(home)).toBeUndefined();
  });

  it("reads a re-sent posts answer the same way, and Instagram pushing back on it", () => {
    const next = profilePostsAnswer(nextAnswer, 200);
    expect(next.posts.map((p) => p.code)).toEqual(["C0005", "C0006"]);
    expect([next.cursor, next.hasNext]).toEqual([undefined, false]);
    expect(failure(() => profilePostsAnswer("", 429))).toBe("rateLimited");
    expect(failure(() => profilePostsAnswer("<html>Log in</html>", 200))).toBe("signedOut");
    expect(failure(() => profilePostsAnswer('{"data":{}}', 200))).toBe("badAnswer");
  });

  it("reads the highlights tray in its order, and nothing while the page hasn't sent it", () => {
    expect(highlightsTray(page)).toEqual([
      { id: "17900000000000002", title: "Summer", cover: "https://cdn.example/hl02.jpg" },
      { id: "17900000000000003", title: "Winter", cover: expect.stringContaining("https://cdn.example/") },
    ]);
    expect(highlightsTray(page.slice(0, 3))).toBeUndefined();
  });

  it("knows a private profile it doesn't follow, and shows none of its posts", () => {
    const profile = profileIn(locked, "sample.user");
    expect(profile && isLocked(profile)).toBe(true);
    expect(profilePosts(locked)?.posts).toEqual([]);
  });

  it("knows the profile as Instagram shows it to everyone", () => {
    const everyone = JSON.stringify({ data: { xig_user_by_igid_v2: { username: "sample.user", pk: "5100000000000000001" } } });
    expect(signedOutProfileView([everyone], "sample.user")).toBe(true);
    expect(signedOutProfileView(page, "sample.user")).toBe(false);
  });
});
