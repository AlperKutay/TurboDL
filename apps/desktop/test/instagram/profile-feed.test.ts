import { afterEach, describe, expect, it } from "vitest";
import nextAnswer from "../../../../packages/shared/src/instagram/fixtures/instagram-profile-next.json?raw";
import profilePage from "../../../../packages/shared/src/instagram/fixtures/instagram-profile-page.json?raw";
import loggedOutPage from "../../../../packages/shared/src/instagram/fixtures/instagram-profile-loggedout.json?raw";
import { SIGNED_OUT_POSTS_QUERY, SIGNED_OUT_TRAY_QUERY, SavedError } from "@turbodl/shared";
import { ProfileFeed, type ProfileDriver } from "../../src/main/instagram/profile-feed";
import { NO_ANSWER, STALE_SIGNED_OUT, STALE_SIGNED_OUT_TRAY, operationIds } from "../../src/main/instagram/signed-out";

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
  async signedOutQuery(_name: string, _variables: Record<string, unknown>, _signal?: AbortSignal): Promise<{ status: number; text: string } | null> {
    return null;
  }
  async rescanScripts() {}
  stopCollecting() {
    this.stopped = true;
  }
  close() {
    this.closed = true;
  }
}

const feed = (page: FakeProfilePage, o: { firstLoad?: number; trayWait?: number; requestWait?: number; opWait?: number; signedIn?: boolean } = {}) =>
  new ProfileFeed(page, "sample.user", { poll: 5, firstLoad: 2000, trayWait: 200, requestWait: 200, opWait: 50, ...o });

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

  it("shows a public profile as signed-out visitors see it: the first posts' covers, and where they end", async () => {
    const f = feed(new FakeProfilePage([JSON.parse(loggedOutPage) as string[]]));
    expect((await f.profile()).username).toBe("sample.user");
    expect(f.limited).toBe(true);
    const first = await f.page();
    expect([first.posts.map((p) => p.code), first.next]).toEqual([["C0001", "C0002", "C0003"], "c1"]);
    expect(f.highlights.map((h) => h.title)).toEqual(["Summer", "Winter"]);
  });

  it("with a session, takes the signed-out view only when the signed-in one never comes", async () => {
    const page = new FakeProfilePage([JSON.parse(loggedOutPage) as string[]]);
    const f = feed(page, { signedIn: true, firstLoad: 100 });
    const started = Date.now();
    await f.profile();
    expect(f.limited).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  it("loads the page once however often the profile is asked for", async () => {
    const page = new FakeProfilePage([DOCUMENTS]);
    const f = feed(page);
    await Promise.all([f.profile(), f.profile()]);
    await f.profile();
    expect(page.loads).toHaveLength(1);
  });
});

const LOGGED_OUT = JSON.parse(loggedOutPage) as string[];
/** The signed-out page with a highlights tray that has more after `t1`. */
const LONG_TRAY = LOGGED_OUT.map((d) => d.replace('"page_info": {"has_next_page": false}', '"page_info": {"has_next_page": true, "end_cursor": "t1"}'));
/** The signed-out page whose first posts are all it has. */
const ONE_PAGE = LOGGED_OUT.map((d) => d.replace('"has_next_page": true, "end_cursor": "c1"', '"has_next_page": false, "end_cursor": null'));

/** A script that defines `name`'s operation id the way Instagram's bundles do. */
const defines = (name: string, id: string) => `__d("${name}_instagramRelayOperation",[],(function(t,n,r,o,a,i){a.exports="${id}"}),null);`;

/** An answer to the signed-out posts query: covers `codes`, more after `cursor` when it is given. */
function postsAnswer(codes: string[], cursor?: string): { status: number; text: string } {
  const edges = codes.map((code, i) => ({ node: { pk: `39000000000000${code}`, code, display_uri: `https://cdn.example/${code}.jpg`, media_type: 1 + (i % 2), user: { username: "sample.user" } } }));
  const page_info = cursor ? { end_cursor: cursor, has_next_page: true } : { end_cursor: null, has_next_page: false };
  return { status: 200, text: JSON.stringify({ data: { xig_user_by_username: { polaris_ordered_timeline_connection: { edges, page_info } } } }) };
}

/** An answer to the signed-out tray query: highlights `ids`, more after `cursor` when it is given. */
function trayAnswer(ids: string[], cursor?: string): { status: number; text: string } {
  const edges = ids.map((id) => ({ node: { id: `highlight:${id}`, title: `H${id}` } }));
  const page_info = cursor ? { end_cursor: cursor, has_next_page: true } : { has_next_page: false };
  return { status: 200, text: JSON.stringify({ data: { xig_user_by_username: { lox_highlights_connection: { edges, page_info } } } }) };
}

/** What Instagram answers a query sent with an id it no longer knows. */
const STALE = { status: 200, text: '{"errors":[{"message":"A server error missing_required_variable_value occured."}],"data":null}' };

type Query = { name: string; docId: string; variables: Record<string, unknown> };

/**
 * The profile as signed-out visitors see it; its signed-out queries go out only with a known id (as the real page's
 * do) and answer through `answer` (which throws as the page does when nothing comes back); `rescan` is what fetching
 * the page's scripts again finds.
 */
class SignedOutPage extends FakeProfilePage {
  queries: Query[] = [];
  signals: (AbortSignal | undefined)[] = [];
  rescans = 0;
  /** the posts query's id when the page was told to stop collecting */
  idAtStop: string | undefined;
  /** the tray query's id then */
  trayIdAtStop: string | undefined;
  constructor(
    steps: string[][],
    private readonly answer: (q: Query) => { status: number; text: string } | null,
    private readonly rescan: () => void | Promise<void> = () => undefined,
  ) {
    super(steps);
  }
  override async signedOutQuery(name: string, variables: Record<string, unknown>, signal?: AbortSignal) {
    const docId = operationIds.get(name);
    if (!docId) return null;
    this.queries.push({ name, docId, variables });
    this.signals.push(signal);
    return this.answer({ name, docId, variables });
  }
  override async rescanScripts() {
    this.rescans++;
    await this.rescan();
  }
  override stopCollecting() {
    this.idAtStop = operationIds.get(SIGNED_OUT_POSTS_QUERY);
    this.trayIdAtStop = operationIds.get(SIGNED_OUT_TRAY_QUERY);
    super.stopCollecting();
  }
}

async function until(done: () => boolean): Promise<void> {
  while (!done()) await new Promise((r) => setTimeout(r, 5));
}

describe("ProfileFeed seen signed out", () => {
  afterEach(() => {
    operationIds.forget(SIGNED_OUT_POSTS_QUERY);
    operationIds.forget(SIGNED_OUT_TRAY_QUERY);
  });

  /** posts after each cursor: c1 → c2 → c3 → the end */
  const pages: Record<string, { status: number; text: string }> = {
    c1: postsAnswer(["D01", "D02", "D03"], "c2"),
    c2: postsAnswer(["D04", "D05", "D06"], "c3"),
    c3: postsAnswer(["D07"]),
  };
  const byCursor = (q: Query) => pages[q.variables.after as string] ?? null;

  it("pages to the profile's end with Instagram's own signed-out query", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], byCursor);
    const f = feed(page);
    await f.profile();
    expect(f.limited).toBe(true);
    const seen: (string | undefined)[][] = [];
    let cursor = (await f.page()).next;
    while (cursor) {
      const next = await f.page(cursor);
      seen.push(next.posts.map((p) => p.code));
      expect(next.posts.every((p) => p.unread && p.items.length === 0)).toBe(true);
      cursor = next.next;
    }
    expect(seen).toEqual([["D01", "D02", "D03"], ["D04", "D05", "D06"], ["D07"]]);
    expect(page.queries.map((q) => [q.name, q.docId])).toEqual(Array(3).fill([SIGNED_OUT_POSTS_QUERY, "111"]));
    expect(page.queries[0].variables).toEqual({ after: "c1", first: 12, username: "sample.user", __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false });
    expect(page.queries.map((q) => q.variables.after)).toEqual(["c1", "c2", "c3"]);
    expect(page.rescans).toBe(0);
    // signed out, the page's own posts request isn't used
    expect(page.scrolls).toBe(0);
  });

  it("waits for the profile's timeline when the page holds the profile before its posts", async () => {
    const f = feed(new SignedOutPage([LOGGED_OUT.slice(0, 2), LOGGED_OUT], byCursor));
    await f.profile();
    const first = await f.page();
    expect([first.posts.map((p) => p.code), first.next]).toEqual([["C0001", "C0002", "C0003"], "c1"]);
  });

  it("waits a little for the posts query's id before it stops reading the page's scripts", async () => {
    const page = new SignedOutPage([LOGGED_OUT], byCursor);
    const f = feed(page, { opWait: 2000 });
    const loaded = f.profile();
    setTimeout(() => operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111")), 50);
    await loaded;
    expect(page.idAtStop).toBe("111");
    expect((await f.page("c1")).next).toBe("c2");
  });

  it("goes on without the id when it doesn't come, and doesn't wait for it when there are no more posts", async () => {
    const slow = new SignedOutPage([LOGGED_OUT], byCursor);
    let started = Date.now();
    await feed(slow, { opWait: 100 }).profile();
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect([slow.stopped, slow.idAtStop]).toEqual([true, undefined]);
    const done = new SignedOutPage([ONE_PAGE], byCursor);
    started = Date.now();
    const f = feed(done, { opWait: 5000 });
    await f.profile();
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await f.page()).next).toBeUndefined();
  });

  it("learns a stale id again once from the page's scripts and tries once more", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], (q) => (q.docId === "222" ? byCursor(q) : STALE), () => operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "222")));
    const f = feed(page);
    await f.profile();
    expect((await f.page("c1")).posts.map((p) => p.code)).toEqual(["D01", "D02", "D03"]);
    expect([page.rescans, page.queries.map((q) => q.docId)]).toEqual([1, ["111", "222"]]);
  });

  it("finds an id it never saw in the page's scripts", async () => {
    const page = new SignedOutPage([LOGGED_OUT], byCursor, () => operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "222")));
    const f = feed(page);
    await f.profile();
    expect((await f.page("c1")).next).toBe("c2");
    expect(page.rescans).toBe(1);
  });

  it("says Instagram changed its page when the id stays stale, and rescans only once", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], () => STALE, () => operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111")));
    const f = feed(page);
    await f.profile();
    await expect(f.page("c1")).rejects.toThrow(STALE_SIGNED_OUT);
    expect([page.rescans, page.queries.length]).toEqual([1, 2]);
    await expect(f.page("c1")).rejects.toThrow(STALE_SIGNED_OUT);
    expect(page.rescans).toBe(1);
    expect(operationIds.get(SIGNED_OUT_POSTS_QUERY)).toBeUndefined();
  });

  it("passes Instagram's push-back on a signed-out query on, keeping the id", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], () => ({ status: 429, text: "" }));
    const f = feed(page);
    await f.profile();
    expect(await failure(f.page("c1"))).toBe("rateLimited");
    expect([page.rescans, operationIds.get(SIGNED_OUT_POSTS_QUERY)]).toEqual([0, "111"]);
  });

  it("keeps the id and says Instagram didn't answer when a query fails on the way or takes too long", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], () => {
      throw new Error(NO_ANSWER);
    });
    const f = feed(page);
    await f.profile();
    await expect(f.page("c1")).rejects.toThrow(NO_ANSWER);
    expect([page.rescans, page.queries.length, operationIds.get(SIGNED_OUT_POSTS_QUERY)]).toEqual([0, 1, "111"]);
  });

  it("tries a newer id another page noted meanwhile at once, keeping it", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LOGGED_OUT], (q) => {
      if (q.docId === "222") return byCursor(q);
      // another profile's page notes a fresh id while this stale one is on its way
      operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "222"));
      return STALE;
    });
    const f = feed(page);
    await f.profile();
    expect((await f.page("c1")).next).toBe("c2");
    expect([page.rescans, page.queries.map((q) => q.docId), operationIds.get(SIGNED_OUT_POSTS_QUERY)]).toEqual([0, ["111", "222"], "222"]);
  });

  it("lets two pages that meet a stale id share one look through the page's scripts", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage(
      [LOGGED_OUT],
      (q) => (q.docId === "222" ? byCursor(q) : STALE),
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "222"));
      },
    );
    const f = feed(page);
    await f.profile();
    const [a, b] = await Promise.all([f.page("c1"), f.page("c2")]);
    expect([a.next, b.next]).toEqual(["c2", "c3"]);
    expect(page.rescans).toBe(1);
  });

  it("lets a second profile's page that meets a stale id wait for the look the first one is taking through its scripts", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const answer = (q: Query) => (q.docId === "222" ? byCursor(q) : STALE);
    // the app looks through a page's scripts once per run: a later look finds nothing, as the real page's does
    let looked = false;
    const look = async () => {
      if (looked) return;
      looked = true;
      await new Promise((r) => setTimeout(r, 20));
      operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "222"));
    };
    const a = new SignedOutPage([LOGGED_OUT], answer, look);
    const b = new SignedOutPage([LOGGED_OUT], answer, look);
    const [fa, fb] = [feed(a), feed(b)];
    await Promise.all([fa.profile(), fb.profile()]);
    const [pa, pb] = await Promise.all([fa.page("c1"), fb.page("c2")]);
    expect([pa.next, pb.next]).toEqual(["c2", "c3"]);
    expect(a.rescans + b.rescans).toBe(1);
  });

  it("stops a called-off read: nothing is sent, and no retry follows the look through the scripts", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const before = new SignedOutPage([LOGGED_OUT], byCursor);
    const f = feed(before);
    await f.profile();
    const off = new AbortController();
    off.abort();
    await expect(f.page("c1", off.signal)).rejects.toThrow("Cancelled.");
    expect(before.queries).toEqual([]);

    let release = () => undefined as void;
    const during = new SignedOutPage([LOGGED_OUT], () => STALE, () => new Promise<void>((r) => (release = r)));
    const g = feed(during);
    await g.profile();
    const stop = new AbortController();
    const read = g.page("c1", stop.signal);
    await until(() => during.rescans === 1);
    stop.abort();
    await expect(read).rejects.toThrow("Cancelled.");
    expect([during.queries.length, during.signals[0]]).toEqual([1, stop.signal]);
    release();
  });

  it("pages the highlights tray with Instagram's signed-out tray query", async () => {
    operationIds.note(defines(SIGNED_OUT_TRAY_QUERY, "333"));
    const trays: Record<string, { status: number; text: string }> = { t1: trayAnswer(["17900000000000010", "17900000000000011"], "t2"), t2: trayAnswer(["17900000000000012"]) };
    const page = new SignedOutPage([LONG_TRAY], (q) => trays[q.variables.after as string] ?? null);
    const f = feed(page);
    await f.profile();
    expect(f.highlights.map((h) => h.title)).toEqual(["Summer", "Winter"]);
    expect(f.trayCursor).toBe("t1");
    expect((await f.moreHighlights())?.map((h) => h.id)).toEqual(["17900000000000010", "17900000000000011"]);
    expect(f.trayCursor).toBe("t2");
    expect((await f.moreHighlights())?.map((h) => h.id)).toEqual(["17900000000000012"]);
    expect(f.trayCursor).toBeUndefined();
    expect(await f.moreHighlights()).toBeNull();
    expect(page.queries.map((q) => [q.name, q.docId])).toEqual([
      [SIGNED_OUT_TRAY_QUERY, "333"],
      [SIGNED_OUT_TRAY_QUERY, "333"],
    ]);
    expect(page.queries[0].variables).toEqual({ after: "t1", first: 12, id: "5100000000000000001" });
  });

  it("waits a little for the tray query's id too when the tray has more", async () => {
    operationIds.note(defines(SIGNED_OUT_POSTS_QUERY, "111"));
    const page = new SignedOutPage([LONG_TRAY], () => null);
    const loaded = feed(page, { opWait: 2000 }).profile();
    setTimeout(() => operationIds.note(defines(SIGNED_OUT_TRAY_QUERY, "333")), 50);
    await loaded;
    expect([page.idAtStop, page.trayIdAtStop]).toEqual(["111", "333"]);
  });

  it("learns a stale or unknown tray id again once, and says so when it stays stale", async () => {
    const trays: Record<string, { status: number; text: string }> = { t1: trayAnswer(["17900000000000010"]) };
    operationIds.note(defines(SIGNED_OUT_TRAY_QUERY, "333"));
    const learns = new SignedOutPage([LONG_TRAY], (q) => (q.docId === "444" ? (trays[q.variables.after as string] ?? null) : STALE), () =>
      operationIds.note(defines(SIGNED_OUT_TRAY_QUERY, "444")),
    );
    const f = feed(learns);
    await f.profile();
    expect((await f.moreHighlights())?.map((h) => h.id)).toEqual(["17900000000000010"]);
    expect([learns.rescans, learns.queries.map((q) => q.docId)]).toEqual([1, ["333", "444"]]);

    operationIds.forget(SIGNED_OUT_TRAY_QUERY);
    const stale = new SignedOutPage([LONG_TRAY], () => STALE, () => operationIds.note(defines(SIGNED_OUT_TRAY_QUERY, "333")));
    const g = feed(stale);
    await g.profile();
    await expect(g.moreHighlights()).rejects.toThrow(STALE_SIGNED_OUT_TRAY);
    expect([stale.rescans, g.trayCursor]).toEqual([1, "t1"]);
  });

  it("has no more highlights when the tray ends on the page, nor signed in", async () => {
    const out = feed(new SignedOutPage([LOGGED_OUT], () => null));
    await out.profile();
    expect([out.trayCursor, await out.moreHighlights()]).toEqual([undefined, null]);
    const signedIn = feed(new FakeProfilePage([DOCUMENTS]));
    await signedIn.profile();
    expect([signedIn.trayCursor, await signedIn.moreHighlights()]).toEqual([undefined, null]);
  });
});
