import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SAVE_OPTIONS } from "@turbodl/shared";
import { mediaKindsArg, saveOptionsArg } from "../src/main/ipc";

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
