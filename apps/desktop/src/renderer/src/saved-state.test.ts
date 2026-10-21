import { describe, expect, it } from "vitest";
import type { SavedPage, SavedPost } from "@turbodl/shared";
import { backupAction, canLoadMore, initialSaved, pageArrived, pageFailed, select, toggle } from "./saved-state";

const post = (id: string): SavedPost => ({ id, items: [{ kind: "image", url: `https://cdn.example/${id}.jpg`, mediaId: id }] });
const page = (ids: string[], next?: string): SavedPage => ({ posts: ids.map(post), ...(next ? { next } : {}) });

describe("saved-state", () => {
  it("drops a page that arrives for a feed no longer shown", () => {
    const all = select(initialSaved(), { kind: "all" });
    const trips = select(all, { kind: "collection", id: "102" });
    const late = pageArrived(trips, all.generation, page(["1", "2"]));
    expect(late.posts).toEqual([]);
    expect(pageFailed(trips, all.generation, { type: "rateLimited" }).status).toBe(trips.status);
    expect(pageArrived(trips, trips.generation, page(["3"])).posts.map((p) => p.id)).toEqual(["3"]);
  });

  it("shows a post that comes on two pages once", () => {
    const s = select(initialSaved(), { kind: "all" });
    const first = pageArrived(s, s.generation, page(["1", "2"], "c1"));
    const second = pageArrived(first, s.generation, page(["2", "3"]));
    expect(second.posts.map((p) => p.id)).toEqual(["1", "2", "3"]);
    expect(second.status).toBe("end");
    expect(canLoadMore(first)).toBe(true);
    expect(canLoadMore(second)).toBe(false);
  });

  it("keeps picks in the order they were made", () => {
    let s = initialSaved();
    for (const id of ["a", "b", "a", "c"]) s = toggle(s, id);
    expect(s.picked).toEqual(["b", "c"]);
  });

  it("starts a feed afresh: no posts, no picks, no cursor", () => {
    let s = select(initialSaved(), { kind: "all" });
    s = toggle(pageArrived(s, s.generation, page(["1"], "c1")), "1");
    const trips = select(s, { kind: "collection", id: "102" });
    expect([trips.posts, trips.picked, trips.next, trips.status]).toEqual([[], [], undefined, "idle"]);
    expect(trips.source).toEqual({ kind: "collection", id: "102" });
  });

  it("offers what a backup's state calls for: sign-in when Instagram signed TurboDL out", () => {
    expect(backupAction("running")).toBe("stop");
    expect(backupAction("signedOut")).toBe("signIn");
    for (const state of ["stopped", "rateLimited", "failed"] as const) expect(backupAction(state)).toBe("continue");
    expect(backupAction("finished")).toBe("none");
  });

  it("stops asking after Instagram pushes back, until asked again", () => {
    const s = select(initialSaved(), { kind: "all" });
    const limited = pageFailed(s, s.generation, { type: "rateLimited" });
    expect(limited.status).toBe("rateLimited");
    expect(canLoadMore(limited)).toBe(false);
    expect(pageFailed(s, s.generation, { type: "failed", message: "Instagram answered HTTP 500." })).toMatchObject({ status: "failed", error: "Instagram answered HTTP 500." });
  });
});
