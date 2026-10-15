import type { FileHandle } from "node:fs/promises";
import type { Segment } from "@turbodl/shared";
import { HttpError, NetworkError, abortError, request } from "./http";

export class RangeNotSupportedError extends Error {
  constructor() {
    super("The server does not support segmented downloads.");
    this.name = "RangeNotSupportedError";
  }
}

export interface WorkerContext {
  url: string;
  headers: Record<string, string>;
  file: FileHandle;
  signal: AbortSignal;
  idleTimeoutMs: number;
  /** most bytes asked for in one request (YouTube slows down bigger ranges); undefined = the whole segment */
  chunkSize?: number;
  onBytes(bytes: number): void;
}

export async function writeFully(file: FileHandle, data: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset);
    offset += bytesWritten;
  }
}

/** Downloads one segment. Respects `segment.end` shrinking while it runs (dynamic split). */
export class SegmentWorker {
  private reserved = 0;

  constructor(
    readonly segment: Segment,
    private readonly ctx: WorkerContext,
  ) {}

  /** Next byte offset this worker will write, including a write in flight. */
  get position(): number {
    return this.segment.start + this.segment.received + this.reserved;
  }

  async run(): Promise<void> {
    const seg = this.segment;
    while (seg.start + seg.received <= seg.end) {
      const from = seg.start + seg.received;
      const to = this.ctx.chunkSize ? Math.min(seg.end, from + this.ctx.chunkSize - 1) : seg.end;
      await this.fetchRange(from, to);
    }
  }

  /** One request for [from, to]. The answer is read to its end so the socket goes back to the pool. */
  private async fetchRange(from: number, to: number): Promise<void> {
    const seg = this.segment;
    const res = await request(this.ctx.url, {
      headers: this.ctx.headers,
      range: { start: from, end: to },
      signal: this.ctx.signal,
      timeoutMs: this.ctx.idleTimeoutMs,
    });
    if (res.status >= 400) {
      res.body.destroy();
      throw new HttpError(res.status);
    }
    const contentRange = Array.isArray(res.headers["content-range"]) ? res.headers["content-range"][0] : res.headers["content-range"];
    const m = /bytes\s+(\d+)-/i.exec(contentRange ?? "");
    if (res.status !== 206 || !m || Number(m[1]) !== from) {
      res.body.destroy();
      throw new RangeNotSupportedError();
    }

    const last = () => Math.min(seg.end, to);
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      const pos = seg.start + seg.received;
      const allowed = last() - pos + 1;
      if (allowed <= 0) break;
      const data = chunk.length > allowed ? chunk.subarray(0, allowed) : chunk;
      this.reserved = data.length;
      try {
        await writeFully(this.ctx.file, data, pos);
      } finally {
        this.reserved = 0;
      }
      seg.received += data.length;
      this.ctx.onBytes(data.length);
    }

    if (seg.start + seg.received <= last()) {
      if (this.ctx.signal.aborted) throw abortError();
      throw new NetworkError("The connection closed early.", "EPREMATURE");
    }
  }
}
