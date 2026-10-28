import { describe, expect, it } from "vitest";
import type { JobEvent } from "@turbodl/shared";
import { Jobs, type JobRunner } from "../../src/main/jobs/jobs";
import { jobKindOf } from "../../src/main/jobs/kind";

const URL_A = "https://example.com/a.zip";

function make(run: JobRunner, keep?: number) {
  let n = 0;
  return new Jobs({ run, now: () => 1000, newId: () => `j${++n}`, keep });
}

describe("Jobs", () => {
  it("starts a job queued, with its kind, and runs it", () => {
    let ran = false;
    const jobs = make(async () => {
      ran = true;
    });
    const job = jobs.create({ url: URL_A });
    expect(ran).toBe(true);
    expect(job).toMatchObject({
      id: "j1",
      url: URL_A,
      kind: "file",
      state: "queued",
      warnings: [],
      files: [],
      failedItems: 0,
      progress: { done: 0 },
      createdAt: 1000,
    });
    expect(jobs.get("j1")).toEqual(job);
    expect(jobs.get("nope")).toBeUndefined();
  });

  it("tells its followers every change, the end last", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = make(async (job) => {
      await gate;
      job.start();
      job.file("/x/a.jpg");
      job.warn("careful");
      job.end({ state: "done" });
    });
    const job = jobs.create({ url: URL_A });
    const events: JobEvent[] = [];
    jobs.subscribe(job.id, (e) => events.push(e));
    release();
    const final = await jobs.ended(job.id)!;
    expect(events.map((e) => e.type)).toEqual(["state", "file", "warning", "state", "end"]);
    expect(events.every((e) => e.jobId === "j1")).toBe(true);
    expect(events[0]).toMatchObject({ type: "state", state: "running" });
    expect(events[4]).toMatchObject({ type: "end", job: final });
    expect(final).toMatchObject({ state: "done", files: ["/x/a.jpg"], warnings: ["careful"], endedAt: 1000 });
    expect(jobs.get("j1")).toEqual(final);
  });

  it("marks a limited job done with signInRequired", async () => {
    const jobs = make(async (job) => {
      job.start();
      job.end({ state: "done", limited: true });
    });
    const job = await jobs.ended(jobs.create({ url: URL_A }).id)!;
    expect(job).toMatchObject({ state: "done", limited: true, reason: "signInRequired" });
  });

  const POST = { code: "C1", url: "https://www.instagram.com/p/C1/", takenAt: null, pinned: false, owner: "u", taggedUsers: [], items: [] };

  it("emits a post event and counts it in progress", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = make(async (job) => {
      await gate;
      job.start();
      job.post(POST);
      job.post({ ...POST, code: "C2" });
      job.end({ state: "done" });
    });
    const job = jobs.create({ url: URL_A });
    const events: JobEvent[] = [];
    jobs.subscribe(job.id, (e) => events.push(e));
    release();
    const final = await jobs.ended(job.id)!;
    expect(events.filter((e) => e.type === "post")).toMatchObject([{ jobId: "j1", post: { code: "C1" } }, { post: { code: "C2" } }]);
    expect(final.progress.done).toBe(2);
  });

  it("sends no post event once ended", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const jobs = make(async (job) => {
      await gate;
      job.end({ state: "cancelled" });
      job.post(POST);
    });
    const job = jobs.create({ url: URL_A });
    const events: JobEvent[] = [];
    jobs.subscribe(job.id, (e) => events.push(e));
    release();
    const final = await jobs.ended(job.id)!;
    expect(events.some((e) => e.type === "post")).toBe(false);
    expect(final.progress.done).toBe(0);
  });

  it("counts its followers", () => {
    const jobs = make(() => new Promise(() => undefined));
    const job = jobs.create({ url: URL_A });
    const record = jobs["records"].get(job.id)!;
    expect(record.followers).toBe(0);
    const off = jobs.subscribe(job.id, () => undefined)!;
    expect(record.followers).toBe(1);
    off();
    expect(record.followers).toBe(0);
  });

  it("tells when a client first follows it, or when it is cancelled first", async () => {
    const jobs = make(() => new Promise(() => undefined));
    const record = (id: string) => jobs["records"].get(id)!;
    const followedJob = record(jobs.create({ url: URL_A }).id);
    let followed = false;
    const waiting = followedJob.followed().then(() => (followed = true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(followed).toBe(false);
    jobs.subscribe(followedJob.id, () => undefined);
    await waiting;
    expect(followed).toBe(true);
    // a follower already there: at once
    await followedJob.followed();
    const cancelled = record(jobs.create({ url: URL_A }).id);
    const stillWaiting = cancelled.followed();
    jobs.cancel(cancelled.id);
    await stillWaiting;
    expect(cancelled.followers).toBe(0);
  });

  it("ends a job whose runner throws as failed, with the message", async () => {
    const jobs = make(async () => {
      throw new Error("boom");
    });
    const job = await jobs.ended(jobs.create({ url: URL_A }).id)!;
    expect(job).toMatchObject({ state: "failed", reason: "error", error: "boom" });
  });

  it("ends a job whose runner returns without a result as failed", async () => {
    const jobs = make(async () => {});
    const job = await jobs.ended(jobs.create({ url: URL_A }).id)!;
    expect(job).toMatchObject({ state: "failed", reason: "error", error: "The job ended without a result." });
  });

  it("cancels: the runner's signal aborts and a queued job ends cancelled at once; cancelling again or after the end changes nothing", async () => {
    let signal!: AbortSignal;
    const jobs = make(async (job) => {
      signal = job.signal;
      await new Promise(() => {});
    });
    const job = jobs.create({ url: URL_A });
    const events: JobEvent[] = [];
    jobs.subscribe(job.id, (e) => events.push(e));
    const first = jobs.cancel(job.id)!;
    expect(signal.aborted).toBe(true);
    expect(first).toMatchObject({ state: "cancelled", endedAt: 1000 });
    expect(events.map((e) => e.type)).toEqual(["state", "end"]);
    expect(jobs.cancel(job.id)).toEqual(first);
    expect(events).toHaveLength(2);
    expect((await jobs.ended(job.id)!).state).toBe("cancelled");
    expect(jobs.cancel("nope")).toBeUndefined();
  });

  it("leaves a running job to its runner when cancelled", async () => {
    const jobs = make(async (job) => {
      job.start();
      await new Promise<void>((r) => job.signal.addEventListener("abort", () => r()));
      job.end({ state: "cancelled", reason: "stopped" });
    });
    const job = jobs.create({ url: URL_A });
    expect(jobs.cancel(job.id)!.state).toBe("running");
    expect(await jobs.ended(job.id)).toMatchObject({ state: "cancelled", reason: "stopped" });
  });

  it("throttles progress events but keeps the latest values in view", () => {
    let t = 0;
    let rec!: Parameters<JobRunner>[0];
    const jobs = new Jobs({ run: async (j) => void (rec = j), now: () => t, newId: () => "p" });
    jobs.create({ url: URL_A });
    const events: JobEvent[] = [];
    jobs.subscribe("p", (e) => events.push(e));
    rec.progress({ done: 1 });
    t = 100;
    rec.progress({ done: 2 });
    expect(rec.view().progress).toEqual({ done: 2 });
    expect(events).toHaveLength(1);
    t = 300;
    rec.progress({ done: 3 });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "progress", progress: { done: 3 } });
  });

  it("keeps the newest 200 jobs, dropping only ended ones", () => {
    const all = make(async (job) => job.end({ state: "done" }));
    for (let i = 0; i < 201; i++) all.create({ url: URL_A });
    expect(all.list()).toHaveLength(200);
    expect(all.get("j1")).toBeUndefined();
    expect(all.list()[0]!.id).toBe("j201");

    let first = true;
    const mixed = make(async (job) => {
      if (first) {
        first = false;
        job.start();
        return new Promise<void>(() => {});
      }
      job.end({ state: "done" });
    });
    for (let i = 0; i < 201; i++) mixed.create({ url: URL_A });
    expect(mixed.list()).toHaveLength(200);
    expect(mixed.get("j1")).toBeDefined();
    expect(mixed.get("j2")).toBeUndefined();
  });

  it("never drops the job just created, though it ended at once and every other one is live", async () => {
    let live = 3;
    const jobs = make(async (job) => {
      if (live-- > 0) {
        job.start();
        return new Promise<void>(() => {});
      }
      job.end({ state: "failed", reason: "rateLimited", error: "Slow down." });
    }, 3);
    for (let i = 0; i < 3; i++) jobs.create({ url: URL_A });
    const { id } = jobs.create({ url: URL_A });
    expect(jobs.get(id)).toMatchObject({ id: "j4", state: "failed", reason: "rateLimited" });
    expect(await jobs.ended(id)).toMatchObject({ state: "failed" });
    expect(jobs.list()).toHaveLength(4);
  });
});

describe("jobKindOf", () => {
  it.each([
    ["https://www.instagram.com/p/ABC/", "instagramPost"],
    ["https://www.instagram.com/reel/ABC/", "instagramPost"],
    ["https://www.instagram.com/stories/u/1/", "instagramStory"],
    ["https://www.instagram.com/stories/highlights/1/", "instagramHighlight"],
    [`https://www.instagram.com/s/${Buffer.from("highlight:1").toString("base64")}/`, "instagramHighlight"],
    ["https://instagram.com/NASA?igsh=abc", "instagramProfile"],
    ["https://www.instagram.com/u/saved/", "instagramSaved"],
    ["https://www.instagram.com/explore/", "file"],
    ["https://example.com/a.zip", "file"],
  ])("reads %s as %s", (url, kind) => {
    expect(jobKindOf(url)).toBe(kind);
  });
});
