import { describe, expect, it } from "vitest";
import nextAnswer from "../../../../packages/shared/src/instagram/fixtures/instagram-profile-next.json?raw";
import profilePage from "../../../../packages/shared/src/instagram/fixtures/instagram-profile-page.json?raw";
import { SavedError } from "@turbodl/shared";
import { ProfileFeed, type ProfileDriver } from "../../src/main/instagram/profile-feed";

const DOCUMENTS = JSON.parse(profilePage) as string[];
const WITHOUT_TRAY = DOCUMENTS.filter((d) => !d.includes('"highlights"'));

/** A profile page whose documents come in steps, one per look (the last stays), and whose re-sends answer in turn. */
class FakeProfilePage implements ProfileDriver {
  loads: string[] = [];
  looks = 0;
  scrolls = 0;
  stopped = false;
  closed = false;
  constructor(
    private readonly steps: string[][],
    private readonly resends: ({ status: number; text: string } | null)[] = [],
    private readonly landsOn?: string,
  ) {}
  async load(url: string) {
    this.loads.push(url);
  }
  async documents() {
    return this.steps[Math.min(this.looks++, this.steps.length - 1)] ?? [];
  }
  finalUrl() {
    return this.landsOn ?? this.loads[0] ?? "about:blank";
  }
  async scrollToEnd() {
    this.scrolls++;
  }
  async resend() {
    return this.resends.length > 1 ? (this.resends.shift() ?? null) : (this.resends[0] ?? null);
  }
  stopCollecting() {
    this.stopped = true;
  }
  close() {
    this.closed = true;
  }
}

const feed = (page: FakeProfilePage, o: { firstLoad?: number; trayWait?: number; requestWait?: number } = {}) =>
  new ProfileFeed(page, "sample.user", { poll: 5, firstLoad: 2000, trayWait: 200, requestWait: 200, ...o });

async function failure(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (err) {
    if (err instanceof SavedError) return err.kind;
    throw err;
  }
  return undefined;
}

describe("ProfileFeed", () => {
  it("reads the profile and the posts its page loaded, then keeps no more of the page's answers", async () => {
    const page = new FakeProfilePage([DOCUMENTS]);
    const f = feed(page);
    expect((await f.profile()).id).toBe("5100000000000000001");
    const first = await f.page();
    expect(first.posts.map((p) => p.code)).toEqual(["C0001", "C0002", "C0003", "C0004"]);
    expect(first.next).toBe("cursor-2");
    expect(page.loads).toEqual(["https://www.instagram.com/sample.user/"]);
    expect(page.stopped).toBe(true);
  });

  it("waits a little for the highlights tray once the profile and posts are in", async () => {
    const f = feed(new FakeProfilePage([WITHOUT_TRAY, DOCUMENTS]));
    await f.profile();
    expect(f.highlights.map((h) => h.title)).toEqual(["Summer", "Winter"]);
  });

  it("goes on without the tray when it doesn't come", async () => {
    const f = feed(new FakeProfilePage([WITHOUT_TRAY]), { trayWait: 50 });
    expect((await f.profile()).username).toBe("sample.user");
    expect(f.highlights).toEqual([]);
  });

  it("answers signed out for Instagram's sign-in page and for the page everyone sees", async () => {
    expect(await failure(feed(new FakeProfilePage([[]], [], "https://www.instagram.com/accounts/login/?next=x")).profile())).toBe("signedOut");
    const everyone = JSON.stringify({ data: { xig_user_by_igid_v2: { username: "sample.user" } } });
    expect(await failure(feed(new FakeProfilePage([[everyone]])).profile())).toBe("signedOut");
  });

  it("gives up when the page never shows the profile", async () => {
    expect(await failure(feed(new FakeProfilePage([[]]), { firstLoad: 100 }).profile())).toBe("badAnswer");
  });

  it("reads the next posts by sending the page's own request again", async () => {
    const f = feed(new FakeProfilePage([DOCUMENTS], [{ status: 200, text: nextAnswer }]));
    await f.profile();
    const next = await f.page("cursor-2");
    expect(next.posts.map((p) => p.code)).toEqual(["C0005", "C0006"]);
    expect(next.next).toBeUndefined();
  });

  it("scrolls once and waits for the page to make its own request first", async () => {
    const page = new FakeProfilePage([DOCUMENTS], [null, null, { status: 200, text: nextAnswer }]);
    const f = feed(page);
    await f.profile();
    expect((await f.page("cursor-2")).posts).toHaveLength(2);
    expect(page.scrolls).toBe(1);
  });

  it("says it can't read on when the page never makes a request of its own", async () => {
    const f = feed(new FakeProfilePage([DOCUMENTS], [null]), { requestWait: 100 });
    await f.profile();
    expect(await failure(f.page("cursor-2"))).toBe("badAnswer");
  });

  it("passes Instagram's push-back on a re-sent request on", async () => {
    const f = feed(new FakeProfilePage([DOCUMENTS], [{ status: 429, text: "" }]));
    await f.profile();
    expect(await failure(f.page("cursor-2"))).toBe("rateLimited");
  });

  it("loads the page once however often the profile is asked for", async () => {
    const page = new FakeProfilePage([DOCUMENTS]);
    const f = feed(page);
    await Promise.all([f.profile(), f.profile()]);
    await f.profile();
    expect(page.loads).toHaveLength(1);
  });
});
