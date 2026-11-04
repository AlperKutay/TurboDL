import { describe, expect, it } from "vitest";
import taggedGraphql from "../../../../packages/shared/src/instagram/fixtures/instagram-tagged-graphql.json";
import taggedRest from "../../../../packages/shared/src/instagram/fixtures/instagram-tagged-rest.json";
import { SavedError } from "@turbodl/shared";
import { TaggedFeed, type TaggedDriver } from "../../src/main/instagram/tagged-feed";

const GRAPHQL = JSON.stringify(taggedGraphql);
const REST = JSON.stringify(taggedRest);

/** A tagged page whose documents come in steps, one per look (the last stays), and whose re-sends answer in turn. */
class FakeTaggedPage implements TaggedDriver {
  loads: string[] = [];
  looks = 0;
  scrolls = 0;
  cursors: string[] = [];
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
  async resend(cursor: string) {
    this.cursors.push(cursor);
    return this.resends.length > 1 ? (this.resends.shift() ?? null) : (this.resends[0] ?? null);
  }
  stopCollecting() {
    this.stopped = true;
  }
  close() {
    this.closed = true;
  }
}

type Options = ConstructorParameters<typeof TaggedFeed>[2];

const feed = (page: FakeTaggedPage, o: Options = {}) => new TaggedFeed(page, "someone", { poll: 5, firstLoad: 2000, requestWait: 200, ...o });

async function failure(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (err) {
    if (err instanceof SavedError) return err.kind;
    throw err;
  }
  return undefined;
}

describe("TaggedFeed", () => {
  it("loads the tagged page and gives the posts it loaded, then keeps no more of the page's answers", async () => {
    const page = new FakeTaggedPage([[GRAPHQL]]);
    const f = feed(page);
    await f.load();
    expect(page.loads).toEqual(["https://www.instagram.com/someone/tagged/"]);
    const first = await f.page();
    expect(first.posts.map((p) => p.code)).toEqual(["T1carOUS", "T2vidEO"]);
    expect(first.next).toBe("QVFDtagged-next");
    expect(page.stopped).toBe(true);
  });

  it("reads the next posts by sending the page's own request again", async () => {
    const page = new FakeTaggedPage([[GRAPHQL]], [{ status: 200, text: REST }]);
    const f = feed(page);
    await f.load();
    const next = await f.page("QVFDtagged-next");
    expect(page.cursors).toEqual(["QVFDtagged-next"]);
    expect(next.posts.map((p) => p.code)).toEqual(["T1carOUS", "T2vidEO"]);
    expect(next.next).toBe("3400000000000000002_501");
    expect(page.scrolls).toBe(0);
  });

  it("reads a first page the page fetched as the REST feed", async () => {
    const f = feed(new FakeTaggedPage([[REST]]));
    await f.load();
    const first = await f.page();
    expect(first.posts).toHaveLength(2);
    expect(first.next).toBe("3400000000000000002_501");
  });

  it("waits for the page's answers while it loads", async () => {
    const page = new FakeTaggedPage([[], ['{"unrelated":true}'], [GRAPHQL]]);
    await feed(page).load();
    expect(page.looks).toBe(3);
  });

  it("loads the page once", async () => {
    const page = new FakeTaggedPage([[GRAPHQL]]);
    const f = feed(page);
    await Promise.all([f.load(), f.load()]);
    await f.load();
    expect(page.loads).toHaveLength(1);
  });

  it("loads from the stand-in site when given one", async () => {
    const page = new FakeTaggedPage([[GRAPHQL]]);
    await new TaggedFeed(page, "some.one", { poll: 5, site: "http://127.0.0.1:4567" }).load();
    expect(page.loads).toEqual(["http://127.0.0.1:4567/some.one/tagged/"]);
  });

  it("answers signed out for Instagram's sign-in page", async () => {
    const reports: string[] = [];
    const page = new FakeTaggedPage([[]], [], "https://www.instagram.com/accounts/login/?next=%2Fsomeone%2Ftagged%2F");
    expect(await failure(feed(page, { report: (url) => reports.push(url) }).load())).toBe("signedOut");
    expect(reports).toEqual([]);
  });

  it("answers signed out when the page shows the profile as everyone sees it", async () => {
    const everyone = JSON.stringify({ data: { xig_user_by_igid_v2: { username: "someone" } } });
    expect(await failure(feed(new FakeTaggedPage([[everyone]])).load())).toBe("signedOut");
  });

  it("reports what the page held and says it can't read it when nothing readable comes in time", async () => {
    const reports: { url: string; documents: string[] }[] = [];
    const page = new FakeTaggedPage([['{"unrelated":true}']]);
    const f = feed(page, { firstLoad: 100, report: (url, documents) => reports.push({ url, documents }) });
    expect(await failure(f.load())).toBe("badAnswer");
    expect(reports).toEqual([{ url: "https://www.instagram.com/someone/tagged/", documents: ['{"unrelated":true}'] }]);
    expect(page.stopped).toBe(false);
  });

  it("has no page before it has loaded", async () => {
    expect(await failure(feed(new FakeTaggedPage([[GRAPHQL]])).page())).toBe("badAnswer");
  });

  it("scrolls once and waits for the page to make its own request first", async () => {
    const page = new FakeTaggedPage([[GRAPHQL]], [null, null, { status: 200, text: REST }]);
    const f = feed(page);
    await f.load();
    expect((await f.page("QVFDtagged-next")).posts).toHaveLength(2);
    expect(page.scrolls).toBe(1);
    expect(page.cursors).toEqual(["QVFDtagged-next", "QVFDtagged-next", "QVFDtagged-next"]);
  });

  it("says it can't read on when the page never makes a request of its own", async () => {
    const f = feed(new FakeTaggedPage([[GRAPHQL]], [null]), { requestWait: 100 });
    await f.load();
    expect(await failure(f.page("QVFDtagged-next"))).toBe("badAnswer");
  });

  it("passes Instagram's push-back on a re-sent request on", async () => {
    const f = feed(new FakeTaggedPage([[GRAPHQL]], [{ status: 429, text: "" }]));
    await f.load();
    expect(await failure(f.page("QVFDtagged-next"))).toBe("rateLimited");
  });

  it("closes its page", () => {
    const page = new FakeTaggedPage([[GRAPHQL]]);
    feed(page).close();
    expect(page.closed).toBe(true);
  });
});
