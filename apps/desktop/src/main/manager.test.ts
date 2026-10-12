import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DownloadRecord, DownloadStatus, DownloadView, NewDownload, Settings } from "@turbodl/shared";
import { DownloadManager, type StateFile, type StateStore } from "./manager";
import { defaultSettings } from "./settings";
import type { TaskHandle } from "./task";

class FakeTask implements TaskHandle {
  speed = 1234;
  eta = 5;
  connections = 2;
  note: string | undefined = undefined;
  started = false;
  private finishRun: (() => void) | null = null;

  constructor(readonly record: DownloadRecord) {}

  start(): Promise<void> {
    this.started = true;
    this.record.status = "downloading";
    return new Promise<void>((resolve) => {
      this.finishRun = resolve;
    });
  }

  finish(status: DownloadStatus = "completed"): void {
    this.record.status = status;
    this.finishRun?.();
  }

  pause(): void {
    this.finish("paused");
  }
}

class MemoryStore implements StateStore {
  saved: StateFile | null = null;
  flushed = 0;
  constructor(private initial: StateFile | null = null) {}
  load(fallback: () => StateFile): StateFile {
    return this.initial ?? fallback();
  }
  save(data: StateFile): void {
    this.saved = JSON.parse(JSON.stringify(data));
  }
  flush(): void {
    this.flushed++;
  }
}

const tick = () => new Promise((r) => setImmediate(r));
let managers: DownloadManager[] = [];
let tmp: string | null = null;
afterEach(async () => {
  for (const m of managers) await m.shutdown();
  managers = [];
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

function setup(opts: { maxConcurrent?: number; initial?: StateFile } = {}) {
  const settings: Settings = { ...defaultSettings("/dl"), maxConcurrent: opts.maxConcurrent ?? 2 };
  const store = new MemoryStore(opts.initial ?? null);
  const tasks: FakeTask[] = [];
  let n = 0;
  const manager = new DownloadManager({
    store,
    settings: () => settings,
    createTask: (r) => {
      const t = new FakeTask(r);
      tasks.push(t);
      return t;
    },
    newId: () => `id${++n}`,
    tickMs: 60_000,
  });
  manager.init();
  managers.push(manager);
  return { manager, store, tasks, settings };
}

function input(name: string, dir = "/dl"): NewDownload {
  return { kind: "http", url: `https://x.com/${name}`, filename: name, dir, category: "other", size: 10, resumable: true, headers: { Cookie: "s=1" } };
}

describe("DownloadManager", () => {
  it("runs at most maxConcurrent downloads and starts the next one when a slot frees", async () => {
    const { manager, tasks } = setup({ maxConcurrent: 2 });
    manager.add(input("a"), "now");
    manager.add(input("b"), "now");
    manager.add(input("c"), "now");
    expect(tasks.map((t) => t.record.filename)).toEqual(["a", "b"]);
    tasks[0].finish();
    await tick();
    expect(tasks.map((t) => t.record.filename)).toEqual(["a", "b", "c"]);
    expect(manager.get("id1")?.status).toBe("completed");
  });

  it("keeps 'later' downloads scheduled until the scheduler activates them", async () => {
    const { manager, tasks } = setup();
    const rec = manager.add(input("a"), "later");
    expect(rec.status).toBe("scheduled");
    expect(tasks).toHaveLength(0);
    expect(manager.activateScheduled()).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(rec.viaScheduler).toBe(true);
    expect(manager.schedulerWorkRemaining()).toBe(true);
    tasks[0].finish();
    await tick();
    expect(manager.schedulerWorkRemaining()).toBe(false);
  });

  it("pauses and resumes", async () => {
    const { manager, tasks } = setup({ maxConcurrent: 1 });
    manager.add(input("a"), "now");
    const queued = manager.add(input("b"), "now");
    manager.pause([queued.id]);
    expect(queued.status).toBe("paused");
    manager.pause(["id1"]);
    await tick();
    expect(manager.get("id1")?.status).toBe("paused");
    manager.resume([queued.id]);
    expect(tasks.at(-1)?.record.id).toBe(queued.id);
  });

  it("resumes interrupted downloads on start-up", () => {
    const record: DownloadRecord = { ...input("a"), id: "old", received: 5, status: "downloading", segments: [], viaScheduler: false, createdAt: 1 };
    const { manager, tasks } = setup({ initial: { version: 1, downloads: [record] } });
    expect(tasks).toHaveLength(1);
    expect(manager.get("old")?.status).toBe("downloading");
  });

  it("emits views without cookies, with live speed", () => {
    const { manager } = setup();
    manager.add(input("a"), "now");
    const updates: DownloadView[][] = [];
    manager.on("update", (items) => updates.push(items));
    manager.flushUpdates();
    expect(updates[0][0]).toMatchObject({ filename: "a", speed: 1234, eta: 5, connections: 2, headers: {} });
  });

  it("emits completed and idle", async () => {
    const { manager, tasks } = setup();
    const events: string[] = [];
    manager.on("completed", (r) => events.push(`completed:${r.filename}`));
    manager.on("idle", () => events.push("idle"));
    manager.add(input("a"), "now");
    tasks[0].finish();
    await tick();
    expect(events).toEqual(["completed:a", "idle"]);
  });

  it("removes a running download and deletes its temp file", async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "turbodl-mgr-"));
    const { manager } = setup();
    const rec = manager.add(input("a.bin", tmp), "now");
    const temp = path.join(tmp, "a.bin.turbodl");
    writeFileSync(temp, "partial");
    const removed: string[][] = [];
    manager.on("removed", (ids) => removed.push(ids));
    await manager.remove([rec.id], true);
    expect(manager.get(rec.id)).toBeUndefined();
    expect(existsSync(temp)).toBe(false);
    expect(removed).toEqual([[rec.id]]);
  });

  it("puts scheduler work back to 'scheduled' at the stop time", async () => {
    const { manager, tasks } = setup({ maxConcurrent: 1 });
    manager.add(input("a"), "later");
    manager.add(input("b"), "later");
    manager.activateScheduled();
    await manager.suspendScheduled();
    expect(tasks[0].record.status).toBe("scheduled");
    expect(manager.get("id2")?.status).toBe("scheduled");
  });

  it("refreshes the URL of a failed download and retries it", async () => {
    const { manager, tasks } = setup();
    const rec = manager.add(input("a"), "now");
    tasks[0].finish("error");
    await tick();
    expect(manager.refreshUrl(rec.id, "https://mirror.example/a")).toBe(true);
    expect(rec.url).toBe("https://mirror.example/a");
    expect(tasks).toHaveLength(2);
  });

  it("saves running downloads as queued on shutdown", async () => {
    const { manager, store } = setup();
    manager.add(input("a"), "now");
    await manager.shutdown();
    managers = [];
    expect(store.saved?.downloads[0].status).toBe("queued");
    expect(store.flushed).toBeGreaterThan(0);
  });

  it("startAll and stopAll", async () => {
    const { manager, tasks } = setup({ maxConcurrent: 5 });
    manager.add(input("a"), "now");
    manager.add(input("b"), "later");
    manager.stopAll();
    await tick();
    expect(manager.list().map((d) => d.status).sort()).toEqual(["paused", "scheduled"]);
    manager.startAll();
    expect(tasks).toHaveLength(3);
  });
});
