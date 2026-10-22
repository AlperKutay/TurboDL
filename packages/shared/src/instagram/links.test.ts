import { describe, expect, it } from "vitest";
import { parseInstagramLink } from "./links";

const ig = (path: string) => parseInstagramLink(`https://www.instagram.com${path}`);

describe("parseInstagramLink", () => {
  it("tells posts, stories, highlights, profiles and saved pages apart", () => {
    expect(ig("/p/C1abcDEF/")).toEqual({ kind: "post", code: "C1abcDEF" });
    expect(ig("/reel/C2reel/?igsh=abc")).toEqual({ kind: "post", code: "C2reel" });
    expect(ig("/reels/C2reel/")).toEqual({ kind: "post", code: "C2reel" });
    expect(ig("/tv/C4tv/")).toEqual({ kind: "post", code: "C4tv" });
    expect(ig("/sample.user/p/C1abcDEF/")).toEqual({ kind: "post", code: "C1abcDEF" });
    expect(ig("/sample.user/reel/C2reel/")).toEqual({ kind: "post", code: "C2reel" });
    expect(ig("/stories/sample.user/4010000000000000002?utm_source=ig_story_item_share")).toEqual({
      kind: "story",
      username: "sample.user",
      item: "4010000000000000002",
    });
    expect(ig("/stories/highlights/17900000000000001/")).toEqual({ kind: "highlight", id: "17900000000000001" });
    expect(ig("/s/aGlnaGxpZ2h0OjE3OTAwMDAwMDAwMDAwMDAy?obrf=b2JyZg")).toEqual({ kind: "highlight", id: "17900000000000002" });
    expect(ig("/Sample.User/")).toEqual({ kind: "profile", username: "sample.user" });
    expect(ig("/sample_user/reels/")).toEqual({ kind: "profile", username: "sample_user" });
    expect(ig("/sample.user/tagged/")).toEqual({ kind: "profile", username: "sample.user" });
    expect(ig("/sample.user/saved/")).toEqual({ kind: "saved", username: "sample.user" });
    expect(ig("/sample.user/saved/all-posts/")).toEqual({ kind: "saved", username: "sample.user" });
    expect(parseInstagramLink("https://instagram.com/sample.user")).toEqual({ kind: "profile", username: "sample.user" });
  });

  it("leaves Instagram's own pages and other sites alone", () => {
    for (const word of ["explore", "accounts", "direct", "about", "legal", "developer", "challenge", "reels", "stories", "p"]) {
      expect(ig(`/${word}/`), word).toBeNull();
    }
    expect(ig("/")).toBeNull();
    expect(ig(`/${"a".repeat(31)}`)).toBeNull();
    expect(ig("/sample-user")).toBeNull();
    expect(parseInstagramLink("https://example.com/p/C1abcDEF/")).toBeNull();
    expect(parseInstagramLink("not a url")).toBeNull();
  });

  it("decodes share codes, padded or not, URL-safe or not", () => {
    const code = (c: string) => parseInstagramLink(`https://www.instagram.com/s/${c}`);
    expect(code("aGlnaGxpZ2h0OjE3OTAwMDAwMDAwMDAwMDAyMQ==")).toEqual({ kind: "highlight", id: "179000000000000021" });
    expect(code("aGlnaGxpZ2h0OjE3OTAwMDAwMDAwMDAwMDAyMQ")).toEqual({ kind: "highlight", id: "179000000000000021" });
    expect(code("cmVlbDoxNzkwMDAwMDAwMDAwMDAwMg==")).toBeNull();
    expect(code("not-base64!")).toBeNull();
    expect(code("aGlnaGxpZ2h0Og")).toBeNull();
  });
});
