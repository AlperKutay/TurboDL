import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_FEATURES, API_VERSION, APP_ID, type ApiFile, type ApiInfo, type AppEvent, type BrowserCookie, type Job, type JobEvent, type PendingItem } from "@turbodl/shared";
import { AppController, type ControllerUi, type InstagramDeps } from "../src/main/controller";
import { startTestServer, type TestServer } from "./fixtures/test-server";

const FAKE_YTDLP = path.join(__dirname, "fixtures", "fake-ytdlp.mjs");
const LAUNCH = { file: "turbodl-test", args: ["--hidden"] };
const SESSION: BrowserCookie[] = [
  { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "s" },
  { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "csrftoken", value: "c" },
];

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

class FakeUi implements ControllerUi {
  events: AppEvent[] = [];
  broadcast(e: AppEvent) {
    this.events.push(e);
  }
  openPending(_item: PendingItem) {}
  closePending() {}
  showMain() {}
  notifyCompleted() {}
  setLaunchAtLogin() {}
  quit() {}
}

let server: TestServer;
let root: string;
let controller: AppController | null;
let port: number;

beforeEach(async () => {
  server = await startTestServer();
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-api-"));
  controller = null;
});
afterEach(async () => {
  await controller?.shutdown();
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const userData = () => path.join(root, "user");
const apiFile = () => JSON.parse(readFileSync(path.join(userData(), "api.json"), "utf8")) as ApiFile;

async function start(bridgePort?: number, instagram?: InstagramDeps, ui: ControllerUi = new FakeUi()): Promise<AppController> {
  mkdirSync(userData(), { recursive: true });
  port = bridgePort ?? (await freePort());
  writeFileSync(path.join(userData(), "settings.json"), JSON.stringify({ baseDir: path.join(root, "dl"), bridgePort: port }));
  const extensionDir = path.join(root, "ext");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(extensionDir, "manifest.json"), "{}");
  controller = new AppController({
    version: "0.0.1",
    userDataDir: userData(),
    downloadsDir: path.join(root, "Downloads"),
    documentsDir: path.join(root, "Documents"),
    extensionSourceDir: extensionDir,
    ffmpegPath: null,
    ui,
    launch: LAUNCH,
    mediaTools: { ensure: async () => ({ ytdlp: "unused", deno: null, ffmpeg: null }), updateIfStale: async () => undefined },
    ytdlpCommand: () => ({ file: process.execPath, args: [FAKE_YTDLP] }),
    instagram,
  });
  await controller.init();
  return controller;
}

/** One call to the API, as a client sends it: the token, no Origin. */
function call(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiFile().token}` };
    if (data !== undefined) headers["Content-Type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

/** The job's events, read until the stream closes. */
function events(id: string): { done: Promise<JobEvent[]>; seen: JobEvent[] } {
  const seen: JobEvent[] = [];
  const done = new Promise<JobEvent[]>((resolve, reject) => {
    const headers = { Authorization: `Bearer ${apiFile().token}` };
    const req = http.request({ host: "127.0.0.1", port, path: `/v1/jobs/${id}/events`, headers }, (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (text: string) => {
        buffer += text;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) if (line) seen.push(JSON.parse(line) as JobEvent);
      });
      res.on("close", () => resolve(seen));
    });
    req.on("error", reject);
    req.end();
  });
  return { done, seen };
}

describe("api.json", () => {
  it("writes api.json with the bridge's port and a token, and rewrites it when the port changes", async () => {
    const c = await start();
    const first = apiFile();
    expect(first).toMatchObject({ api: API_VERSION, version: "0.0.1", port, launch: LAUNCH });
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    const other = await freePort();
    await c.updateSettings({ bridgePort: other });
    expect(apiFile()).toEqual({ ...first, port: other });
  });

  it("writes port null when the port is taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    try {
      const taken = (blocker.address() as net.AddressInfo).port;
      await start(taken);
      // clients say so with the app's own message
      expect(apiFile()).toMatchObject({ port: null, error: `Port ${taken} is used by another program. Choose another port in Settings.` });
    } finally {
      blocker.close();
    }
  });
});

describe("api.json failures", () => {
  it("answers with the token from api.json right after init", async () => {
    await start();
    const res = await call("GET", "/v1/info");
    expect(res.status).toBe(200);
    const bad = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/v1/info", headers: { Authorization: "Bearer " } }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(bad).toBe(403);
  });

  it("starts and broadcasts the bridge status when api.json can't be written", async () => {
    mkdirSync(path.join(userData(), "api.json"), { recursive: true });
    const ui = new FakeUi();
    const c = await start(undefined, undefined, ui);
    expect(c.snapshot().bridge).toMatchObject({ ok: true, port });
    expect(ui.events.some((e) => e.type === "bridge")).toBe(true);
    // the file it couldn't put in place is not left behind
    expect(readdirSync(userData()).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("jobs API", () => {
  it("runs a file link sent with the token and streams it to its end", async () => {
    const data = Buffer.alloc(2000, 7);
    server.setFile("/files/a.zip", { data, contentType: "application/zip" });
    await start();
    const created = await call("POST", "/v1/jobs", { url: server.url("/files/a.zip") });
    expect(created.status).toBe(201);
    const job = (created.json as { job: Job }).job;
    expect(job.kind).toBe("file");
    const all = await events(job.id).done;
    const end = all[all.length - 1];
    expect(end.type).toBe("end");
    if (end.type !== "end") return;
    expect(end.job).toMatchObject({ state: "done" });
    expect(existsSync(end.job.files[0])).toBe(true);
    expect(readFileSync(end.job.files[0])).toEqual(data);
  });

  it("answers who is signed in to Instagram, without asking Instagram", async () => {
    let asked = 0;
    const instagram: InstagramDeps = {
      find: async () => ({ type: "nothing" }),
      signIn: async () => null,
      crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
      agent: "TestAgent/1",
      get: async (url) => {
        asked++;
        if (url.endsWith("/web_form_data/")) return { status: 200, body: JSON.stringify({ form_data: { username: "sample.user" }, status: "ok" }) };
        return { status: 200, body: "{}" };
      },
      collections: async () => [{ id: "100", name: "All posts", count: 4, isAll: true }],
    };
    const c = await start(undefined, instagram);
    const info = async () => (await call("GET", "/v1/info")).json as ApiInfo;
    expect(await info()).toEqual({ app: APP_ID, version: "0.0.1", api: API_VERSION, instagram: { signedIn: false }, features: [...API_FEATURES] });
    c.instagramSession.take(SESSION);
    expect(await info()).toEqual({ app: APP_ID, version: "0.0.1", api: API_VERSION, instagram: { signedIn: true }, features: [...API_FEATURES] });
    expect(asked).toBe(0);
    await c.savedCollections(true);
    asked = 0;
    expect((await info()).instagram).toEqual({ signedIn: true, username: "sample.user" });
    expect(asked).toBe(0);
  });

  it("closes event streams on shutdown", async () => {
    server.setFile("/files/slow.bin", { data: Buffer.alloc(200000, 1), contentType: "application/octet-stream", throttle: 1000 });
    const c = await start();
    const created = await call("POST", "/v1/jobs", { url: server.url("/files/slow.bin") });
    const id = (created.json as { job: Job }).job.id;
    const stream = events(id);
    for (let i = 0; i < 200 && stream.seen.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect(stream.seen.length).toBeGreaterThan(0);
    await c.shutdown();
    const all = await Promise.race([stream.done, new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    expect(all).not.toBeNull();
    // the stream was closed by the bridge, not ended by the job
    expect(all?.some((e) => e.type === "end")).toBe(false);
  });
});
