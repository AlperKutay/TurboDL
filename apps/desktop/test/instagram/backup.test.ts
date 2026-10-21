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
  ledger?: BackupLedger;
  /** a fetch that never ends until it is called off */
  hang?: string;
  /** ms a called-off fetch takes to clean up after itself */
  cleanup?: number;
  count?: number;
}

function setup(o: Setup = {}) {
  root ||= mkdtempSync(path.join(os.tmpdir(), "turbodl-backup-"));
  const pages = o.pages ?? PAGES;
  const ledgers = new LedgerStore(path.join(root, "ledgers"));
  if (o.ledger) ledgers.save("102", o.ledger);
  const asked: (string | undefined)[] = [];
  const fetched: string[] = [];
  const waits: number[] = [];
  const views: BackupView[] = [];
  const cleaned: string[] = [];
  const target: BackupTarget = { id: "102", kind: "collection", name: "Trips", count: o.count ?? 3, dir: path.join(root, "Trips"), allowsEarlyStop: true };
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
      random: () => 0.5,
      headers: { Referer: "https://www.instagram.com/" },
    },
    (view) => views.push(view),
  );
  return { run, asked, fetched, waits, views, ledgers, target, cleaned };
}

describe("BackupRun", () => {
  it("saves every item of every post, by id, and remembers reaching the end", async () => {
    const { run, ledgers, target } = setup();
    await run.start();
    expect(readdirSync(target.dir).sort()).toEqual(["11.jpg", "12.mp4", "2.jpg", "3.jpg"]);
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12", "2", "3"], failedPosts: [], reachedEnd: true });
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
    expect(ledgers.load("102")).toEqual({ saved: ["11", "12", "2"], failedPosts: [], reachedEnd: false });
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

  it("waits between posts it fetched and before each next page, never after posts already done", async () => {
    const { run, waits } = setup({ ledger: { saved: ["2"], failedPosts: [], reachedEnd: false } });
    await run.start();
    // post 1 fetched → 1.5–3 s (2.25 s at 0.5); post 2 done; page 2 → 2 s; post 3 fetched → 2.25 s
    expect(waits).toEqual([2250, 2000, 2250]);
  });
});
