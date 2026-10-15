import { existsSync, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { uniqueName, type DownloadRecord, type Segment } from "@turbodl/shared";
import type { TaskHandle } from "../task";
import { HttpError, NetworkError, abortError, isAbortError, request } from "./http";
import { probe } from "./probe";
import { RangeNotSupportedError, SegmentWorker, writeFully } from "./segment-worker";
import { insertSegment, isSegmentDone, planSegments, segmentsValid, splitLargest, totalReceived } from "./segments";
import { SpeedMeter, estimateEta } from "./speed";

export const TEMP_SUFFIX = ".turbodl";

export interface HttpTaskOptions {
  maxConnections: () => number;
  idleTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /** most bytes per request, see SegmentWorker */
  chunkSize?: number;
}

const FATAL_FS_CODES = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS", "ENOTDIR", "EEXIST", "EISDIR", "EBADF"]);

function isFatal(err: unknown): boolean {
  if (err instanceof RangeNotSupportedError) return true;
  if (err instanceof HttpError) return err.status < 500 && err.status !== 408 && err.status !== 429;
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === "string" && FATAL_FS_CODES.has(code);
}

/** What a server answers when it allows fewer connections per client than we opened. */
function isLimitError(err: unknown): boolean {
  if (err instanceof RangeNotSupportedError) return true;
  return err instanceof HttpError && (err.status === 403 || err.status === 429 || err.status === 503);
}

const NOTE_MS = 5000;

export function describeError(err: unknown): string {
  if (err instanceof HttpError || err instanceof NetworkError || err instanceof RangeNotSupportedError) return err.message;
  const e = err as NodeJS.ErrnoException;
  switch (e?.code) {
    case "ENOSPC":
      return "Not enough disk space.";
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "No permission to write to the folder.";
    case "ENOTDIR":
    case "EEXIST":
      return "Could not create the download folder.";
    default:
      return e?.message ? String(e.message) : "Unknown error.";
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpDownloadTask implements TaskHandle {
  private flash: { text: string; until: number } | null = null;
  private controller: AbortController | null = null;
  private readonly meter = new SpeedMeter();
  private readonly workers = new Map<Segment, SegmentWorker>();
  private singleActive = false;
  private pauseRequested = false;

  constructor(
    readonly record: DownloadRecord,
    private readonly opts: HttpTaskOptions,
  ) {}

  get note(): string | undefined {
    return this.flash && Date.now() < this.flash.until ? this.flash.text : undefined;
  }

  get speed(): number {
    return this.record.status === "downloading" ? this.meter.bytesPerSecond : 0;
  }

  get eta(): number | null {
    return this.record.size === null ? null : estimateEta(this.record.size - this.record.received, this.speed);
  }

  get connections(): number {
    return this.singleActive ? 1 : this.workers.size;
  }

  private get tempPath(): string {
    return path.join(this.record.dir, this.record.filename + TEMP_SUFFIX);
  }

  pause(): void {
    this.pauseRequested = true;
    this.controller?.abort();
  }

  async start(): Promise<void> {
    const rec = this.record;
    this.pauseRequested = false;
    this.controller = new AbortController();
    this.meter.reset();
    rec.status = "downloading";
    rec.error = undefined;
    let file: FileHandle | null = null;
    try {
      const info = await probe(rec.url, rec.headers, this.controller.signal);
      const changed =
        rec.segments.length > 0 &&
        (info.size !== rec.size ||
          (!!rec.etag && !!info.etag && rec.etag !== info.etag) ||
          (!!rec.lastModified && !!info.lastModified && rec.lastModified !== info.lastModified));
      if (changed || !info.resumable) {
        rec.segments = [];
        rec.received = 0;
      }
      rec.size = info.size;
      rec.resumable = info.resumable;
      rec.etag = info.etag;
      rec.lastModified = info.lastModified;
      await fsp.mkdir(rec.dir, { recursive: true });

      if (rec.resumable && rec.size !== null && rec.size > 0) {
        file = await this.openSegmentedFile(rec.size);
        try {
          await this.runSegmented(file);
        } catch (err) {
          if (!(err instanceof RangeNotSupportedError) || this.pauseRequested) throw err;
          await file.close();
          file = null;
          rec.resumable = false;
          rec.segments = [];
          rec.received = 0;
          this.controller = new AbortController();
          file = await fsp.open(this.tempPath, "w");
          await this.runSingle(file);
        }
      } else {
        file = await fsp.open(this.tempPath, "w");
        await this.runSingle(file);
      }

      if (this.pauseRequested) {
        rec.status = "paused";
        return;
      }
      await file.close();
      file = null;
      await this.finalize();
    } catch (err) {
      if (this.pauseRequested || isAbortError(err)) {
        rec.status = "paused";
      } else {
        rec.status = "error";
        rec.error = describeError(err);
      }
    } finally {
      if (file) await file.close().catch(() => undefined);
      if (rec.segments.length > 0) rec.received = totalReceived(rec.segments);
      this.workers.clear();
      this.singleActive = false;
      this.controller = null;
    }
  }

  private async openSegmentedFile(size: number): Promise<FileHandle> {
    const rec = this.record;
    if (rec.segments.length > 0 && segmentsValid(rec.segments, size) && existsSync(this.tempPath)) {
      const stat = await fsp.stat(this.tempPath);
      if (stat.size === size) return fsp.open(this.tempPath, "r+");
    }
    rec.segments = planSegments(size, Math.max(1, this.opts.maxConnections()));
    rec.received = 0;
    const file = await fsp.open(this.tempPath, "w");
    await file.truncate(size);
    return file;
  }

  private runSegmented(file: FileHandle): Promise<void> {
    const rec = this.record;
    const signal = this.controller!.signal;
    const maxRetries = this.opts.maxRetries ?? 8;
    const retryBase = this.opts.retryBaseMs ?? 1000;

    return new Promise<void>((resolve, reject) => {
      const failures = new Map<Segment, number>();
      const backoff = new Map<Segment, NodeJS.Timeout>();
      let failure: unknown = null;
      let settled = false;
      // lowered when the server refuses extra connections; only for this run
      let cap = Number.POSITIVE_INFINITY;
      const limit = () => Math.max(1, Math.min(cap, this.opts.maxConnections()));

      const settle = () => {
        if (settled) return;
        settled = true;
        for (const timer of backoff.values()) clearTimeout(timer);
        backoff.clear();
        signal.removeEventListener("abort", onAbort);
        if (failure) reject(failure);
        else resolve();
      };
      const settleWhenIdle = () => {
        if (this.workers.size === 0) settle();
      };
      const onAbort = () => {
        for (const timer of backoff.values()) clearTimeout(timer);
        backoff.clear();
        settleWhenIdle();
      };
      const fail = (err: unknown) => {
        if (failure) return;
        failure = err;
        this.controller?.abort();
        settleWhenIdle();
      };
      signal.addEventListener("abort", onAbort);

      const launch = (seg: Segment) => {
        const worker = new SegmentWorker(seg, {
          url: rec.url,
          headers: rec.headers,
          file,
          signal,
          idleTimeoutMs: this.opts.idleTimeoutMs ?? 30000,
          chunkSize: this.opts.chunkSize,
          onBytes: (n) => {
            this.meter.add(n);
            rec.received += n;
          },
        });
        this.workers.set(seg, worker);
        worker.run().then(
          () => {
            this.workers.delete(seg);
            failures.delete(seg);
            if (signal.aborted) settleWhenIdle();
            else fill();
          },
          (err: unknown) => {
            this.workers.delete(seg);
            if (signal.aborted) {
              settleWhenIdle();
              return;
            }
            if (isLimitError(err) && this.workers.size > 0) {
              // the server caps connections per client: carry on with the ones that work
              cap = this.workers.size;
              this.flash = { text: `The server allows at most ${cap} connections.`, until: Date.now() + NOTE_MS };
              fill();
              return;
            }
            const count = (failures.get(seg) ?? 0) + 1;
            failures.set(seg, count);
            if (isFatal(err) || count > maxRetries) {
              fail(err);
              return;
            }
            const wait = Math.min(30000, retryBase * 2 ** (count - 1));
            backoff.set(
              seg,
              setTimeout(() => {
                backoff.delete(seg);
                fill();
              }, wait),
            );
          },
        );
      };

      const fill = () => {
        if (settled || signal.aborted) return;
        const segments = rec.segments;
        if (segments.every(isSegmentDone)) {
          settleWhenIdle();
          return;
        }
        const max = limit();
        for (const seg of segments) {
          if (this.workers.size >= max) break;
          if (isSegmentDone(seg) || this.workers.has(seg) || backoff.has(seg)) continue;
          launch(seg);
        }
        while (this.workers.size < max && backoff.size === 0) {
          const idle = segments.some((s) => !isSegmentDone(s) && !this.workers.has(s));
          if (idle) break;
          const right = splitLargest([...this.workers.keys()], (s) => this.workers.get(s)!.position);
          if (!right) break;
          insertSegment(segments, right);
          launch(right);
        }
      };

      fill();
    });
  }

  private async runSingle(file: FileHandle): Promise<void> {
    const rec = this.record;
    const signal = this.controller!.signal;
    const maxRetries = this.opts.maxRetries ?? 8;
    let attempt = 0;
    for (;;) {
      rec.received = 0;
      try {
        this.singleActive = true;
        const res = await request(rec.url, { headers: rec.headers, signal, timeoutMs: this.opts.idleTimeoutMs ?? 30000 });
        if (res.status >= 400) {
          res.body.destroy();
          throw new HttpError(res.status);
        }
        let pos = 0;
        for await (const chunk of res.body as AsyncIterable<Buffer>) {
          await writeFully(file, chunk, pos);
          pos += chunk.length;
          rec.received = pos;
          this.meter.add(chunk.length);
        }
        if (rec.size !== null && pos < rec.size) throw new NetworkError("The connection closed early.", "EPREMATURE");
        await file.truncate(pos);
        rec.size = pos;
        return;
      } catch (err) {
        if (signal.aborted) throw err;
        attempt++;
        if (isFatal(err) || attempt > maxRetries) throw err;
        await delay(Math.min(30000, (this.opts.retryBaseMs ?? 1000) * 2 ** (attempt - 1)), signal);
      } finally {
        this.singleActive = false;
      }
    }
  }

  private async finalize(): Promise<void> {
    const rec = this.record;
    if (rec.segments.length > 0 && rec.size !== null && totalReceived(rec.segments) !== rec.size) {
      throw new NetworkError("The download is incomplete.", "EINCOMPLETE");
    }
    const temp = this.tempPath;
    const finalName = uniqueName(rec.filename, (n) => existsSync(path.join(rec.dir, n)));
    await fsp.rename(temp, path.join(rec.dir, finalName));
    rec.filename = finalName;
    rec.received = rec.size ?? rec.received;
    rec.segments = [];
    rec.status = "completed";
    rec.completedAt = Date.now();
  }
}
