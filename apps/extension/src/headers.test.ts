import { describe, expect, it } from "vitest";
import { basename, headerValue, isHttpUrl, sizeFromHeaders } from "./headers";

describe("headers", () => {
  const headers = [
    { name: "Content-Type", value: "video/mp4" },
    { name: "content-length", value: "1000" },
  ];

  it("reads headers case-insensitively", () => {
    expect(headerValue(headers, "content-type")).toBe("video/mp4");
    expect(headerValue(undefined, "x")).toBeUndefined();
  });

  it("prefers the Content-Range total over Content-Length", () => {
    expect(sizeFromHeaders(headers)).toBe(1000);
    expect(sizeFromHeaders([...headers, { name: "Content-Range", value: "bytes 0-999/52428800" }])).toBe(52428800);
    expect(sizeFromHeaders([{ name: "Content-Range", value: "bytes 0-999/*" }])).toBeUndefined();
    expect(sizeFromHeaders([])).toBeUndefined();
  });

  it("extracts base names and recognises http URLs", () => {
    expect(basename("C:\\Users\\a\\Downloads\\file.zip")).toBe("file.zip");
    expect(basename("/home/a/x.tar.gz")).toBe("x.tar.gz");
    expect(isHttpUrl("https://x.com")).toBe(true);
    expect(isHttpUrl("blob:https://x.com/1")).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });
});
