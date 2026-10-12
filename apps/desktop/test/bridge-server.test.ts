import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DownloadRequest, MediaRequest } from "@turbodl/shared";
import { createBridgeServer, type BridgeServer } from "../src/main/bridge-server";

const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";
let server: BridgeServer;
let port: number;
let downloads: DownloadRequest[];
let media: MediaRequest[];
let accept: boolean;

beforeEach(async () => {
  downloads = [];
  media = [];
  accept = true;
  server = createBridgeServer({
    version: "1.2.3",
    allowedOrigin: ORIGIN,
    getConfig: () => ({ captureEnabled: true, captureExtensions: ["zip"], minCaptureSize: 0 }),
    onDownload: async (req) => {
      downloads.push(req);
      return accept ? { accepted: true } : { accepted: false, reason: "probe failed" };
    },
    onMedia: async (req) => {
      media.push(req);
    },
  });
  port = await server.listen(0);
});
afterEach(async () => {
  await server.close();
});

interface CallOptions {
  method?: string;
  origin?: string | null;
  host?: string;
  body?: string;
  contentType?: string;
}

function call(path: string, o: CallOptions = {}): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}` };
    if (o.origin !== null) headers.Origin = o.origin ?? ORIGIN;
    if (o.body !== undefined) headers["Content-Type"] = o.contentType ?? "application/json";
    const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }));
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

describe("bridge server", () => {
  it("answers ping and config for the extension", async () => {
    expect(await call("/v1/ping")).toEqual({ status: 200, json: { app: "turbodl", version: "1.2.3" } });
    expect((await call("/v1/config")).json).toEqual({ captureEnabled: true, captureExtensions: ["zip"], minCaptureSize: 0 });
  });

  it("answers ping and config over POST, because Chrome omits Origin on extension GETs", async () => {
    expect(await call("/v1/ping", { method: "POST", body: "{}" })).toEqual({ status: 200, json: { app: "turbodl", version: "1.2.3" } });
    expect((await call("/v1/config", { method: "POST", body: "{}" })).json).toEqual({ captureEnabled: true, captureExtensions: ["zip"], minCaptureSize: 0 });
  });

  it("rejects other origins and missing origins", async () => {
    expect((await call("/v1/ping", { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/v1/ping", { origin: null })).status).toBe(403);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    expect((await call("/v1/ping", { host: `evil.example:${port}` })).status).toBe(403);
    expect((await call("/v1/ping", { host: `localhost:${port}` })).status).toBe(200);
  });

  it("accepts a valid download request", async () => {
    const res = await call("/v1/downloads", {
      method: "POST",
      body: JSON.stringify({ url: "https://x.com/a.zip", referrer: "https://x.com/", cookies: "a=1", fileSize: 10, source: "intercept", extra: 1 }),
    });
    expect(res).toEqual({ status: 202, json: { accepted: true } });
    expect(downloads[0]).toEqual({ url: "https://x.com/a.zip", referrer: "https://x.com/", cookies: "a=1", fileSize: 10, source: "intercept" });
  });

  it("returns 422 when the app declines", async () => {
    accept = false;
    const res = await call("/v1/downloads", { method: "POST", body: JSON.stringify({ url: "https://x.com/a.zip", source: "intercept" }) });
    expect(res).toEqual({ status: 422, json: { accepted: false, reason: "probe failed" } });
  });

  it("validates bodies", async () => {
    expect((await call("/v1/downloads", { method: "POST", body: JSON.stringify({ url: "javascript:alert(1)" }) })).status).toBe(400);
    expect((await call("/v1/downloads", { method: "POST", body: "{nope" })).status).toBe(400);
    expect((await call("/v1/downloads", { method: "POST", body: "{}", contentType: "text/plain" })).status).toBe(415);
    expect((await call("/v1/downloads", { method: "POST", body: JSON.stringify({ url: "https://x.com/" + "a".repeat(1_100_000) }) })).status).toBe(413);
    expect(downloads).toHaveLength(0);
  });

  it("accepts media requests and drops invalid items", async () => {
    const res = await call("/v1/media", {
      method: "POST",
      body: JSON.stringify({
        pageUrl: "https://video.example/watch?v=1",
        title: "Clip",
        items: [
          { url: "https://cdn.example/a.m3u8", kind: "hls", size: 10 },
          { url: "blob:https://video.example/1", kind: "file" },
          { url: "https://cdn.example/b.mp4", kind: "weird" },
        ],
      }),
    });
    expect(res.status).toBe(202);
    expect(media[0]).toEqual({ pageUrl: "https://video.example/watch?v=1", title: "Clip", items: [{ url: "https://cdn.example/a.m3u8", kind: "hls", size: 10 }] });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await call("/v1/nope")).status).toBe(404);
  });

  it("fails to listen on a busy port", async () => {
    const other = createBridgeServer({
      version: "x",
      allowedOrigin: ORIGIN,
      getConfig: () => ({ captureEnabled: true, captureExtensions: [], minCaptureSize: 0 }),
      onDownload: async () => ({ accepted: true }),
      onMedia: async () => undefined,
    });
    await expect(other.listen(port)).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
