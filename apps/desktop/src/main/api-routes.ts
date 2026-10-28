import http from "node:http";
import path from "node:path";
import {
  isJobEnded,
  type ApiInfo,
  type InstagramLoginResult,
  type Job,
  type JobEvent,
  type JobOptions,
  type JobRequest,
} from "@turbodl/shared";

/** What the bridge needs from the app to serve the jobs API. */
export interface ApiHandlers {
  token(): string;
  info(): Promise<ApiInfo>;
  createJob(request: JobRequest): Job;
  jobs(): Job[];
  job(id: string): Job | undefined;
  cancelJob(id: string): Job | undefined;
  /** undefined: no such job */
  subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined;
  instagramLogin(): Promise<InstagramLoginResult>;
  instagramLogout(): Promise<void>;
}

const MAX_BODY = 1024 * 1024;

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 16_000) return false;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** The request body as text, or null when it is over 1 MB. */
export function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The API's routes: /v1/info, /v1/jobs…, /v1/instagram/… */
export function isApiPath(p: string): boolean {
  return p === "/v1/info" || p === "/v1/jobs" || p.startsWith("/v1/jobs/") || p.startsWith("/v1/instagram/");
}

const BOOLEAN_OPTIONS = ["highlights", "highlightsOnly", "allCollections", "audio", "postsOnly"] as const;

function parseOptions(v: unknown): JobOptions | string {
  if (!isObj(v)) return "options";
  const out: JobOptions = {};
  for (const key of BOOLEAN_OPTIONS) {
    if (v[key] === undefined) continue;
    if (typeof v[key] !== "boolean") return "options";
    out[key] = v[key];
  }
  if (v.maxHeight !== undefined) {
    if (typeof v.maxHeight !== "number" || !Number.isInteger(v.maxHeight) || v.maxHeight < 1 || v.maxHeight > 100_000) return "maxHeight";
    out.maxHeight = v.maxHeight;
  }
  if (v.collections !== undefined) {
    const c = v.collections;
    if (!Array.isArray(c) || c.length < 1 || c.length > 50 || !c.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 200)) {
      return "collections";
    }
    out.collections = c as string[];
  }
  if (v.since !== undefined) {
    const ms = typeof v.since === "string" && v.since.length <= 100 ? Date.parse(v.since) : NaN;
    if (Number.isNaN(ms)) return "since";
    out.since = new Date(ms).toISOString();
  }
  if (v.limit !== undefined) {
    if (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 100_000) return "limit";
    out.limit = v.limit;
  }
  if (v.known !== undefined) {
    const k = v.known;
    if (!Array.isArray(k) || k.length > 10_000 || !k.every((s) => typeof s === "string" && s.length >= 1 && s.length <= 64)) {
      return "known";
    }
    out.known = k as string[];
  }
  if (!out.postsOnly && (out.since !== undefined || out.limit !== undefined || out.known !== undefined)) {
    return "since, limit and known need postsOnly";
  }
  if (out.postsOnly && (out.highlights || out.highlightsOnly || out.collections || out.allCollections)) {
    return "postsOnly can't be combined with highlights or collections";
  }
  if (out.highlights && out.highlightsOnly) return "highlights and highlightsOnly can't both be set";
  if (out.collections && out.allCollections) return "collections and allCollections can't both be set";
  return out;
}

/** A job request from a client, or the name of the first field that is wrong. */
export function parseJobRequest(v: unknown): JobRequest | string {
  if (!isObj(v)) return "body";
  if (!isHttpUrl(v.url)) return "url";
  const out: JobRequest = { url: v.url };
  if (v.dir !== undefined) {
    if (typeof v.dir !== "string" || !path.isAbsolute(v.dir)) return "dir must be an absolute path";
    out.dir = v.dir;
  }
  if (v.name !== undefined) {
    if (typeof v.name !== "string" || v.name.length < 1 || v.name.length > 255) return "name";
    out.name = v.name;
  }
  if (v.options !== undefined) {
    const options = parseOptions(v.options);
    if (typeof options === "string") return options;
    out.options = options;
  }
  return out;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Streams a job's events, one JSON line each, until its end event. */
function streamEvents(req: http.IncomingMessage, res: http.ServerResponse, id: string, api: ApiHandlers): void {
  const job = api.job(id);
  if (!job) return sendJson(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  const write = (event: JobEvent) => res.write(`${JSON.stringify(event)}\n`);
  write({ type: "job", jobId: id, job });
  if (isJobEnded(job.state)) {
    write({ type: "end", jobId: id, job });
    res.end();
    return;
  }
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  unsubscribe = api.subscribe(id, (event) => {
    if (res.writableEnded) return;
    write(event);
    if (event.type === "end") {
      stop();
      res.end();
    }
  });
  if (!unsubscribe) return void res.end();
  req.on("close", stop);
  res.on("close", stop);
}

/** Answers an API request whose token and Origin were already checked. */
export async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, api: ApiHandlers): Promise<void> {
  const get = req.method === "GET";
  const post = req.method === "POST";
  if (get && urlPath === "/v1/info") return sendJson(res, 200, await api.info());
  if (urlPath === "/v1/jobs") {
    if (get) return sendJson(res, 200, { jobs: api.jobs() });
    if (post) {
      if (!String(req.headers["content-type"] ?? "").includes("application/json")) return sendJson(res, 415, { error: "content-type" });
      const body = await readBody(req);
      if (body === null) return sendJson(res, 413, { error: "too large" });
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return sendJson(res, 400, { error: "json" });
      }
      const parsed = parseJobRequest(json);
      if (typeof parsed === "string") return sendJson(res, 400, { error: parsed });
      return sendJson(res, 201, { job: api.createJob(parsed) });
    }
  }
  const match = /^\/v1\/jobs\/([^/]+)(\/events|\/cancel)?$/.exec(urlPath);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return sendJson(res, 404, { error: "not found" });
    }
    if (get && !match[2]) {
      const job = api.job(id);
      return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: "not found" });
    }
    if (get && match[2] === "/events") return streamEvents(req, res, id, api);
    if (post && match[2] === "/cancel") {
      const job = api.cancelJob(id);
      return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: "not found" });
    }
  }
  if (post && urlPath === "/v1/instagram/login") return sendJson(res, 200, await api.instagramLogin());
  if (post && urlPath === "/v1/instagram/logout") {
    await api.instagramLogout();
    return sendJson(res, 200, { signedIn: false });
  }
  sendJson(res, 404, { error: "not found" });
}
