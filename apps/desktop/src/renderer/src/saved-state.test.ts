import { describe, expect, it } from "vitest";
import type { BackupView, SavedPage, SavedPost, ScreenBackupView } from "@turbodl/shared";
import { backupAction, canLoadMore, initialSaved, pageArrived, pageFailed, panelState, panelWarnings, sameFeed, select, toggle } from "./saved-state";

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

    it("keeps a profile's feed apart from Saved's", () => {
    const all = pageArrived(select(initialSaved(), { kind: "all" }), 1, page(["1"]));
    const profile = select(all, { kind: "profile", username: "sample.user" });
    expect([profile.posts, profile.source]).toEqual([[], { kind: "profile", username: "sample.user" }]);
    expect(sameFeed(profile.source, { kind: "profile", username: "sample.user" })).toBe(true);
    expect(sameFeed(profile.source, { kind: "profile", username: "other.user" })).toBe(false);
    expect(sameFeed({ kind: "all" }, { kind: "collection", id: "102" })).toBe(false);
  });

    it("offers what a backup's state calls for: sign-in when Instagram signed TurboDL out", () => {
    expect(backupAction("running")).toBe("stop");
    expect(backupAction("signedOut")).toBe("signIn");
    for (const state of ["stopped", "rateLimited", "failed"] as const) expect(backupAction(state)).toBe("continue");
    expect(backupAction("finished")).toBe("none");
  });

  it("shows a screen's profile backup going on between its parts, and how it ended after its last part finished", () => {
    const finished: BackupView = { targetId: "profile-51", kind: "profile", name: "sample.user", state: "finished", done: 3, failed: 0, saved: 3, progress: 0 };
    const screen = (state: ScreenBackupView["state"], error?: string): ScreenBackupView => ({ username: "sample.user", state, warnings: [], ran: true, ...(error ? { error } : {}) });
    expect(panelState(finished, null)).toEqual({ state: "finished" });
    // between its parts no backup runs, but it goes on: Stop
    expect(panelState(finished, screen("running"))).toEqual({ state: "running" });
    // stopped between parts: Continue
    expect(panelState(finished, screen("cancelled", "The backup was stopped in TurboDL."))).toEqual({ state: "stopped" });
    // a later part refused
    expect(panelState(finished, screen("failed", "Sign in to Instagram again."))).toEqual({ state: "failed", error: "Sign in to Instagram again." });
    expect(panelState(finished, screen("done"))).toEqual({ state: "finished" });
    // a part that didn't finish says itself how it ended
    const slowed: BackupView = { ...finished, state: "rateLimited" };
    expect(panelState(slowed, screen("failed", "Instagram asked TurboDL to slow down. Try again in a few minutes."))).toEqual({ state: "rateLimited" });
    const broken: BackupView = { ...finished, state: "failed", error: "boom" };
    expect(panelState(broken, screen("failed", "boom"))).toEqual({ state: "failed", error: "boom" });
  });

  it("lets a screen backup that never ran, or ran for another profile, leave a backup's panel alone", () => {
    const finished: BackupView = { targetId: "profile-51", kind: "profile", name: "sample.user", state: "finished", done: 3, failed: 0, saved: 3, progress: 0 };
    const screen = (username: string, state: ScreenBackupView["state"], ran: boolean, error?: string): ScreenBackupView => ({ username, state, warnings: [], ran, ...(error ? { error } : {}) });
    // refused before its first part: the other profile's panel stays as it was
    expect(panelState(finished, screen("other.user", "failed", false, "This account is private."))).toEqual({ state: "finished" });
    expect(panelState(finished, screen("sample.user", "failed", false, "x"))).toEqual({ state: "finished" });
    expect(panelState(finished, screen("sample.user", "running", false))).toEqual({ state: "finished" });
    // it ran, but for someone else
    expect(panelState(finished, screen("other.user", "cancelled", true))).toEqual({ state: "finished" });
    // a collection's backup is nobody's profile
    const collection: BackupView = { ...finished, kind: "collection", name: "sample.user" };
    expect(panelState(collection, screen("sample.user", "failed", true, "x"))).toEqual({ state: "finished" });
    // its own parts, whatever their kind, follow it (names differ in case: Instagram's own spelling)
    for (const [kind, name] of [["profile", "Sample.User"], ["highlights", "sample.user · Highlights"], ["tagged", "sample.user · Tagged"]] as const) {
      const part: BackupView = { ...finished, kind, name };
      expect(panelState(part, screen("sample.user", "cancelled", true))).toEqual({ state: "stopped" });
    }
    expect(panelState({ ...finished, kind: "highlights", name: "other.user · Highlights" }, screen("other.user", "failed", true, "x"))).toEqual({ state: "failed", error: "x" });
    expect(panelState({ ...finished, kind: "highlights", name: "sample.user · Highlights" }, screen("sample.user", "failed", true, "x"))).toEqual({ state: "failed", error: "x" });
    // a backup that isn't the screen job's (an API job's) is shown by its own state, whatever the screen did
    expect(panelState({ ...finished, state: "rateLimited" }, screen("other.user", "running", true))).toEqual({ state: "rateLimited" });
  });

  it("shows a screen backup's warnings once, under its own profile's backup only", () => {
    const part: BackupView = { targetId: "profile-51", kind: "profile", name: "sample.user", state: "finished", done: 3, failed: 0, saved: 3, progress: 0, warning: "Skipped 2 posts." };
    const screen = (username: string, ran: boolean): ScreenBackupView => ({ username, state: "done", warnings: ["Skipped 2 posts.", "This profile has no highlights."], ran });
    // the part's own warning isn't repeated
    expect(panelWarnings(part, screen("sample.user", true))).toEqual(["This profile has no highlights."]);
    // a job that never ran, or ran for someone else, says nothing under this backup
    expect(panelWarnings(part, screen("sample.user", false))).toEqual([]);
    expect(panelWarnings(part, screen("other.user", true))).toEqual([]);
    expect(panelWarnings(part, null)).toEqual([]);
  });

  it("stops asking after Instagram pushes back, until asked again", () => {
    const s = select(initialSaved(), { kind: "all" });
    const limited = pageFailed(s, s.generation, { type: "rateLimited" });
    expect(limited.status).toBe("rateLimited");
    expect(canLoadMore(limited)).toBe(false);
    expect(pageFailed(s, s.generation, { type: "failed", message: "Instagram answered HTTP 500." })).toMatchObject({ status: "failed", error: "Instagram answered HTTP 500." });
  });
});
