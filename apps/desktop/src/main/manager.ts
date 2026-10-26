import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { uniqueName, type DownloadRecord, type DownloadView, type NewDownload, type Settings } from "@turbodl/shared";
import { TEMP_SUFFIX } from "./engine/download-task";
import { streamTempFiles } from "./media/stream-task";
import type { JsonStore } from "./store";
import type { TaskHandle } from "./task";

export interface StateFile {
  version: 1;
  downloads: DownloadRecord[];
}

export type StateStore = Pick<JsonStore<StateFile>, "load" | "save" | "flush">;

export interface ManagerOptions {
  store: StateStore;
  settings: () => Settings;
  createTask: (record: DownloadRecord) => TaskHandle;
  newId?: () => string;
  tickMs?: number;
  filesOf?: (record: DownloadRecord) => string[];
}

type ManagerEvents = {
  update: [DownloadView[]];
  removed: [string[]];
  completed: [DownloadRecord];
  idle: [];
};

interface Running {
  task: TaskHandle;
  done: Promise<void>;
}

export function defaultFilesOf(record: DownloadRecord): string[] {
  if (record.status === "completed") return [path.join(record.dir, record.filename)];
  if (record.kind === "http") return [path.join(record.dir, record.filename + TEMP_SUFFIX)];
  if (record.kind === "stream") return streamTempFiles(record);
  return [];
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class DownloadManager extends EventEmitter<ManagerEvents> {
  private readonly records = new Map<string, DownloadRecord>();
  private readonly running = new Map<string, Running>();
  private readonly dirty = new Set<string>();
  private readonly removing = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private ticks = 0;
  private stopping = false;

  constructor(private readonly opts: ManagerOptions) {
    super();
  }

  init(): void {
    const state = this.opts.store.load(() => ({ version: 1, downloads: [] }));
    for (const record of state.downloads ?? []) {
      if (record.status === "downloading") record.status = "queued";
      this.records.set(record.id, record);
    }
    this.timer = setInterval(() => this.flushUpdates(), this.opts.tickMs ?? 500);
    this.pump();
  }

  get(id: string): DownloadRecord | undefined {
    return this.records.get(id);
  }

  /** true while `remove` is stopping and deleting this download */
  isRemoving(id: string): boolean {
    return this.removing.has(id);
  }

  list(): DownloadView[] {
    return [...this.records.values()].map((r) => this.view(r));
  }

  add(input: NewDownload, mode: "now" | "later"): DownloadRecord {
    // unfinished downloads in one folder must not share a name: they would share the temp file
    const taken = (name: string) =>
      [...this.records.values()].some((r) => r.dir === input.dir && r.filename === name && r.status !== "completed");
    const record: DownloadRecord = {
      ...input,
      filename: uniqueName(input.filename, taken),
      id: (this.opts.newId ?? randomId)(),
      headers: { ...input.headers },
      received: 0,
      status: mode === "now" ? "queued" : "scheduled",
      segments: [],
      viaScheduler: false,
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    this.changed(record.id);
    this.persist();
    this.pump();
    return record;
  }

  pause(ids: string[]): void {
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      const run = this.running.get(id);
      if (run) run.task.pause();
      else if (record.status === "queued" || record.status === "scheduled") {
        record.status = "paused";
        this.changed(id);
      }
    }
    this.persist();
  }

  resume(ids: string[]): void {
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record || this.running.has(id)) continue;
      if (record.status === "paused" || record.status === "error" || record.status === "scheduled") {
        record.status = "queued";
        record.error = undefined;
        this.changed(id);
      }
    }
    this.persist();
    this.pump();
  }

  async remove(ids: string[], deleteFiles: boolean): Promise<void> {
    const removed: string[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (!record) continue;
      this.removing.add(id);
      const run = this.running.get(id);
      if (run) {
        run.task.pause();
        await run.done;
      }
      this.records.delete(id);
      this.removing.delete(id);
      this.dirty.delete(id);
      removed.push(id);
      if (deleteFiles) {
        for (const file of (this.opts.filesOf ?? defaultFilesOf)(record)) {
          await fsp.rm(file, { force: true }).catch(() => undefined);
        }
      }
    }
    if (removed.length > 0) {
      this.emit("removed", removed);
      this.persist();
    }
    this.pump();
  }

  refreshUrl(id: string, url: string): boolean {
    const record = this.records.get(id);
    if (!record || this.running.has(id) || record.status === "completed") return false;
    record.url = url;
    record.status = "queued";
    record.error = undefined;
    this.changed(id);
    this.persist();
    this.pump();
    return true;
  }

  startAll(): void {
    this.resume([...this.records.values()].filter((r) => ["paused", "error", "scheduled"].includes(r.status)).map((r) => r.id));
  }

  stopAll(): void {
    this.pause([...this.records.values()].filter((r) => r.status === "queued" || r.status === "downloading").map((r) => r.id));
  }

  /** Re-evaluate the queue (e.g. after maxConcurrent changed). */
  poke(): void {
    this.pump();
  }

  activateScheduled(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.status !== "scheduled") continue;
      record.status = "queued";
      record.viaScheduler = true;
      this.changed(record.id);
      count++;
    }
    if (count > 0) {
      this.persist();
      this.pump();
    }
    return count;
  }

  async suspendScheduled(): Promise<void> {
    const waits: Promise<void>[] = [];
    for (const record of this.records.values()) {
      if (!record.viaScheduler) continue;
      if (record.status === "queued") {
        record.status = "scheduled";
        this.changed(record.id);
      }
      const run = this.running.get(record.id);
      if (run) {
        run.task.pause();
        waits.push(
          run.done.then(() => {
            if (record.status === "paused") {
              record.status = "scheduled";
              this.changed(record.id);
            }
          }),
        );
      }
    }
    await Promise.all(waits);
    this.persist();
  }

  schedulerWorkRemaining(): boolean {
    for (const record of this.records.values()) {
      if (record.viaScheduler && (record.status === "queued" || record.status === "downloading")) return true;
    }
    return false;
  }

  clearSchedulerFlags(): void {
    for (const record of this.records.values()) {
      if (record.viaScheduler && record.status !== "scheduled") record.viaScheduler = false;
    }
    this.persist();
  }

  /** Emit views for running and changed downloads. Called on a timer. */
  flushUpdates(): void {
    const ids = new Set([...this.dirty, ...this.running.keys()]);
    this.dirty.clear();
    const items: DownloadView[] = [];
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) items.push(this.view(record));
    }
    if (items.length > 0) this.emit("update", items);
    if (this.running.size > 0 && ++this.ticks % 4 === 0) this.persist();
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const runs = [...this.running.entries()];
    for (const [, run] of runs) run.task.pause();
    await Promise.race([Promise.all(runs.map(([, run]) => run.done)), new Promise((r) => setTimeout(r, 3000))]);
    for (const [id] of runs) {
      const record = this.records.get(id);
      if (record && (record.status === "paused" || record.status === "downloading")) record.status = "queued";
    }
    this.opts.store.save(this.state());
    this.opts.store.flush();
  }

  private state(): StateFile {
    return { version: 1, downloads: [...this.records.values()] };
  }

  private persist(): void {
    this.opts.store.save(this.state());
  }

  private changed(id: string): void {
    this.dirty.add(id);
  }

  private view(record: DownloadRecord): DownloadView {
    const run = this.running.get(record.id);
    return {
      ...record,
      headers: {},
      // stored browser cookies stay in the main process
      ytdlp: record.ytdlp && { formatSelector: record.ytdlp.formatSelector, audioOnly: record.ytdlp.audioOnly },
      // track records, origins and cookies stay in the main process
      stream: undefined,
      segments: record.segments.map((s) => ({ ...s })),
      speed: run?.task.speed ?? 0,
      eta: run?.task.eta ?? null,
      connections: run?.task.connections ?? 0,
      note: run?.task.note,
    };
  }

  private pump(): void {
    if (this.stopping) return;
    const max = this.opts.settings().maxConcurrent;
    for (const record of this.records.values()) {
      if (this.running.size >= max) break;
      if (record.status === "queued" && !this.running.has(record.id)) this.startTask(record);
    }
  }

  private startTask(record: DownloadRecord): void {
    const task = this.opts.createTask(record);
    record.status = "downloading";
    this.changed(record.id);
    const done = task
      .start()
      .catch((err: unknown) => {
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
      })
      .then(() => this.onTaskDone(record));
    this.running.set(record.id, { task, done });
  }

  private onTaskDone(record: DownloadRecord): void {
    this.running.delete(record.id);
    this.changed(record.id);
    this.persist();
    if (record.status === "completed" && this.records.has(record.id)) this.emit("completed", record);
    this.pump();
    const busy = this.running.size > 0 || [...this.records.values()].some((r) => r.status === "queued");
    if (!busy && !this.stopping) this.emit("idle");
  }
}
