import { createDecipheriv } from "node:crypto";
import { promises as fsp } from "node:fs";
import { HttpError, NetworkError, abortError, delay, isAbortError, request } from "./http";
import { RangeNotSupportedError, writeFully } from "./segment-worker";

export interface FragmentKey {
  url: string;
  /** null: the IV is the fragment's media sequence number */
  iv: Buffer | null;
}

export interface Fragment {
  url: string;
  /** inclusive byte range inside `url` */
  range?: { start: number; end: number };
  /** AES-128-CBC key; absent for clear fragments */
  key?: FragmentKey;
  /** media sequence number (HLS) */
  sequence: number;
}

export interface FragmentPlan {
  init?: Fragment;
  fragments: Fragment[];
}

export interface FragmentProgress {
  count: number;
  initDone: boolean;
  /** fragments appended to the file, in order */
  done: number;
  /** file length after the last appended fragment */
  bytes: number;
}

export interface FragmentRunOptions {
  path: string;
  plan: FragmentPlan;
  /** updated as fragments are appended; starts over when `count` does not match the plan */
  progress: FragmentProgress;
  headers: Record<string, string>;
  /** the Cookie header only goes to this host (the playlist's) */
  cookieHost?: string;
  signal: AbortSignal;
  connections: () => number;
  onBytes(bytes: number): void;
  idleTimeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

export function sequenceIv(sequence: number): Buffer {
  const iv = Buffer.alloc(16);
  iv.writeBigUInt64BE(BigInt(sequence), 8);
  return iv;
}

/** Headers for one request: the Cookie header stays on the host it came from. */
export function headersFor(headers: Record<string, string>, url: string, cookieHost?: string): Record<string, string> {
  if (!cookieHost || headers.Cookie === undefined) return headers;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // an invalid URL fails in the request itself
  }
  if (host === cookieHost) return headers;
  const copy = { ...headers };
  delete copy.Cookie;
  return copy;
}

function retryable(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof HttpError) return err.status >= 500 || err.status === 408 || err.status === 429;
  if (err instanceof NetworkError) return true;
  return typeof (err as NodeJS.ErrnoException)?.code === "string";
}

async function fetchBody(
  url: string,
  headers: Record<string, string>,
  range: Fragment["range"],
  signal: AbortSignal,
  timeoutMs: number,
  onBytes: (n: number) => void,
): Promise<Buffer> {
  const res = await request(url, { headers, range, signal, timeoutMs });
  if (res.status >= 400) {
    res.body.destroy();
    throw new HttpError(res.status);
  }
  if (range && res.status !== 206) {
    res.body.destroy();
    throw new RangeNotSupportedError();
  }
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      length += chunk.length;
      onBytes(chunk.length);
    }
  } catch (err) {
    if (signal.aborted) throw abortError();
    throw err;
  }
  const header = res.headers["content-length"];
  const expected = Number(Array.isArray(header) ? header[0] : header);
  if (Number.isFinite(expected) && length < expected) throw new NetworkError("The connection closed early.", "EPREMATURE");
  return Buffer.concat(chunks, length);
}

/**
 * Downloads `plan` into one file: fragments run in parallel, are appended strictly in order,
 * and at most 2 × connections fragments are held in memory.
 */
export async function downloadFragments(o: FragmentRunOptions): Promise<void> {
  const { plan, progress } = o;
  if (progress.count !== plan.fragments.length) {
    Object.assign(progress, { count: plan.fragments.length, initDone: false, done: 0, bytes: 0 });
  }
  const maxRetries = o.maxRetries ?? 8;
  const retryBase = o.retryBaseMs ?? 1000;
  const timeoutMs = o.idleTimeoutMs ?? 30000;
  const inner = new AbortController();
  const signal = AbortSignal.any([o.signal, inner.signal]);
  const keys = new Map<string, Promise<Buffer>>();

  const retry = async <T>(job: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await job();
      } catch (err) {
        if (signal.aborted) throw abortError();
        if (!retryable(err) || attempt > maxRetries) throw err;
        await delay(Math.min(30000, retryBase * 2 ** (attempt - 1)), signal);
      }
    }
  };
  const get = (url: string, range?: Fragment["range"]) =>
    retry(() => fetchBody(url, headersFor(o.headers, url, o.cookieHost), range, signal, timeoutMs, o.onBytes));
  const keyFor = (url: string): Promise<Buffer> => {
    let key = keys.get(url);
    if (!key) {
      key = get(url).then((k) => {
        if (k.length !== 16) throw new Error("The stream's encryption key is invalid.");
        return k;
      });
      keys.set(url, key);
      key.catch(() => keys.delete(url));
    }
    return key;
  };
  const load = async (f: Fragment): Promise<Buffer> => {
    const body = await get(f.url, f.range);
    if (!f.key) return body;
    const key = await keyFor(f.key.url);
    try {
      const decipher = createDecipheriv("aes-128-cbc", key, f.key.iv ?? sequenceIv(f.sequence));
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new Error("Could not decrypt a stream segment.");
    }
  };

  const file = await fsp.open(o.path, progress.bytes > 0 ? "r+" : "w");
  try {
    await file.truncate(progress.bytes);
    let pos = progress.bytes;
    const append = async (data: Buffer) => {
      await writeFully(file, data, pos);
      pos += data.length;
    };
    if (plan.init && !progress.initDone) {
      await append(await load(plan.init));
      progress.initDone = true;
      progress.bytes = pos;
    }

    await new Promise<void>((resolve, reject) => {
      const total = plan.fragments.length;
      const ready = new Map<number, Buffer>();
      let next = progress.done;
      let active = 0;
      let writing = false;
      let failure: unknown = null;
      let settled = false;

      const settle = () => {
        if (settled || active > 0 || writing) return;
        if (failure) {
          settled = true;
          reject(failure);
        } else if (progress.done >= total) {
          settled = true;
          resolve();
        }
      };
      const fail = (err: unknown) => {
        failure ??= err;
        inner.abort();
        settle();
      };
      const flush = async () => {
        if (writing) return;
        writing = true;
        try {
          while (!failure && ready.has(progress.done)) {
            const data = ready.get(progress.done)!;
            ready.delete(progress.done);
            await append(data);
            progress.done++;
            progress.bytes = pos;
          }
        } catch (err) {
          failure ??= err;
          inner.abort();
        }
        writing = false;
        pump();
      };
      const pump = () => {
        if (!failure && signal.aborted) failure = abortError();
        if (!failure) {
          const width = Math.max(1, o.connections());
          while (active < width && next < total && next < progress.done + width * 2) {
            const index = next++;
            active++;
            load(plan.fragments[index]).then(
              (data) => {
                active--;
                ready.set(index, data);
                void flush();
              },
              (err: unknown) => {
                active--;
                fail(err);
              },
            );
          }
        }
        settle();
      };
      pump();
    });
  } finally {
    inner.abort();
    await file.close();
  }
}
