import { describe, expect, it } from "vitest";
import collections1 from "../../../../packages/shared/src/instagram/fixtures/instagram-collections-1.json?raw";
import collections2 from "../../../../packages/shared/src/instagram/fixtures/instagram-collections-2.json?raw";
import { loadCollections } from "../../src/main/instagram/collections";
import type { PageDriver } from "../../src/main/instagram/finder";

/** A saved page whose documents move on one step per scroll; the last step stays. */
class ScrolledPage implements PageDriver {
  loads: string[] = [];
  scrolls = 0;
  closed = false;
  constructor(private readonly steps: string[][]) {}
  async load(url: string) {
    this.loads.push(url);
  }
  async documents() {
    return this.steps[Math.min(this.scrolls, this.steps.length - 1)] ?? [];
  }
  async scrollToEnd() {
    this.scrolls++;
  }
  finalUrl() {
    return this.loads[0] ?? "about:blank";
  }
  close() {
    this.closed = true;
  }
}

/** A collections list of `n` own collections that always says more are coming. */
const growing = (n: number) =>
  JSON.stringify({
    data: {
      viewer: {
        collections_unified_with_auto_collections: {
          edges: Array.from({ length: n }, (_, k) => ({ node: { __typename: "MediaCollection", collection_id: `${200 + k}`, collection_name: `C${k}` } })),
          page_info: { has_next_page: true },
        },
      },
    },
  });

const load = (page: ScrolledPage, o: { timeout?: number; maxScrolls?: number } = {}) => loadCollections(() => page, "sample.user", { poll: 5, timeout: 2000, ...o });

describe("loadCollections", () => {
  it("scrolls once per new batch until the page says there are no more", async () => {
    const page = new ScrolledPage([[collections1], [collections1, collections2]]);
    const list = await load(page);
    expect(list?.map((c) => c.name)).toEqual(["All posts", "Trips", "Recipes", "Music"]);
    expect(page.scrolls).toBe(1);
    expect(page.loads).toEqual(["https://www.instagram.com/sample.user/saved/"]);
    expect(page.closed).toBe(true);
  });

  it("answers null when the page lists nothing in time", async () => {
    const page = new ScrolledPage([[]]);
    expect(await load(page, { timeout: 100 })).toBeNull();
    expect(page.closed).toBe(true);
  });

  it("stops after the most scrolls it may do", async () => {
    const page = new ScrolledPage([[growing(1)], [growing(2)], [growing(3)], [growing(4)]]);
    const list = await load(page, { maxScrolls: 2 });
    expect(page.scrolls).toBe(2);
    expect(list).toHaveLength(3);
  });

  it("stops when scrolling brings nothing new", async () => {
    const page = new ScrolledPage([[growing(1)]]);
    const started = Date.now();
    const list = await load(page, { timeout: 60_000 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(page.scrolls).toBe(1);
    expect(list).toHaveLength(1);
  });
});
