import { describe, expect, it } from "vitest";
import { parseDocument } from "./json";
import { postItems, storyItems } from "./media";
import carousel from "./fixtures/instagram-v1-carousel.json";
import graphSidecar from "./fixtures/instagram-graph-sidecar.json";
import highlightShare from "./fixtures/instagram-highlight-share.json";
import reel from "./fixtures/instagram-v1-reel.json";
import storyReel from "./fixtures/instagram-story-reel.json";

const doc = (value: unknown) => JSON.stringify(value);
const file = (url: string) => url.split("/").pop()?.split("?")[0];

describe("postItems", () => {
  it("reads a carousel in order, best versions with previews", () => {
    const found = postItems([doc(carousel)], "C1abcDEF");
    expect(found.map((i) => i.kind)).toEqual(["image", "video", "image"]);
    expect(file(found[0].url)).toBe("photo1_1080.jpg");
    expect([found[0].width, found[0].height]).toEqual([1080, 1350]);
    expect(file(found[1].url)).toBe("video2_720.mp4");
    expect([found[1].width, found[1].height]).toEqual([720, 1280]);
    expect(found[1].duration).toBe(12.5);
    expect(file(found[1].thumbnail ?? "")).toBe("video2_cover.jpg");
    expect(file(found[2].url)).toBe("photo3_1080.jpg");
    // Previews use the smallest version that is still at least 320 wide.
    expect(file(found[0].thumbnail ?? "")).toBe("photo1_640.jpg");
    expect(file(found[2].thumbnail ?? "")).toBe("photo3_320.jpg");
  });

  it("takes the post once even when the page sends it twice", () => {
    expect(postItems([doc(carousel), doc(carousel)], "C1abcDEF")).toHaveLength(3);
  });

  it("picks a reel's best version", () => {
    const found = postItems([doc(reel)], "C2reel");
    expect(found).toHaveLength(1);
    expect(file(found[0].url)).toBe("reel_1080.mp4");
    expect(found[0].height).toBe(1920);
    expect(found[0].duration).toBe(30);
  });

  it("reads the older GraphQL shape", () => {
    const found = postItems([doc(graphSidecar)], "C3graph");
    expect(found.map((i) => i.kind)).toEqual(["image", "video"]);
    expect(file(found[0].url)).toBe("child1_1080.jpg");
    expect(found[0].width).toBe(1080);
    expect(file(found[1].url)).toBe("child2.mp4");
    expect(found[1].height).toBe(1280);
  });

  it("only counts the post in the address", () => {
    expect(postItems([doc(carousel)], "ZZZ")).toEqual([]);
  });
});

describe("storyItems", () => {
  it("finds a story's reel and marks the shared item", () => {
    const found = storyItems([doc(storyReel)], { kind: "story", username: "someone", item: "4010000000000000002" });
    expect(found.map((i) => i.kind)).toEqual(["video", "image"]);
    expect(found.map((i) => i.shared ?? false)).toEqual([false, true]);
    expect(file(found[0].url)).toBe("story_one.mp4");
    expect([found[0].width, found[0].height]).toEqual([640, 1136]);
    expect(found[0].duration).toBe(20);
    expect(file(found[1].url)).toBe("story_two_1080.jpg");
  });

  it("finds a highlight in reels_media and in the connection a share link's page uses", () => {
    expect(storyItems([doc(storyReel)], { kind: "highlight", id: "17900000000000001" }).map((i) => file(i.url))).toEqual([
      "highlight_one_1080.jpg",
    ]);
    const summer = storyItems([doc(highlightShare)], { kind: "highlight", id: "17900000000000002" });
    expect(summer.map((i) => i.kind)).toEqual(["video", "image"]);
    expect(file(summer[0].url)).toBe("summer_one.mp4");
    expect(summer[0].duration).toBe(9.5);
    expect(storyItems([doc(highlightShare)], { kind: "highlight", id: "17900000000000003" }).map((i) => file(i.url))).toEqual([
      "winter_one_1080.jpg",
    ]);
  });

  it("keeps each story's pk", () => {
    const found = storyItems([doc(highlightShare)], { kind: "highlight", id: "17900000000000002" });
    expect(found.map((i) => i.mediaId)).toEqual(["3900000000000000011", "3900000000000000012"]);
  });

  it("finds nothing before the data arrives", () => {
    expect(storyItems([], { kind: "story", username: "someone", item: "4010000000000000002" })).toEqual([]);
  });
});

describe("parseDocument", () => {
  it("reads guarded JSON and one value per line", () => {
    expect(parseDocument('for (;;);{"a":1}')).toEqual({ a: 1 });
    expect(parseDocument('while(1);{"a":2}')).toEqual({ a: 2 });
    expect(parseDocument('{"a":1}\n{"b":2}')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseDocument("<html>")).toBeNull();
  });
});
