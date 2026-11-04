import { describe, expect, it } from "vitest";
import { DEFAULT_SAVE_OPTIONS, type BackupView, type ParsedProfileList, type ProfileListView } from "@turbodl/shared";
import {
  countdown,
  fileSummary,
  invalidLines,
  listActions,
  listBanner,
  listOwnsBackup,
  listPosition,
  listStartProblem,
  listStateLine,
  namesPreview,
  rowText,
  waitNumber,
} from "./profile-list-state";

const NOW = 1_700_000_000_000;

function list(over: Partial<ProfileListView> = {}): ProfileListView {
  return {
    name: "list.txt",
    rows: [
      { username: "a.one", state: "done", files: 12, fetched: 3 },
      { username: "b.two", state: "running" },
      { username: "c.three", state: "waiting" },
    ],
    index: 1,
    state: "running",
    options: { ...DEFAULT_SAVE_OPTIONS },
    wait: { min: 2, max: 5 },
    ...over,
  };
}

const backup = (kind: BackupView["kind"], name: string, state: BackupView["state"] = "running"): BackupView => ({
  targetId: "profile-51",
  kind,
  name,
  state,
  done: 1,
  failed: 0,
  saved: 1,
  progress: 0,
});

const parsed = (usernames: string[], invalid: ParsedProfileList["invalid"] = [], tooMany = false): ParsedProfileList => ({ usernames, invalid, tooMany });

describe("profile-list-state", () => {
  it("counts down in m:ss, h:mm:ss from an hour, never below 0:00", () => {
    expect(countdown(NOW + 192_000, NOW)).toBe("3:12");
    expect(countdown(NOW + 59_001, NOW)).toBe("1:00");
    expect(countdown(NOW + 5_000, NOW)).toBe("0:05");
    expect(countdown(NOW + 3_600_000, NOW)).toBe("1:00:00");
    expect(countdown(NOW + 1440 * 60_000, NOW)).toBe("24:00:00");
    expect(countdown(NOW - 3_000, NOW)).toBe("0:00");
  });

  it("says where the list is: the row running or next, a finished list's last", () => {
    expect(listPosition(list())).toBe("2 of 3");
    expect(listPosition(list({ index: 0, state: "waiting" }))).toBe("1 of 3");
    expect(listPosition(list({ index: 3, state: "finished" }))).toBe("3 of 3");
  });

  it("words each state of the list", () => {
    expect(listStateLine(list(), NOW)).toBe("Backing up @b.two");
    // the progress, with the part when the running backup is that profile's
    expect(listStateLine(list({ progress: { done: 48, total: 230 } }), NOW, backup("profile", "B.Two"))).toBe("Backing up @b.two · posts 48 / 230");
    expect(listStateLine(list({ progress: { done: 1, total: 2 } }), NOW, backup("highlights", "b.two · Highlights"))).toBe("Backing up @b.two · highlights 1 / 2");
    expect(listStateLine(list({ progress: { done: 1 } }), NOW, backup("tagged", "b.two · Tagged"))).toBe("Backing up @b.two · tagged posts 1");
    // another profile's backup names no part
    expect(listStateLine(list({ progress: { done: 1230, total: 4000 } }), NOW, backup("profile", "a.one"))).toBe("Backing up @b.two · 1,230 / 4,000");
    expect(listStateLine(list({ state: "waiting", index: 2, nextAt: NOW + 192_000 }), NOW)).toBe("Next profile in 3:12");
    const slowed = "Instagram asked TurboDL to slow down — going on at 18:40.";
    expect(listStateLine(list({ state: "slowedDown", nextAt: NOW + 900_000, message: slowed }), NOW)).toBe(slowed);
    expect(listStateLine(list({ state: "rateLimited", message: "Slow down 3 times." }), NOW)).toBe("Slow down 3 times.");
    expect(listStateLine(list({ state: "signedOut", message: "Signed out." }), NOW)).toBe("Signed out.");
    expect(listStateLine(list({ state: "stopped" }), NOW)).toBe("Stopped");
    const finished = list({
      state: "finished",
      index: 3,
      rows: [
        { username: "a", state: "done", fetched: 0 },
        { username: "b", state: "done", fetched: 2 },
        { username: "c", state: "skipped", note: "This account is private." },
      ],
    });
    expect(listStateLine(finished, NOW)).toBe("Finished: 2 backed up, 1 skipped");
    expect(listStateLine({ ...finished, rows: [...finished.rows, { username: "d", state: "failed", note: "x" }] }, NOW)).toBe("Finished: 2 backed up, 1 skipped, 1 failed");
  });

  it("offers Stop while the list goes on, Continue and Close once it stopped, Close once finished", () => {
    for (const state of ["running", "waiting", "slowedDown"] as const) expect(listActions(state)).toEqual({ stop: true, continue: false, signIn: false, close: false });
    for (const state of ["stopped", "rateLimited"] as const) expect(listActions(state)).toEqual({ stop: false, continue: true, signIn: false, close: true });
    expect(listActions("signedOut")).toEqual({ stop: false, continue: true, signIn: true, close: true });
    expect(listActions("finished")).toEqual({ stop: false, continue: false, signIn: false, close: true });
  });

  it("says how each row went", () => {
    expect(rowText({ username: "a", state: "done", files: 1204, fetched: 3 })).toBe("✓ @a — 1,204 files · 3 new");
    expect(rowText({ username: "a", state: "done", files: 1, fetched: 1 })).toBe("✓ @a — 1 file · 1 new");
    // no total from the Profiles index (a highlights-only list)
    expect(rowText({ username: "a", state: "done", fetched: 4 })).toBe("✓ @a — 4 new");
    expect(rowText({ username: "a", state: "done", files: 6, fetched: 0, note: "Skipped 2 posts." })).toBe("✓ @a — 6 files · 0 new · Skipped 2 posts.");
    expect(rowText({ username: "b", state: "skipped", note: "This account is private." })).toBe("⚠ @b — This account is private.");
    expect(rowText({ username: "c", state: "failed", note: "boom" })).toBe("✗ @c — boom");
    expect(rowText({ username: "d", state: "running" })).toBe("⏳ @d — running");
    expect(rowText({ username: "e", state: "waiting" })).toBe("· @e — waiting");
  });

  it("puts a line above an open profile while a list is unfinished", () => {
    expect(listBanner(list())).toBe("List: 2 of 3 — @b.two");
    expect(listBanner(list({ state: "waiting", index: 2, nextAt: NOW }))).toBe("List: 3 of 3 — @c.three");
    expect(listBanner(list({ state: "finished", index: 3 }))).toBeNull();
    expect(listBanner(null)).toBeNull();
  });

  it("knows the unfinished list's own backup: the profile it is at, whatever the part", () => {
    for (const b of [backup("profile", "B.Two", "rateLimited"), backup("highlights", "b.two · Highlights", "stopped"), backup("tagged", "b.two · Tagged", "signedOut")]) {
      // its slow-down wait: the list goes on with it by itself
      expect(listOwnsBackup(b, list({ state: "slowedDown" }))).toBe("active");
      expect(listOwnsBackup(b, list({ state: "running" }))).toBe("active");
      // stopped: its Continue is the list's
      for (const state of ["stopped", "rateLimited", "signedOut"] as const) expect(listOwnsBackup(b, list({ state }))).toBe("resumable");
    }
    // the profile before the one waiting to run, another profile, a collection, a finished list, no list
    expect(listOwnsBackup(backup("profile", "a.one", "failed"), list({ state: "waiting", nextAt: NOW }))).toBeNull();
    expect(listOwnsBackup(backup("profile", "other", "stopped"), list({ state: "stopped" }))).toBeNull();
    expect(listOwnsBackup(backup("collection", "b.two", "stopped"), list({ state: "stopped" }))).toBeNull();
    expect(listOwnsBackup(backup("profile", "c.three", "stopped"), list({ state: "finished", index: 3 }))).toBeNull();
    expect(listOwnsBackup(backup("profile", "b.two", "stopped"), null)).toBeNull();
  });

  it("sums up the chosen file: how many profiles, the first names, the lines that aren't profiles", () => {
    expect(fileSummary("list.txt", parsed(["a", "b"]))).toBe("list.txt · 2 profiles");
    expect(fileSummary("one.txt", parsed(["a"]))).toBe("one.txt · 1 profile");
    expect(namesPreview(["a", "b"])).toBe("@a, @b");
    const ten = Array.from({ length: 10 }, (_, i) => `u${i}`);
    expect(namesPreview(ten)).toBe("@u0, @u1, @u2, @u3, @u4, @u5, @u6, @u7 +2 more");
    expect(namesPreview(ten.slice(0, 8))).toBe("@u0, @u1, @u2, @u3, @u4, @u5, @u6, @u7");
    expect(invalidLines(parsed(["a"], [{ line: 7, text: "not a name!" }]))).toEqual(["Line 7 isn't a profile: not a name!"]);
    const five = [2, 4, 6, 8, 9].map((line) => ({ line, text: `x ${line}` }));
    expect(invalidLines(parsed([], five))).toEqual(["Line 2 isn't a profile: x 2", "Line 4 isn't a profile: x 4", "Line 6 isn't a profile: x 6", "and 2 more"]);
  });

  it("starts a list only with a file of profiles, a right wait and something to save", () => {
    const ok = { file: { list: parsed(["a", "b"]) }, wait: { min: 0, max: 0 }, options: { ...DEFAULT_SAVE_OPTIONS }, signedIn: true };
    expect(listStartProblem(ok)).toBeNull();
    expect(listStartProblem({ ...ok, file: null })).toBe("Choose a .txt file first.");
    expect(listStartProblem({ ...ok, file: { list: parsed(["a"], [], true) } })).toBe("A list can hold at most 1,000 profiles.");
    expect(listStartProblem({ ...ok, file: { list: parsed([], [{ line: 1, text: "x y" }]) } })).toBe("The file holds no profiles.");
    expect(listStartProblem({ ...ok, wait: { min: 5, max: 2 } })).toBe("Waits are whole minutes from 0 to 1440, the most at least the least.");
    // an empty field is no wait at all, not 0
    expect(listStartProblem({ ...ok, wait: { min: waitNumber(""), max: waitNumber("3") } })).toBe("Waits are whole minutes from 0 to 1440, the most at least the least.");
    expect(listStartProblem({ ...ok, options: { ...ok.options, photos: false, videos: false } })).toBe("Pick photos, videos or both.");
    // tagged alone needs a session
    const taggedOnly = { ...ok.options, posts: false, highlights: false, tagged: true };
    expect(listStartProblem({ ...ok, options: taggedOnly })).toBeNull();
    expect(listStartProblem({ ...ok, options: taggedOnly, signedIn: false })).toBe("Pick at least one of posts, highlights and tagged posts.");
    expect(waitNumber(" 4 ")).toBe(4);
  });
});
