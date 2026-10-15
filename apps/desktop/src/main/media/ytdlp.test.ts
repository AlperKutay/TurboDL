import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDownloadArgs,
  buildInfoArgs,
  formatOptionsFromInfo,
  heightSelector,
  lastErrorLine,
  loginHint,
  needsLogin,
  parseFileLine,
  parseProgressLine,
} from "./ytdlp";

const base = {
  url: "https://www.youtube.com/watch?v=abc",
  outputDir: "/dl/Video",
  formatSelector: heightSelector(720),
  audioOnly: false,
  headers: {},
  ffmpegPath: "/tools/ffmpeg",
  denoPath: "/tools/deno",
  connections: 8,
};

describe("buildDownloadArgs", () => {
  it("builds a video download command", () => {
    const args = buildDownloadArgs(base);
    expect(args.slice(-2)).toEqual(["--", base.url]);
    expect(args).toContain("--newline");
    expect(args).toContain("--no-playlist");
    expect(args[args.indexOf("-N") + 1]).toBe("8");
    expect(args[args.indexOf("-f") + 1]).toBe(heightSelector(720));
    expect(args[args.indexOf("-o") + 1]).toBe(path.join("/dl/Video", "%(title).150B.%(ext)s"));
    expect(args[args.indexOf("--merge-output-format") + 1]).toBe("mp4");
    expect(args[args.indexOf("--ffmpeg-location") + 1]).toBe("/tools/ffmpeg");
    expect(args[args.indexOf("--js-runtimes") + 1]).toBe("deno:/tools/deno");
    expect(args[args.indexOf("--progress-template") + 1]).toMatch(/^download:TDLPROG /);
    expect(args[args.indexOf("--print") + 1]).toBe("after_move:TDLFILE %(filepath)s");
  });

  it("extracts mp3 for audio-only and passes headers, but never the Cookie header", () => {
    const args = buildDownloadArgs({ ...base, audioOnly: true, formatSelector: "ba/b", headers: { Referer: "https://a/", Cookie: "x=1" }, denoPath: null, ffmpegPath: null });
    expect(args).toEqual(expect.arrayContaining(["-x", "--audio-format", "mp3"]));
    expect(args).not.toContain("--merge-output-format");
    expect(args).not.toContain("--js-runtimes");
    expect(args).not.toContain("--ffmpeg-location");
    const headerValues = args.filter((_, i) => args[i - 1] === "--add-headers");
    expect(headerValues).toEqual(["Referer:https://a/"]);
  });

  it("passes browser cookies as a cookie file", () => {
    const args = buildDownloadArgs({ ...base, cookieFile: "/tmp/turbodl-ck-1/cookies.txt" });
    expect(args[args.indexOf("--cookies") + 1]).toBe("/tmp/turbodl-ck-1/cookies.txt");
    expect(args.indexOf("--cookies")).toBeLessThan(args.indexOf("--"));
    expect(buildDownloadArgs(base)).not.toContain("--cookies");
  });

  it("clamps the connection count", () => {
    expect(buildDownloadArgs({ ...base, connections: 64 })[buildDownloadArgs(base).indexOf("-N") + 1]).toBe("16");
  });
});

describe("buildInfoArgs", () => {
  it("asks for JSON without downloading", () => {
    expect(buildInfoArgs("https://v.example/1", "/tools/deno", { Referer: "https://v.example/" })).toEqual([
      "-J",
      "--no-playlist",
      "--no-warnings",
      "--js-runtimes",
      "deno:/tools/deno",
      "--add-headers",
      "Referer:https://v.example/",
      "--",
      "https://v.example/1",
    ]);
  });

  it("adds the cookie file and leaves the Cookie header out", () => {
    expect(buildInfoArgs("https://v.example/1", null, { Cookie: "a=1" }, "/tmp/c.txt")).toEqual(["-J", "--no-playlist", "--no-warnings", "--cookies", "/tmp/c.txt", "--", "https://v.example/1"]);
  });
});

describe("output parsing", () => {
  it("parses progress lines", () => {
    expect(parseProgressLine("TDLPROG 1024 2048 NA 512.5 2")).toEqual({ downloaded: 1024, total: 2048, speed: 512.5, eta: 2 });
    expect(parseProgressLine("TDLPROG 1024 NA 4096.0 NA NA")).toEqual({ downloaded: 1024, total: 4096, speed: null, eta: null });
    expect(parseProgressLine("[download] Destination: x.mp4")).toBeNull();
    expect(parseProgressLine("TDLPROG NA NA NA NA NA")).toBeNull();
  });

  it("parses the final file line, keeping spaces", () => {
    expect(parseFileLine("TDLFILE C:\\dl\\Vidéo Zoë.mp4")).toBe("C:\\dl\\Vidéo Zoë.mp4");
    expect(parseFileLine("something else")).toBeNull();
  });

  it("extracts the last ERROR line", () => {
    expect(lastErrorLine("WARNING: x\nERROR: [youtube] abc: Video unavailable\n")).toBe("[youtube] abc: Video unavailable");
    expect(lastErrorLine("just text\n")).toBe("just text");
    expect(lastErrorLine("")).toBe("yt-dlp failed.");
  });
});

describe("formatOptionsFromInfo", () => {
  it("offers each video height (desc) and audio", () => {
    const info = {
      title: "Clip",
      formats: [
        { height: 360, vcodec: "avc1", acodec: "none" },
        { height: 1080, vcodec: "avc1", acodec: "none" },
        { height: 720, vcodec: "vp9", acodec: "none" },
        { height: 720, vcodec: "avc1", acodec: "none" },
        { vcodec: "none", acodec: "mp4a" },
        { height: 2160, vcodec: "vp9", acodec: "none" },
      ],
    };
    const { title, options } = formatOptionsFromInfo(info);
    expect(title).toBe("Clip");
    expect(options.map((o) => o.label)).toEqual(["2160p (4K)", "1080p", "720p", "360p", "Audio only (MP3)"]);
    expect(options[1]).toEqual({ id: "h1080", label: "1080p", formatSelector: heightSelector(1080), audioOnly: false });
    expect(options.at(-1)).toMatchObject({ id: "audio", formatSelector: "ba/b", audioOnly: true });
  });

  it("falls back to best quality when heights are unknown", () => {
    const { title, options } = formatOptionsFromInfo({ formats: [{ vcodec: "unknown" }] });
    expect(title).toBe("video");
    expect(options.map((o) => o.id)).toEqual(["best", "audio"]);
  });
});

describe("login errors", () => {
  it("recognises yt-dlp's sign-in errors", () => {
    expect(needsLogin("[youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users. Use --cookies-from-browser or --cookies for the authentication.")).toBe(true);
    expect(needsLogin("[youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.")).toBe(true);
    expect(needsLogin("[youtube] abc: Private video. Sign in if you've been granted access to this video")).toBe(true);
    expect(needsLogin("[generic] Unsupported URL: https://x.example/")).toBe(false);
    expect(needsLogin("HTTP Error 404: Not Found")).toBe(false);
  });

  it("explains what to do, depending on whether the browser session was tried", () => {
    expect(loginHint("Sign in to confirm your age", false)).toContain("in your browser while signed in");
    const tried = loginHint("Sign in to confirm your age", true);
    expect(tried).toContain("with your browser session either");
    expect(tried).toContain("(yt-dlp: Sign in to confirm your age)");
  });
});

describe("buildInfoArgs with a format selector", () => {
  it("asks yt-dlp for the chosen formats when a selector is given", () => {
    expect(buildInfoArgs("https://v.example/w", null, {}, null, "bv*+ba/b").slice(0, 5)).toEqual(["-J", "--no-playlist", "--no-warnings", "-f", "bv*+ba/b"]);
    expect(buildInfoArgs("https://v.example/w", null, {})).not.toContain("-f");
  });
});
