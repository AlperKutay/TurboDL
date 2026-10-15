import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { makeClips, streamsOf } from "../test/fixtures/media";
import { httpPostJson, launchApp } from "./helpers";

// The media window lists an HLS stream's qualities (read by TurboDL, no yt-dlp)
// and TurboDL downloads the chosen one with its own engine and ffmpeg.
test("an HLS stream picked in the media window is downloaded by TurboDL's own engine", async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), "turbodl-e2e-hls-"));
  const clips = makeClips(work);
  const site = http.createServer((req, res) => {
    const p = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (p === "/master.m3u8") {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=700000,RESOLUTION=320x240\nav/index.m3u8\n");
      return;
    }
    const file = path.join(clips.hls.av, path.basename(p));
    if (p.startsWith("/av/") && existsSync(file)) {
      res.writeHead(200);
      res.end(readFileSync(file));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const { app, userData, baseDir, port } = await launchApp();
  try {
    const main = await app.firstWindow();
    const dialogOpened = app.waitForEvent("window");
    expect(await httpPostJson(port, "/v1/media", { pageUrl: `${siteUrl}/watch`, title: "Stream test", items: [{ url: `${siteUrl}/master.m3u8`, kind: "hls" }] })).toBe(202);
    const dialog = await dialogOpened;
    await expect(dialog.getByText("240p · 0.7 Mbps")).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText("Audio only (MP3)")).toBeVisible();
    await dialog.getByRole("button", { name: "Download now", exact: true }).click();

    const file = path.join(baseDir, "Video", "Stream test.mp4");
    await expect(main.locator("tr[data-status='completed']")).toContainText("Stream test.mp4", { timeout: 60_000 });
    expect(streamsOf(file)).toEqual(["Video: h264", "Audio: aac"]);
    expect(readdirSync(path.join(baseDir, "Video")).filter((n) => n.includes(".turbodl"))).toEqual([]);
  } finally {
    await app.close();
    await new Promise<void>((r) => site.close(() => r()));
    rmSync(userData, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
