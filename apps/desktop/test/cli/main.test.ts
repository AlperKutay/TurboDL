import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiLaunch, InstagramPostInfo, JobEvent } from "@turbodl/shared";
import { HELP } from "../../src/cli/args";
import { run, type CliIo } from "../../src/cli/main";
import { makeJob, startFakeApi, type FakeApi } from "./fake-api";

class Sink extends Writable {
  text = "";
  override _write(chunk: Buffer | string, _encoding: BufferEncoding, done: () => void): void {
    this.text += chunk.toString();
    done();
  }
}

let fake: FakeApi;
const cwd = path.join(os.tmpdir(), "turbodl-cli-cwd");

beforeEach(async () => {
  fake = await startFakeApi();
});
afterEach(async () => {
  await fake.dispose();
});

interface CliOptions {
  tty?: boolean;
  /** user data folder; the fake app's by default */
  dir?: string;
  /** runs on every wait of the command's clock */
  onSleep?: () => Promise<void>;
}

/** Runs the command against the fake app with in-memory streams and a clock that only moves when the command waits. */
function cli(argv: string[], o: CliOptions = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const spawned: ApiLaunch[] = [];
  let handler: (() => void) | undefined;
  let t = 0;
  const io: CliIo = {
    argv,
    cwd,
    env: { TURBODL_USER_DATA: o.dir ?? fake.dir },
    platform: process.platform,
    home: os.tmpdir(),
    stdout,
    stderr,
    tty: o.tty ?? false,
    version: "9.9.9",
    onInterrupt: (h) => {
      handler = h;
      return () => {
        if (handler === h) handler = undefined;
      };
    },
    spawn: (launch) => void spawned.push(launch),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await o.onSleep?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return {
    stdout,
    stderr,
    spawned,
    interrupt: () => {
      if (!handler) throw new Error("no Ctrl+C handler");
      handler();
    },
    done: run(io),
  };
}

const file = (name: string) => path.join(os.tmpdir(), "turbodl-out", name);

describe("turbodl get", () => {
  it("gets a link: file paths on stdout, the end on stderr, code 0", async () => {
    const c = cli(["get", "https://example.com/a.zip", "-d", "out"]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "state", state: "running" });
    fake.push("job1", { type: "file", path: file("a.zip") });
    fake.push("job1", { type: "file", path: file("b.zip"), existing: true });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stdout.text).toBe(`${file("a.zip")}\n${file("b.zip")}\n`);
    expect(c.stderr.text).toBe("job1: done, 2 files\n");
    expect(fake.requests).toEqual([{ url: "https://example.com/a.zip", dir: path.resolve(cwd, "out") }]);
    expect(c.spawned).toEqual([]);
  });

  it("sends the options, the name and nothing it wasn't given", async () => {
    const c = cli(["get", "https://example.com/v", "--name", "clip.mp4", "--max-height", "720", "--audio"]);
    await fake.subscribed("job1");
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(fake.requests).toEqual([{ url: "https://example.com/v", name: "clip.mp4", options: { maxHeight: 720, audio: true } }]);
  });

  it("prints only JSON lines on stdout with --json", async () => {
    const c = cli(["get", "https://example.com/a.zip", "--json"], { tty: true });
    await fake.subscribed("job1");
    fake.push("job1", { type: "progress", progress: { done: 0, total: 1, bytes: 1024, totalBytes: 4096, speed: 512 } });
    fake.push("job1", { type: "warning", message: "careful" });
    fake.push("job1", { type: "file", path: file("a.zip") });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    const lines = c.stdout.text.split("\n");
    expect(lines.pop()).toBe("");
    const events = lines.map((l) => JSON.parse(l) as JobEvent);
    expect(events.map((e) => e.type)).toEqual(["job", "progress", "warning", "file", "end"]);
    expect(events.every((e) => e.jobId === "job1")).toBe(true);
    expect(events[3]).toEqual({ type: "file", path: file("a.zip"), jobId: "job1" });
    expect(events.at(-1)?.type).toBe("end");
    expect(c.stderr.text).toBe("");
  });

  it("prints no progress on stdout and no carriage returns without a TTY", async () => {
    const c = cli(["get", "https://example.com/a.zip"]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "progress", progress: { done: 0, total: 1, bytes: 1048576, totalBytes: 4194304, speed: 1048576 } });
    fake.push("job1", { type: "progress", progress: { done: 0, total: 1, bytes: 2097152, totalBytes: 4194304, speed: 1048576 } });
    fake.push("job1", { type: "file", path: file("a.zip") });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stdout.text).toBe(`${file("a.zip")}\n`);
    expect(c.stdout.text).not.toContain("\r");
    expect(c.stderr.text).not.toContain("\r");
    expect(c.stderr.text).toBe("job1: done, 1 file\n");
  });

  it("rewrites one progress line on stderr on a terminal and keeps stdout to the paths", async () => {
    const c = cli(["get", "https://example.com/a.zip"], { tty: true });
    await fake.subscribed("job1");
    fake.push("job1", { type: "progress", progress: { done: 0, total: 1, bytes: 1048576, totalBytes: 4194304, speed: 1048576 } });
    fake.push("job1", { type: "file", path: file("a.zip") });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stdout.text).toBe(`${file("a.zip")}\n`);
    expect(c.stderr.text).toContain("\rjob1  0/1  1.0 MB / 4.0 MB  1.0 MB/s");
    expect(c.stderr.text.endsWith("job1: done, 1 file\n")).toBe(true);
  });

  it("shows on the progress line what a job is doing, when it says", async () => {
    const c = cli(["get", "https://www.instagram.com/someone/"], { tty: true });
    await fake.subscribed("job1");
    fake.push("job1", { type: "progress", progress: { done: 2, total: 7, note: "Signed out: reading each post from its own page" } });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stderr.text).toContain("\rjob1  2/7  Signed out: reading each post from its own page");
  });

  it("prints warnings and why a job failed on stderr", async () => {
    const c = cli(["get", "https://example.com/a.zip"]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "warning", message: "1 post is shown only to signed-in visitors; sign in to save them." });
    fake.end("job1", { state: "failed", reason: "notFound", error: "That post doesn't exist." });
    expect(await c.done).toBe(1);
    expect(c.stdout.text).toBe("");
    expect(c.stderr.text).toBe("job1: warning: 1 post is shown only to signed-in visitors; sign in to save them.\njob1: failed (notFound), 0 files: That post doesn't exist.\n");
  });

  it("exits 3 for a limited job and 4 for Instagram's slow-down", async () => {
    const limited = cli(["get", "https://www.instagram.com/someone/"]);
    await fake.subscribed("job1");
    fake.end("job1", { state: "done", limited: true, reason: "signInRequired" });
    expect(await limited.done).toBe(3);

    const slow = cli(["get", "https://www.instagram.com/p/abc/"]);
    await fake.subscribed("job2");
    fake.end("job2", { state: "failed", reason: "rateLimited" });
    expect(await slow.done).toBe(4);
  });

  it("follows several links and exits with the code that comes first in the order", async () => {
    const c = cli(["get", "https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    await fake.subscribed("job1");
    await fake.subscribed("job2");
    await fake.subscribed("job3");
    expect(fake.requests.map((r) => r.url)).toEqual(["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
    fake.push("job2", { type: "file", path: file("2.bin") });
    fake.end("job2", { state: "failed", reason: "error", error: "boom" });
    fake.push("job1", { type: "file", path: file("1.bin") });
    fake.end("job1", { state: "failed", reason: "rateLimited" });
    fake.end("job3", { state: "done", limited: true, reason: "signInRequired" });
    expect(await c.done).toBe(1);
    expect(c.stdout.text).toBe(`${file("2.bin")}\n${file("1.bin")}\n`);
  });

  it("cancels the followed jobs on Ctrl+C and exits 130", async () => {
    const c = cli(["get", "https://example.com/1", "https://example.com/2"]);
    await fake.subscribed("job1");
    await fake.subscribed("job2");
    c.interrupt();
    await fake.until(() => fake.cancelled.length === 2);
    expect([...fake.cancelled].sort()).toEqual(["job1", "job2"]);
    fake.end("job1", { state: "cancelled" });
    fake.end("job2", { state: "cancelled" });
    expect(await c.done).toBe(130);
  });

  it("exits 130 at once on a second Ctrl+C and lets go of the streams", async () => {
    const c = cli(["get", "https://example.com/1"]);
    await fake.subscribed("job1");
    c.interrupt();
    await fake.until(() => fake.cancelled.length === 1);
    c.interrupt();
    expect(await c.done).toBe(130);
    await fake.until(() => fake.listeners("job1") === 0);
  });

  it("exits 6 when another client cancels the job it follows", async () => {
    const other = cli(["get", "https://example.com/1"]);
    await fake.subscribed("job1");
    fake.end("job1", { state: "cancelled" });
    expect(await other.done).toBe(6);

    const stopped = cli(["get", "https://example.com/2"]);
    await fake.subscribed("job2");
    fake.end("job2", { state: "cancelled", reason: "stopped", warnings: ["Paused in TurboDL."] });
    expect(await stopped.done).toBe(6);
    expect(fake.cancelled).toEqual([]);
  });

  it('exits 5 with "TurboDL quit." when the stream closes before the end', async () => {
    const c = cli(["get", "https://example.com/1", "https://example.com/2"]);
    await fake.subscribed("job1");
    await fake.subscribed("job2");
    await fake.stop();
    expect(await c.done).toBe(5);
    expect(c.stderr.text).toBe("turbodl: TurboDL quit.\n");
  });

  it("keeps following a job when TurboDL moves to another port, without printing a file twice", async () => {
    let moved = false;
    const c = cli(["get", "https://example.com/1"], {
      onSleep: async () => {
        if (moved) return;
        moved = true;
        await fake.restart();
      },
    });
    await fake.subscribed("job1");
    fake.push("job1", { type: "file", path: file("a.bin") });
    await fake.stop();
    await fake.subscribed("job1", 2);
    fake.push("job1", { type: "file", path: file("b.bin") });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(moved).toBe(true);
    expect(c.stdout.text).toBe(`${file("a.bin")}\n${file("b.bin")}\n`);
    expect(c.stderr.text).toBe("job1: done, 2 files\n");
  });

  it("sends a Ctrl+C's cancel again when TurboDL comes back on another port", async () => {
    let moved = false;
    const c = cli(["get", "https://example.com/1"], {
      onSleep: async () => {
        if (moved) return;
        moved = true;
        // Ctrl+C while the stream is cut: its cancel goes to the old, closed port
        c.interrupt();
        await fake.restart();
      },
    });
    await fake.subscribed("job1");
    await fake.stop();
    await fake.subscribed("job1", 2);
    await fake.until(() => fake.cancelled.length === 1);
    expect(fake.cancelled).toEqual(["job1"]);
    fake.end("job1", { state: "cancelled" });
    expect(await c.done).toBe(130);
    expect(moved).toBe(true);
  }, 5000);

  it("answers a usage error with code 2 and a bad request from the API with code 2", async () => {
    const usage = cli(["get"]);
    expect(await usage.done).toBe(2);
    expect(usage.stderr.text).toBe("turbodl: get needs at least one link\nRun turbodl --help.\n");
    expect(usage.stdout.text).toBe("");

    const bad = cli(["get", "https://example.com/1", "ftp://example.com/2"]);
    expect(await bad.done).toBe(2);
    expect(fake.cancelled).toEqual(["job1"]);
    expect(bad.stderr.text).toBe("turbodl: TurboDL refused ftp://example.com/2: url\n");
    expect(bad.stdout.text).toBe("");
  });

  it("exits 5 with the never-opened message when there is no api.json", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "turbodl-cli-empty-"));
    try {
      const c = cli(["get", "https://example.com/1"], { dir: empty });
      expect(await c.done).toBe(5);
      expect(c.stderr.text).toBe("turbodl: TurboDL hasn't been opened on this computer yet. Open it once, then try again.\n");
      expect(c.spawned).toEqual([]);

      const json = cli(["list", "--json"], { dir: empty });
      expect(await json.done).toBe(5);
      expect(JSON.parse(json.stdout.text)).toEqual({ type: "error", message: "TurboDL hasn't been opened on this computer yet. Open it once, then try again." });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("turbodl wait", () => {
  it("follows jobs it didn't start and prints the files of one that already ended", async () => {
    fake.jobs.set("old", makeJob("old", { state: "done", files: [file("old.bin")] }));
    fake.jobs.set("live", makeJob("live"));
    const c = cli(["wait", "old", "live"]);
    await fake.subscribed("live");
    fake.push("live", { type: "file", path: file("live.bin") });
    fake.end("live", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stdout.text.split("\n").sort()).toEqual(["", file("live.bin"), file("old.bin")].sort());
    expect(fake.requests).toEqual([]);
  });

  it("cancels on Ctrl+C like get", async () => {
    fake.jobs.set("live", makeJob("live"));
    const c = cli(["wait", "live"]);
    await fake.subscribed("live");
    c.interrupt();
    await fake.until(() => fake.cancelled.length === 1);
    fake.end("live", { state: "cancelled" });
    expect(await c.done).toBe(130);
  });
});

describe("turbodl add, list, status, cancel", () => {
  it("adds jobs and prints their ids", async () => {
    const c = cli(["add", "https://example.com/1", "https://example.com/2"]);
    expect(await c.done).toBe(0);
    expect(c.stdout.text).toBe("job1\njob2\n");
    expect(c.stderr.text).toBe("");
    expect(fake.listeners("job1")).toBe(0);

    const json = cli(["add", "https://example.com/3", "--json"]);
    expect(await json.done).toBe(0);
    const line = JSON.parse(json.stdout.text);
    expect(line).toMatchObject({ type: "job", jobId: "job3", job: { id: "job3", url: "https://example.com/3" } });
  });

  it("lists, shows and cancels jobs", async () => {
    fake.jobs.set("a1", makeJob("a1", { state: "done", files: [file("a.zip")] }));
    fake.jobs.set("b22", makeJob("b22", { url: "https://www.instagram.com/p/x/", kind: "instagramPost", reason: "signInRequired", limited: true }));

    const list = cli(["list"]);
    expect(await list.done).toBe(0);
    expect(list.stdout.text).toBe("b22  running  instagramPost  https://www.instagram.com/p/x/\na1   done     file           https://example.com/a.zip\n");

    const listJson = cli(["list", "--json"]);
    expect(await listJson.done).toBe(0);
    expect(listJson.stdout.text.trimEnd().split("\n").map((l) => JSON.parse(l).jobId)).toEqual(["b22", "a1"]);

    const status = cli(["status", "a1"]);
    expect(await status.done).toBe(0);
    expect(status.stdout.text).toBe(
      `id: a1\nurl: https://example.com/a.zip\nkind: file\nstate: done\nfile: ${file("a.zip")}\ncreated: ${new Date(1).toISOString()}\n`,
    );

    const cancel = cli(["cancel", "b22"]);
    expect(await cancel.done).toBe(0);
    expect(fake.cancelled).toEqual(["b22"]);
    expect(cancel.stdout.text).toContain("id: b22\n");
    expect(cancel.stdout.text).toContain("reason: signInRequired\nlimited: true\n");

    const json = cli(["status", "a1", "--json"]);
    expect(await json.done).toBe(0);
    expect(JSON.parse(json.stdout.text)).toEqual({ type: "job", jobId: "a1", job: fake.jobs.get("a1") });
  });

  it("answers an unknown job id with code 1", async () => {
    const status = cli(["status", "nope"]);
    expect(await status.done).toBe(1);
    expect(status.stderr.text).toBe("turbodl: No job nope.\n");

    fake.jobs.set("a1", makeJob("a1"));
    const cancel = cli(["cancel", "nope", "a1"]);
    expect(await cancel.done).toBe(1);
    expect(fake.cancelled).toEqual(["a1"]);
    expect(cancel.stderr.text).toBe("turbodl: No job nope.\n");

    const wait = cli(["wait", "nope"]);
    expect(await wait.done).toBe(1);
    expect(wait.stderr.text).toBe("turbodl: No job nope.\n");

    const json = cli(["status", "nope", "--json"]);
    expect(await json.done).toBe(1);
    expect(JSON.parse(json.stdout.text)).toEqual({ type: "error", message: "No job nope." });
    expect(json.stderr.text).toBe("turbodl: No job nope.\n");
  });
});

describe("turbodl instagram, help and version", () => {
  it("logs in to Instagram and exits 3 when the window was closed signed out", async () => {
    const out = cli(["instagram", "login"]);
    expect(await out.done).toBe(3);
    expect(out.stdout.text).toBe("signedIn: false\n");

    fake.instagram = { signedIn: true, username: "someone" };
    const signedIn = cli(["instagram", "login", "--json"]);
    expect(await signedIn.done).toBe(0);
    expect(JSON.parse(signedIn.stdout.text)).toEqual({ type: "instagram", signedIn: true, username: "someone" });

    const status = cli(["instagram", "status"]);
    expect(await status.done).toBe(0);
    expect(status.stdout.text).toBe("signedIn: true\nusername: someone\n");

    const logout = cli(["instagram", "logout"]);
    expect(await logout.done).toBe(0);
    expect(fake.loggedOut).toBe(true);
    expect(logout.stdout.text).toBe("signedIn: false\n");
  });

  it("prints help and the version without TurboDL", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "turbodl-cli-empty-"));
    try {
      const version = cli(["--version"], { dir: empty });
      expect(await version.done).toBe(0);
      expect(version.stdout.text).toBe("turbodl 9.9.9\n");

      const help = cli(["help"], { dir: empty });
      expect(await help.done).toBe(0);
      expect(help.stdout.text).toBe(HELP);
      expect(help.stderr.text).toBe("");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("turbodl posts", () => {
  const profile = "https://www.instagram.com/someone/";
  const post = (code: string, patch: Partial<InstagramPostInfo> = {}): InstagramPostInfo => ({
    code,
    url: `https://www.instagram.com/p/${code}/`,
    takenAt: "2026-03-01T10:00:00.000Z",
    pinned: false,
    owner: "someone",
    taggedUsers: [],
    items: [{ kind: "image", url: "https://cdn.example/a.jpg" }],
    ...patch
  });

  it("prints one line per post and exits 0", async () => {
    const c = cli(["posts", profile]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "post", post: post("AAA", { pinned: true, items: [{ kind: "image", url: "u1" }, { kind: "video", url: "u2" }] }) });
    fake.push("job1", { type: "post", post: post("BBB", { takenAt: null, signInOnly: true }) });
    fake.push("job1", { type: "post", post: post("CCC", { known: true }) });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    expect(c.stdout.text).toBe(
      "AAA\t2026-03-01T10:00:00.000Z\t2 items\tpinned\nBBB\t-\t1 item\tsign-in only\nCCC\t2026-03-01T10:00:00.000Z\t1 item\tknown\n"
    );
  });

  it("posts --json prints each post event as a JSON line", async () => {
    const c = cli(["posts", profile, "--json"]);
    await fake.subscribed("job1");
    const p = post("AAA");
    fake.push("job1", { type: "post", post: p });
    fake.end("job1", { state: "done" });
    expect(await c.done).toBe(0);
    const lines = c.stdout.text.trim().split("\n").map((l) => JSON.parse(l) as JobEvent);
    expect(lines.filter((l) => l.type === "post")).toEqual([{ type: "post", jobId: "job1", post: p }]);
    expect(lines.at(-1)?.type).toBe("end");
  });

  it("posts exits 4 when the list is rate limited", async () => {
    const c = cli(["posts", profile]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "post", post: post("AAA") });
    fake.end("job1", { state: "failed", reason: "rateLimited" });
    expect(await c.done).toBe(4);
  });

  it("posts exits 3 when it ended limited, with its warnings on stderr", async () => {
    const c = cli(["posts", profile]);
    await fake.subscribed("job1");
    fake.push("job1", { type: "warning", message: "Some posts need a sign-in." });
    fake.end("job1", { state: "done", limited: true });
    expect(await c.done).toBe(3);
    expect(c.stderr.text).toContain("job1: warning: Some posts need a sign-in.");
    expect(c.stdout.text).toBe("");
  });

  it("posts exits 5 when the stream drops instead of reconnecting", async () => {
    // a reconnect would wait for api.json to name an app that answers
    let waited = false;
    const c = cli(["posts", profile], {
      onSleep: async () => {
        waited = true;
      },
    });
    await fake.subscribed("job1");
    await fake.stop();
    expect(await c.done).toBe(5);
    expect(c.stderr.text).toBe("turbodl: TurboDL quit.\n");
    expect(waited).toBe(false);
  });

  it("posts sends postsOnly with since and limit", async () => {
    const c = cli(["posts", profile, "--since", "2026-01-02", "--limit", "5"]);
    await fake.subscribed("job1");
    fake.end("job1", { state: "done" });
    await c.done;
    expect(fake.requests).toEqual([{ url: profile, options: { postsOnly: true, since: "2026-01-02T00:00:00.000Z", limit: 5 } }]);
  });

  it("posts sends only postsOnly without the options", async () => {
    const c = cli(["posts", profile]);
    await fake.subscribed("job1");
    fake.end("job1", { state: "done" });
    await c.done;
    expect(fake.requests).toEqual([{ url: profile, options: { postsOnly: true } }]);
  });
});
