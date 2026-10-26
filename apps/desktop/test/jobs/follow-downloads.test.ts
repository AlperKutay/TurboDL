import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRecord, JobEvent, NewDownload } from "@turbodl/shared";
import { HttpDownloadTask, TEMP_SUFFIX } from "../../src/main/engine/download-task";
import { followDownloads } from "../../src/main/jobs/follow-downloads";
import { JobRecord } from "../../src/main/jobs/job-record";
import { DownloadManager, type StateFile, type StateStore } from "../../src/main/manager";
import type { TaskHandle } from "../../src/main/task";
import { defaultSettings } from "../../src/main/settings";
import { startTestServer, type TestServer } from "../fixtures/test-server";

const MB = 1024 * 1024;
let server: TestServer;
let dir: string;
let manager: DownloadManager;

class MemoryStore implements StateStore {
  load(fallback: () => StateFile): StateFile {
    return fallback();
  }
  save(): void {}
  flush(): void {}
}

beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-follow-"));
  manager = new DownloadManager({
    store: new MemoryStore(),
    settings: () => ({ ...defaultSettings(dir), maxConcurrent: 4 }),
    createTask: (record) => new HttpDownloadTask(record, { maxConnections: () => 2, retryBaseMs: 10, idleTimeoutMs: 5000 }),
    tickMs: 20,
  });
  manager.init();
});
afterEach(async () => {
  await manager.shutdown();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function newJob(): { job: JobRecord; events: JobEvent[] } {
  const job = new JobRecord("j1", { url: "https://example.com/x" }, "file", () => Date.now());
  const events: JobEvent[] = [];
  job.subscribe((e) => events.push(e));
  return { job, events };
}

function item(urlPath: string, filename: string): NewDownload {
  return { kind: "http", url: server.url(urlPath), filename, dir, category: "other", size: null, resumable: false, headers: {} };
}

const filesOf = (events: JobEvent[]) => events.flatMap((e) => (e.type === "file" ? [e.path] : []));

async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("followDownloads", () => {
  it("reports each finished file at its final name", async () => {
    writeFileSync(path.join(dir, "a.zip"), "old");
    server.setFile("/a.zip", { data: Buffer.from("new") });
    const { job, events } = newJob();
    const id = manager.add(item("/a.zip", "a.zip"), "now").id;
    const outcome = await followDownloads(manager, [id], job);
    expect(outcome).toEqual({ type: "completed" });
    const files = filesOf(events);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(dir, "a (1).zip"));
    expect(job.view().progress).toMatchObject({ done: 1, total: 1 });
  });

  it("fails with the download's error once the others have ended", async () => {
    server.setFile("/missing.bin", { data: Buffer.alloc(0), status: 404 });
    server.setFile("/ok.bin", { data: Buffer.alloc(1 * MB, 1), throttle: 2 * MB });
    const { job, events } = newJob();
    const bad = manager.add(item("/missing.bin", "missing.bin"), "now").id;
    const good = manager.add(item("/ok.bin", "ok.bin"), "now").id;
    const outcome = await followDownloads(manager, [bad, good], job);
    expect(outcome.type).toBe("error");
    if (outcome.type === "error") expect(outcome.message).toBe(manager.get(bad)!.error);
    expect(filesOf(events)).toEqual([path.join(dir, "ok.bin")]);
  });

  it("stops when a download is paused in TurboDL, and leaves it paused", async () => {
    server.setFile("/slow.bin", { data: Buffer.alloc(4 * MB, 1), throttle: 256 * 1024 });
    const { job } = newJob();
    const id = manager.add(item("/slow.bin", "slow.bin"), "now").id;
    const followed = followDownloads(manager, [id], job);
    await until(() => manager.get(id)!.status === "downloading");
    manager.pause([id]);
    manager.flushUpdates();
    expect(await followed).toEqual({ type: "stopped", message: "A download was paused in TurboDL." });
    await until(() => manager.get(id)!.status === "paused");
    expect(manager.get(id)!.status).toBe("paused");
  });

  it("stops when a download is removed in TurboDL", async () => {
    server.setFile("/slow.bin", { data: Buffer.alloc(4 * MB, 1), throttle: 256 * 1024 });
    const { job } = newJob();
    const id = manager.add(item("/slow.bin", "slow.bin"), "now").id;
    const followed = followDownloads(manager, [id], job);
    await until(() => manager.get(id)!.status === "downloading");
    const removal = manager.remove([id], true);
    manager.flushUpdates(); // an update while the removal is stopping the task must not read as a pause
    expect(await followed).toEqual({ type: "stopped", message: "A download was removed in TurboDL." });
    await removal;
  });

  it("stops on Pause all", async () => {
    server.setFile("/slow.bin", { data: Buffer.alloc(4 * MB, 1), throttle: 256 * 1024 });
    const { job } = newJob();
    const id = manager.add(item("/slow.bin", "slow.bin"), "now").id;
    const followed = followDownloads(manager, [id], job);
    await until(() => manager.get(id)!.status === "downloading");
    manager.stopAll();
    expect(await followed).toEqual({ type: "stopped", message: "A download was paused in TurboDL." });
  });

  it("on cancel removes the unfinished downloads with their partial files and keeps the finished ones", async () => {
    server.setFile("/fast.bin", { data: Buffer.alloc(1024, 2) });
    server.setFile("/slow.bin", { data: Buffer.alloc(4 * MB, 1), throttle: 256 * 1024 });
    const { job, events } = newJob();
    const fast = manager.add(item("/fast.bin", "fast.bin"), "now").id;
    const slow = manager.add(item("/slow.bin", "slow.bin"), "now").id;
    const followed = followDownloads(manager, [fast, slow], job);
    await until(() => filesOf(events).length === 1);
    await until(() => existsSync(path.join(dir, "slow.bin" + TEMP_SUFFIX)));
    job.cancel();
    expect(await followed).toEqual({ type: "cancelled" });
    expect(manager.get(slow)).toBeUndefined();
    expect(manager.get(fast)?.status).toBe("completed");
    expect(existsSync(path.join(dir, "slow.bin" + TEMP_SUFFIX))).toBe(false);
    expect(existsSync(path.join(dir, "fast.bin"))).toBe(true);
  });

  it("cancels at once when the job is already cancelled", async () => {
    server.setFile("/slow.bin", { data: Buffer.alloc(4 * MB, 1), throttle: 256 * 1024 });
    const { job } = newJob();
    const id = manager.add(item("/slow.bin", "slow.bin"), "now").id;
    job.cancel();
    expect(await followDownloads(manager, [id], job)).toEqual({ type: "cancelled" });
    expect(manager.get(id)).toBeUndefined();
  });

  it("does not read a removal's pause as a pause", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new DownloadManager({
      store: new MemoryStore(),
      settings: () => ({ ...defaultSettings(dir), maxConcurrent: 1 }),
      createTask: (record: DownloadRecord): TaskHandle => ({
        record,
        speed: 0,
        eta: null,
        connections: 0,
        note: undefined,
        pause: () => {
          record.status = "paused";
        },
        start: async () => {
          record.status = "downloading";
          await gate;
        },
      }),
      tickMs: 60_000,
    });
    fake.init();
    try {
      const { job } = newJob();
      const id = fake.add(item("/x.bin", "x.bin"), "now").id;
      const followed = followDownloads(fake, [id], job);
      const removal = fake.remove([id], true);
      fake.flushUpdates(); // the record is paused while the removal waits for the task
      expect(fake.get(id)?.status).toBe("paused");
      release();
      await removal;
      expect(await followed).toEqual({ type: "stopped", message: "A download was removed in TurboDL." });
    } finally {
      release();
      await fake.shutdown();
    }
  });
});
