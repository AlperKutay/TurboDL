import http from "node:http";
import path from "node:path";
import {
  TAGGED_AVAILABLE,
  isJobEnded,
  parseIsoTime,
  type ApiInfo,
  type InstagramLoginResult,
  type Job,
  type JobEvent,
  type JobOptions,
  type JobRequest,
  type ListWait,
  type ProfileListView,
  type ProfileSaveOptions,
  type Result,
  type TelegramPairResult,
  type TelegramStatus,
  DEFAULT_LIST_WAIT,
  waitProblem,
} from "@turbodl/shared";
import { UNFINISHED, listNames } from "./instagram/profile-lists";

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
  /** the profile list, or null when there is none */
  list(): ProfileListView | null;
  startList(request: ParsedListRequest): Promise<Result>;
  stopList(): Promise<void>;
  continueList(): Promise<Result>;
  closeList(): Promise<Result>;
  /** the Telegram bot: its status (never its token) and its settings */
  telegram: {
    status(): TelegramStatus;
    setToken(token: string | null): Promise<Result>;
    setChat(chatId: number | null): Promise<Result>;
    setEnabled(enabled: boolean): Promise<Result>;
    pair(): Promise<TelegramPairResult>;
  };
}

/** A list request as the app starts it: names as `listNames` gives them, every option and the wait filled in. */
export interface ParsedListRequest {
  name: string;
  usernames: string[];
  options: ProfileSaveOptions;
  wait: ListWait;
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

/** The API's routes: /v1/info, /v1/jobs…, /v1/lists…, /v1/instagram/… */
export function isApiPath(p: string): boolean {
  return p === "/v1/info" || p === "/v1/jobs" || p.startsWith("/v1/jobs/") || p === "/v1/lists" || p.startsWith("/v1/lists/") || p.startsWith("/v1/instagram/");
}

/** The methods the API answers on a path: only the lists routes take DELETE. */
export function isApiMethod(method: string | undefined, p: string): boolean {
  return method === "GET" || method === "POST" || (method === "DELETE" && (p === "/v1/lists" || p.startsWith("/v1/lists/")));
}

const LIST_OPTION_KEYS = ["posts", "highlights", "tagged", "photos", "videos"] as const;
/** a list's options when the request leaves them out: unlike a single profile job, highlights are on */
const LIST_OPTION_DEFAULTS: ProfileSaveOptions = { posts: true, highlights: true, tagged: false, photos: true, videos: true };

/**
 * A list request from a client, or why not: the name of the first field that is wrong, or the app's own message for
 * profiles and the wait. Every option comes out a boolean (a stored list with anything else is lost after a restart).
 */
export function parseListRequest(v: unknown): ParsedListRequest | string {
  if (!isObj(v)) return "body";
  if (!Array.isArray(v.profiles)) return "profiles";
  const names = listNames(v.profiles);
  if ("error" in names) return names.error;
  const options = { ...LIST_OPTION_DEFAULTS };
  if (v.options !== undefined) {
    if (!isObj(v.options)) return "options";
    for (const [key, value] of Object.entries(v.options)) {
      if (!(LIST_OPTION_KEYS as readonly string[]).includes(key) || typeof value !== "boolean") return "options";
      options[key as (typeof LIST_OPTION_KEYS)[number]] = value;
    }
  }
  let wait: ListWait = { ...DEFAULT_LIST_WAIT };
  if (v.wait !== undefined) {
    const w = isObj(v.wait) ? v.wait : {};
    const problem = waitProblem({ min: w.min, max: w.max });
    if (problem) return problem;
    wait = { min: w.min as number, max: w.max as number };
  }
  let name = "API list";
  if (v.name !== undefined) {
    if (typeof v.name !== "string" || v.name.length < 1 || v.name.length > 255) return "name";
    name = v.name;
  }
  return { name, usernames: names.names, options, wait };
}

const BOOLEAN_OPTIONS = ["highlights", "highlightsOnly", "allCollections", "audio", "postsOnly", "posts", "tagged", "photos", "videos"] as const;

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
    const iso = typeof v.since === "string" && v.since.length <= 100 ? parseIsoTime(v.since) : undefined;
    if (iso === undefined) return "since";
    out.since = iso;
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
  if (out.postsOnly && (out.posts !== undefined || out.tagged !== undefined || out.photos !== undefined || out.videos !== undefined)) {
    return "postsOnly can't be combined with posts, tagged, photos or videos";
  }
  if (out.highlightsOnly && out.posts !== undefined) return "highlightsOnly can't be combined with posts";
  if (out.tagged && !TAGGED_AVAILABLE) return "tagged isn't available in this version";
  if (out.photos === false && out.videos === false) return "photos and videos can't both be off";
  if (out.posts === false && !out.highlights && !out.tagged && !out.highlightsOnly) {
    return "nothing to save: posts is off and neither highlights nor tagged is on";
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

/** The list routes: start it, read it, stop it, continue it, close it. */
async function handleLists(req: http.IncomingMessage, res: http.ServerResponse, urlPath: string, api: ApiHandlers): Promise<void> {
  const method = req.method;
  if (urlPath === "/v1/lists" && method === "POST") {
    if (!String(req.headers["content-type"] ?? "").includes("application/json")) return sendJson(res, 415, { error: "content-type" });
    const body = await readBody(req);
    if (body === null) return sendJson(res, 413, { error: "too large" });
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { error: "json" });
    }
    const parsed = parseListRequest(json);
    if (typeof parsed === "string") return sendJson(res, 400, { error: parsed });
    const started = await api.startList(parsed);
    if (!started.ok) return sendJson(res, started.error === UNFINISHED ? 409 : 400, { error: started.error });
    return sendJson(res, 201, { list: api.list() });
  }
  if (urlPath !== "/v1/lists/current" && urlPath !== "/v1/lists/current/stop" && urlPath !== "/v1/lists/current/continue") {
    return sendJson(res, 404, { error: "not found" });
  }
  if (urlPath === "/v1/lists/current" && method === "GET") return sendJson(res, 200, { list: api.list() });
  if (urlPath === "/v1/lists/current/stop" && method === "POST") {
    await api.stopList();
    return sendJson(res, 200, { list: api.list() });
  }
  if (urlPath === "/v1/lists/current/continue" && method === "POST") {
    const resumed = await api.continueList();
    return resumed.ok ? sendJson(res, 200, { list: api.list() }) : sendJson(res, 409, { error: resumed.error });
  }
  if (urlPath === "/v1/lists/current" && method === "DELETE") {
    if (!api.list()) return sendJson(res, 200, { list: null });
    const closed = await api.closeList();
    return closed.ok ? sendJson(res, 200, { list: null }) : sendJson(res, 409, { error: closed.error });
  }
  sendJson(res, 404, { error: "not found" });
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
  if (urlPath.startsWith("/v1/lists")) return handleLists(req, res, urlPath, api);
  if (post && urlPath === "/v1/instagram/login") return sendJson(res, 200, await api.instagramLogin());
  if (post && urlPath === "/v1/instagram/logout") {
    await api.instagramLogout();
    return sendJson(res, 200, { signedIn: false });
  }
  sendJson(res, 404, { error: "not found" });
}
