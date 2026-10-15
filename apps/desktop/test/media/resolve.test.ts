import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord } from "@turbodl/shared";
import { cookieHeaderFromYtdlp, createResolver, resolveDash, resolveHls, streamOptions, tracksFromYtdlpInfo } from "../../src/main/media/resolve";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const FAKE = path.join(__dirname, "..", "fixtures", "fake-ytdlp.mjs");
let server: TestServer;
let dir: string;
beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-resolve-"));
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const text = (s: string) => Buffer.from(s);
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",DEFAULT=YES,URI="a/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud"
v720/index.m3u8
`;
const MEDIA = "#EXTM3U\n#EXTINF:2,\ns0.ts\n#EXTINF:2,\ns1.ts\n#EXT-X-ENDLIST\n";

function serveHls() {
  server.setFile("/h/master.m3u8", { data: text(MASTER) });
  for (const p of ["/h/v360/index.m3u8", "/h/v720/index.m3u8", "/h/a/index.m3u8"]) server.setFile(p, { data: text(MEDIA) });
}

describe("cookieHeaderFromYtdlp", () => {
  it("keeps name=value pairs and drops cookie attributes", () => {
    expect(cookieHeaderFromYtdlp("GVCK=def; Domain=.googlevideo.com; Path=/; Secure; Expires=Thu, 01 Jan 2026 00:00:00 GMT; X=1; HttpOnly")).toBe("GVCK=def; X=1");
    expect(cookieHeaderFromYtdlp(undefined)).toBeNull();
    expect(cookieHeaderFromYtdlp("Domain=.x; Path=/")).toBeNull();
  });
});

describe("tracksFromYtdlpInfo", () => {
  const video = { format_id: "298", protocol: "https", url: "https://rr1.googlevideo.com/v?x=1", ext: "mp4", vcodec: "avc1", acodec: "none", filesize: 150524867, http_headers: { "User-Agent": "UA", Accept: "*/*" }, downloader_options: { http_chunk_size: 10485760 }, cookies: "GV=1; Domain=.googlevideo.com; Path=/" };
  const audio = { format_id: "140", protocol: "https", url: "https://rr1.googlevideo.com/a?x=1", ext: "m4a", vcodec: "none", acodec: "mp4a.40.2", filesize: 10271496, http_headers: { "User-Agent": "UA" } };

  it("turns requested formats into file tracks with chunking and scoped cookies", async () => {
    const r = await tracksFromYtdlpInfo({ requested_formats: [video, audio] });
    expect(r).toEqual({
      type: "tracks",
      tracks: [
        { id: "298", role: "video", ext: "mp4", headers: { "User-Agent": "UA", Accept: "*/*", Cookie: "GV=1" }, cookieHost: "rr1.googlevideo.com", source: { kind: "file", url: video.url, size: 150524867, chunkSize: 10485760 } },
        { id: "140", role: "audio", ext: "m4a", headers: { "User-Agent": "UA" }, cookieHost: "rr1.googlevideo.com", source: { kind: "file", url: audio.url, size: 10271496 } },
      ],
    });
  });

  it("reads a single chosen format from the top level", async () => {
    const r = await tracksFromYtdlpInfo({ ...audio, title: "Song" });
    expect(r.type === "tracks" && r.tracks.map((t) => t.id)).toEqual(["140"]);
  });

  it("downloads m3u8 formats itself and leaves other protocols and live videos to yt-dlp", async () => {
    server.setFile("/f/index.m3u8", { data: text(MEDIA) });
    const hls = { format_id: "hls-720", protocol: "m3u8_native", url: server.url("/f/index.m3u8"), ext: "mp4", vcodec: "avc1", acodec: "mp4a" };
    const r = await tracksFromYtdlpInfo({ requested_formats: [hls] });
    if (r.type !== "tracks") throw new Error("expected tracks");
    expect(r.tracks[0]).toMatchObject({ id: "hls-720", role: "av", ext: "ts", source: { kind: "fragments" } });
    expect(await tracksFromYtdlpInfo({ requested_formats: [{ ...video, protocol: "http_dash_segments" }] })).toEqual({ type: "fallback" });
    expect(await tracksFromYtdlpInfo({ ...video, is_live: true })).toEqual({ type: "fallback" });
  });

  it("refuses DRM", async () => {
    await expect(tracksFromYtdlpInfo({ ...video, has_drm: true })).rejects.toThrow("DRM-protected");
  });
});

describe("resolveHls", () => {
  it("picks the chosen variant and its separate audio", async () => {
    serveHls();
    const r = await resolveHls({ url: server.url("/h/master.m3u8"), variant: "640x360@900000" }, { Cookie: "s=1" });
    if (r.type !== "tracks") throw new Error("expected tracks");
    expect(r.tracks.map((t) => [t.id, t.role, t.ext])).toEqual([
      ["v:640x360@900000", "video", "ts"],
      ["a:aud:Main", "audio", "ts"],
    ]);
    expect(r.tracks[0].cookieHost).toBe("127.0.0.1");
    const first = r.tracks[0].source;
    expect(first.kind === "fragments" && first.plan.fragments[0].url).toBe(server.url("/h/v360/s0.ts"));
  });

  it("takes the best variant without a key, and only the audio playlist for audio only", async () => {
    serveHls();
    const best = await resolveHls({ url: server.url("/h/master.m3u8"), variant: null }, {});
    expect(best.type === "tracks" && best.tracks[0].id).toBe("v:1280x720@2500000");
    const audio = await resolveHls({ url: server.url("/h/master.m3u8"), variant: "audio" }, {});
    expect(audio.type === "tracks" && audio.tracks.map((t) => [t.id, t.role])).toEqual([["a:aud:Main", "audio"]]);
  });

  it("downloads a plain media playlist as one track and leaves live ones to yt-dlp", async () => {
    server.setFile("/m/index.m3u8", { data: text(MEDIA) });
    server.setFile("/m/live.m3u8", { data: text("#EXTM3U\n#EXTINF:2,\ns0.ts\n") });
    const r = await resolveHls({ url: server.url("/m/index.m3u8"), variant: null }, {});
    expect(r.type === "tracks" && r.tracks.map((t) => [t.id, t.role])).toEqual([["media", "av"]]);
    expect(await resolveHls({ url: server.url("/m/live.m3u8"), variant: null }, {})).toEqual({ type: "fallback" });
  });

  it("says when the chosen quality is gone, and refuses DRM", async () => {
    serveHls();
    await expect(resolveHls({ url: server.url("/h/master.m3u8"), variant: "1920x1080@5000000" }, {})).rejects.toThrow("The selected quality is no longer available.");
    server.setFile("/d/index.m3u8", { data: text('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:2,\ns.ts\n#EXT-X-ENDLIST\n') });
    await expect(resolveHls({ url: server.url("/d/index.m3u8"), variant: null }, {})).rejects.toThrow("This stream is DRM-protected and cannot be downloaded.");
  });
});

describe("resolveDash", () => {
  const MPD = `<MPD type="static" mediaPresentationDuration="PT4S"><Period>
    <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate duration="2" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
      <Representation id="v1" bandwidth="1000000" height="360"/><Representation id="v2" bandwidth="3000000" height="720"/></AdaptationSet>
    <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate duration="2" media="$RepresentationID$/$Number$.m4s" initialization="$RepresentationID$/init.mp4"/>
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2"/></AdaptationSet></Period></MPD>`;

  it("joins the chosen video with the best audio, or audio alone", async () => {
    server.setFile("/x.mpd", { data: text(MPD) });
    const r = await resolveDash({ url: server.url("/x.mpd"), video: "v2", audio: null }, {});
    expect(r.type === "tracks" && r.tracks.map((t) => [t.id, t.role, t.ext])).toEqual([
      ["v2", "video", "mp4"],
      ["a1", "audio", "m4a"],
    ]);
    const audio = await resolveDash({ url: server.url("/x.mpd"), video: null, audio: null }, {});
    expect(audio.type === "tracks" && audio.tracks.map((t) => t.id)).toEqual(["a1"]);
    await expect(resolveDash({ url: server.url("/x.mpd"), video: "v9", audio: null }, {})).rejects.toThrow("The selected quality is no longer available.");
  });

  it("leaves live and multi-period manifests to yt-dlp", async () => {
    server.setFile("/live.mpd", { data: text(`<MPD type="dynamic"><Period/></MPD>`) });
    expect(await resolveDash({ url: server.url("/live.mpd"), video: null, audio: null }, {})).toEqual({ type: "fallback" });
  });
});

describe("streamOptions", () => {
  it("lists HLS and DASH qualities, and explains live and DRM streams", async () => {
    serveHls();
    expect((await streamOptions("hls", server.url("/h/master.m3u8"), {})).map((o) => o.label)).toEqual(["720p · 2.5 Mbps", "360p · 0.9 Mbps", "Audio only (MP3)"]);
    server.setFile("/m/index.m3u8", { data: text(MEDIA) });
    expect((await streamOptions("hls", server.url("/m/index.m3u8"), {})).map((o) => o.id)).toEqual(["media", "audio"]);
    server.setFile("/m/live.m3u8", { data: text("#EXTM3U\n#EXTINF:2,\ns0.ts\n") });
    await expect(streamOptions("hls", server.url("/m/live.m3u8"), {})).rejects.toThrow("live stream");
    server.setFile("/p.mpd", { data: text(`<MPD type="static" mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="x"/><Representation id="v" bandwidth="1" height="360"/></AdaptationSet></Period></MPD>`) });
    await expect(streamOptions("dash", server.url("/p.mpd"), {})).rejects.toThrow("DRM-protected");
    await expect(streamOptions("hls", server.url("/nope.m3u8"), {})).rejects.toThrow("404");
  });
});

describe("createResolver", () => {
  function streamRecord(pageUrl: string, formatSelector: string): DownloadRecord {
    return {
      id: "s1", kind: "stream", url: pageUrl, filename: "Clip.mp4", dir, category: "video", size: null, received: 0, status: "queued",
      headers: { Cookie: "secret=1", Referer: pageUrl }, resumable: true, segments: [], viaScheduler: false, createdAt: 0,
      stream: { origin: { type: "ytdlp", pageUrl, formatSelector }, output: "mp4", tracks: [] },
    };
  }

  it("asks yt-dlp for the chosen formats of a page and never hands it the page cookie", async () => {
    server.setFile("/yt/page.info.json", { data: text(JSON.stringify({ title: "Local", requested_formats: [{ format_id: "v1", protocol: "https", url: server.url("/yt/v.mp4"), ext: "mp4", vcodec: "avc1", acodec: "none" }] })) });
    const resolve = createResolver({ tools: async () => ({ ytdlp: "unused", deno: null, ffmpeg: null }), command: () => ({ file: process.execPath, args: [FAKE] }) });
    const r = await resolve(streamRecord(server.url("/yt/page"), "bv*[height<=720]+ba/b"), new AbortController().signal);
    expect(r.type === "tracks" && r.tracks[0].id).toBe("v1");
    const info = server.requests.find((q) => q.path === "/yt/page.info.json")!;
    expect(decodeURIComponent(info.url.split("f=")[1])).toBe("bv*[height<=720]+ba/b");
  });

  it("explains a login wall in the same words as the quality list", async () => {
    const resolve = createResolver({ tools: async () => ({ ytdlp: "unused", deno: null, ffmpeg: null }), command: () => ({ file: process.execPath, args: [FAKE] }) });
    await expect(resolve(streamRecord("https://video.example/login", "b"), new AbortController().signal)).rejects.toThrow("in your browser while signed in");
  });
});
