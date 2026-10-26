import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiInfo, Job, JobEvent } from "@turbodl/shared";
import { createBridgeServer, type BridgeServer } from "../../src/main/bridge-server";
import type { ApiHandlers } from "../../src/main/api-routes";
import { ApiClient, ApiError, ping } from "../../src/cli/client";

const TOKEN = "secret-token-0123456789";
const info: ApiInfo = { app: "turbodl", version: "1.2.3", api: 1, instagram: { signedIn: false } };

function makeJob(id: string, state: Job["state"] = "running"): Job {
  return { id, url: "https://example.com/a.zip", kind: "file", state, warnings: [], files: [], failedItems: 0, progress: { done: 0 }, createdAt: 1 };
}

let server: BridgeServer;
let port: number;
let client: ApiClient;
let jobs: Map<string, Job>;
let script: (listener: (e: JobEvent) => void, id: string) => void;
let loggedOut: boolean;

const fake: ApiHandlers = {
  token: () => TOKEN,
  info: async () => info,
  createJob: (request) => {
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
    setTimeout(() => script(listener, id), 20);
    return () => undefined;
  },
  instagramLogin: async () => ({ signedIn: true, username: "someone" }),
  instagramLogout: async () => void (loggedOut = true),
};

beforeEach(async () => {
  jobs = new Map();
  loggedOut = false;
  script = () => undefined;
  server = createBridgeServer({
    version: "1.2.3",
    allowedOrigin: "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea",
    getConfig: () => ({ captureEnabled: true, captureExtensions: [], minCaptureSize: 0 }),
    onDownload: async () => ({ accepted: true }),
    onMedia: async () => undefined,
    api: fake,
  });
  port = await server.listen(0);
  client = new ApiClient({ port, token: TOKEN });
});
afterEach(async () => {
  await server.close();
});

describe("ApiClient", () => {
  it("reads info and pings", async () => {
    expect(await client.info()).toEqual(info);
    expect(await ping({ port, token: TOKEN })).toBe(true);
    expect(await ping({ port, token: "wrong" })).toBe(false);
  });

  it("creates, lists, reads and cancels jobs", async () => {
    const job = await client.createJob({ url: "https://example.com/a.zip" });
    expect(job.id).toBe("job1");
    expect((await client.jobs()).map((j) => j.id)).toEqual(["job1"]);
    expect((await client.job("job1"))?.id).toBe("job1");
    expect((await client.cancel("job1"))?.state).toBe("cancelled");
  });

  it("turns a 400 into an ApiError with the API's message", async () => {
    await expect(client.createJob({ url: "ftp://nope" })).rejects.toMatchObject({ status: 400, message: "url" });
  });

  it("returns null for an unknown job", async () => {
    expect(await client.job("nope")).toBeNull();
    expect(await client.cancel("nope")).toBeNull();
  });

  it("handles Instagram login and logout", async () => {
    expect(await client.instagramLogin()).toEqual({ signedIn: true, username: "someone" });
    await client.instagramLogout();
    expect(loggedOut).toBe(true);
  });

  it("yields events from job to end, then stops", async () => {
    jobs.set("j", makeJob("j"));
    script = (l, id) => {
      l({ type: "job", job: makeJob(id), jobId: id });
      l({ type: "state", state: "running", jobId: id });
      l({ type: "end", job: makeJob(id, "done"), jobId: id });
    };
    const types: string[] = [];
    for await (const e of client.events("j")) types.push(e.type);
    expect(types[0]).toBe("job");
    expect(types.at(-1)).toBe("end");
  });

  it("stops when the server closes the stream without end", async () => {
    jobs.set("j", makeJob("j"));
    script = () => {
      setTimeout(() => void server.close(), 20);
    };
    const types: string[] = [];
    for await (const e of client.events("j")) types.push(e.type);
    expect(types).toEqual(["job"]);
  });

  it("ends the events and lets go of the stream when the signal aborts", async () => {
    jobs.set("j", makeJob("j"));
    const abort = new AbortController();
    const types: string[] = [];
    for await (const e of client.events("j", abort.signal)) {
      types.push(e.type);
      abort.abort();
    }
    expect(types).toEqual(["job"]);
  }, 5000);

  it("reports a wrong token as 403", async () => {
    const bad = new ApiClient({ port, token: "wrong" });
    await expect(bad.info()).rejects.toMatchObject({ status: 403, message: "TurboDL refused the key in api.json." });
  });

  it("reports a closed port as a lost connection", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const err = await new ApiClient({ port: closed, token: TOKEN }).info().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, message: "Lost the connection to TurboDL." });
    expect(await ping({ port: closed, token: TOKEN })).toBe(false);
  });
  it("rejects events for an unknown job and for a wrong token", async () => {
    await expect(client.events("nope")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 404, message: "not found" });
    const bad = new ApiClient({ port, token: "wrong" });
    await expect(bad.events("j")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ status: 403, message: "TurboDL refused the key in api.json." });
  });

  it("reassembles a line and a multi-byte character split across chunks", async () => {
    const NL = String.fromCharCode(10);
    const event: JobEvent = { type: "warning", message: "café 日本", jobId: "j" };
    const bytes = Buffer.from(JSON.stringify(event) + NL + JSON.stringify({ type: "state", state: "done", jobId: "j" }) + NL, "utf8");
    // cut inside the two-byte "é"
    const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
    const raw = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(bytes.subarray(0, cut));
      setTimeout(() => res.end(bytes.subarray(cut)), 30);
    });
    const rawPort = await new Promise<number>((r) => raw.listen(0, "127.0.0.1", () => r((raw.address() as { port: number }).port)));
    try {
      const got: JobEvent[] = [];
      for await (const e of new ApiClient({ port: rawPort, token: TOKEN }).events("j")) got.push(e);
      expect(got).toEqual([event, { type: "state", state: "done", jobId: "j" }]);
    } finally {
      raw.close();
    }
  });
});
