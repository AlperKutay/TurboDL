import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SavedError, type BackupView, type InstagramItem, type SavedPost } from "@turbodl/shared";
import { BackupRun, type BackupTarget } from "../../src/main/instagram/backup";
import { LedgerStore, type BackupLedger } from "../../src/main/instagram/ledger";

const item = (id: string, kind: InstagramItem["kind"] = "image"): InstagramItem => ({ kind, url: `https://cdn.example/${id}.${kind === "video" ? "mp4" : "jpg"}`, mediaId: id });
const post = (id: string, ...items: InstagramItem[]): SavedPost => ({ id, cover: `https://cdn.example/${id}-cover.jpg`, items });

/** Posts 1 (a photo 11 and a video 12) and 2 on the first page, post 3 on the second. */
const PAGES = [[post("1", item("11"), item("12", "video")), post("2", item("2"))], [post("3", item("3"))]];

let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

interface Setup {
  pages?: SavedPost[][];
  /** the page (by number) that answers this error instead */
  pushBack?: { page: number; error: SavedError };
  failing?: string[];
  /** what an earlier run left (the fields not given are empty) */
  ledger?: Partial<BackupLedger>;
  /** a fetch that never ends until it is called off */
  hang?: string;
  /** ms a called-off fetch takes to clean up after itself */
  cleanup?: number;
  pageGap?: [number, number];
  /** what `random` answers, in turn (the last one stays) */
  randoms?: number[];
  count?: number;
  /** the ledger's name (102 unless given) */
  id?: string;
  kind?: BackupView["kind"];
  checkCount?: boolean;
  /** how a post known only by its cover is read from its own page (a profile seen signed out) */
  read?: (post: SavedPost) => Promise<SavedPost>;
}

function setup(o: Setup = {}) {
  root ||= mkdtempSync(path.join(os.tmpdir(), "turbodl-backup-"));
  const pages = o.pages ?? PAGES;
  const ledgers = new LedgerStore(path.join(root, "ledgers"));
  const id = o.id ?? "102";
  if (o.ledger) ledgers.save(id, { saved: [], failedPosts: [], reachedEnd: false, donePosts: [], signInPosts: [], ...o.ledger });
  const asked: (string | undefined)[] = [];
  /** the posts read from their own pages, in turn */
  const reads: string[] = [];
  const fetched: string[] = [];
  const waits: number[] = [];
  const views: BackupView[] = [];
  const cleaned: string[] = [];
  const files: { file: string; existing: boolean }[] = [];
  const target: BackupTarget = {
    id,
    kind: o.kind ?? "collection",
    name: "Trips",
    count: o.count ?? 3,
    dir: path.join(root, "Trips"),
    allowsEarlyStop: o.kind !== "highlights",
    ...(o.pageGap ? { pageGap: o.pageGap } : {}),
    ...(o.checkCount ? { checkCount: true } : {}),
  };
  const read = o.read;
  const run = new BackupRun(
    target,
    {
      page: async (cursor) => {
        asked.push(cursor);
        const k = cursor ? Number(cursor) : 0;
        if (o.pushBack?.page === k) throw o.pushBack.error;
        return { posts: pages[k], ...(k + 1 < pages.length ? { next: String(k + 1) } : {}) };
      },
      fetch: async (url, file, { signal }) => {
        fetched.push(url);
        if (url === o.hang) {
          await new Promise((_, reject) =>
            signal?.addEventListener("abort", () =>
              setTimeout(() => {
                cleaned.push(url);
                reject(new Error("Cancelled."));
              }, o.cleanup ?? 0),
            ),
          );
        }
        if (o.failing?.includes(url)) throw new Error("boom");
        writeFileSync(file, "x");
      },
      ledgers,
      wait: async (ms) => {
        waits.push(ms);
      },
      random: () => (o.randoms && o.randoms.length > 1 ? (o.randoms.shift() as number) : (o.randoms?.[0] ?? 0.5)),
      headers: { Referer: "https://www.instagram.com/" },
      onFile: (file, existing) => files.push({ file, existing }),
      ...(read
        ? {
            read: (p: SavedPost) => {
              reads.push(p.id);
              return read(p);
            },
          }
        : {}),
    },
    (view) => views.push(view),
  );
  return { run, asked, fetched, waits, views, ledgers, target, cleaned, files, reads };
}

describe("BackupRun", () => {
  it("saves every item of every post, by id, and remembers reaching the end", async () => {
    const { run, ledgers, target } = setup();
    await run.start();
    expect(readdirSync(target.dir).sort()).toEqual(["11.jpg", "12.mp4", "2.jpg", "3.jpg"]);
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12", "2", "3"], failedPosts: [], reachedEnd: true, donePosts: ["1", "2", "3"], signInPosts: [] });
    expect(run.view()).toMatchObject({ state: "finished", done: 3, failed: 0, left: 0, saved: 4 });
  });

  it("goes on where an earlier run stopped, without saving anything twice", async () => {
    const { run, fetched } = setup({ ledger: { saved: ["11", "12"], failedPosts: [], reachedEnd: false } });
    await run.start();
    expect(fetched).toEqual(["https://cdn.example/2.jpg", "https://cdn.example/3.jpg"]);
    expect(run.view()).toMatchObject({ state: "finished", done: 3, saved: 2 });
  });

  it("doesn't record a failed item, counts its post failed, and tries it again next run", async () => {
    const first = setup({ failing: ["https://cdn.example/12.mp4"] });
    await first.run.start();
    expect(first.ledgers.load("102")).toMatchObject({ saved: ["11", "2", "3"], failedPosts: ["1"] });
    expect(first.run.view()).toMatchObject({ state: "finished", done: 2, failed: 1 });
    const second = setup();
    await second.run.start();
    expect(second.fetched).toEqual(["https://cdn.example/12.mp4"]);
    expect(second.ledgers.load("102").failedPosts).toEqual([]);
  });

  it("stops at a page already saved only after a complete pass that left nothing failed", async () => {
    const all = ["11", "12", "2", "3"];
    const clean = setup({ ledger: { saved: all, failedPosts: [], reachedEnd: true } });
    await clean.run.start();
    expect(clean.asked).toEqual([undefined]);
    expect(clean.run.view()).toMatchObject({ state: "finished", done: 3 });
    for (const ledger of [
      { saved: all, failedPosts: [], reachedEnd: false },
      { saved: all, failedPosts: ["9"], reachedEnd: true },
    ]) {
      const again = setup({ ledger });
      await again.run.start();
      expect(again.asked).toEqual([undefined, "1"]);
    }
  });

  it("stops as signed out when the session dies midway, keeping what it saved", async () => {
    const { run, ledgers } = setup({ pushBack: { page: 1, error: new SavedError("signedOut") } });
    await run.start();
    expect(run.view().state).toBe("signedOut");
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12", "2"], failedPosts: [], reachedEnd: false, donePosts: ["1", "2"], signInPosts: [] });
  });

  it("stops at once when Instagram asks to slow down", async () => {
    const { run, fetched } = setup({ pushBack: { page: 0, error: new SavedError("rateLimited") } });
    await run.start();
    expect(run.view().state).toBe("rateLimited");
    expect(fetched).toEqual([]);
  });

  it("drops the item in flight when stopped: no file, not recorded", async () => {
    const { run, ledgers, target, views } = setup({ hang: "https://cdn.example/12.mp4" });
    const running = run.start();
    await new Promise((r) => setTimeout(r, 50));
    run.stop();
    await running;
    expect(run.view().state).toBe("stopped");
    expect(existsSync(path.join(target.dir, "12.mp4"))).toBe(false);
    expect(ledgers.load("102").saved).toEqual(["11"]);
    expect(views[views.length - 1].state).toBe("stopped");
  });

  it("stops only once the item in flight has been dropped", async () => {
    const { run, cleaned } = setup({ hang: "https://cdn.example/12.mp4", cleanup: 50 });
    void run.start();
    await new Promise((r) => setTimeout(r, 30));
    await run.stop();
    expect(cleaned).toEqual(["https://cdn.example/12.mp4"]);
  });

  it("counts a file already on disk as saved without fetching it again", async () => {
    const { run, fetched, ledgers, target } = setup();
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(path.join(target.dir, "11.jpg"), "x");
    await run.start();
    expect(fetched).not.toContain("https://cdn.example/11.jpg");
    expect(ledgers.load("102").saved).toContain("11");
  });

  it("reports each item it puts in the folder, and the ones already there", async () => {
    const { run, files, target } = setup({ failing: ["https://cdn.example/12.mp4"] });
    mkdirSync(target.dir, { recursive: true });
    writeFileSync(path.join(target.dir, "11.jpg"), "x");
    await run.start();
    // 12 failed: nothing of it is in the folder
    expect(files).toEqual([
      { file: path.join(target.dir, "11.jpg"), existing: true },
      { file: path.join(target.dir, "2.jpg"), existing: false },
      { file: path.join(target.dir, "3.jpg"), existing: false },
    ]);
  });

  it("counts a post that shows nothing as failed, tried again next run, and goes on", async () => {
    const { run, ledgers } = setup({ pages: [[post("1", item("11")), post("9"), post("2", item("2"))]] });
    await run.start();
    expect(run.view()).toMatchObject({ state: "finished", done: 2, failed: 1 });
    expect(ledgers.load("102")).toMatchObject({ saved: ["11", "2"], failedPosts: ["9"] });
  });

  it("waits the target's own gap before each next page", async () => {
    const { run, waits } = setup({ pageGap: [3000, 6000], ledger: { saved: ["11", "12", "2"], failedPosts: [], reachedEnd: false } });
    await run.start();
    // page 1 all saved before; page 2 after 3–6 s (4.5 s at 0.5); post 3 fetched → 2.25 s
    expect(waits).toEqual([4500, 2250]);
  });

  it("draws a new gap before each next page", async () => {
    const pages = [[post("1", item("11"))], [post("2", item("2"))], [post("3", item("3"))]];
    const { run, waits } = setup({ pages, pageGap: [3000, 6000], randoms: [0, 1], ledger: { saved: ["11", "2", "3"], failedPosts: [], reachedEnd: false } });
    await run.start();
    expect(waits).toEqual([3000, 6000]);
  });

  it("waits between posts it fetched and before each next page, never after posts already done", async () => {
    const { run, waits } = setup({ ledger: { saved: ["2"], failedPosts: [], reachedEnd: false } });
    await run.start();
    // post 1 fetched → 1.5–3 s (2.25 s at 0.5); post 2 done; page 2 → 2 s; post 3 fetched → 2.25 s
    expect(waits).toEqual([2250, 2000, 2250]);
  });
});

/** A post as a profile seen signed out lists it: its cover only. */
const cover = (id: string): SavedPost => ({ id, code: `C${id}`, cover: `https://cdn.example/${id}-cover.jpg`, items: [], unread: true });
/** Posts 1 and 2 on the first page, 3 on the second, known by their covers. */
const COVERS = [[cover("1"), cover("2")], [cover("3")]];
/** What each post's own page shows. */
const OWN_PAGES: Record<string, InstagramItem[]> = { "1": [item("11"), item("12", "video")], "2": [item("2")], "3": [item("3")], "4": [item("4")] };

/** Reads a post from its own page as OWN_PAGES shows it: `signInOnly` ones are shown only to signed-in visitors, `wall` ones land on the login wall. */
function reader(o: { signInOnly?: string[]; wall?: string[] } = {}) {
  return async (post: SavedPost): Promise<SavedPost> => {
    if (o.wall?.includes(post.id)) throw new SavedError("rateLimited");
    if (o.signInOnly?.includes(post.id)) return { ...post, signInOnly: true };
    const items = OWN_PAGES[post.id] ?? [];
    return items.length > 0 ? { ...post, items, unread: false } : { ...post, items: [] };
  };
}

describe("BackupRun over a profile seen signed out", () => {
  it("reads each post known only by its cover from its own page, saves its items and remembers the post as done", async () => {
    const { run, reads, ledgers, target } = setup({ pages: COVERS, read: reader() });
    await run.start();
    expect(reads).toEqual(["1", "2", "3"]);
    expect(readdirSync(target.dir).sort()).toEqual(["11.jpg", "12.mp4", "2.jpg", "3.jpg"]);
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12", "2", "3"], failedPosts: [], reachedEnd: true, donePosts: ["1", "2", "3"], signInPosts: [] });
    expect(run.view()).toMatchObject({ state: "finished", done: 3, failed: 0, left: 0, saved: 4 });
  });

  it("reads no post's page on a re-run of a finished backup, and stops at the first page", async () => {
    await setup({ pages: COVERS, read: reader() }).run.start();
    const again = setup({ pages: COVERS, read: reader() });
    await again.run.start();
    expect(again.reads).toEqual([]);
    expect(again.asked).toEqual([undefined]);
    expect(again.fetched).toEqual([]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 3, saved: 0 });
  });

  it("reads only the new posts on a later run, stopping at the first page it already has", async () => {
    await setup({ pages: COVERS, read: reader() }).run.start();
    const again = setup({ pages: [[cover("4"), cover("1")], [cover("2"), cover("3")]], read: reader(), count: 4 });
    await again.run.start();
    expect(again.reads).toEqual(["4"]);
    expect(again.asked).toEqual([undefined, "1"]);
    expect(again.fetched).toEqual(["https://cdn.example/4.jpg"]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 4, left: 0 });
  });

  it("knows a post an earlier backup saved by its items once it is read, downloading nothing again", async () => {
    const { run, reads, fetched, ledgers } = setup({ pages: COVERS, read: reader(), ledger: { saved: ["11", "12", "2", "3"], reachedEnd: true } });
    await run.start();
    expect(reads).toEqual(["1", "2", "3"]);
    expect(fetched).toEqual([]);
    expect(ledgers.load("102").donePosts).toEqual(["1", "2", "3"]);
  });

  it("skips a post shown only to signed-in visitors: counted, not failed, and not read again on later runs", async () => {
    const first = setup({ pages: COVERS, read: reader({ signInOnly: ["2"] }) });
    await first.run.start();
    expect(first.reads).toEqual(["1", "2", "3"]);
    expect(first.run.view()).toMatchObject({ state: "finished", done: 2, failed: 0, signInOnly: 1, left: 0 });
    expect(first.ledgers.load("102")).toEqual({ saved: ["11", "12", "3"], failedPosts: [], reachedEnd: true, donePosts: ["1", "3"], signInPosts: ["2"] });
    // it doesn't keep the next run from stopping at the first page
    const again = setup({ pages: COVERS, read: reader({ signInOnly: ["2"] }) });
    await again.run.start();
    expect(again.reads).toEqual([]);
    expect(again.asked).toEqual([undefined]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 2, failed: 0, signInOnly: 1, left: 0 });
  });

  it("still counts the posts left for a sign-in below the page a re-run stops at", async () => {
    await setup({ pages: COVERS, read: reader({ signInOnly: ["3"] }) }).run.start();
    const again = setup({ pages: COVERS, read: reader({ signInOnly: ["3"] }) });
    await again.run.start();
    expect(again.asked).toEqual([undefined]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 2, signInOnly: 1, left: 0 });
  });

  it("saves on a signed-in run the posts a signed-out run left for a sign-in, going past the pages it has", async () => {
    await setup({ pages: COVERS, read: reader({ signInOnly: ["3"] }) }).run.start();
    // signed in, the posts come with their items: nothing is read
    const signedIn = setup();
    await signedIn.run.start();
    expect(signedIn.asked).toEqual([undefined, "1"]);
    expect(signedIn.fetched).toEqual(["https://cdn.example/3.jpg"]);
    expect(signedIn.ledgers.load("102")).toMatchObject({ failedPosts: [], signInPosts: [], donePosts: ["1", "2", "3"], reachedEnd: true });
    expect(signedIn.run.view()).toMatchObject({ state: "finished", done: 3, left: 0 });
    expect(signedIn.run.view().signInOnly).toBeUndefined();
  });

  it("stops at once at Instagram's login wall, keeps what it saved, and goes on past it next time", async () => {
    const walled = setup({ pages: COVERS, read: reader({ wall: ["2"] }) });
    await walled.run.start();
    expect(walled.run.view().state).toBe("rateLimited");
    expect(walled.reads).toEqual(["1", "2"]);
    expect(walled.asked).toEqual([undefined]);
    expect(walled.ledgers.load("102")).toEqual({ saved: ["11", "12"], failedPosts: [], reachedEnd: false, donePosts: ["1"], signInPosts: [] });
    const again = setup({ pages: COVERS, read: reader() });
    await again.run.start();
    expect(again.reads).toEqual(["2", "3"]);
    expect(again.fetched).toEqual(["https://cdn.example/2.jpg", "https://cdn.example/3.jpg"]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 3 });
  });

  it("counts a post whose own page shows nothing as failed, and reads it again next run", async () => {
    const first = setup({ pages: [[cover("1"), cover("9")]], read: reader(), count: 2 });
    await first.run.start();
    expect(first.run.view()).toMatchObject({ state: "finished", done: 1, failed: 1 });
    expect(first.ledgers.load("102")).toMatchObject({ failedPosts: ["9"], donePosts: ["1"] });
    const again = setup({ pages: [[cover("1"), cover("9")]], read: reader(), count: 2 });
    await again.run.start();
    expect(again.reads).toEqual(["9"]);
  });

  it("trusts the listing's end only when it listed nearly every post Instagram counts", async () => {
    const listing = (n: number) => [Array.from({ length: n }, (_, k) => post(`${k + 1}`, item(`${k + 1}`)))];
    const short = setup({ id: "short", pages: listing(40), count: 100, checkCount: true });
    await short.run.start();
    expect(short.run.view()).toMatchObject({ state: "finished", done: 40, warning: "Instagram listed 40 of 100 posts." });
    expect(short.ledgers.load("short").reachedEnd).toBe(false);
    const nearly = setup({ id: "nearly", pages: listing(95), count: 100, checkCount: true });
    await nearly.run.start();
    expect(nearly.run.view()).toMatchObject({ state: "finished", done: 95 });
    expect(nearly.run.view().warning).toBeUndefined();
    expect(nearly.ledgers.load("nearly").reachedEnd).toBe(true);
    // without the check (signed in) the end is Instagram's word, as always
    const trusted = setup({ id: "trusted", pages: listing(40), count: 100 });
    await trusted.run.start();
    expect(trusted.run.view().warning).toBeUndefined();
    expect(trusted.ledgers.load("trusted").reachedEnd).toBe(true);
  });

  it("goes through every highlight on every run: a highlight is never done by its id", async () => {
    const first = setup({ kind: "highlights", pages: [[post("h1", item("s1"))]], count: 1 });
    await first.run.start();
    expect(first.ledgers.load("102").donePosts).toEqual([]);
    const again = setup({ kind: "highlights", pages: [[post("h1", item("s1"), item("s2"))]], count: 1, ledger: { saved: ["s1"], donePosts: ["h1"] } });
    await again.run.start();
    expect(again.fetched).toEqual(["https://cdn.example/s2.jpg"]);
    expect(again.run.view()).toMatchObject({ state: "finished", done: 1 });
  });
});
