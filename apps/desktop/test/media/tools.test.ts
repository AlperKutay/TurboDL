import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolManager, denoAssetName, extractZip, tarCommand, ytdlpAssetName } from "../../src/main/media/tools";
import { makeZip } from "../fixtures/zip";
import { startTestServer, type TestServer } from "../fixtures/test-server";

let server: TestServer;
let dir: string;
beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-tools-"));
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("asset names", () => {
  it("chooses per platform", () => {
    expect(ytdlpAssetName("win32")).toBe("yt-dlp.exe");
    expect(ytdlpAssetName("darwin")).toBe("yt-dlp_macos");
    expect(denoAssetName("win32", "x64")).toBe("deno-x86_64-pc-windows-msvc.zip");
    expect(denoAssetName("win32", "arm64")).toBe("deno-x86_64-pc-windows-msvc.zip");
    expect(denoAssetName("darwin", "arm64")).toBe("deno-aarch64-apple-darwin.zip");
    expect(denoAssetName("darwin", "x64")).toBe("deno-x86_64-apple-darwin.zip");
    expect(ytdlpAssetName("linux")).toBe("yt-dlp_linux");
    expect(denoAssetName("linux", "x64")).toBe("deno-x86_64-unknown-linux-gnu.zip");
  });
});

describe("ToolManager", () => {
  function manager(extracted: string[]) {
    return new ToolManager({
      dir: path.join(dir, "tools"),
      ffmpegPath: "/ffmpeg",
      platform: "darwin",
      arch: "arm64",
      ytdlpBaseUrl: server.url("/yt"),
      denoBaseUrl: server.url("/deno"),
      extractZip: async (zip, dest) => {
        extracted.push(path.basename(zip));
        writeFileSync(path.join(dest, "deno"), "deno-binary");
      },
    });
  }

  it("downloads yt-dlp and deno once", async () => {
    server.setFile("/yt/yt-dlp_macos", { data: Buffer.from("ytdlp-binary") });
    server.setFile("/deno/deno-aarch64-apple-darwin.zip", { data: Buffer.from("zip") });
    const extracted: string[] = [];
    const tm = manager(extracted);
    const statuses: string[] = [];
    const paths = await tm.ensure((s) => statuses.push(s));
    expect(paths).toEqual({ ytdlp: tm.ytdlpPath, deno: tm.denoPath, ffmpeg: "/ffmpeg" });
    expect(readFileSync(tm.ytdlpPath, "utf8")).toBe("ytdlp-binary");
    expect(extracted).toEqual(["deno-aarch64-apple-darwin.zip"]);
    expect(statuses.length).toBe(2);
    const before = server.requests.length;
    await tm.ensure();
    expect(server.requests.length).toBe(before);
  });

  it("works without deno when its download fails", async () => {
    server.setFile("/yt/yt-dlp_macos", { data: Buffer.from("ytdlp-binary") });
    const tm = manager([]);
    const paths = await tm.ensure();
    expect(paths.deno).toBeNull();
    expect(existsSync(tm.ytdlpPath)).toBe(true);
  });

  it("fails when yt-dlp cannot be downloaded", async () => {
    await expect(manager([]).ensure()).rejects.toMatchObject({ status: 404 });
  });

  it("downloads yt-dlp_linux and unpacks Deno without tar on Linux", async () => {
    server.setFile("/yt/yt-dlp_linux", { data: Buffer.from("ytdlp-binary") });
    server.setFile("/deno/deno-x86_64-unknown-linux-gnu.zip", { data: makeZip([{ name: "deno", data: "deno-binary" }]) });
    const tm = new ToolManager({
      dir: path.join(dir, "tools"),
      ffmpegPath: null,
      platform: "linux",
      arch: "x64",
      ytdlpBaseUrl: server.url("/yt"),
      denoBaseUrl: server.url("/deno"),
    });
    const paths = await tm.ensure();
    expect(paths.deno).toBe(tm.denoPath);
    expect(readFileSync(tm.denoPath, "utf8")).toBe("deno-binary");
    expect(existsSync(path.join(dir, "tools", "deno-x86_64-unknown-linux-gnu.zip"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(tm.denoPath).mode & 0o111).not.toBe(0);
  });

  it("updates yt-dlp when it is older than a week", async () => {
    const updates: string[] = [];
    const tm = new ToolManager({ dir, ffmpegPath: null, platform: "darwin", runUpdate: async (p) => void updates.push(p) });
    writeFileSync(tm.ytdlpPath, "x");
    await tm.updateIfStale();
    expect(updates).toEqual([]);
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    utimesSync(tm.ytdlpPath, old, old);
    await tm.updateIfStale();
    expect(updates).toEqual([tm.ytdlpPath]);
    expect(Date.now() - statSync(tm.ytdlpPath).mtimeMs).toBeLessThan(60_000);
  });
});

describe("extractZip", () => {
  it.skipIf(process.platform === "linux")("extracts a zip with the system tar", async () => {
    const out = path.join(dir, "out");
    mkdirSync(out);
    writeFileSync(path.join(dir, "hello.txt"), "merhaba");
    const zip = path.join(dir, "a.zip");
    const made = spawnSync(tarCommand(), ["-a", "-cf", zip, "-C", dir, "hello.txt"]);
    expect(made.status).toBe(0);
    await extractZip(zip, out);
    expect(readFileSync(path.join(out, "hello.txt"), "utf8")).toBe("merhaba");
  });
});
