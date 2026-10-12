import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, DEFAULT_CAPTURE_EXTENSIONS, categorize, extensionFromMime, getExtension } from "./index";

describe("getExtension", () => {
  it("returns the lower-case extension of the last path part", () => {
    expect(getExtension("a/b/Setup.EXE")).toBe("exe");
    expect(getExtension("C:\\x\\archive.tar.gz")).toBe("gz");
  });

  it("returns an empty string when there is no extension", () => {
    expect(getExtension("README")).toBe("");
    expect(getExtension(".hidden")).toBe("");
    expect(getExtension("file.")).toBe("");
  });
});

describe("categorize", () => {
  it("maps extensions to categories", () => {
    expect(categorize("film.MKV")).toBe("video");
    expect(categorize("song.mp3")).toBe("music");
    expect(categorize("app.dmg")).toBe("programs");
    expect(categorize("a.7z")).toBe("archives");
    expect(categorize("cv.pdf")).toBe("documents");
    expect(categorize("p.png")).toBe("images");
    expect(categorize("data.xyz")).toBe("other");
  });

  it("falls back to the MIME type when the name has no extension", () => {
    expect(categorize("download", "application/zip")).toBe("archives");
    expect(categorize("download", "application/octet-stream")).toBe("other");
  });
});

describe("extensionFromMime", () => {
  it("ignores parameters and case", () => {
    expect(extensionFromMime("Video/MP4; codecs=avc1")).toBe("mp4");
    expect(extensionFromMime(undefined)).toBe("");
  });
});

describe("defaults", () => {
  it("captures common download types but not page assets", () => {
    for (const ext of ["zip", "exe", "dmg", "mp4", "mp3", "pdf", "iso"]) expect(DEFAULT_CAPTURE_EXTENSIONS).toContain(ext);
    for (const ext of ["ts", "png", "txt", "html"]) expect(DEFAULT_CAPTURE_EXTENSIONS).not.toContain(ext);
  });

  it("has English labels", () => {
    expect(CATEGORY_LABELS.music).toBe("Music");
    expect(CATEGORY_LABELS.archives).toBe("Archives");
  });
});
