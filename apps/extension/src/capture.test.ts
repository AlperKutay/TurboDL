import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake of the slice of the chrome.* API that capture.ts and bridge.ts use.
// Real-browser download E2E is not possible on every machine, so the capture
// flow (pause → hand over → cancel/erase or resume) is pinned here.

interface FakeItem {
  id: number;
  url: string;
  finalUrl: string;
  filename: string;
  mime: string;
  totalBytes: number;
  fileSize: number;
  state: "in_progress" | "complete" | "interrupted";
  referrer: string;
  byExtensionId?: string;
}

interface Posted {
  path: string;
  body: Record<string, unknown>;
}

let created: ((item: FakeItem) => void)[];
let changed: ((delta: { id: number; filename?: { current?: string } }) => void)[];
let items: Map<number, FakeItem>;
let calls: string[];
let posted: Posted[];
let storage: Record<string, unknown>;
let appAccepts: boolean;
let appRunning: boolean;
let nativeReply: () => unknown;
let nativeHost: string | null;

function item(patch: Partial<FakeItem> = {}): FakeItem {
  return {
    id: 1,
    url: "https://files.example.com/a.zip",
    finalUrl: "https://files.example.com/a.zip",
    filename: "",
    mime: "application/zip",
    totalBytes: 5_000_000,
    fileSize: 0,
    state: "in_progress",
    referrer: "https://site.example/",
    ...patch,
  };
}

beforeEach(() => {
  created = [];
  changed = [];
  items = new Map();
  calls = [];
  posted = [];
  storage = {};
  appAccepts = true;
  appRunning = true;
  nativeReply = () => {
    throw new Error("Specified native messaging host not found.");
  };
  nativeHost = null;
  vi.resetModules();
  vi.stubGlobal("chrome", {
    runtime: {
      id: "self-extension-id",
      sendNativeMessage: async (name: string) => {
        nativeHost = name;
        calls.push("launch");
        return nativeReply();
      },
    },
    storage: {
      local: {
        get: async () => ({ ...storage }),
        set: async (values: Record<string, unknown>) => void Object.assign(storage, values),
      },
    },
    cookies: { getAll: async () => [{ name: "session", value: "abc" }] },
    action: { setBadgeBackgroundColor: async () => undefined, setBadgeText: async () => undefined },
    downloads: {
      onCreated: { addListener: (f: (i: FakeItem) => void) => created.push(f) },
      onChanged: { addListener: (f: (d: { id: number }) => void) => changed.push(f) },
      search: async ({ id }: { id: number }) => (items.has(id) ? [{ ...items.get(id)! }] : []),
      pause: async (id: number) => void calls.push(`pause:${id}`),
      resume: async (id: number) => void calls.push(`resume:${id}`),
      cancel: async (id: number) => void calls.push(`cancel:${id}`),
      erase: async ({ id }: { id: number }) => void calls.push(`erase:${id}`),
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: { body?: string }) => {
    if (!appRunning) throw new TypeError("Failed to fetch");
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(init.body) : {};
    posted.push({ path, body });
    if (path === "/v1/ping") return new Response(JSON.stringify({ app: "turbodl", version: "0.2.0" }), { status: 200 });
    if (path === "/v1/config") {
      return new Response(JSON.stringify({ captureEnabled: true, captureExtensions: ["zip", "mkv"], minCaptureSize: 0 }), { status: 200 });
    }
    if (path === "/v1/downloads") {
      return appAccepts
        ? new Response(JSON.stringify({ accepted: true }), { status: 202 })
        : new Response(JSON.stringify({ accepted: false, reason: "no" }), { status: 422 });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function start(): Promise<void> {
  const { registerCapture } = await import("./capture");
  registerCapture();
}

function create(i: FakeItem): void {
  items.set(i.id, i);
  for (const f of created) f({ ...i });
}

const settle = () => new Promise((r) => setTimeout(r, 30));
const downloadPosts = () => posted.filter((p) => p.path === "/v1/downloads");

describe("download capture", () => {
  it("hands a matching download to the app, then cancels and erases it in Chrome", async () => {
    await start();
    create(item());
    await vi.waitFor(() => expect(calls).toEqual(["pause:1", "cancel:1", "erase:1"]));
    expect(downloadPosts()).toHaveLength(1);
    expect(downloadPosts()[0].body).toMatchObject({
      url: "https://files.example.com/a.zip",
      referrer: "https://site.example/",
      cookies: "session=abc",
      fileSize: 5_000_000,
      mime: "application/zip",
      source: "intercept",
    });
  });

  it("resumes the Chrome download when the app declines it", async () => {
    appAccepts = false;
    await start();
    create(item());
    await vi.waitFor(() => expect(calls).toEqual(["pause:1", "resume:1"]));
  });

  it("leaves Chrome alone when the app is not running", async () => {
    appRunning = false;
    await start();
    create(item());
    await settle();
    expect(calls).toEqual([]);
  });

  it("leaves Chrome alone when capture is switched off in the popup", async () => {
    storage.captureOn = false;
    await start();
    create(item());
    await settle();
    expect(calls).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("ignores file types that are not on the list", async () => {
    await start();
    create(item({ url: "https://x.example/page", finalUrl: "https://x.example/page", filename: "C:\\dl\\page.html", mime: "text/html" }));
    await settle();
    expect(calls).toEqual([]);
  });

  it("waits for Chrome to decide the file name when the URL gives no hint", async () => {
    await start();
    const unnamed = item({ url: "https://x.example/get.php?id=7", finalUrl: "https://x.example/get.php?id=7", mime: "application/octet-stream" });
    create(unnamed);
    await settle();
    expect(calls).toEqual([]);
    items.set(1, { ...unnamed, filename: "C:\\Users\\a\\Downloads\\film.mkv" });
    for (const f of changed) f({ id: 1, filename: { current: "C:\\Users\\a\\Downloads\\film.mkv" } });
    await vi.waitFor(() => expect(calls).toEqual(["pause:1", "cancel:1", "erase:1"]));
    expect(downloadPosts()[0].body).toMatchObject({ filename: "film.mkv" });
  });

  it("keeps a download Chrome already finished", async () => {
    await start();
    const done = item();
    items.set(1, { ...done, state: "complete" });
    for (const f of created) f({ ...done });
    await settle();
    expect(calls).toEqual(["pause:1"]);
    expect(downloadPosts()).toHaveLength(0);
  });

  it("hands each download over only once", async () => {
    await start();
    const i = item();
    create(i);
    for (const f of created) f({ ...i });
    await vi.waitFor(() => expect(calls).toContain("erase:1"));
    await settle();
    expect(downloadPosts()).toHaveLength(1);
  });

  const remembered = { captureEnabled: true, captureExtensions: ["zip", "mkv"], minCaptureSize: 0 };

  it("starts TurboDL through the native host when it is closed, then hands the download over", async () => {
    appRunning = false;
    storage.lastConfig = remembered;
    nativeReply = () => {
      appRunning = true;
      return { ok: true };
    };
    await start();
    create(item());
    await vi.waitFor(() => expect(calls).toEqual(["pause:1", "launch", "cancel:1", "erase:1"]), { timeout: 4000 });
    expect(nativeHost).toBe("com.turbodl.host");
    expect(downloadPosts()).toHaveLength(1);
  });

  it("gives the download back to Chrome when TurboDL cannot be started", async () => {
    appRunning = false;
    storage.lastConfig = remembered;
    await start();
    create(item());
    await vi.waitFor(() => expect(calls).toEqual(["pause:1", "launch", "resume:1"]));
  });

  it("starts TurboDL only once for several downloads", async () => {
    appRunning = false;
    storage.lastConfig = remembered;
    nativeReply = () => {
      setTimeout(() => (appRunning = true), 300);
      return { ok: true };
    };
    await start();
    create(item({ id: 1 }));
    create(item({ id: 2, url: "https://files.example.com/b.zip", finalUrl: "https://files.example.com/b.zip" }));
    await vi.waitFor(() => expect(downloadPosts()).toHaveLength(2), { timeout: 6000 });
    expect(calls.filter((c) => c === "launch")).toHaveLength(1);
  });

  it("uses the remembered capture list while TurboDL is closed", async () => {
    appRunning = false;
    storage.lastConfig = { ...remembered, captureExtensions: ["mkv"] };
    await start();
    create(item());
    await settle();
    expect(calls).toEqual([]);
  });

  it("remembers the capture settings it got from the app", async () => {
    await start();
    create(item());
    await vi.waitFor(() => expect(calls).toContain("erase:1"));
    expect(storage.lastConfig).toEqual({ captureEnabled: true, captureExtensions: ["zip", "mkv"], minCaptureSize: 0 });
  });

  it("never captures its own downloads", async () => {
    await start();
    create(item({ byExtensionId: "self-extension-id" }));
    await settle();
    expect(calls).toEqual([]);
  });
});
