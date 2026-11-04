import { describe, expect, it } from "vitest";
import graphql from "./fixtures/instagram-tagged-graphql.json?raw";
import rest from "./fixtures/instagram-tagged-rest.json?raw";
import profilePage from "./fixtures/instagram-profile-page.json?raw";
import { taggedAnswer, taggedPosts } from "./tagged";
import { SavedError } from "./saved";

describe("taggedPosts", () => {
  it("reads a usertags connection by its shape", () => {
    const found = taggedPosts([graphql]);
    expect(found?.posts.map((p) => [p.id, p.code])).toEqual([
      ["3400000000000000001", "T1carOUS"],
      ["3400000000000000002", "T2vidEO"],
    ]);
    expect(found?.posts[0].items.map((i) => i.kind)).toEqual(["image", "video"]);
    expect(found).toMatchObject({ cursor: "QVFDtagged-next", hasNext: true });
  });

  it("reads the REST feed from the usertags address's answers, with next_max_id as the cursor", () => {
    const found = taggedPosts([], [rest]);
    expect(found?.posts.map((p) => p.code)).toEqual(["T1carOUS", "T2vidEO"]);
    expect(found).toMatchObject({ cursor: "3400000000000000002_501", hasNext: true });
  });

  it("ignores a REST feed that didn't come from the usertags address (the account's own feeds look the same)", () => {
    expect(taggedPosts([rest])).toBeUndefined();
    expect(taggedPosts([rest], [])).toBeUndefined();
    // a usertags connection is read wherever it is
    expect(taggedPosts([rest, graphql])?.cursor).toBe("QVFDtagged-next");
  });

  it("takes a numeric next_max_id and needs a cursor for more", () => {
    expect(taggedPosts([], ['{"items":[],"more_available":true,"next_max_id":12345}'])).toMatchObject({ cursor: "12345", hasNext: true });
    expect(taggedPosts([], ['{"items":[],"more_available":true}'])).toEqual({ posts: [], hasNext: false });
    expect(taggedPosts([], ['{"items":[],"more_available":false,"next_max_id":"x"}'])?.hasNext).toBe(false);
  });

  it("is undefined for the profile's own timeline", () => {
    expect(taggedPosts([profilePage])).toBeUndefined();
  });
});

describe("taggedAnswer", () => {
  it("reads either answer", () => {
    expect(taggedAnswer(graphql, 200).posts).toHaveLength(2);
    expect(taggedAnswer(rest, 200).cursor).toBe("3400000000000000002_501");
  });

  it("throws as profilePostsAnswer does", () => {
    expect(() => taggedAnswer('{"status":"fail","message":"Please wait a few minutes"}', 429)).toThrowError(expect.objectContaining({ kind: "rateLimited" }));
    expect(() => taggedAnswer("<html>login</html>", 200)).toThrowError(expect.objectContaining({ kind: "signedOut" }));
    expect(() => taggedAnswer('{"data":{}}', 200)).toThrowError(expect.objectContaining({ kind: "badAnswer" }));
    expect(() => taggedAnswer('{"data":{}}', 200)).toThrowError(SavedError);
  });
});
