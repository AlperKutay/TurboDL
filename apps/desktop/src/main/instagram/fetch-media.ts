import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { TEMP_SUFFIX } from "../engine/download-task";
import { HttpError, NetworkError, request } from "../engine/http";

export interface FetchMediaOptions {
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** 0…1, when the server says how large the file is */
  onProgress?: (fraction: number) => void;
}

/**
 * One photo or video from Instagram's CDN into `file`: written under a temporary name and renamed once complete, so
 * a failed or stopped fetch leaves nothing behind.
 */
export async function fetchMedia(url: string, file: string, o: FetchMediaOptions): Promise<void> {
  const temp = file + TEMP_SUFFIX;
  try {
    const res = await request(url, { headers: o.headers, signal: o.signal });
    if (res.status < 200 || res.status > 299) {
      res.body.resume();
      throw new HttpError(res.status);
    }
    const total = Number(res.headers["content-length"]) || 0;
    let received = 0;
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (total > 0) o.onProgress?.(Math.min(received / total, 1));
        done(null, chunk);
      },
    });
    await pipeline(res.body, count, createWriteStream(temp), { signal: o.signal });
    if (total > 0 && received !== total) throw new NetworkError("The connection closed before the file was complete.");
    await rename(temp, file);
    o.onProgress?.(1);
  } catch (err) {
    await rm(temp, { force: true });
    throw err;
  }
}
