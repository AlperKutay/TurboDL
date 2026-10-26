import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApiFile, ApiInfo, InstagramLoginResult, Job, JobEvent, JobEventBody, JobRequest } from "@turbodl/shared";
import { createBridgeServer, type BridgeServer } from "../../src/main/bridge-server";
import type { ApiHandlers } from "../../src/main/api-routes";

export const TOKEN = "secret-token-0123456789";

/** A job as the fake app holds it. */
export function makeJob(id: string, patch: Partial<Job> = {}): Job {
  return { id, url: "https://example.com/a.zip", kind: "file", state: "running", warnings: [], files: [], failedItems: 0, progress: { done: 0 }, createdAt: 1, ...patch };
}

/** The real API routes on a free port, backed by scripted jobs, with api.json in a temporary user data folder. */
export interface FakeApi {
  /** the temporary user data folder holding api.json */
  dir: string;
  port: number;
  jobs: Map<string, Job>;
  requests: JobRequest[];
  cancelled: string[];
  instagram: InstagramLoginResult;
  loggedOut: boolean;
  /** resolves once `cond` holds; checked now and after every API call */
  until(cond: () => boolean): Promise<void>;
  /** resolves once the job's events were subscribed to `count` times in all */
  subscribed(id: string, count?: number): Promise<void>;
  /** live event listeners of the job */
  listeners(id: string): number;
  /** sends an event to the job's followers and updates the job */
  push(id: string, body: JobEventBody): void;
  /** ends the job with `patch` (at least its state) and sends `end` */
  end(id: string, patch: Partial<Job>): void;
  /** closes the server, cutting every stream, as a quitting app does */
  stop(): Promise<void>;
  /** serves the same jobs on a new port and rewrites api.json, as a port change in Settings does */
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

/** Starts the fake app. */
export async function startFakeApi(): Promise<FakeApi> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turbodl-cli-main-"));
  const jobs = new Map<string, Job>();
  const listeners = new Map<string, Set<(e: JobEvent) => void>>();
  const subscriptions = new Map<string, number>();
  const waiters = new Set<() => void>();
  const servers: BridgeServer[] = [];
  const notify = () => {
    for (const w of [...waiters]) w();
  };

  const handlers: ApiHandlers = {
    token: () => TOKEN,
    info: async (): Promise<ApiInfo> => ({ app: "turbodl", version: "1.2.3", api: 1, instagram: fake.instagram }),
    createJob: (request) => {
      const job = makeJob(`job${jobs.size + 1}`, { url: request.url, state: "queued" });
      jobs.set(job.id, job);
      fake.requests.push(request);
      notify();
      return job;
    },
    jobs: () => [...jobs.values()].reverse(),
    job: (id) => jobs.get(id),
    cancelJob: (id) => {
      const job = jobs.get(id);
      if (job) fake.cancelled.push(id);
      notify();
      return job;
    },
    subscribe: (id, listener) => {
      if (!jobs.has(id)) return undefined;
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      subscriptions.set(id, (subscriptions.get(id) ?? 0) + 1);
      notify();
      return () => {
        set.delete(listener);
        notify();
      };
    },
    instagramLogin: async () => fake.instagram,
    instagramLogout: async () => {
      fake.loggedOut = true;
      fake.instagram = { signedIn: false };
    },
  };

  const serve = async (): Promise<number> => {
    const server = createBridgeServer({
      version: "1.2.3",
      allowedOrigin: "chrome-extension://fnkkncklkbdmaphmmddfmbcjkllejhea",
      getConfig: () => ({ captureEnabled: true, captureExtensions: [], minCaptureSize: 0 }),
      onDownload: async () => ({ accepted: true }),
      onMedia: async () => undefined,
      api: handlers,
    });
    servers.push(server);
    const port = await server.listen(0);
    const file: ApiFile = { api: 1, version: "1.2.3", port, token: TOKEN, launch: { file: "turbodl-test-never-started", args: ["--hidden"] } };
    fs.writeFileSync(path.join(dir, "api.json"), JSON.stringify(file));
    return port;
  };

  const emit = (id: string, body: JobEventBody) => {
    for (const l of [...(listeners.get(id) ?? [])]) l({ ...body, jobId: id } as JobEvent);
  };

  const fake: FakeApi = {
    dir,
    port: 0,
    jobs,
    requests: [],
    cancelled: [],
    instagram: { signedIn: false },
    loggedOut: false,
    until(cond) {
      return new Promise((resolve) => {
        const check = () => {
          if (!cond()) return;
          waiters.delete(check);
          resolve();
        };
        waiters.add(check);
        check();
      });
    },
    subscribed(id, count = 1) {
      return fake.until(() => (subscriptions.get(id) ?? 0) >= count);
    },
    listeners(id) {
      return listeners.get(id)?.size ?? 0;
    },
    push(id, body) {
      const job = jobs.get(id);
      if (!job) throw new Error(`no job ${id}`);
      if (body.type === "file") job.files.push(body.path);
      if (body.type === "state") job.state = body.state;
      if (body.type === "progress") job.progress = body.progress;
      if (body.type === "warning") job.warnings.push(body.message);
      emit(id, body);
    },
    end(id, patch) {
      const job = { ...jobs.get(id)!, ...patch, endedAt: 2 };
      jobs.set(id, job);
      emit(id, { type: "end", job });
    },
    async stop() {
      await servers.at(-1)?.close();
    },
    async restart() {
      fake.port = await serve();
    },
    async dispose() {
      for (const s of servers) await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  fake.port = await serve();
  return fake;
}
