import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_FEATURES, isJobEnded, type ApiInfo, type Job, type JobEvent, type JobRequest, type ListWait, type ProfileListView, type ProfileSaveOptions, type TelegramStatus } from "@turbodl/shared";
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
let list: ProfileListView | null;
let listRequests: { name: string; usernames: string[]; options: ProfileSaveOptions; wait: ListWait }[];
let startResult: { ok: false; error: string } | null;
let telegramStatus: TelegramStatus;
let telegramCalls: unknown[][];
let telegramRefusal: string | null;

const info: ApiInfo = { app: "turbodl", version: "1.2.3", api: 1, instagram: { signedIn: false }, features: ["posts"] };

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
  list: () => list,
  startList: async (request) => {
    if (list && list.state !== "finished") return { ok: false, error: "Close the list that is there first." };
    if (startResult) return startResult;
    listRequests.push(request);
    list = {
      name: request.name,
      rows: request.usernames.map((username) => ({ username, state: "waiting" as const })),
      index: 0,
      state: "running",
      options: request.options,
      wait: request.wait,
    };
    return { ok: true };
  },
  stopList: async () => {
    if (list && list.state === "running") list.state = "stopped";
  },
  continueList: async () => {
    if (!list) return { ok: false, error: "There is no list." };
    if (list.state !== "stopped") return { ok: false, error: "The list is running." };
    list.state = "running";
    return { ok: true };
  },
  closeList: async () => {
    if (!list) return { ok: false, error: "There is no list." };
    if (list.state === "running") return { ok: false, error: "Stop the list first." };
    list = null;
    return { ok: true };
  },
  telegram: {
    status: () => telegramStatus,
    setToken: async (token) => {
      telegramCalls.push(["token", token]);
      if (telegramRefusal) return { ok: false, error: telegramRefusal };
      telegramStatus = { ...telegramStatus, tokenSet: token !== null, state: token === null ? "noToken" : "connecting" };
      return { ok: true };
    },
    setChat: async (chatId) => {
      telegramCalls.push(["chat", chatId]);
      if (telegramRefusal) return { ok: false, error: telegramRefusal };
      telegramStatus = { ...telegramStatus, chatId };
      return { ok: true };
    },
    setEnabled: async (enabled) => {
      telegramCalls.push(["enabled", enabled]);
      if (telegramRefusal) return { ok: false, error: telegramRefusal };
      telegramStatus = { ...telegramStatus, enabled };
      return { ok: true };
    },
    pair: async () => {
      telegramCalls.push(["pair"]);
      if (telegramRefusal) return { ok: false, error: telegramRefusal };
      return { ok: true, code: "123456", bot: "turbo_bot", expiresAt: 1_700_000_600_000 };
    },
  },
};

beforeEach(async () => {
  jobs = new Map();
  listeners = new Map();
  requests = [];
  list = null;
  listRequests = [];
  startResult = null;
  telegramStatus = { state: "off", tokenSet: false, chatId: null, enabled: false };
  telegramCalls = [];
  telegramRefusal = null;
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

const del = (path: string, o: CallOptions = {}) => call(path, { ...o, method: "DELETE" });
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

  it("refuses profile options that save nothing or contradict each other", async () => {
    const err = async (options: unknown) => {
      const res = await post("/v1/jobs", { url: "https://example.com/a", options });
      expect(res.status).toBe(400);
      return res.json.error;
    };
    expect(await err({ photos: false, videos: false })).toBe("photos and videos can't both be off");
    expect(await err({ posts: false })).toBe("nothing to save: posts is off and neither highlights nor tagged is on");
    expect(await err({ highlightsOnly: true, posts: false })).toBe("highlightsOnly can't be combined with posts");
    expect(await err({ highlightsOnly: true, posts: true })).toBe("highlightsOnly can't be combined with posts");
    for (const extra of [{ posts: true }, { tagged: true }, { photos: false }, { videos: false }]) {
      expect(await err({ postsOnly: true, ...extra })).toBe("postsOnly can't be combined with posts, tagged, photos or videos");
    }
    expect(await err({ posts: "no" })).toBe("options");
  });

  it("accepts profile options that leave something to save", async () => {
    for (const options of [{ posts: false, tagged: true }, { posts: false, highlights: true }, { photos: false }, { videos: false, tagged: false }]) {
      const res = await post("/v1/jobs", { url: "https://example.com/a", options });
      expect(res.status).toBe(201);
    }
    expect(requests.map((r) => r.options)).toEqual([{ posts: false, tagged: true }, { posts: false, highlights: true }, { photos: false }, { videos: false, tagged: false }]);
  });

  it("accepts a posts-only request with since, limit and known", async () => {
    const res = await post("/v1/jobs", {
      url: "https://www.instagram.com/someone/",
      options: { postsOnly: true, since: "2026-01-02T03:04:05+02:00", limit: 50, known: ["abc", "def"] },
    });
    expect(res.status).toBe(201);
    expect(requests).toEqual([
      {
        url: "https://www.instagram.com/someone/",
        options: { postsOnly: true, since: "2026-01-02T01:04:05.000Z", limit: 50, known: ["abc", "def"] },
      },
    ]);
  });

  it.each([
    ["a since nobody can read", { postsOnly: true, since: "not a date" }, "since"],
    ["a non-string since", { postsOnly: true, since: 5 }, "since"],
    ["a numeric-string since", { postsOnly: true, since: "1" }, "since"],
    ["a non-ISO since", { postsOnly: true, since: "October 1" }, "since"],
    ["a since without an offset", { postsOnly: true, since: "2026-01-01T00:00:00" }, "since"],
    ["a zero limit", { postsOnly: true, limit: 0 }, "limit"],
    ["a fractional limit", { postsOnly: true, limit: 1.5 }, "limit"],
    ["a limit over 100000", { postsOnly: true, limit: 100_001 }, "limit"],
    ["known that is not an array", { postsOnly: true, known: "abc" }, "known"],
    ["known with an empty code", { postsOnly: true, known: [""] }, "known"],
    ["known with a code over 64 characters", { postsOnly: true, known: ["a".repeat(65)] }, "known"],
    ["known with a non-string", { postsOnly: true, known: [1] }, "known"],
    ["known with over 10000 codes", { postsOnly: true, known: Array.from({ length: 10_001 }, () => "a") }, "known"],
    ["since without postsOnly", { since: "2026-01-01" }, "since, limit and known need postsOnly"],
    ["limit without postsOnly", { limit: 5 }, "since, limit and known need postsOnly"],
    ["known without postsOnly", { known: ["a"] }, "since, limit and known need postsOnly"],
    ["postsOnly with highlights", { postsOnly: true, highlights: true }, "postsOnly can't be combined with highlights or collections"],
    ["postsOnly with highlightsOnly", { postsOnly: true, highlightsOnly: true }, "postsOnly can't be combined with highlights or collections"],
    ["postsOnly with collections", { postsOnly: true, collections: ["a"] }, "postsOnly can't be combined with highlights or collections"],
    ["postsOnly with allCollections", { postsOnly: true, allCollections: true }, "postsOnly can't be combined with highlights or collections"],
  ])("answers 400 for %s", async (_name, options, error) => {
    const res = await post("/v1/jobs", { url: "https://www.instagram.com/someone/", options });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe(error);
    expect(requests).toEqual([]);
  });

  it("names the features in /v1/info", async () => {
    expect((await call("/v1/info")).json.features).toContain("posts");
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

const WAIT_TEXT = "Waits are whole minutes from 0 to 1440, the most at least the least.";

describe("lists", () => {
  const ALL_ON = { posts: true, highlights: true, tagged: false, photos: true, videos: true };

  it("refuses the lists routes without the token and from a website", async () => {
    expect((await call("/v1/lists/current", { token: null })).status).toBe(403);
    expect((await post("/v1/lists", { profiles: ["a"] }, { token: "wrong" })).status).toBe(403);
    expect((await del("/v1/lists/current", { token: null })).status).toBe(403);
    expect((await call("/v1/lists/current", { origin: "https://site.example" })).status).toBe(403);
    expect((await del("/v1/lists/current", { origin: "https://site.example" })).status).toBe(403);
    expect(listRequests).toEqual([]);
  });

  it("starts a list with the defaults: posts, highlights, photos and videos on, tagged off, a 2 to 5 minute wait", async () => {
    const res = await post("/v1/lists", { profiles: ["@Alice", "https://www.instagram.com/bob/", "alice"] });
    expect(res.status).toBe(201);
    expect(res.json.list).toMatchObject({ name: "API list", state: "running" });
    expect(listRequests).toEqual([{ name: "API list", usernames: ["alice", "bob"], options: ALL_ON, wait: { min: 2, max: 5 } }]);
  });

  it("takes options, a wait and a name, and fills the options it was not given", async () => {
    const res = await post("/v1/lists", { profiles: ["a"], name: "Friends", wait: { min: 0, max: 1 }, options: { tagged: true, videos: false } });
    expect(res.status).toBe(201);
    expect(listRequests).toEqual([
      { name: "Friends", usernames: ["a"], options: { posts: true, highlights: true, tagged: true, photos: true, videos: false }, wait: { min: 0, max: 1 } },
    ]);
  });

  it.each([
    ["no profiles field", {}, "profiles"],
    ["profiles that is not an array", { profiles: "a" }, "profiles"],
    ["an empty profiles", { profiles: [] }, "The list has no profiles."],
    ["a non-string profile", { profiles: [1] }, "The list holds something that isn't a profile's name."],
    ["a profile that is not a name", { profiles: ["a", "not a profile!"] }, `"not a profile!" isn't a profile.`],
    ["over 1000 profiles", { profiles: Array.from({ length: 1001 }, (_, i) => `user${i}`) }, "A list can hold at most 1,000 profiles."],
    ["options that is not an object", { profiles: ["a"], options: "x" }, "options"],
    ["an option that is not a boolean", { profiles: ["a"], options: { posts: "yes" } }, "options"],
    ["an unknown option", { profiles: ["a"], options: { audio: true } }, "options"],
    ["a profile job's option the list lacks", { profiles: ["a"], options: { postsOnly: true } }, "options"],
    ["a wait that is not an object", { profiles: ["a"], wait: 5 }, WAIT_TEXT],
    ["a wait with the most under the least", { profiles: ["a"], wait: { min: 5, max: 2 } }, WAIT_TEXT],
    ["a wait over a day", { profiles: ["a"], wait: { min: 0, max: 1441 } }, WAIT_TEXT],
    ["an empty name", { profiles: ["a"], name: "" }, "name"],
    ["a name over 255 characters", { profiles: ["a"], name: "x".repeat(256) }, "name"],
    ["a name that is not text", { profiles: ["a"], name: 3 }, "name"],
  ])("answers 400 for %s", async (_name, body, error) => {
    const res = await post("/v1/lists", body);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error });
    expect(listRequests).toEqual([]);
  });

  it("answers 400 for broken JSON and for a body that is not an object", async () => {
    const broken = await call("/v1/lists", { method: "POST", body: "{" });
    expect(broken.status).toBe(400);
    expect(broken.json).toEqual({ error: "json" });
    const array = await post("/v1/lists", []);
    expect(array.status).toBe(400);
    expect(array.json).toEqual({ error: "body" });
  });

  it("answers 409 for a list while another is not finished, and allows one after it finished", async () => {
    await post("/v1/lists", { profiles: ["a"] });
    const second = await post("/v1/lists", { profiles: ["b"] });
    expect(second.status).toBe(409);
    expect(second.json).toEqual({ error: "Close the list that is there first." });
    list!.state = "finished";
    expect((await post("/v1/lists", { profiles: ["b"] })).status).toBe(201);
  });

  it("answers 400 with the app's own message when the app refuses the options", async () => {
    startResult = { ok: false, error: "Pick photos, videos or both." };
    const res = await post("/v1/lists", { profiles: ["a"], options: { photos: false, videos: false } });
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: "Pick photos, videos or both." });
  });

  it("answers the current list, or null when there is none", async () => {
    const none = await call("/v1/lists/current");
    expect(none.status).toBe(200);
    expect(none.json).toEqual({ list: null });
    await post("/v1/lists", { profiles: ["a"] });
    const res = await call("/v1/lists/current");
    expect(res.status).toBe(200);
    expect(res.json.list.rows).toEqual([{ username: "a", state: "waiting" }]);
  });

  it("stops, continues and closes the list", async () => {
    await post("/v1/lists", { profiles: ["a"] });
    const refused = await del("/v1/lists/current");
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: "Stop the list first." });
    const stopped = await post("/v1/lists/current/stop", {});
    expect(stopped.status).toBe(200);
    expect(stopped.json.list.state).toBe("stopped");
    const running = await post("/v1/lists/current/continue", {});
    expect(running.status).toBe(200);
    expect(running.json.list.state).toBe("running");
    const again = await post("/v1/lists/current/continue", {});
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: "The list is running." });
    await post("/v1/lists/current/stop", {});
    const closed = await del("/v1/lists/current");
    expect(closed.status).toBe(200);
    expect(closed.json).toEqual({ list: null });
  });

  it("answers null for stop and close with no list, and 409 for continue", async () => {
    expect((await post("/v1/lists/current/stop", {})).json).toEqual({ list: null });
    expect((await del("/v1/lists/current")).json).toEqual({ list: null });
    const res = await post("/v1/lists/current/continue", {});
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "There is no list." });
  });

  it("answers 404 for other lists routes and methods", async () => {
    expect((await call("/v1/lists")).status).toBe(404);
    expect((await call("/v1/lists/other")).status).toBe(404);
    expect((await post("/v1/lists/current", {})).status).toBe(404);
    expect((await call("/v1/lists/current/stop")).status).toBe(404);
    expect((await del("/v1/lists")).status).toBe(404);
  });

  it("is a feature clients can look for", () => {
    expect(API_FEATURES).toContain("lists");
  });
});

describe("telegram", () => {
  it("GET /v1/telegram returns the status", async () => {
    const r = await call("/v1/telegram");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ telegram: telegramStatus });
  });

  it("POST token, chat and enabled call the handlers and return the status", async () => {
    const token = await post("/v1/telegram/token", { token: "123:abc" });
    expect(token.status).toBe(200);
    expect(token.json).toEqual({ telegram: { state: "connecting", tokenSet: true, chatId: null, enabled: false } });
    const chat = await post("/v1/telegram/chat", { chatId: 42 });
    expect(chat.json.telegram.chatId).toBe(42);
    const enabled = await post("/v1/telegram/enabled", { enabled: true });
    expect(enabled.json.telegram.enabled).toBe(true);
    expect((await post("/v1/telegram/chat", { chatId: null })).json.telegram.chatId).toBeNull();
    expect((await post("/v1/telegram/token", { token: null })).json.telegram.tokenSet).toBe(false);
    expect(telegramCalls).toEqual([["token", "123:abc"], ["chat", 42], ["enabled", true], ["chat", null], ["token", null]]);
  });

  it("answers a bad body with 400 and calls nothing", async () => {
    for (const [path, body] of [
      ["/v1/telegram/token", { token: 5 }],
      ["/v1/telegram/token", {}],
      ["/v1/telegram/chat", { chatId: "42" }],
      ["/v1/telegram/chat", { chatId: 0 }],
      ["/v1/telegram/chat", { chatId: 1.5 }],
      ["/v1/telegram/chat", {}],
      ["/v1/telegram/enabled", { enabled: "yes" }],
      ["/v1/telegram/enabled", [true]],
    ] as const) {
      const r = await post(path, body);
      expect(r.status, path).toBe(400);
      expect(typeof r.json.error).toBe("string");
    }
    const notJson = await call("/v1/telegram/enabled", { method: "POST", body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(notJson.json).toEqual({ error: "json" });
    expect(telegramCalls).toEqual([]);
  });

  it("answers the app's refusal with 400 and its message", async () => {
    telegramRefusal = "Telegram refused that token.";
    const r = await post("/v1/telegram/token", { token: "123:abc" });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "Telegram refused that token." });
    expect((await post("/v1/telegram/pair", {})).status).toBe(400);
  });

  it("pair returns the code", async () => {
    const r = await post("/v1/telegram/pair", {});
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ code: "123456", bot: "turbo_bot", expiresAt: 1_700_000_600_000 });
    expect((await call("/v1/telegram/pair", { method: "POST" })).status).toBe(200);
  });

  it("knows only its own routes and methods", async () => {
    expect((await call("/v1/telegram/nope")).status).toBe(404);
    expect((await call("/v1/telegram/token")).status).toBe(404);
    expect((await post("/v1/telegram", {})).status).toBe(404);
  });

  it("never echoes the token", async () => {
    const secret = "987654321:SECRET-token-value";
    const seen = [
      await post("/v1/telegram/token", { token: secret }),
      await call("/v1/telegram"),
      await post("/v1/telegram/token", { token: 5 }),
      await post("/v1/telegram/chat", { chatId: 7 }),
      await post("/v1/telegram/pair", {}),
    ];
    telegramRefusal = "nope";
    seen.push(await post("/v1/telegram/token", { token: secret }));
    for (const r of seen) expect(JSON.stringify(r.json)).not.toContain("SECRET");
  });

  it("needs the API token", async () => {
    for (const [method, path] of [["GET", "/v1/telegram"], ["POST", "/v1/telegram/token"], ["POST", "/v1/telegram/pair"]]) {
      const r = await call(path, { method, token: null, body: method === "POST" ? "{}" : undefined });
      expect(r.status, path).toBe(403);
    }
    expect(telegramCalls).toEqual([]);
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
