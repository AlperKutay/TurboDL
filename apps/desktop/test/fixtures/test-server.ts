import http from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FileSpec {
  data: Buffer;
  /** honour Range requests (default true) */
  ranges?: boolean;
  /** honour only the "bytes=0-0" probe range; answer every other range with 200 */
  rangesOnlyForProbe?: boolean;
  contentType?: string;
  contentDisposition?: string;
  etag?: string;
  lastModified?: string;
  /** bytes per second per response; a function receives the requested range start */
  throttle?: number | ((rangeStart: number) => number);
  /** destroy the socket after this many body bytes, for the first `dropCount` responses */
  dropAfter?: number;
  dropCount?: number;
  /** answer with this status and an empty body */
  status?: number;
  /** 302 to this absolute URL or path */
  redirectTo?: string;
  /** send no Content-Length (chunked) */
  omitLength?: boolean;
}

export interface RequestLog {
  path: string;
  /** path with the query string */
  url: string;
  range?: string;
  headers: http.IncomingHttpHeaders;
}

export interface TestServer {
  url(path: string): string;
  setFile(path: string, spec: FileSpec): void;
  readonly requests: RequestLog[];
  readonly bytesSent: number;
  readonly maxConcurrent: number;
  /** TCP connections accepted so far (keep-alive reuse keeps this low) */
  readonly connections: number;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  const files = new Map<string, FileSpec & { served: number }>();
  const state = { requests: [] as RequestLog[], bytesSent: 0, maxConcurrent: 0, active: 0, connections: 0 };
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    state.requests.push({ path, url: req.url ?? "/", range: req.headers.range, headers: req.headers });
    const spec = files.get(path);
    if (!spec) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (spec.redirectTo) {
      res.writeHead(302, { Location: spec.redirectTo });
      res.end();
      return;
    }
    if (spec.status) {
      res.writeHead(spec.status);
      res.end();
      return;
    }

    const total = spec.data.length;
    let start = 0;
    let end = total - 1;
    let status = 200;
    const range = req.headers.range;
    const honourRange = spec.ranges !== false && (!spec.rangesOnlyForProbe || range === "bytes=0-0");
    if (range && honourRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      if (m) {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= total) {
          res.writeHead(416, { "Content-Range": `bytes */${total}` });
          res.end();
          return;
        }
        status = 206;
      }
    }

    const headers: http.OutgoingHttpHeaders = { "Content-Type": spec.contentType ?? "application/octet-stream" };
    if (spec.ranges !== false) headers["Accept-Ranges"] = "bytes";
    if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${total}`;
    if (!spec.omitLength) headers["Content-Length"] = String(end - start + 1);
    if (spec.contentDisposition) headers["Content-Disposition"] = spec.contentDisposition;
    if (spec.etag) headers.ETag = spec.etag;
    if (spec.lastModified) headers["Last-Modified"] = spec.lastModified;
    res.writeHead(status, headers);

    const responseIndex = spec.served++;
    const dropAt = spec.dropAfter !== undefined && responseIndex < (spec.dropCount ?? 1) ? spec.dropAfter : Infinity;
    const rate = typeof spec.throttle === "function" ? spec.throttle(start) : spec.throttle;
    const chunkSize = rate ? Math.max(16 * 1024, Math.floor(rate / 20)) : 64 * 1024;
    state.active++;
    state.maxConcurrent = Math.max(state.maxConcurrent, state.active);
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        state.active--;
      }
    };
    res.on("close", finish);

    let pos = start;
    let sent = 0;
    const pump = () => {
      if (res.destroyed) return finish();
      while (pos <= end) {
        if (sent >= dropAt) {
          req.socket.destroy();
          return finish();
        }
        const len = Math.min(chunkSize, end - pos + 1, dropAt - sent);
        const chunk = spec.data.subarray(pos, pos + len);
        pos += len;
        sent += len;
        state.bytesSent += len;
        const ok = res.write(chunk);
        if (rate) {
          setTimeout(pump, (len / rate) * 1000);
          return;
        }
        if (!ok) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });

  server.on("connection", (socket) => {
    state.connections++;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    setFile: (path: string, spec: FileSpec) => {
      files.set(path, { ...spec, served: 0 });
    },
    get requests() {
      return state.requests;
    },
    get bytesSent() {
      return state.bytesSent;
    },
    get maxConcurrent() {
      return state.maxConcurrent;
    },
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
