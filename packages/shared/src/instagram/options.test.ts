import { describe, expect, it } from "vitest";
import { DEFAULT_SAVE_OPTIONS, effectiveSaveOptions, mediaKinds, profileName, profileUrl, saveJobOptions, saveOptionsProblem } from "./options";

describe("save options", () => {
  it("maps photos and videos to media kinds", () => {
    expect(mediaKinds({ photos: true, videos: false })).toEqual(["image"]);
    expect(mediaKinds({ photos: true, videos: true })).toEqual(["image", "video"]);
    expect(mediaKinds({ photos: false, videos: false })).toEqual([]);
  });

  it("names why a backup cannot start", () => {
    expect(saveOptionsProblem(DEFAULT_SAVE_OPTIONS)).toBeNull();
    expect(saveOptionsProblem({ ...DEFAULT_SAVE_OPTIONS, posts: false, highlights: false, tagged: false })).toBe("Pick at least one of posts, highlights and tagged posts.");
    expect(saveOptionsProblem({ ...DEFAULT_SAVE_OPTIONS, photos: false, videos: false })).toBe("Pick photos, videos or both.");
  });

  it("takes tagged posts only with a session", () => {
    expect(effectiveSaveOptions({ ...DEFAULT_SAVE_OPTIONS }, false).tagged).toBe(false);
    expect(effectiveSaveOptions({ ...DEFAULT_SAVE_OPTIONS }, true).tagged).toBe(true);
  });

  it("turns save options into job options, leaving out the API's defaults", () => {
    expect(saveJobOptions(DEFAULT_SAVE_OPTIONS)).toEqual({ highlights: true, tagged: true });
    expect(saveJobOptions({ ...DEFAULT_SAVE_OPTIONS, posts: false, tagged: false, videos: false })).toEqual({ posts: false, highlights: true, videos: false });
  });
});

describe("profileName", () => {
  it("takes a profile link or a username typed in, and nothing else", () => {
    expect(profileName("@Sample.User")).toBe("sample.user");
    expect(profileName("https://www.instagram.com/Sample.User/?igsh=x")).toBe("sample.user");
    expect(profileName(" @sample_user.2 ")).toBe("sample_user.2");
    expect(profileName("sample.user")).toBe("sample.user");
    for (const text of ["https://www.instagram.com/p/C1abcDEF/", "https://example.com/sample.user", "a-b", "not a name!", "", "@"]) expect(profileName(text), text).toBeNull();
  });
});

describe("profileUrl", () => {
  it("encodes the name", () => {
    expect(profileUrl("demo.person")).toBe("https://www.instagram.com/demo.person/");
    expect(profileUrl("a b")).toBe("https://www.instagram.com/a%20b/");
  });
});
