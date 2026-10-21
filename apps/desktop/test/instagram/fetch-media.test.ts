import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fetchMedia } from "../../src/main/instagram/fetch-media";
import { startTestServer, type TestServer } from "../fixtures/test-server";

let server: TestServer;
let dir = "";
beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-media-"));
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const headers = { Referer: "https://www.instagram.com/", "User-Agent": "Agent/1" };

describe("fetchMedia", () => {
  it("writes the whole file under its name and leaves no temporary file", async () => {
    const data = randomBytes(200_000);
    server.setFile("/a.jpg", { data, contentType: "image/jpeg" });
    const file = path.join(dir, "11.jpg");
    const seen: number[] = [];
    await fetchMedia(server.url("/a.jpg"), file, { headers, onProgress: (f) => seen.push(f) });
    expect(readFileSync(file).equals(data)).toBe(true);
    expect(readdirSync(dir)).toEqual(["11.jpg"]);
    expect(seen[seen.length - 1]).toBe(1);
  });

  it("leaves nothing behind when the server fails or drops the connection", async () => {
    server.setFile("/broken.jpg", { data: Buffer.alloc(10), status: 500 });
    await expect(fetchMedia(server.url("/broken.jpg"), path.join(dir, "1.jpg"), { headers })).rejects.toThrow();
    server.setFile("/dropped.mp4", { data: randomBytes(100_000), dropAfter: 1000, dropCount: 5 });
    await expect(fetchMedia(server.url("/dropped.mp4"), path.join(dir, "2.mp4"), { headers })).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves nothing behind when it is called off", async () => {
    server.setFile("/slow.mp4", { data: randomBytes(500_000), throttle: 100_000 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    await expect(fetchMedia(server.url("/slow.mp4"), path.join(dir, "3.mp4"), { headers, signal: stop.signal })).rejects.toThrow();
    expect(existsSync(path.join(dir, "3.mp4"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("sends what a browser sends for a picture, and no cookies", async () => {
    server.setFile("/b.jpg", { data: Buffer.from("x") });
    await fetchMedia(server.url("/b.jpg"), path.join(dir, "b.jpg"), { headers });
    const sent = server.requests[0].headers;
    expect([sent.referer, sent["user-agent"], sent.cookie]).toEqual(["https://www.instagram.com/", "Agent/1", undefined]);
  });
});
