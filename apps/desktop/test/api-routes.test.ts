import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isJobEnded, type ApiInfo, type Job, type JobEvent, type JobRequest } from "@turbodl/shared";
import { createBridgeServer, type BridgeServer } from "../src/main/bridge-server";
import type { ApiHandlers } from "../src/main/api-routes";

const ORIGIN = "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea";
const TOKEN = "secret-token-0123456789";
const DIR = process.platform === "win32" ? "C:\\Downloads" : "/downloads";

let server: BridgeServer;
let port: number;
let jobs: Map<string, Job>;
let listeners: Map<string, Set<(event: JobEvent) => void>>;
let requests: JobRequest[];

const info: ApiInfo = { app: "turbodl", version: "1.2.3", api: 1, instagram: { signedIn: false } };

function makeJob(id: string, state: Job["state"] = "running"): Job {
  return { id, url: "https://example.com/a.zip", kind: "file", state, warnings: [], files: [], failedItems: 0, progress: { done: 0 }, createdAt: 1 };
}

function liveListeners(): number {
  let n = 0;
  for (const set of listeners.values()) n += set.size;
  return n;
}

function push(id: string, event: JobEvent) {
  for (const l of [...(listeners.get(id) ?? [])]) l(event);
}

const fake: ApiHandlers = {
  token: () => TOKEN,
  info: async () => info,
  createJob: (request) => {
    requests.push(request);
    const job = makeJob(`job${jobs.size + 1}`, "queued");
    jobs.set(job.id, job);
    return job;
  },
  jobs: () => [...jobs.values()],
  job: (id) => jobs.get(id),
  cancelJob: (id) => {
    const job = jobs.get(id);
    if (job) job.state = "cancelled";
    return job;
  },
  subscribe: (id, listener) => {
    if (!jobs.has(id)) return undefined;
    const set = listeners.get(id) ?? new Set();
    listeners.set(id, set);
    set.add(listener);
    return () => void set.delete(listener);
  },
  instagramLogin: async () => ({ signedIn: true, username: "someone" }),
  instagramLogout: async () => undefined,
};

beforeEach(async () => {
  jobs = new Map();
  listeners = new Map();
  requests = [];
  server = createBridgeServer({
    version: "1.2.3",
    allowedOrigin: ORIGIN,
    getConfig: () => ({ captureEnabled: true, captureExtensions: [], minCaptureSize: 0 }),
    onDownload: async () => ({ accepted: true }),
    onMedia: async () => undefined,
    api: fake,
  });
  port = await server.listen(0);
});
afterEach(async () => {
  await server.close();
});

interface CallOptions {
  method?: string;
  origin?: string;
  token?: string | null;
  body?: string;
}

function headersFor(o: CallOptions): Record<string, string> {
  const headers: Record<string, string> = { Host: `127.0.0.1:${port}` };
  if (o.origin) headers.Origin = o.origin;
  if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN}`;
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  return headers;
}

function call(path: string, o: CallOptions = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: headersFor(o) }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, headers: res.headers }));
    });
    req.on("error", reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

const post = (path: string, body: unknown, o: CallOptions = {}) => call(path, { ...o, method: "POST", body: JSON.stringify(body) });

/** Opens an event stream and hands back what was read so far; lines are parsed as they arrive. */
function follow(path: string) {
  const lines: any[] = [];
  let socketReq!: http.ClientRequest;
  const closed = new Promise<void>((resolve) => {
    socketReq = http.request({ host: "127.0.0.1", port, path, headers: headersFor({}) }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          lines.push(JSON.parse(buf.slice(0, i)));
          buf = buf.slice(i + 1);
        }
      });
      res.on("end", () => resolve());
      res.on("close", () => resolve());
    });
    socketReq.on("error", () => resolve());
    socketReq.end();
  });
  const waitFor = async (n: number) => {
    const until = Date.now() + 2000;
    while (lines.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
  };
  return { lines, closed, waitFor, destroy: () => socketReq.destroy() };
}

describe("token and origin", () => {
  it("refuses API calls without the token, with a wrong one, and from a website even with the token", async () => {
    expect((await call("/v1/info", { token: null })).status).toBe(403);
    const wrong = await call("/v1/info", { token: "wrong" });
    expect(wrong.status).toBe(403);
    expect(wrong.json).toEqual({ error: "token" });
    expect((await call("/v1/info", { origin: "https://site.example" })).status).toBe(403);
  });

  it("accepts the token with no Origin and with the extension's Origin", async () => {
    const bare = await call("/v1/info");
    expect(bare.status).toBe(200);
    expect(bare.json).toEqual(info);
    const ext = await call("/v1/info", { origin: ORIGIN });
    expect(ext.status).toBe(200);
    expect(ext.json).toEqual(info);
  });

  it("keeps a website's preflight out", async () => {
    const res = await call("/v1/jobs", { method: "OPTIONS", origin: "https://site.example", token: null });
    expect(res.status).toBe(403);
  });

  it("keeps the extension's routes behind their Origin rule", async () => {
    const res = await post("/v1/downloads", { url: "https://example.com/a.zip" });
    expect(res.status).toBe(403);
  });
});

describe("jobs", () => {
  it("creates a job and answers 201 with it", async () => {
    const res = await post("/v1/jobs", { url: "https://example.com/a.zip", dir: DIR, name: "a.zip", options: { audio: true }, extra: 1 });
    expect(res.status).toBe(201);
    expect(res.json.job.id).toBe("job1");
    expect(requests).toEqual([{ url: "https://example.com/a.zip", dir: DIR, name: "a.zip", options: { audio: true } }]);
    expect((await call("/v1/jobs")).json.jobs).toHaveLength(1);
    expect((await call("/v1/jobs/job1")).json.job.id).toBe("job1");
  });

  it("answers 400 for a bad url, a relative dir, a bad maxHeight and conflicting options", async () => {
    const err = async (body: unknown) => {
      const res = await post("/v1/jobs", body);
      expect(res.status).toBe(400);
      return res.json.error;
    };
    expect(await err({ url: "ftp://example.com/a" })).toBe("url");
    expect(await err({ url: "https://example.com/a", dir: "relative/dir" })).toBe("dir must be an absolute path");
    expect(await err({ url: "https://example.com/a", name: "" })).toBe("name");
    expect(await err({ url: "https://example.com/a", options: "x" })).toBe("options");
    expect(await err({ url: "https://example.com/a", options: { audio: "yes" } })).toBe("options");
    expect(await err({ url: "https://example.com/a", options: { maxHeight: 0 } })).toBe("maxHeight");
    expect(await err({ url: "https://example.com/a", options: { maxHeight: 720.5 } })).toBe("maxHeight");
    expect(await err({ url: "https://example.com/a", options: { collections: [] } })).toBe("collections");
    expect(await err({ url: "https://example.com/a", options: { highlights: true, highlightsOnly: true } })).toBe(
      "highlights and highlightsOnly can't both be set",
    );
    expect(await err({ url: "https://example.com/a", options: { collections: ["a"], allCollections: true } })).toBe(
      "collections and allCollections can't both be set",
    );
    expect(requests).toEqual([]);
  });

  it("cancels a job and answers the job", async () => {
    await post("/v1/jobs", { url: "https://example.com/a.zip" });
    const res = await post("/v1/jobs/job1/cancel", {});
    expect(res.status).toBe(200);
    expect(res.json.job.state).toBe("cancelled");
  });

  it("answers 404 for an unknown job and an unknown API route", async () => {
    expect((await call("/v1/jobs/nope")).status).toBe(404);
    expect((await call("/v1/jobs/nope/events")).status).toBe(404);
    expect((await post("/v1/jobs/nope/cancel", {})).status).toBe(404);
    expect((await call("/v1/instagram/nothing")).status).toBe(404);
  });

  it("runs the Instagram routes", async () => {
    expect((await post("/v1/instagram/login", {})).json).toEqual({ signedIn: true, username: "someone" });
    expect((await post("/v1/instagram/logout", {})).json).toEqual({ signedIn: false });
  });
});

describe("events", () => {
  it("streams a job's events as lines, the job first and the end last, then closes", async () => {
    jobs.set("j", makeJob("j"));
    const stream = follow("/v1/jobs/j/events");
    await stream.waitFor(1);
    const done = { ...makeJob("j", "done"), endedAt: 2 };
    push("j", { type: "state", state: "running", jobId: "j" });
    push("j", { type: "file", path: "a.zip", jobId: "j" });
    push("j", { type: "end", job: done, jobId: "j" });
    await stream.closed;
    expect(stream.lines.map((l) => l.type)).toEqual(["job", "state", "file", "end"]);
    expect(stream.lines.every((l) => l.jobId === "j")).toBe(true);
    expect(stream.lines[3].job.state).toBe("done");
    expect(liveListeners()).toBe(0);
  });

  it("answers an ended job's events at once", async () => {
    jobs.set("j", makeJob("j", "failed"));
    expect(isJobEnded(jobs.get("j")!.state)).toBe(true);
    const stream = follow("/v1/jobs/j/events");
    await stream.closed;
    expect(stream.lines.map((l) => l.type)).toEqual(["job", "end"]);
  });

  it("lets go of a follower that hangs up", async () => {
    jobs.set("j", makeJob("j"));
    const stream = follow("/v1/jobs/j/events");
    await stream.waitFor(1);
    expect(liveListeners()).toBe(1);
    stream.destroy();
    const until = Date.now() + 1000;
    while (liveListeners() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(liveListeners()).toBe(0);
    expect(() => push("j", { type: "state", state: "running", jobId: "j" })).not.toThrow();
  });

  it("closes open event streams when the bridge closes", async () => {
    jobs.set("j", makeJob("j"));
    const stream = follow("/v1/jobs/j/events");
    await stream.waitFor(1);
    await server.close();
    await stream.closed;
    expect(stream.lines.map((l) => l.type)).toEqual(["job"]);
  });
});
