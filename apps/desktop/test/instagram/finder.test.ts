import { describe, expect, it } from "vitest";
import carousel from "../../../../packages/shared/src/instagram/fixtures/instagram-v1-carousel.json";
import highlightShare from "../../../../packages/shared/src/instagram/fixtures/instagram-highlight-share.json";
import { InstagramFinder, type PageDriver } from "../../src/main/instagram/finder";

/** A page whose documents come in steps, one per look; the last step stays. */
class FakePage implements PageDriver {
  loads: string[] = [];
  closed = false;
  looks = 0;
  /** a load that never finishes, or one that throws */
  loading: "ok" | "hangs" | "throws" = "ok";
  constructor(
    private readonly steps: string[][],
    private readonly landsOn?: string,
  ) {}
  async load(url: string) {
    this.loads.push(url);
    if (this.loading === "hangs") await new Promise(() => undefined);
    if (this.loading === "throws") throw new Error("no window");
  }
  async documents() {
    const step = this.steps[Math.min(this.looks, this.steps.length - 1)] ?? [];
    this.looks++;
    return step;
  }
  finalUrl() {
    return this.landsOn ?? this.loads[this.loads.length - 1] ?? "about:blank";
  }
  async scrollToEnd() {}
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
    const login = "https://www.instagram.com/accounts/login/?next=%2Fp%2FC1abcDEF%2F";
    expect(await finder(new FakePage([[]], login)).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "signedOut" });
    expect((await finder(new FakePage([[]], "https://www.instagram.com/challenge/xyz/")).find({ kind: "post", code: "C1abcDEF" })).type).toBe("signedOut");
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

  it("asks to sign in for a post the signed-out page hides, and for any signed-out page that shows nothing", async () => {
    const gated = '{"data":{"xig_polaris_media":{"code":"C1abcDEF","if_not_gated_logged_out":null}}}';
    expect(await finder(new FakePage([[gated]])).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "signedOut" });
    const loggedOut = '{"__type":"preloader","id":"adp_PolarisLoggedOutMediaQuery","result":{}}';
    expect(await finder(new FakePage([[loggedOut]])).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "signedOut" });
  });

  describe("signed out", () => {
    const out = (page: FakePage) => new InstagramFinder(() => page, { poll: 5, timeout: 150, signedIn: false });
    const post = { kind: "post", code: "C1abcDEF" } as const;

    it("tells a post shown only to signed-in visitors from a wall", async () => {
      const gated = '{"data":{"xig_polaris_media":{"code":"C1abcDEF","if_not_gated_logged_out":null}}}';
      expect(await out(new FakePage([[gated]])).find(post)).toEqual({ type: "signInOnly" });
    });

    it("answers nothing for a logged-out view that showed nothing in time", async () => {
      const loggedOut = '{"__type":"preloader","id":"adp_PolarisLoggedOutMediaQuery","result":{}}';
      expect(await out(new FakePage([[loggedOut]])).find(post)).toEqual({ type: "nothing" });
    });

    it("still answers signedOut for a sign-in or check page", async () => {
      expect(await out(new FakePage([[]], "https://www.instagram.com/accounts/login/?next=%2Fp%2FC1abcDEF%2F")).find(post)).toEqual({ type: "signedOut" });
      const at = "https://www.instagram.com/challenge/xyz/";
      expect(await out(new FakePage([[]], at)).find(post)).toEqual({ type: "signedOut", at });
    });

    it("reads a public post as before", async () => {
      const outcome = await out(new FakePage([[JSON.stringify(carousel)]])).find(post);
      expect(outcome.type).toBe("items");
    });
  });

  it("keeps where Instagram's check page is, for the sign-in window to open", async () => {
    const at = "https://www.instagram.com/challenge/xyz/";
    expect(await finder(new FakePage([[]], at)).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "signedOut", at });
  });

  it("gives up in time even when the page never finishes loading", async () => {
    const page = new FakePage([[]]);
    page.loading = "hangs";
    const started = Date.now();
    expect(await finder(page).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "nothing" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.closed).toBe(true);
  });

  it("answers nothing when the window can't be made", async () => {
    const page = new FakePage([[]]);
    page.loading = "throws";
    expect(await finder(page).find({ kind: "post", code: "C1abcDEF" })).toEqual({ type: "nothing" });
    expect(page.closed).toBe(true);
  });

  it("stops and closes the page when the search is called off", async () => {
    const page = new FakePage([[]]);
    const stop = new AbortController();
    const search = new InstagramFinder(() => page, { poll: 5, timeout: 60_000 }).find({ kind: "post", code: "C1abcDEF" }, stop.signal);
    setTimeout(() => stop.abort(), 30);
    const started = Date.now();
    expect(await search).toEqual({ type: "nothing" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.closed).toBe(true);
  });

  it("closes the page afterwards, found or not", async () => {
    const found = new FakePage([[JSON.stringify(carousel)]]);
    await finder(found).find({ kind: "post", code: "C1abcDEF" });
    const missing = new FakePage([[]]);
    await finder(missing).find({ kind: "post", code: "C1abcDEF" });
    expect([found.closed, missing.closed]).toEqual([true, true]);
  });
});
