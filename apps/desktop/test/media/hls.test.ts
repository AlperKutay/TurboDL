import { describe, expect, it } from "vitest";
import { audioFor, bestVariant, hlsOptions, lowestVariant, parseAttributes, parseHls, pickVariant, variantKey, type HlsMaster } from "../../src/main/media/hls";
import { qualityLabel } from "../../src/main/media/quality";

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",DEFAULT=YES,URI="a1/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud2",NAME="English",DEFAULT=YES,URI="a2/prog_index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="sub1",NAME="English",URI="s1/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2177116,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=960x540,FRAME-RATE=60.000,AUDIO="aud1"
v5/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8001098,CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60.000,AUDIO="aud1"
v9/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6312875,CODECS="avc1.64002a,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=60.000,AUDIO="aud1"
v8/prog_index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=8223601,CODECS="avc1.64002a,ac-3",RESOLUTION=1920x1080,FRAME-RATE=60.000,AUDIO="aud2"
v9/prog_index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=541052,CODECS="avc1.640015,mp4a.40.2",RESOLUTION=480x270,FRAME-RATE=30.000,AUDIO="aud1"
v2/prog_index.m3u8
`;
const BASE = "https://cdn.example/hls/master.m3u8?token=1";

function master(): HlsMaster {
  const pl = parseHls(MASTER, BASE);
  if (pl.type !== "master") throw new Error("expected master");
  return pl.master;
}

describe("parseAttributes", () => {
  it("keeps commas inside quotes", () => {
    expect(parseAttributes('BANDWIDTH=1,CODECS="avc1.6,mp4a.40.2",RESOLUTION=1x2')).toEqual({ BANDWIDTH: "1", CODECS: "avc1.6,mp4a.40.2", RESOLUTION: "1x2" });
  });
});

describe("parseHls master", () => {
  it("reads variants and audio renditions with absolute URLs", () => {
    const m = master();
    expect(m.variants).toHaveLength(5);
    expect(m.variants[1]).toEqual({
      url: "https://cdn.example/hls/v9/prog_index.m3u8",
      bandwidth: 8001098,
      width: 1920,
      height: 1080,
      frameRate: 60,
      codecs: "avc1.64002a,mp4a.40.2",
      audioGroup: "aud1",
    });
    expect(m.audio).toEqual([
      { groupId: "aud1", name: "English", url: "https://cdn.example/hls/a1/prog_index.m3u8", isDefault: true },
      { groupId: "aud2", name: "English", url: "https://cdn.example/hls/a2/prog_index.m3u8", isDefault: true },
    ]);
  });

  it("prefers AAC variants and keeps one entry per height", () => {
    const options = hlsOptions(master());
    expect(options.map((o) => o.label)).toEqual(["1080p60 · 8.0 Mbps", "540p60 · 2.2 Mbps", "270p · 0.5 Mbps", "Audio only (MP3)"]);
    expect(options[0]).toEqual({ id: "1920x1080@8001098", label: "1080p60 · 8.0 Mbps", formatSelector: "1920x1080@8001098", audioOnly: false });
    expect(options[3]).toMatchObject({ id: "audio", audioOnly: true });
  });

  it("finds a variant by key, or the closest one of the same height", () => {
    const m = master();
    expect(pickVariant(m, "1920x1080@6312875")?.url).toContain("v8/");
    expect(pickVariant(m, "1920x1080@6400000")?.url).toContain("v8/");
    expect(pickVariant(m, "1280x720@3000000")).toBeNull();
    expect(variantKey(m.variants[0])).toBe("960x540@2177116");
    expect(bestVariant(m)?.url).toContain("v9/");
    expect(bestVariant(m)?.codecs).toContain("mp4a");
    expect(lowestVariant(m)?.url).toContain("v2/");
  });

  it("finds the separate audio of a variant", () => {
    const m = master();
    expect(audioFor(m, m.variants[1])?.url).toBe("https://cdn.example/hls/a1/prog_index.m3u8");
    expect(audioFor(m, { ...m.variants[1], audioGroup: null })).toBeNull();
  });

  it("labels variants without a resolution by bandwidth", () => {
    const pl = parseHls("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2100000\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000\nlower.m3u8\n", BASE);
    if (pl.type !== "master") throw new Error("expected master");
    expect(hlsOptions(pl.master).map((o) => o.label)).toEqual(["2.1 Mbps", "0.9 Mbps", "Audio only (MP3)"]);
    expect(qualityLabel(720, 25, 3_000_000)).toBe("720p · 3.0 Mbps");
  });
});

describe("parseHls media", () => {
  it("reads fragments, byte ranges, the init map and the end tag", () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:1
#EXT-X-MAP:URI="main.mp4",BYTERANGE="719@0"
#EXTINF:6.0,
#EXT-X-BYTERANGE:1508000@719
main.mp4
#EXTINF:6.0,
#EXT-X-BYTERANGE:1510244
main.mp4
#EXTINF:3.5,
other.mp4
#EXT-X-ENDLIST
`,
      "https://cdn.example/v5/prog_index.m3u8",
    );
    if (pl.type !== "media") throw new Error("expected media");
    expect(pl.media.live).toBe(false);
    expect(pl.media.drm).toBe(false);
    expect(pl.media.fmp4).toBe(true);
    expect(pl.media.duration).toBe(15.5);
    expect(pl.media.plan.init).toEqual({ url: "https://cdn.example/v5/main.mp4", range: { start: 0, end: 718 }, sequence: 0 });
    expect(pl.media.plan.fragments).toEqual([
      { url: "https://cdn.example/v5/main.mp4", range: { start: 719, end: 1508718 }, sequence: 1 },
      { url: "https://cdn.example/v5/main.mp4", range: { start: 1508719, end: 3018962 }, sequence: 2 },
      { url: "https://cdn.example/v5/other.mp4", sequence: 3 },
    ]);
  });

  it("reads AES-128 keys with and without an IV, and clear segments after METHOD=NONE", () => {
    const pl = parseHls(
      `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:4,
s0.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2"
#EXTINF:4,
s1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:4,
s2.ts
`,
      "https://cdn.example/x/index.m3u8",
    );
    if (pl.type !== "media") throw new Error("expected media");
    const [a, b, c] = pl.media.plan.fragments;
    expect(a.key).toEqual({ url: "https://keys.example/k1", iv: Buffer.from("000102030405060708090a0b0c0d0e0f", "hex") });
    expect(b.key).toEqual({ url: "https://cdn.example/x/k2", iv: null });
    expect(b.sequence).toBe(1);
    expect(c.key).toBeUndefined();
    expect(pl.media.live).toBe(true);
    expect(pl.media.fmp4).toBe(false);
  });

  it("flags SAMPLE-AES and vendor key formats as DRM", () => {
    for (const key of ['METHOD=SAMPLE-AES,URI="skd://x"', 'METHOD=AES-128,URI="k",KEYFORMAT="com.apple.streamingkeydelivery"']) {
      const pl = parseHls(`#EXTM3U\n#EXT-X-KEY:${key}\n#EXTINF:4,\ns.ts\n#EXT-X-ENDLIST\n`, BASE);
      if (pl.type !== "media") throw new Error("expected media");
      expect(pl.media.drm).toBe(true);
    }
  });

  it("puts a changed init map in front of the next segment", () => {
    const pl = parseHls(`#EXTM3U\n#EXT-X-MAP:URI="i1.mp4"\n#EXTINF:4,\na.m4s\n#EXT-X-MAP:URI="i2.mp4"\n#EXTINF:4,\nb.m4s\n#EXT-X-ENDLIST\n`, BASE);
    if (pl.type !== "media") throw new Error("expected media");
    expect(pl.media.plan.init?.url).toBe("https://cdn.example/hls/i1.mp4");
    expect(pl.media.plan.fragments.map((f) => f.url.split("/").pop())).toEqual(["a.m4s", "i2.mp4", "b.m4s"]);
  });
});
