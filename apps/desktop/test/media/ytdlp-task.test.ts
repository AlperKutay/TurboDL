import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord } from "@turbodl/shared";
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
    await new Promise((r) => setTimeout(r, 400));
    expect(rec.received).toBeGreaterThan(0);
    t.pause();
    await running;
    expect(rec.status).toBe("paused");
  });

  it("fetches media info as JSON", async () => {
    const info = (await fetchMediaInfo(tools, "https://video.example/info", {}, command)) as { title: string };
    expect(info.title).toBe("Info");
  });
});
