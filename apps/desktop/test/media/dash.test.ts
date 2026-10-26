import { describe, expect, it } from "vitest";
import { bestAudio, dashOptions, expandTemplate, parseIsoDuration, parseMpd } from "../../src/main/media/dash";

const AKAMAI = `<?xml version="1.0" encoding="utf-8"?>
<MPD mediaPresentationDuration="PT634.566S" type="static" xmlns="urn:mpeg:dash:schema:mpd:2011">
 <BaseURL>./</BaseURL>
 <Period>
  <AdaptationSet mimeType="video/mp4" contentType="video">
   <SegmentTemplate duration="120" timescale="30" media="$RepresentationID$/$RepresentationID$_$Number$.m4v" startNumber="1" initialization="$RepresentationID$/$RepresentationID$_0.m4v"/>
   <Representation id="bbb_30fps_1280x720_4000k" codecs="avc1.64001f" bandwidth="4952892" width="1280" height="720" frameRate="30"/>
   <Representation id="bbb_30fps_1920x1080_8000k" codecs="avc1.640028" bandwidth="9914554" width="1920" height="1080" frameRate="30"/>
   <Representation id="bbb_30fps_320x180_200k" codecs="avc1.64000d" bandwidth="254320" width="320" height="180" frameRate="30"/>
   <Representation id="bbb_30fps_320x180_400k" codecs="avc1.64000d" bandwidth="507246" width="320" height="180" frameRate="30"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" contentType="audio">
   <SegmentTemplate duration="192512" timescale="48000" media="$RepresentationID$/$RepresentationID$_$Number$.m4a" startNumber="1" initialization="$RepresentationID$/$RepresentationID$_0.m4a"/>
   <Representation id="bbb_a64k" codecs="mp4a.40.5" bandwidth="67071" audioSamplingRate="48000"/>
  </AdaptationSet>
 </Period>
</MPD>`;
const URL_AKAMAI = "https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd";

describe("DASH helpers", () => {
  it("reads ISO 8601 durations", () => {
    expect(parseIsoDuration("PT634.566S")).toBeCloseTo(634.566);
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
    expect(parseIsoDuration("P1DT1S")).toBe(86401);
    expect(parseIsoDuration("bad")).toBeNull();
    expect(parseIsoDuration(undefined)).toBeNull();
  });

  it("expands template identifiers, widths and $$", () => {
    expect(expandTemplate("$RepresentationID$/s_$Number%05d$_$Time$_$Bandwidth$$$.m4s", { RepresentationID: "v1", Bandwidth: 800, Number: 7, Time: 9000 })).toBe(
      "v1/s_00007_9000_800$.m4s",
    );
  });
});

describe("parseMpd", () => {
  it("builds numbered fragments from a SegmentTemplate with duration", () => {
    const m = parseMpd(AKAMAI, URL_AKAMAI);
    expect(m).toMatchObject({ live: false, multiPeriod: false });
    const hd = m.representations.find((r) => r.id === "bbb_30fps_1920x1080_8000k")!;
    expect(hd).toMatchObject({ kind: "video", height: 1080, width: 1920, frameRate: 30, mimeType: "video/mp4", protected: false });
    if (hd.source?.kind !== "fragments") throw new Error("expected fragments");
    expect(hd.source.plan.fragments).toHaveLength(159);
    expect(hd.source.plan.init?.url).toBe("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_0.m4v");
    expect(hd.source.plan.fragments[0].url).toBe("https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps_1920x1080_8000k/bbb_30fps_1920x1080_8000k_1.m4v");
    expect(hd.source.plan.fragments[158].url).toMatch(/_159\.m4v$/);
    const audio = bestAudio(m)!;
    expect(audio.id).toBe("bbb_a64k");
    if (audio.source?.kind !== "fragments") throw new Error("expected fragments");
    expect(audio.source.plan.fragments).toHaveLength(159);
  });

  it("offers one quality per height plus audio only", () => {
    expect(dashOptions(parseMpd(AKAMAI, URL_AKAMAI))).toEqual([
      { id: "bbb_30fps_1920x1080_8000k", label: "1080p · 9.9 Mbps", formatSelector: "bbb_30fps_1920x1080_8000k", audioOnly: false, height: 1080 },
      { id: "bbb_30fps_1280x720_4000k", label: "720p · 5.0 Mbps", formatSelector: "bbb_30fps_1280x720_4000k", audioOnly: false, height: 720 },
      { id: "bbb_30fps_320x180_400k", label: "180p · 0.5 Mbps", formatSelector: "bbb_30fps_320x180_400k", audioOnly: false, height: 180 },
      { id: "audio", label: "Audio only (MP3)", formatSelector: "audio", audioOnly: true },
    ]);
  });

  it("follows a SegmentTimeline with $Time$ and a repeat to the end of the period", () => {
    const xml = `<MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="video" mimeType="video/mp4">
      <SegmentTemplate timescale="1000" media="v/$Time$.m4s" initialization="v/init.mp4">
        <SegmentTimeline><S t="0" d="4000"/><S d="3000" r="-1"/></SegmentTimeline>
      </SegmentTemplate>
      <Representation id="v" bandwidth="1000" height="360"/></AdaptationSet></Period></MPD>`;
    const rep = parseMpd(xml, "https://cdn.example/a/manifest.mpd").representations[0];
    if (rep.source?.kind !== "fragments") throw new Error("expected fragments");
    expect(rep.source.plan.fragments.map((f) => f.url.split("/").pop())).toEqual(["0.m4s", "4000.m4s", "7000.m4s"]);
  });

  it("reads a SegmentList with media ranges", () => {
    const xml = `<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="audio/mp4">
      <Representation id="a" bandwidth="128000" codecs="mp4a.40.2"><BaseURL>audio.mp4</BaseURL>
        <SegmentList><Initialization range="0-799"/><SegmentURL mediaRange="800-1999"/><SegmentURL mediaRange="2000-2999"/></SegmentList>
      </Representation></AdaptationSet></Period></MPD>`;
    const rep = parseMpd(xml, "https://cdn.example/m/x.mpd").representations[0];
    expect(rep.kind).toBe("audio");
    if (rep.source?.kind !== "fragments") throw new Error("expected fragments");
    expect(rep.source.plan.init).toEqual({ url: "https://cdn.example/m/audio.mp4", range: { start: 0, end: 799 }, sequence: 0 });
    expect(rep.source.plan.fragments.map((f) => f.range)).toEqual([
      { start: 800, end: 1999 },
      { start: 2000, end: 2999 },
    ]);
  });

  it("treats SegmentBase or a bare BaseURL as one file, through the BaseURL chain", () => {
    const xml = `<MPD type="static" mediaPresentationDuration="PT8S"><BaseURL>https://media.example/root/</BaseURL><Period><BaseURL>p1/</BaseURL>
      <AdaptationSet mimeType="video/webm"><BaseURL>set/</BaseURL>
        <Representation id="w" bandwidth="500000" height="480" codecs="vp9"><BaseURL>video.webm</BaseURL><SegmentBase indexRange="0-100"/></Representation>
      </AdaptationSet></Period></MPD>`;
    expect(parseMpd(xml, "https://cdn.example/x.mpd").representations[0].source).toEqual({ kind: "file", url: "https://media.example/root/p1/set/video.webm" });
  });

  it("flags DRM, live and multi-period manifests", () => {
    const drm = `<MPD type="static" mediaPresentationDuration="PT8S"><Period><AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
    expect(parseMpd(drm, "https://x.example/a.mpd").representations[0].protected).toBe(true);
    expect(parseMpd(`<MPD type="dynamic"><Period/></MPD>`, "https://x.example/a.mpd").live).toBe(true);
    expect(parseMpd(`<MPD type="static"><Period duration="PT1S"/><Period duration="PT1S"/></MPD>`, "https://x.example/a.mpd").multiPeriod).toBe(true);
  });

  it("gives no source when the length of a numbered template is unknown", () => {
    const xml = `<MPD type="static"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="4" media="$Number$.m4s"/><Representation id="v" bandwidth="1"/></AdaptationSet></Period></MPD>`;
    expect(parseMpd(xml, "https://x.example/a.mpd").representations[0].source).toBeNull();
  });
});
