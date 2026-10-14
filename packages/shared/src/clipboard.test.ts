import { describe, expect, it } from "vitest";
import { clipboardLink } from "./clipboard";

const exts = ["zip", "mp4", "pdf"];

describe("clipboardLink", () => {
  it("accepts a copied link to a file type on the capture list", () => {
    expect(clipboardLink("https://files.example.com/a/setup.ZIP", exts)).toBe("https://files.example.com/a/setup.ZIP");
    expect(clipboardLink("  http://x.example/film.mp4\n", exts)).toBe("http://x.example/film.mp4");
  });

  it("reads the extension from the path, not the query string or fragment", () => {
    expect(clipboardLink("https://x.example/get/report.pdf?token=a.b#page=2", exts)).toBe("https://x.example/get/report.pdf?token=a.b#page=2");
    expect(clipboardLink("https://x.example/download?file=a.zip", exts)).toBeNull();
  });

  it("decodes encoded file names", () => {
    expect(clipboardLink("https://x.example/T%C3%BCrk%C3%A7e%20dosya.zip", exts)).toBe("https://x.example/T%C3%BCrk%C3%A7e%20dosya.zip");
  });

  it("ignores text that is not a single http(s) link to a listed file type", () => {
    expect(clipboardLink("https://x.example/page.html", exts)).toBeNull();
    expect(clipboardLink("https://x.example/", exts)).toBeNull();
    expect(clipboardLink("ftp://x.example/a.zip", exts)).toBeNull();
    expect(clipboardLink("download: https://x.example/a.zip", exts)).toBeNull();
    expect(clipboardLink("a.zip", exts)).toBeNull();
    expect(clipboardLink(`https://x.example/${"a".repeat(2000)}.zip`, exts)).toBeNull();
    expect(clipboardLink("", exts)).toBeNull();
  });
});
