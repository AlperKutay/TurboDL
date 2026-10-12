import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SiteServer {
  url(path: string): string;
  close(): Promise<void>;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function closer(server: http.Server): () => Promise<void> {
  return () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Test page</title></head><body>${body}</body></html>`);
}

/** Sends `data` slowly (~320 KB/s) so the extension has time to pause the browser download. */
function slow(res: http.ServerResponse, data: Buffer, type: string): void {
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(data.length) });
  let pos = 0;
  const tick = () => {
    if (res.destroyed) return;
    if (pos >= data.length) {
      res.end();
      return;
    }
    res.write(data.subarray(pos, pos + 32 * 1024));
    pos += 32 * 1024;
    setTimeout(tick, 100);
  };
  tick();
}

function ranged(req: http.IncomingMessage, res: http.ServerResponse, data: Buffer, type: string): void {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  if (!m) {
    res.writeHead(200, { "Content-Type": type, "Content-Length": String(data.length), "Accept-Ranges": "bytes" });
    res.end(data);
    return;
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
  res.writeHead(206, {
    "Content-Type": type,
    "Content-Length": String(end - start + 1),
    "Content-Range": `bytes ${start}-${end}/${data.length}`,
    "Accept-Ranges": "bytes",
  });
  res.end(data.subarray(start, end + 1));
}

export async function startSiteServer(): Promise<SiteServer> {
  const archive = Buffer.alloc(2 * 1024 * 1024, 7);
  const clip = Buffer.alloc(1024 * 1024, 1);
  const server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    switch (path) {
      case "/page.html":
        return html(res, `<a id="dl" href="/files/archive.zip">Download the archive</a>`);
      case "/video.html":
        return html(
          res,
          `<video id="v" src="/media/clip.mp4" muted autoplay style="display:block;width:640px;height:360px;background:#000"></video>
           <script>fetch("/media/playlist.m3u8").catch(() => {});</script>`,
        );
      case "/files/archive.zip":
        return slow(res, archive, "application/zip");
      case "/media/clip.mp4":
        return ranged(req, res, clip, "video/mp4");
      case "/media/playlist.m3u8":
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        res.end("#EXTM3U\n#EXT-X-ENDLIST\n");
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  const port = await listen(server);
  return { url: (p: string) => `http://127.0.0.1:${port}${p}`, close: closer(server) };
}

export interface BridgeRequest {
  method: string;
  path: string;
  origin?: string;
  body?: any;
}

export interface MockBridge {
  readonly port: number;
  accept: boolean;
  readonly requests: BridgeRequest[];
  close(): Promise<void>;
}

/** Minimal stand-in for the desktop bridge (same contract, same Origin rule). */
export async function startMockBridge(expectedOrigin: string): Promise<MockBridge> {
  const requests: BridgeRequest[] = [];
  const state = { accept: true };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = (req.url ?? "").split("?")[0];
    requests.push({ method: req.method ?? "", path, origin: req.headers.origin, body: raw ? JSON.parse(raw) : undefined });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin !== expectedOrigin) return json(403, { error: "origin" });
    if (path === "/v1/ping") return json(200, { app: "turbodl", version: "test" });
    if (path === "/v1/config") return json(200, { captureEnabled: true, captureExtensions: ["zip", "mp4"], minCaptureSize: 0 });
    if (path === "/v1/downloads") return state.accept ? json(202, { accepted: true }) : json(422, { accepted: false, reason: "test" });
    if (path === "/v1/media") return json(202, { accepted: true });
    return json(404, { error: "not found" });
  });
  const port = await listen(server);
  return {
    port,
    get accept() {
      return state.accept;
    },
    set accept(value: boolean) {
      state.accept = value;
    },
    requests,
    close: closer(server),
  };
}
