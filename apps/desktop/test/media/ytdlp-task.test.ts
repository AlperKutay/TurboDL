import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord } from "@turbodl/shared";
import { withCookieFile } from "../../src/main/media/cookies";
import { YtdlpTask, fetchMediaInfo } from "../../src/main/media/ytdlp-task";
import type { ToolPaths } from "../../src/main/media/tools";

const FAKE = path.join(__dirname, "..", "fixtures", "fake-ytdlp.mjs");
const command = () => ({ file: process.execPath, args: [FAKE] });
const tools: ToolPaths = { ytdlp: "unused", deno: null, ffmpeg: null };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-ytdlp-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function record(mode: string): DownloadRecord {
  return {
    id: "y1",
    kind: "ytdlp",
    url: `https://video.example/${mode}`,
    pageUrl: `https://video.example/${mode}`,
    filename: "Clip.mp4",
    dir,
    category: "video",
    size: null,
    received: 0,
    status: "queued",
    headers: {},
    resumable: false,
    segments: [],
    ytdlp: { formatSelector: "bv*+ba/b", audioOnly: false },
    viaScheduler: false,
    createdAt: Date.now(),
  };
}

function task(rec: DownloadRecord, notes: string[] = []) {
  return new YtdlpTask(rec, {
    tools: async (onStatus) => {
      onStatus("downloading yt-dlp…");
      notes.push("asked");
      return tools;
    },
    connections: () => 4,
    command,
  });
}

describe("YtdlpTask", () => {
  it("completes, reads the UTF-8 file name and the final size", async () => {
    const rec = record("ok");
    await task(rec).start();
    expect(rec.status).toBe("completed");
    expect(rec.filename).toBe("Vidéo Zoë.mp4");
    expect(rec.size).toBe(1500);
    expect(existsSync(path.join(dir, "Vidéo Zoë.mp4"))).toBe(true);
  });

  it("adds up progress across separately downloaded parts", async () => {
    const rec = record("two-parts");
    const t = task(rec);
    const seen: number[] = [];
    const timer = setInterval(() => seen.push(rec.received), 5);
    await t.start();
    clearInterval(timer);
    expect(rec.status).toBe("completed");
    expect(Math.max(...seen)).toBeGreaterThan(1000);
  });

  it("reports yt-dlp errors", async () => {
    const rec = record("error");
    await task(rec).start();
    expect(rec.status).toBe("error");
    expect(rec.error).toBe("[generic] Unsupported URL: https://video.example/error");
  });

  it("pauses by killing the process", async () => {
    const rec = record("slow");
    const t = task(rec);
    const running = t.start();
    // wait for the first progress line; slow machines need longer to start the process
    for (let i = 0; i < 200 && rec.received === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(rec.received).toBeGreaterThan(0);
    t.pause();
    await running;
    expect(rec.status).toBe("paused");
  });

  it("fetches media info as JSON", async () => {
    const info = (await fetchMediaInfo(tools, "https://video.example/info", {}, { command })) as { title: string };
    expect(info.title).toBe("Info");
  });

  const loginCookie = { domain: "video.example", hostOnly: true, path: "/", secure: true, expires: 0, name: "session", value: "ok" };

  it("passes the stored browser cookies as a cookie file and deletes it afterwards", async () => {
    const rec = record("login");
    rec.ytdlp = { ...rec.ytdlp!, cookies: [loginCookie] };
    await task(rec).start();
    expect(rec.status).toBe("completed");
    const used = readFileSync(path.join(dir, "cookie-file.txt"), "utf8");
    expect(used).toContain("turbodl-ck-");
    expect(existsSync(used)).toBe(false);
  });

  it("explains how to download a video that needs a login", async () => {
    const rec = record("login");
    await task(rec).start();
    expect(rec.status).toBe("error");
    expect(rec.error).toContain("in your browser while signed in");
    const expired = record("login");
    expired.ytdlp = { ...expired.ytdlp!, cookies: [{ ...loginCookie, value: "expired" }] };
    await task(expired).start();
    expect(expired.error).toContain("with your browser session either");
  });

  it("never sends cookies as a request header", async () => {
    const rec = record("ok");
    rec.headers = { Cookie: "a=1", Referer: "https://video.example/" };
    await task(rec).start();
    expect(rec.status).toBe("completed");
  });

  it("fetches media info with a cookie file when given one", async () => {
    await expect(fetchMediaInfo(tools, "https://video.example/login", {}, { command })).rejects.toThrow(/Sign in to confirm your age/);
    const info = await withCookieFile([loginCookie], (cookieFile) => fetchMediaInfo(tools, "https://video.example/login", {}, { command, cookieFile }));
    expect((info as { title: string }).title).toBe("Info");
  });
});
