import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SAVE_OPTIONS } from "@turbodl/shared";
import { mediaKindsArg, profileListArg, saveOptionsArg } from "../src/main/ipc";

// the handlers aren't registered here: only the checks of what the renderer sends
vi.mock("electron", () => ({ app: {}, BrowserWindow: {}, clipboard: {}, dialog: {}, ipcMain: {}, shell: {} }));

describe("the renderer's save options", () => {
  it("keeps each option that is a boolean", () => {
    const picked = { posts: false, highlights: true, tagged: false, photos: true, videos: false };
    expect(saveOptionsArg(picked)).toEqual(picked);
  });

  it("takes the default for each option that isn't a boolean, and drops anything else", () => {
    expect(saveOptionsArg({ posts: "no", highlights: 0, tagged: null, photos: false, extra: true })).toEqual({ ...DEFAULT_SAVE_OPTIONS, photos: false });
    expect(saveOptionsArg(undefined)).toEqual(DEFAULT_SAVE_OPTIONS);
    expect(saveOptionsArg("posts")).toEqual(DEFAULT_SAVE_OPTIONS);
  });

  it("reads photos and videos alone for a highlights backup", () => {
    expect(mediaKindsArg({ photos: false, videos: true, posts: false })).toEqual({ photos: false, videos: true });
    expect(mediaKindsArg({ photos: "x" })).toEqual({ photos: true, videos: true });
    expect(mediaKindsArg(null)).toEqual({ photos: true, videos: true });
  });
});

describe("the renderer's profile list", () => {
  const WAIT = { min: 2, max: 5 };
  const WAIT_PROBLEM = { ok: false, error: "Waits are whole minutes from 0 to 1440, the most at least the least." };
  const NO_PROFILES = { ok: false, error: "The list has no profiles." };

  it("takes a list as the renderer sends it, each name as Instagram's address has it", () => {
    const options = { posts: true, highlights: false, tagged: false, photos: true, videos: false };
    expect(profileListArg({ name: "friends.txt", usernames: ["Sample.User", "@other.user", "sample.user"], options, wait: { min: 0, max: 3 } })).toEqual({
      ok: true,
      list: { name: "friends.txt", usernames: ["sample.user", "other.user"], options, wait: { min: 0, max: 3 } },
    });
    // the name is only shown; options that aren't booleans are their defaults
    expect(profileListArg({ name: 5, usernames: ["sample.user"], options: "all", wait: WAIT })).toEqual({
      ok: true,
      list: { name: "", usernames: ["sample.user"], options: DEFAULT_SAVE_OPTIONS, wait: WAIT },
    });
  });

  it("refuses what isn't a list, with the reasons the app gives", () => {
    expect(profileListArg({ name: "friends.txt", usernames: "sample.user", wait: WAIT })).toEqual(NO_PROFILES);
    expect(profileListArg({ usernames: [], wait: WAIT })).toEqual(NO_PROFILES);
    expect(profileListArg(null)).toEqual(NO_PROFILES);
    expect(profileListArg({ usernames: ["sample.user", { name: "x" }], wait: WAIT })).toEqual({ ok: false, error: "The list holds something that isn't a profile's name." });
    expect(profileListArg({ usernames: ["sample.user", "not a name"], wait: WAIT })).toEqual({ ok: false, error: '"not a name" isn\'t a profile.' });
    expect(profileListArg({ usernames: ["sample.user"], wait: { min: "2", max: 5 } })).toEqual(WAIT_PROBLEM);
    expect(profileListArg({ usernames: ["sample.user"], wait: { min: 2, max: Number.NaN } })).toEqual(WAIT_PROBLEM);
    expect(profileListArg({ usernames: ["sample.user"], wait: { min: 2 } })).toEqual(WAIT_PROBLEM);
    expect(profileListArg({ usernames: ["sample.user"], wait: "2-5" })).toEqual(WAIT_PROBLEM);
    expect(profileListArg({ usernames: ["sample.user"] })).toEqual(WAIT_PROBLEM);
  });
});
