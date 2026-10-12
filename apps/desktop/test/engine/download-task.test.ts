import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord } from "@turbodl/shared";
import { HttpDownloadTask, TEMP_SUFFIX } from "../../src/main/engine/download-task";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const MB = 1024 * 1024;
let server: TestServer;
let dir: string;

beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-task-"));
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function record(urlPath: string, filename: string, targetDir = dir): DownloadRecord {
  return {
    id: "t1",
    kind: "http",
    url: server.url(urlPath),
    filename,
    dir: targetDir,
    category: "other",
    size: null,
    received: 0,
    status: "queued",
    headers: {},
    resumable: false,
    segments: [],
    viaScheduler: false,
    createdAt: Date.now(),
  };
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const options = (connections = 4) => ({ maxConnections: () => connections, retryBaseMs: 10, idleTimeoutMs: 5000 });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = (r: DownloadRecord): DownloadRecord => JSON.parse(JSON.stringify(r));

describe("HttpDownloadTask", () => {
  it("downloads with several connections and produces an identical file", async () => {
    const data = randomBytes(4 * MB);
    server.setFile("/f.bin", { data, throttle: 4 * MB });
    const rec = record("/f.bin", "f.bin");
    await new HttpDownloadTask(rec, options(4)).start();
    expect(rec.status).toBe("completed");
    expect(rec.received).toBe(data.length);
    expect(sha(readFileSync(path.join(dir, "f.bin")))).toBe(sha(data));
    expect(server.maxConcurrent).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(dir, `f.bin${TEMP_SUFFIX}`))).toBe(false);
  });

  it("pauses and resumes from a persisted record without starting over", async () => {
    const data = randomBytes(8 * MB);
    server.setFile("/big.bin", { data, throttle: 1 * MB });
    const rec = record("/big.bin", "big.bin");
    const task = new HttpDownloadTask(rec, options(4));
    const running = task.start();
    await wait(800);
    task.pause();
    await running;
    expect(rec.status).toBe("paused");
    expect(rec.received).toBeGreaterThan(0);
    expect(rec.received).toBeLessThan(data.length);

    const restored = clone(rec);
    const sentBefore = server.bytesSent;
    await new HttpDownloadTask(restored, options(4)).start();
    expect(restored.status).toBe("completed");
    expect(sha(readFileSync(path.join(dir, "big.bin")))).toBe(sha(data));
    expect(server.bytesSent - sentBefore).toBeLessThan(data.length);
  });

  it("restarts cleanly when the temp file vanished between sessions", async () => {
    const data = randomBytes(6 * MB);
    server.setFile("/v.bin", { data, throttle: 1 * MB });
    const rec = record("/v.bin", "v.bin");
    const task = new HttpDownloadTask(rec, options(4));
    const running = task.start();
    await wait(600);
    task.pause();
    await running;
    rmSync(path.join(dir, `v.bin${TEMP_SUFFIX}`));
    server.setFile("/v.bin", { data });
    const restored = clone(rec);
    await new HttpDownloadTask(restored, options(4)).start();
    expect(restored.status).toBe("completed");
    expect(sha(readFileSync(path.join(dir, "v.bin")))).toBe(sha(data));
  });

  it("retries dropped connections", async () => {
    const data = randomBytes(3 * MB);
    server.setFile("/drop.bin", { data, dropAfter: 200 * 1024, dropCount: 3 });
    const rec = record("/drop.bin", "drop.bin");
    await new HttpDownloadTask(rec, options(3)).start();
    expect(rec.status).toBe("completed");
    expect(sha(readFileSync(path.join(dir, "drop.bin")))).toBe(sha(data));
  });

  it("uses a single connection when the server has no range support", async () => {
    const data = randomBytes(2 * MB);
    server.setFile("/nr.bin", { data, ranges: false });
    const rec = record("/nr.bin", "nr.bin");
    await new HttpDownloadTask(rec, options(4)).start();
    expect(rec.status).toBe("completed");
    expect(rec.resumable).toBe(false);
    expect(server.requests.slice(1).every((r) => r.range === undefined)).toBe(true);
    expect(sha(readFileSync(path.join(dir, "nr.bin")))).toBe(sha(data));
  });

  it("falls back to one connection when ranges only work for the probe", async () => {
    const data = randomBytes(3 * MB);
    server.setFile("/liar.bin", { data, rangesOnlyForProbe: true });
    const rec = record("/liar.bin", "liar.bin");
    await new HttpDownloadTask(rec, options(4)).start();
    expect(rec.status).toBe("completed");
    expect(rec.resumable).toBe(false);
    expect(sha(readFileSync(path.join(dir, "liar.bin")))).toBe(sha(data));
  });

  it("splits a slow segment when a connection becomes free", async () => {
    const data = randomBytes(8 * MB);
    server.setFile("/split.bin", { data, throttle: (start) => (start === 0 ? 64 * MB : 2 * MB) });
    const rec = record("/split.bin", "split.bin");
    await new HttpDownloadTask(rec, options(2)).start();
    expect(rec.status).toBe("completed");
    expect(sha(readFileSync(path.join(dir, "split.bin")))).toBe(sha(data));
    const starts = server.requests
      .filter((r) => r.range && r.range !== "bytes=0-0")
      .map((r) => Number(/bytes=(\d+)-/.exec(r.range!)![1]));
    expect(starts.some((s) => s !== 0 && s !== 4 * MB)).toBe(true);
  });

  it("fails with a readable message on 404", async () => {
    server.setFile("/missing", { data: Buffer.alloc(0), status: 404 });
    const rec = record("/missing", "missing.bin");
    await new HttpDownloadTask(rec, options()).start();
    expect(rec.status).toBe("error");
    expect(rec.error).toContain("404");
  });

  it("starts over when the server file changed (ETag)", async () => {
    const v1 = randomBytes(6 * MB);
    const v2 = randomBytes(6 * MB);
    server.setFile("/e.bin", { data: v1, etag: '"v1"', throttle: 1 * MB });
    const rec = record("/e.bin", "e.bin");
    const task = new HttpDownloadTask(rec, options(4));
    const running = task.start();
    await wait(600);
    task.pause();
    await running;
    expect(rec.received).toBeGreaterThan(0);
    server.setFile("/e.bin", { data: v2, etag: '"v2"' });
    const restored = clone(rec);
    await new HttpDownloadTask(restored, options(4)).start();
    expect(restored.status).toBe("completed");
    expect(sha(readFileSync(path.join(dir, "e.bin")))).toBe(sha(v2));
  });

  it("picks a free name when the target exists", async () => {
    writeFileSync(path.join(dir, "dup.bin"), "old");
    server.setFile("/dup.bin", { data: randomBytes(1000) });
    const rec = record("/dup.bin", "dup.bin");
    await new HttpDownloadTask(rec, options()).start();
    expect(rec.filename).toBe("dup (1).bin");
    expect(readFileSync(path.join(dir, "dup.bin"), "utf8")).toBe("old");
  });

  it("downloads files of unknown size and empty files", async () => {
    const data = randomBytes(300 * 1024);
    server.setFile("/chunked", { data, ranges: false, omitLength: true });
    const rec = record("/chunked", "chunked.bin");
    await new HttpDownloadTask(rec, options()).start();
    expect(rec.status).toBe("completed");
    expect(rec.size).toBe(data.length);

    server.setFile("/empty", { data: Buffer.alloc(0) });
    const empty = record("/empty", "empty.bin");
    await new HttpDownloadTask(empty, options()).start();
    expect(empty.status).toBe("completed");
    expect(readFileSync(path.join(dir, "empty.bin")).length).toBe(0);
  });

  it("reports an unwritable folder as an error instead of throwing", async () => {
    const blocker = path.join(dir, "not-a-folder");
    writeFileSync(blocker, "x");
    server.setFile("/w.bin", { data: randomBytes(1000) });
    const rec = record("/w.bin", "w.bin", path.join(blocker, "sub"));
    await new HttpDownloadTask(rec, options()).start();
    expect(rec.status).toBe("error");
    expect(rec.error).toBeTruthy();
  });
});
