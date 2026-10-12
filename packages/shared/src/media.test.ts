import { describe, expect, it } from "vitest";
import { addMediaItem, classifyMedia, describeMedia, type MediaItem } from "./index";

describe("classifyMedia", () => {
  it("detects HLS and DASH by type or extension", () => {
    expect(classifyMedia({ url: "https://cdn.x/a/master.m3u8" })).toBe("hls");
    expect(classifyMedia({ url: "https://cdn.x/a/play", contentType: "application/vnd.apple.mpegurl" })).toBe("hls");
    expect(classifyMedia({ url: "https://cdn.x/a/play", contentType: "application/x-mpegURL; charset=utf-8" })).toBe("hls");
    expect(classifyMedia({ url: "https://cdn.x/a/manifest.mpd" })).toBe("dash");
    expect(classifyMedia({ url: "https://cdn.x/a/m", contentType: "application/dash+xml" })).toBe("dash");
  });

  it("detects large direct media files", () => {
    expect(classifyMedia({ url: "https://x.com/v.mp4", contentType: "video/mp4", size: 5_000_000 })).toBe("file");
    expect(classifyMedia({ url: "https://x.com/stream", contentType: "audio/mpeg" })).toBe("file");
  });

  it("ignores small files, segments and googlevideo", () => {
    expect(classifyMedia({ url: "https://x.com/v.mp4", contentType: "video/mp4", size: 1000 })).toBeNull();
    expect(classifyMedia({ url: "https://x.com/seg-1.ts", contentType: "video/mp2t", size: 2_000_000 })).toBeNull();
    expect(classifyMedia({ url: "https://x.com/seg", contentType: "video/mp2t", size: 2_000_000 })).toBeNull();
    expect(classifyMedia({ url: "https://x.com/chunk.m4s", size: 2_000_000 })).toBeNull();
    expect(classifyMedia({ url: "https://rr1.googlevideo.com/videoplayback", contentType: "video/mp4", size: 9_000_000 })).toBeNull();
    expect(classifyMedia({ url: "https://x.com/page", contentType: "text/html" })).toBeNull();
    expect(classifyMedia({ url: "not a url" })).toBeNull();
  });
});

describe("addMediaItem", () => {
  const item = (n: number): MediaItem => ({ url: `https://x.com/${n}.mp4`, kind: "file" });

  it("de-duplicates by URL, moving the item to the end", () => {
    const list = addMediaItem(addMediaItem([item(1), item(2)], item(1)), item(3));
    expect(list.map((m) => m.url)).toEqual([item(2).url, item(1).url, item(3).url]);
  });

  it("keeps only the newest items", () => {
    let list: MediaItem[] = [];
    for (let i = 0; i < 5; i++) list = addMediaItem(list, item(i), 3);
    expect(list.map((m) => m.url)).toEqual([item(2).url, item(3).url, item(4).url]);
  });
});

describe("describeMedia", () => {
  it("labels kinds", () => {
    expect(describeMedia({ url: "https://x/a.m3u8", kind: "hls" })).toBe("HLS stream");
    expect(describeMedia({ url: "https://x/a.mpd", kind: "dash" })).toBe("DASH stream");
    expect(describeMedia({ url: "https://x/a.webm", kind: "file" })).toBe("Video file (webm)");
    expect(describeMedia({ url: "https://x/a", kind: "file", contentType: "audio/mpeg" })).toBe("Audio file (mp3)");
  });
});
