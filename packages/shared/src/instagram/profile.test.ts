import { describe, expect, it } from "vitest";
import lockedPage from "./fixtures/instagram-profile-locked.json?raw";
import loggedOutPage from "./fixtures/instagram-profile-loggedout.json?raw";
import nextAnswer from "./fixtures/instagram-profile-next.json?raw";
import profilePage from "./fixtures/instagram-profile-page.json?raw";
import {
  highlightsTray,
  isLocked,
  pageLsd,
  profileIn,
  profilePosts,
  profilePostsAnswer,
  relayOperationId,
  signedOutPostsAnswer,
  signedOutProfile,
  signedOutProfileView,
  signedOutTrayAnswer,
} from "./profile";
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

describe("profile pages signed out", () => {
  const page = JSON.parse(loggedOutPage) as string[];

  it("reads the profile, its first posts as covers with their kind, and its highlights", () => {
    const found = signedOutProfile(page, "Sample.User");
    expect(found?.profile).toEqual({
      id: "5100000000000000001",
      username: "sample.user",
      fullName: "Sample User",
      isPrivate: false,
      following: false,
      picture: "https://cdn.example/sample.jpg",
    });
    expect(found?.posts.map((p) => [p.id, p.code, p.cover, p.mediaType, p.unread, p.items])).toEqual([
      ["3800000000000000001", "C0001", "https://cdn.example/c0001.jpg", 8, true, []],
      ["3800000000000000002", "C0002", "https://cdn.example/c0002.jpg", 2, true, []],
      ["3800000000000000003", "C0003", "https://cdn.example/c0003.jpg", 1, true, []],
    ]);
    expect(found?.highlights).toEqual([
      { id: "17900000000000002", title: "Summer", cover: "https://cdn.example/hl02.jpg" },
      { id: "17900000000000003", title: "Winter", cover: "https://cdn.example/hl03.jpg" },
    ]);
  });

  it("says where the first page of posts and highlights ends", () => {
    const found = signedOutProfile(page, "sample.user");
    expect([found?.cursor, found?.hasNext, found?.trayCursor, found?.trayHasNext]).toEqual(["c1", true, undefined, false]);
    const end = page.map((d) => d.replace('"has_next_page": true, "end_cursor": "c1"', '"has_next_page": false, "end_cursor": null'));
    expect([signedOutProfile(end, "sample.user")?.cursor, signedOutProfile(end, "sample.user")?.hasNext]).toEqual([undefined, false]);
  });

  it("never takes a suggested account for the profile, and finds nothing on a signed-in page", () => {
    expect(signedOutProfile(page, "other.user")).toBeUndefined();
    expect(signedOutProfile(JSON.parse(profilePage) as string[], "sample.user")).toBeUndefined();
  });
});

function postsBody(count: number, next: boolean): string {
  const edges = Array.from({ length: count }, (_, i) => ({
    node: { pk: `380000000000000${100 + i}`, code: `D${100 + i}`, display_uri: `https://cdn.example/d${i}.jpg`, media_type: i % 2 ? 2 : 1, carousel_media_count: null, user: { id: "5100000000000000001", username: "sample.user" } },
  }));
  const page_info = next ? { end_cursor: "c2", has_next_page: true } : { end_cursor: null, has_next_page: false };
  return JSON.stringify({ data: { xig_user_by_username: { polaris_ordered_timeline_connection: { edges, page_info } } } });
}

describe("signed-out answers", () => {
  it("reads a posts answer: covers, the cursor, and whether more follow", () => {
    const more = signedOutPostsAnswer(postsBody(12, true), 200);
    expect(more.posts).toHaveLength(12);
    expect(more.posts[0]).toEqual({ id: "380000000000000100", code: "D100", cover: "https://cdn.example/d0.jpg", items: [], unread: true, mediaType: 1 });
    expect(more.posts[1].mediaType).toBe(2);
    expect([more.cursor, more.hasNext]).toEqual(["c2", true]);
    const last = signedOutPostsAnswer(postsBody(3, false), 200);
    expect([last.posts.length, last.cursor, last.hasNext]).toEqual([3, undefined, false]);
  });

  it("pushes back on a posts answer like the others, and calls an answer without the connection bad", () => {
    expect(failure(() => signedOutPostsAnswer("", 429))).toBe("rateLimited");
    expect(failure(() => signedOutPostsAnswer("<html>Log in</html>", 200))).toBe("signedOut");
    expect(failure(() => signedOutPostsAnswer("{}", 500))).toBe("http");
    const stale = '{"errors":[{"message":"A server error missing_required_variable_value occured."}],"data":null}';
    expect(failure(() => signedOutPostsAnswer(stale, 200))).toBe("badAnswer");
  });

  it("reads a tray answer wherever it holds the highlights connection", () => {
    const body = JSON.stringify({
      data: {
        xig_user_by_username: {
          lox_highlights_connection: {
            edges: [{ node: { id: "highlight:17900000000000009", title: "Trips", cover_media_cropped_thumbnail_url: "https://cdn.example/hl09.jpg" } }, { node: { id: "highlight:17900000000000010", title: "Food" } }],
            page_info: { has_next_page: true, end_cursor: "t2" },
          },
        },
      },
    });
    expect(signedOutTrayAnswer(body, 200)).toEqual({
      highlights: [{ id: "17900000000000009", title: "Trips", cover: "https://cdn.example/hl09.jpg" }, { id: "17900000000000010", title: "Food" }],
      cursor: "t2",
      hasNext: true,
    });
    expect(failure(() => signedOutTrayAnswer("", 429))).toBe("rateLimited");
    expect(failure(() => signedOutTrayAnswer('{"data":null,"errors":[{"message":"x"}]}', 200))).toBe("badAnswer");
  });
});

describe("what the page tells the query", () => {
  const script = (params: string, x: string) => `__d("PolarisFooQuery_instagramRelayOperation",[],(function(${params}){${x}.exports="25773221932354322"}),null);`;

  it("finds the operation id whatever the parameter and variable names", () => {
    expect(relayOperationId(script("t,n,r,o,a,i", "a"), "PolarisFooQuery")).toBe("25773221932354322");
    expect(relayOperationId(`x;${script("a,b,c,d,e,f", "e")}y`, "PolarisFooQuery")).toBe("25773221932354322");
    expect(relayOperationId(script("t,n,r,o,a,i", "a"), "PolarisBarQuery")).toBeUndefined();
    expect(relayOperationId(script("t,n,r,o,a,i", "a"), "Foo")).toBeUndefined();
  });

  it("finds the lsd token", () => {
    expect(pageLsd('..."LSD",[],{"token":"AVq-abc_123"},323...')).toBe("AVq-abc_123");
    expect(pageLsd("<html></html>")).toBeUndefined();
  });
});
