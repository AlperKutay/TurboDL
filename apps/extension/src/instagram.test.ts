import { describe, expect, it } from "vitest";
import { INSTAGRAM_PAGES, instagramTarget } from "./instagram";

/** A Chrome match pattern's path part as a regular expression ("*" is anything). */
const matches = (address: string) =>
  INSTAGRAM_PAGES.some((pattern) => {
    const [, host, path] = /^https:\/\/([^/]+)(\/.*)$/.exec(pattern) ?? [];
    const u = new URL(address);
    return u.host === host && new RegExp(`^${path.replace(/[.?]/g, "\\$&").replace(/\*/g, ".*")}$`).test(u.pathname + u.search);
  });

describe("Open in TurboDL on Instagram", () => {
  it("shows on posts, reels, stories and highlights only", () => {
    for (const page of [
      "https://www.instagram.com/p/C1abcDEF/",
      "https://www.instagram.com/reel/C1abcDEF/",
      "https://www.instagram.com/reels/C1abcDEF/",
      "https://www.instagram.com/tv/C1abcDEF/",
      "https://www.instagram.com/sample.user/p/C1abcDEF/",
      "https://www.instagram.com/sample.user/reel/C1abcDEF/",
      "https://www.instagram.com/stories/sample.user/3100000000000000001/",
      "https://www.instagram.com/stories/highlights/17900000000000003/",
      "https://www.instagram.com/s/aGlnaGxpZ2h0OjE3OTAwMDAwMDAwMDAwMDAz",
      "https://instagram.com/p/C1abcDEF/",
    ]) {
      expect(matches(page), page).toBe(true);
    }
    for (const page of ["https://www.instagram.com/", "https://www.instagram.com/sample.user/", "https://www.instagram.com/explore/", "https://www.instagram.com/direct/inbox/"]) {
      expect(matches(page), page).toBe(false);
    }
  });

  it("shows on the owner's saved pages too, which open Saved", () => {
    expect(matches("https://www.instagram.com/sample.user/saved/")).toBe(true);
    expect(matches("https://www.instagram.com/sample.user/saved/trips/17800000000000001/")).toBe(true);
    expect(instagramTarget("https://www.instagram.com/sample.user/saved/")).toBe("https://www.instagram.com/sample.user/saved/");
  });

  it("opens the post a right-clicked picture links to, otherwise the page itself", () => {
    const page = "https://www.instagram.com/p/C1abcDEF/";
    expect(instagramTarget(page, "https://www.instagram.com/p/C2other/")).toBe("https://www.instagram.com/p/C2other/");
    expect(instagramTarget(page, "https://www.instagram.com/sample.user/")).toBe(page);
    expect(instagramTarget(page, "https://example.com/")).toBe(page);
    expect(instagramTarget(page)).toBe(page);
  });
});
