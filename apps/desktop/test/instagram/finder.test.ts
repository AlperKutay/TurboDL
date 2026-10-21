import { describe, expect, it } from "vitest";
import carousel from "../../../../packages/shared/src/instagram/fixtures/instagram-v1-carousel.json";
import highlightShare from "../../../../packages/shared/src/instagram/fixtures/instagram-highlight-share.json";
import { InstagramFinder, type PageDriver } from "../../src/main/instagram/finder";

/** A page whose documents come in steps, one per look; the last step stays. */
class FakePage implements PageDriver {
  loads: string[] = [];
  closed = false;
  looks = 0;
  constructor(
    private readonly steps: string[][],
    private readonly landsOn?: string,
  ) {}
  async load(url: string) {
    this.loads.push(url);
  }
  async documents() {
    const step = this.steps[Math.min(this.looks, this.steps.length - 1)] ?? [];
    this.looks++;
    return step;
  }
  finalUrl() {
    return this.landsOn ?? this.loads[this.loads.length - 1] ?? "about:blank";
  }
  close() {
    this.closed = true;
  }
}

const finder = (page: FakePage, report?: (url: string, documents: string[]) => void) =>
  new InstagramFinder(() => page, { poll: 5, timeout: 150, report });

describe("InstagramFinder", () => {
  it("reads a post from its page", async () => {
    const page = new FakePage([[JSON.stringify(carousel)]]);
    const outcome = await finder(page).find({ kind: "post", code: "C1abcDEF" });
    expect(outcome.type).toBe("items");
    expect(outcome.type === "items" && outcome.items).toHaveLength(3);
    expect(page.loads).toEqual(["https://www.instagram.com/p/C1abcDEF/"]);
  });

  it("waits for the page's documents", async () => {
    const page = new FakePage([[], [], [JSON.stringify(carousel)]]);
    const outcome = await finder(page).find({ kind: "post", code: "C1abcDEF" });
    expect(outcome.type === "items" && outcome.items.length).toBe(3);
    expect(page.looks).toBe(3);
  });

  it("answers sign-in for Instagram's sign-in and check pages", async () => {
    for (const landing of ["https://www.instagram.com/accounts/login/?next=%2Fp%2FC1abcDEF%2F", "https://www.instagram.com/challenge/xyz/"]) {
      expect(await finder(new FakePage([[]], landing)).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "signedOut" });
    }
  });

  it("answers nothing when the page shows nothing in time, and reports what it saw", async () => {
    const seen: string[] = [];
    const outcome = await finder(new FakePage([['{"unrelated":true}']]), (url) => seen.push(url)).find({ kind: "post", code: "C1abcDEF" });
    expect(outcome).toEqual({ type: "nothing" });
    expect(seen).toEqual(["https://www.instagram.com/p/C1abcDEF/"]);
  });

  it("reads a highlight from its own page", async () => {
    const page = new FakePage([[JSON.stringify(highlightShare)]]);
    const outcome = await finder(page).find({ kind: "highlight", id: "17900000000000003" });
    expect(page.loads).toEqual(["https://www.instagram.com/stories/highlights/17900000000000003/"]);
    expect(outcome.type === "items" && outcome.items.map((i) => i.url.split("/").pop())).toEqual(["winter_one_1080.jpg"]);
  });

  it("closes the page afterwards, found or not", async () => {
    const found = new FakePage([[JSON.stringify(carousel)]]);
    await finder(found).find({ kind: "post", code: "C1abcDEF" });
    const missing = new FakePage([[]]);
    await finder(missing).find({ kind: "post", code: "C1abcDEF" });
    expect([found.closed, missing.closed]).toEqual([true, true]);
  });
});
