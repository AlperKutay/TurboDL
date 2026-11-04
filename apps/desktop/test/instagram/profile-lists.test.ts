import { describe, expect, it } from "vitest";
import { DEFAULT_SAVE_OPTIONS, type Job, type JobProgress, type ListWait, type ProfileListView, type ProfileSaveOptions } from "@turbodl/shared";
import { ProfileLists, isProfileListView, listNames, type ProfileListsDeps, type ProfileRun } from "../../src/main/instagram/profile-lists";
import { profileShowedNothing } from "../../src/main/instagram/profile-service";

const MIN = 60_000;
/** 4 Nov 2026, 18:25 UTC: where the fake clock starts */
const T0 = Date.UTC(2026, 10, 4, 18, 25);
const OPTIONS: ProfileSaveOptions = { ...DEFAULT_SAVE_OPTIONS, tagged: false };
const SLOW_DOWN = "Instagram asked TurboDL to slow down. Try again in a few minutes.";
const RATE_LIMITED = "Instagram asked TurboDL to slow down 3 times in a row. Continue later.";
const SIGNED_OUT = "Instagram signed TurboDL out. Sign in, then continue.";
const PLAN = "Backing up 3 posts, about 2 MB, 40 GB free on the drive.";

/** How a fake profile run ends: the job's fields (and how many files it fetched), or held until the test ends it. */
type Outcome = (Partial<Job> & { fetched?: number }) | "hold" | "throw";

const DONE: Outcome = { state: "done" };
const PRIVATE: Outcome = { state: "failed", reason: "private", error: "This account is private." };
const SLOWED: Outcome = { state: "failed", reason: "rateLimited", error: SLOW_DOWN };
const EXPIRED: Outcome = { state: "failed", reason: "signInRequired", error: "Instagram signed TurboDL out. Sign in to Instagram again." };
const nothing = (username: string): Outcome => ({ state: "failed", reason: "error", error: profileShowedNothing(username) });

/** HH:MM of an epoch time, local, as the slowed-down message shows it. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A clock that moves only when the test moves it: each wait ends at its own time, the earliest first; an abort ends it at once. */
function steppedClock(start = T0) {
  let now = start;
  const timers: { due: number; resolve(): void }[] = [];
  const waits: number[] = [];
  return {
    waits,
    now: () => now,
    wait: (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        waits.push(ms);
        const timer = { due: now + ms, resolve };
        timers.push(timer);
        signal.addEventListener(
          "abort",
          () => {
            const i = timers.indexOf(timer);
            if (i >= 0) timers.splice(i, 1);
            reject(new Error("Cancelled."));
          },
          { once: true },
        );
      }),
    /** ends the earliest wait, the clock moved to its time; false when nothing waits */
    step(): boolean {
      timers.sort((x, y) => x.due - y.due);
      const next = timers.shift();
      if (!next) return false;
      now = Math.max(now, next.due);
      next.resolve();
      return true;
    },
    /** moves the clock without ending any wait */
    advance(ms: number): void {
      now += ms;
    },
    pending: () => timers.length,
  };
}

function jobOf(username: string, o: Partial<Job>): Job {
  return { id: `job-${username}`, url: `https://www.instagram.com/${username}/`, kind: "instagramProfile", state: "done", warnings: [], files: [], failedItems: 0, progress: { done: 0 }, createdAt: 0, ...o };
}

interface FakeRun {
  username: string;
  options: ProfileSaveOptions;
  /** the clock's time when it started */
  at: number;
  cancelled: boolean;
  end(outcome: Exclude<Outcome, "hold">): void;
  tell(progress: JobProgress): void;
}

/**
 * A runner with fake deps: each profile's runs end as `script` says, in turn (done once its outcomes are used up);
 * "hold" leaves a run going until the test ends or cancels it.
 */
function harness(o: { script?: Record<string, Outcome[]>; random?: number; totals?: Record<string, number>; load?: ProfileListView | null; cancelThrows?: boolean } = {}) {
  const clock = steppedClock();
  const runs: FakeRun[] = [];
  const saved: (ProfileListView | null)[] = [];
  const changes: (ProfileListView | null)[] = [];
  const notes: string[] = [];
  const left = Object.fromEntries(Object.entries(o.script ?? {}).map(([name, outcomes]) => [name, [...outcomes]]));
  let randoms = 0;
  const deps: ProfileListsDeps = {
    runProfile(username, options): ProfileRun {
      let resolve!: (ended: { job: Job; fetched: number }) => void;
      let reject!: (err: Error) => void;
      const ended = new Promise<{ job: Job; fetched: number }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      let listener: ((p: JobProgress) => void) | undefined;
      const run: FakeRun = {
        username,
        options,
        at: clock.now(),
        cancelled: false,
        end: (outcome) => {
          if (outcome === "throw") return reject(new Error("The job couldn't start."));
          const { fetched = 0, ...job } = outcome;
          resolve({ job: jobOf(username, job), fetched });
        },
        tell: (p) => listener?.(p),
      };
      runs.push(run);
      const next = left[username]?.shift() ?? DONE;
      if (next !== "hold") queueMicrotask(() => run.end(next));
      return {
        ended,
        cancel: () => {
          // as cancelling a job that has ended may
          if (o.cancelThrows) throw new Error("This job has ended.");
          run.cancelled = true;
          resolve({ job: jobOf(username, { state: "cancelled" }), fetched: 0 });
        },
        progress: (l) => (listener = l),
      };
    },
    wait: clock.wait,
    now: clock.now,
    random: () => {
      randoms++;
      return o.random ?? 0.5;
    },
    load: () => o.load ?? null,
    save: (list) => saved.push(list),
    onChange: (list) => changes.push(list),
    notify: (text) => notes.push(text),
    savedTotal: (username) => o.totals?.[username],
  };
  const lists = new ProfileLists(deps);
  return { clock, runs, saved, changes, notes, deps, lists, randoms: () => randoms };
}

type Harness = ReturnType<typeof harness>;

/** Lets everything that is ready run (the clock doesn't move). */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Runs the list on, moving the clock through each wait, until nothing is left to run but a held profile. */
async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 200; i++) {
    await flush();
    if (!h.clock.step()) return;
  }
  throw new Error("the list never settled");
}

function start(h: Harness, usernames: string[], wait: ListWait = { min: 0, max: 0 }) {
  return h.lists.start({ name: "friends.txt", usernames, options: OPTIONS, wait });
}

const ranAt = (h: Harness) => h.runs.map((r) => [r.username, (r.at - T0) / MIN]);

describe("ProfileLists", () => {
  it("backs up every profile in order with a random wait between them", async () => {
    const h = harness({
      script: { "first.one": [{ state: "done", limited: true, fetched: 2, warnings: [PLAN, "This profile has no highlights.", "1 post is shown only to signed-in visitors; sign in to save them."] }], "second.one": [{ state: "done", fetched: 0, warnings: [PLAN] }] },
      totals: { "first.one": 12, "second.one": 5 },
    });
    expect(start(h, ["first.one", "second.one", "third.one"], { min: 2, max: 4 })).toEqual({ ok: true });
    expect(h.lists.view()).toMatchObject({ name: "friends.txt", index: 0, state: "running", options: OPTIONS, wait: { min: 2, max: 4 }, rows: [{ username: "first.one", state: "running" }, { username: "second.one", state: "waiting" }, { username: "third.one", state: "waiting" }] });
    await settle(h);
    // no wait before the first or after the last; random 0.5 of 2–4 minutes: 3 minutes each
    expect(ranAt(h)).toEqual([["first.one", 0], ["second.one", 3], ["third.one", 6]]);
    expect(h.clock.waits).toEqual([3 * MIN, 3 * MIN]);
    expect(h.runs.map((r) => r.options)).toEqual([OPTIONS, OPTIONS, OPTIONS]);
    const view = h.lists.view()!;
    expect(view.state).toBe("finished");
    expect(view.index).toBe(3);
    expect(view.nextAt).toBeUndefined();
    expect(view.progress).toBeUndefined();
    expect(view.rows).toEqual([
      // the plan's warning is news only before the start: the last other warning is the row's note
      { username: "first.one", state: "done", files: 12, fetched: 2, note: "1 post is shown only to signed-in visitors; sign in to save them." },
      { username: "second.one", state: "done", files: 5, fetched: 0 },
      // no Profiles entry for it: no total
      { username: "third.one", state: "done", fetched: 0 },
    ]);
    expect(h.notes).toEqual(["Profile list finished: 3 backed up, 0 skipped."]);
    // every change is saved and told, as plain JSON
    expect(h.changes).toEqual(h.saved);
    expect(h.saved.at(-1)).toEqual(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    // the wait is shown as such, until a time drawn once
    const waiting = h.changes.filter((v) => v?.state === "waiting");
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting[0]).toMatchObject({ index: 1, nextAt: T0 + 3 * MIN, rows: [{ state: "done" }, { state: "waiting" }, { state: "waiting" }] });
    expect(h.randoms()).toBe(2);
  });

  it("skips private profiles and profiles that showed nothing, and goes on", async () => {
    const h = harness({
      script: {
        "shut.door": [PRIVATE],
        // the error names the profile as Instagram's address does, lowercased
        "No.Such.One": [nothing("no.such.one")],
        "broken.one": [{ state: "failed", reason: "error", error: "The backup failed.", failedItems: 2 }],
      },
    });
    start(h, ["first.one", "shut.door", "No.Such.One", "broken.one", "last.one"]);
    await settle(h);
    expect(ranAt(h).map(([name]) => name)).toEqual(["first.one", "shut.door", "No.Such.One", "broken.one", "last.one"]);
    expect(h.lists.view()!.rows).toEqual([
      { username: "first.one", state: "done", fetched: 0 },
      { username: "shut.door", state: "skipped", note: "This account is private." },
      { username: "No.Such.One", state: "skipped", note: profileShowedNothing("no.such.one") },
      // posts it couldn't save before it broke don't make it a partial backup
      { username: "broken.one", state: "failed", note: "The backup failed." },
      { username: "last.one", state: "done", fetched: 0 },
    ]);
    expect(h.lists.view()!.state).toBe("finished");
    expect(h.notes).toEqual(["Profile list finished: 2 backed up, 2 skipped, 1 failed."]);
  });

  it("counts a profile whose backups couldn't save some posts as backed up, with the job's words", async () => {
    const missed = "2 posts couldn't be saved; they're tried again on the next run.";
    const h = harness({
      script: { "some.missed": [{ state: "failed", reason: "error", error: missed, failedItems: 2, missedItems: 2, fetched: 5 }] },
      totals: { "some.missed": 40 },
    });
    start(h, ["some.missed", "next.one"]);
    await settle(h);
    expect(h.lists.view()!.rows).toEqual([
      { username: "some.missed", state: "done", files: 40, fetched: 5, note: missed },
      { username: "next.one", state: "done", fetched: 0 },
    ]);
    expect(h.notes).toEqual(["Profile list finished: 2 backed up, 0 skipped."]);
  });

  it("fails a profile whose run broke, and goes on", async () => {
    const h = harness({ script: { "first.one": ["throw"] } });
    start(h, ["first.one", "second.one"]);
    await settle(h);
    expect(h.lists.view()!.rows).toEqual([
      { username: "first.one", state: "failed", note: "The job couldn't start." },
      { username: "second.one", state: "done", fetched: 0 },
    ]);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("stops with the reason, and says so, when its run breaks", async () => {
    const h = harness();
    h.deps.wait = () => Promise.reject(new Error("The clock broke."));
    start(h, ["first.one", "second.one"], { min: 1, max: 1 });
    await flush();
    const view = h.lists.view()!;
    expect(view).toMatchObject({ state: "stopped", index: 1, message: "The clock broke.", rows: [{ state: "done" }, { state: "waiting" }] });
    expect(h.saved.at(-1)).toEqual(view);
    expect(h.changes.at(-1)).toEqual(view);
    expect(h.notes).toEqual(["Profile list stopped: something went wrong; continue it in TurboDL."]);
    // Continue goes on, the reason gone
    h.deps.wait = h.clock.wait;
    expect(h.lists.continue()).toEqual({ ok: true });
    expect(h.lists.view()!.message).toBeUndefined();
    await settle(h);
    expect(h.lists.view()).toMatchObject({ state: "finished", rows: [{ state: "done" }, { state: "done" }] });
  });

  it("waits 15 minutes on a slow-down and runs the same profile again", async () => {
    const h = harness({ script: { "first.one": [SLOWED, DONE] } });
    start(h, ["first.one", "second.one"]);
    await flush();
    expect(h.lists.view()).toMatchObject({
      state: "slowedDown",
      index: 0,
      nextAt: T0 + 15 * MIN,
      message: `Instagram asked TurboDL to slow down — going on at ${hhmm(T0 + 15 * MIN)}.`,
      rows: [{ username: "first.one", state: "waiting" }, { username: "second.one", state: "waiting" }],
    });
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 15], ["second.one", 15]]);
    expect(h.clock.waits).toEqual([15 * MIN]);
    expect(h.lists.view()).toMatchObject({ state: "finished", rows: [{ state: "done" }, { state: "done" }] });
    expect(h.lists.view()!.message).toBeUndefined();
  });

  it("stops after 3 slow-downs in a row, and Continue counts them anew", async () => {
    const h = harness({ script: { "first.one": [SLOWED, SLOWED, SLOWED, SLOWED, DONE] } });
    start(h, ["first.one", "second.one"]);
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 15], ["first.one", 30]]);
    const view = h.lists.view()!;
    expect(view).toMatchObject({ state: "rateLimited", index: 0, message: RATE_LIMITED, rows: [{ state: "waiting" }, { state: "waiting" }] });
    expect(view.nextAt).toBeUndefined();
    expect(h.clock.pending()).toBe(0);
    // a list that stops by itself says so
    expect(h.notes).toEqual(["Profile list stopped: Instagram asked TurboDL to slow down 3 times in a row."]);
    // Continue runs the same profile at once; the next slow-down is the first of a new count
    expect(h.lists.continue()).toEqual({ ok: true });
    await flush();
    expect(h.lists.view()).toMatchObject({ state: "slowedDown", index: 0 });
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 15], ["first.one", 30], ["first.one", 30], ["first.one", 45], ["second.one", 45]]);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("counts slow-downs in a row anew after a done row", async () => {
    const h = harness({ script: { "first.one": [SLOWED, SLOWED, DONE], "second.one": [SLOWED, DONE] } });
    start(h, ["first.one", "second.one"]);
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 15], ["first.one", 30], ["second.one", 30], ["second.one", 45]]);
    expect(h.lists.view()).toMatchObject({ state: "finished", rows: [{ state: "done" }, { state: "done" }] });
    expect(h.changes.some((v) => v?.state === "rateLimited")).toBe(false);
  });

  it("treats three profiles in a row that showed nothing as a slow-down", async () => {
    const h = harness({ script: { "gone.one": [nothing("gone.one")], "gone.two": [nothing("gone.two")], "slow.three": [nothing("slow.three"), DONE] } });
    start(h, ["gone.one", "gone.two", "slow.three", "last.one"]);
    await flush();
    // the first two stay skipped; the third is taken as Instagram pushing back
    expect(h.lists.view()).toMatchObject({
      state: "slowedDown",
      index: 2,
      nextAt: T0 + 15 * MIN,
      message: `Instagram asked TurboDL to slow down — going on at ${hhmm(T0 + 15 * MIN)}.`,
      rows: [{ state: "skipped" }, { state: "skipped" }, { username: "slow.three", state: "waiting" }, { state: "waiting" }],
    });
    await settle(h);
    expect(ranAt(h)).toEqual([["gone.one", 0], ["gone.two", 0], ["slow.three", 0], ["slow.three", 15], ["last.one", 15]]);
    expect(h.lists.view()!.rows.map((r) => r.state)).toEqual(["skipped", "skipped", "done", "done"]);
    expect(h.notes).toEqual(["Profile list finished: 2 backed up, 2 skipped."]);
  });

  it("skips a profile that shows nothing again after that wait, without stopping the list", async () => {
    const names = ["typo.one", "typo.two", "typo.three", "typo.four", "typo.five", "real.one"];
    const h = harness({ script: Object.fromEntries(names.slice(0, 5).map((n) => [n, [nothing(n), nothing(n)]])) });
    start(h, names);
    await settle(h);
    // three misspelled names: one 15-minute wait, all three skipped; both counts start over, so two more are just skipped
    expect(h.clock.waits).toEqual([15 * MIN]);
    expect(ranAt(h)).toEqual([["typo.one", 0], ["typo.two", 0], ["typo.three", 0], ["typo.three", 15], ["typo.four", 15], ["typo.five", 15], ["real.one", 15]]);
    expect(h.lists.view()!.rows.map((r) => [r.username, r.state, r.note])).toEqual([
      ...names.slice(0, 5).map((n) => [n, "skipped", profileShowedNothing(n)]),
      ["real.one", "done", undefined],
    ]);
    expect(h.lists.view()!.state).toBe("finished");
    expect(h.notes).toEqual(["Profile list finished: 1 backed up, 5 skipped."]);
  });

  it("stops the list when the session expired, and continue() runs that row", async () => {
    const h = harness({ script: { "second.one": [EXPIRED, DONE] } });
    start(h, ["first.one", "second.one", "third.one"], { min: 2, max: 4 });
    await settle(h);
    const view = h.lists.view()!;
    expect(view).toMatchObject({ state: "signedOut", index: 1, message: SIGNED_OUT, rows: [{ state: "done" }, { state: "waiting" }, { state: "waiting" }] });
    expect(view.nextAt).toBeUndefined();
    expect(h.clock.pending()).toBe(0);
    expect(h.notes).toEqual(["Profile list stopped: Instagram signed TurboDL out."]);
    h.clock.advance(60 * MIN);
    expect(h.lists.continue()).toEqual({ ok: true });
    await settle(h);
    // that row at once (it waited before its first run), then the next one after its wait
    expect(ranAt(h)).toEqual([["first.one", 0], ["second.one", 3], ["second.one", 63], ["third.one", 66]]);
    expect(h.lists.view()).toMatchObject({ state: "finished", rows: [{ state: "done" }, { state: "done" }, { state: "done" }] });
    expect(h.lists.view()!.message).toBeUndefined();
    expect(h.notes).toEqual(["Profile list stopped: Instagram signed TurboDL out.", "Profile list finished: 3 backed up, 0 skipped."]);
  });

  it("shows the running profile's progress, and stops it: Continue runs it again", async () => {
    const h = harness({ script: { "first.one": ["hold", DONE] } });
    start(h, ["first.one", "second.one"]);
    await flush();
    const savedBefore = h.saved.length;
    h.runs[0].tell({ done: 4, total: 10, bytes: 1000, note: "Signed out: reading each post from its own page" });
    h.runs[0].tell({ done: 5, total: 10 });
    expect(h.lists.view()!.progress).toEqual({ done: 5, total: 10 });
    // progress is told, not saved: a list loaded later drops it anyway
    expect(h.changes.at(-2)!.progress).toEqual({ done: 4, total: 10, note: "Signed out: reading each post from its own page" });
    expect(h.changes.at(-1)!.progress).toEqual({ done: 5, total: 10 });
    expect(h.saved).toHaveLength(savedBefore);
    expect(h.saved.some((v) => v?.progress)).toBe(false);
    await h.lists.stop();
    expect(h.runs[0].cancelled).toBe(true);
    const view = h.lists.view()!;
    expect(view).toMatchObject({ state: "stopped", index: 0, rows: [{ state: "waiting" }, { state: "waiting" }] });
    expect(view.progress).toBeUndefined();
    expect(h.saved.at(-1)).toEqual(view);
    expect(h.lists.continue()).toEqual({ ok: true });
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 0], ["second.one", 0]]);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("stops the list when its running profile is stopped elsewhere", async () => {
    const h = harness({ script: { "first.one": [{ state: "cancelled", reason: "stopped", error: "The backup was stopped in TurboDL." }] } });
    start(h, ["first.one", "second.one"]);
    await settle(h);
    expect(h.lists.view()).toMatchObject({ state: "stopped", index: 0, rows: [{ state: "waiting" }, { state: "waiting" }] });
    expect(h.runs).toHaveLength(1);
  });

  it("continues after a stop in a wait without running a profile twice or waiting twice", async () => {
    const h = harness();
    start(h, ["first.one", "second.one"], { min: 2, max: 4 });
    await flush();
    expect(h.lists.view()).toMatchObject({ state: "waiting", index: 1, nextAt: T0 + 3 * MIN });
    await h.lists.stop();
    expect(h.clock.pending()).toBe(0);
    expect(h.lists.view()).toMatchObject({ state: "stopped", index: 1, nextAt: T0 + 3 * MIN, rows: [{ state: "done" }, { state: "waiting" }] });
    h.clock.advance(1 * MIN);
    expect(h.lists.continue()).toEqual({ ok: true });
    expect(h.lists.view()).toMatchObject({ state: "waiting", nextAt: T0 + 3 * MIN });
    await settle(h);
    // the rest of the wait drawn before the stop, then the second profile; the first isn't run again
    expect(h.clock.waits).toEqual([3 * MIN, 2 * MIN]);
    expect(ranAt(h)).toEqual([["first.one", 0], ["second.one", 3]]);
    expect(h.randoms()).toBe(1);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("runs on at once when a stored wait has passed by Continue", async () => {
    const h = harness();
    start(h, ["first.one", "second.one"], { min: 2, max: 4 });
    await flush();
    await h.lists.stop();
    h.clock.advance(10 * MIN);
    h.lists.continue();
    await settle(h);
    expect(h.clock.waits).toEqual([3 * MIN]);
    expect(ranAt(h)).toEqual([["first.one", 0], ["second.one", 10]]);
  });

  it("stops in a slow-down's wait and keeps its time", async () => {
    const h = harness({ script: { "first.one": [SLOWED, DONE] } });
    start(h, ["first.one"]);
    await flush();
    await h.lists.stop();
    const view = h.lists.view()!;
    expect(view).toMatchObject({ state: "stopped", index: 0, nextAt: T0 + 15 * MIN });
    expect(view.message).toBeUndefined();
    h.lists.continue();
    await settle(h);
    expect(ranAt(h)).toEqual([["first.one", 0], ["first.one", 15]]);
  });

  it("keeps a profile that ended as Stop came: the list stops before the next one, or finishes after the last", async () => {
    const h = harness({ script: { "first.one": ["hold"], "second.one": ["hold"] } });
    start(h, ["first.one", "second.one"], { min: 2, max: 4 });
    await flush();
    h.runs[0].end(DONE as Exclude<Outcome, "hold">);
    await h.lists.stop();
    expect(h.runs[0].cancelled).toBe(true);
    expect(h.lists.view()).toMatchObject({ state: "stopped", index: 1, nextAt: T0 + 3 * MIN, rows: [{ state: "done" }, { state: "waiting" }] });
    expect(h.clock.pending()).toBe(0);
    h.lists.continue();
    await settle(h);
    h.runs[1].end(DONE as Exclude<Outcome, "hold">);
    await h.lists.stop();
    expect(h.lists.view()).toMatchObject({ state: "finished", index: 2, rows: [{ state: "done" }, { state: "done" }] });
    expect(h.notes).toEqual(["Profile list finished: 2 backed up, 0 skipped."]);
  });

  it("still stops when cancelling a profile's run that has just ended throws", async () => {
    const h = harness({ script: { "first.one": ["hold"] }, cancelThrows: true });
    start(h, ["first.one", "second.one"], { min: 2, max: 4 });
    await flush();
    h.runs[0].end(DONE as Exclude<Outcome, "hold">);
    await h.lists.stop();
    expect(h.lists.view()).toMatchObject({ state: "stopped", index: 1, rows: [{ state: "done" }, { state: "waiting" }] });
    expect(h.clock.pending()).toBe(0);
  });

  it("brings a stored time to go on back to the list's longest wait (15 minutes at least) from now, on load and on Continue", async () => {
    // saved while the clock was days ahead
    const load: ProfileListView = {
      name: "friends.txt",
      rows: [{ username: "first.one", state: "done", fetched: 0 }, { username: "second.one", state: "waiting" }],
      index: 1,
      state: "waiting",
      nextAt: T0 + 3 * 24 * 60 * MIN,
      options: OPTIONS,
      wait: { min: 2, max: 5 },
    };
    const loaded = harness({ load });
    expect(loaded.lists.view()).toMatchObject({ state: "stopped", nextAt: T0 + 15 * MIN });
    loaded.lists.continue();
    await settle(loaded);
    expect(loaded.clock.waits).toEqual([15 * MIN]);
    expect(ranAt(loaded)).toEqual([["second.one", 15]]);

    // a clock set back a day after a stop: Continue waits the list's longest wait, not a day and more
    const h = harness();
    start(h, ["first.one", "second.one"], { min: 30, max: 60 });
    await flush();
    expect(h.lists.view()).toMatchObject({ state: "waiting", nextAt: T0 + 45 * MIN });
    await h.lists.stop();
    h.clock.advance(-24 * 60 * MIN);
    expect(h.lists.continue()).toEqual({ ok: true });
    expect(h.lists.view()).toMatchObject({ state: "waiting", nextAt: T0 - 24 * 60 * MIN + 60 * MIN });
    await settle(h);
    expect(h.clock.waits).toEqual([45 * MIN, 60 * MIN]);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("never takes up a loaded list that hasn't a list's shape", async () => {
    const h = harness({ load: { name: "friends.txt", rows: "first.one", index: 0, state: "stopped" } as unknown as ProfileListView });
    expect(h.lists.view()).toBeNull();
    expect(h.lists.continue()).toEqual({ ok: false, error: "There is no list." });
    expect(start(h, ["first.one"])).toEqual({ ok: true });
  });

  it("does nothing on stop() without a running list", async () => {
    const h = harness();
    await h.lists.stop();
    expect(h.lists.view()).toBeNull();
    expect(h.saved).toEqual([]);
  });

  it("loads an unfinished list as stopped", async () => {
    for (const state of ["running", "waiting", "slowedDown"] as const) {
      const load: ProfileListView = {
        name: "friends.txt",
        rows: [
          { username: "first.one", state: "done", files: 3, fetched: 3 },
          { username: "second.one", state: state === "running" ? "running" : "waiting" },
          { username: "third.one", state: "waiting" },
        ],
        index: 1,
        state,
        ...(state === "running" ? { progress: { done: 2, total: 9 } } : { nextAt: T0 + 5 * MIN }),
        ...(state === "slowedDown" ? { message: `Instagram asked TurboDL to slow down — going on at ${hhmm(T0 + 5 * MIN)}.` } : {}),
        options: OPTIONS,
        wait: { min: 0, max: 0 },
      };
      const h = harness({ load });
      const view = h.lists.view()!;
      expect(view).toMatchObject({ state: "stopped", index: 1, rows: [{ state: "done", files: 3 }, { state: "waiting" }, { state: "waiting" }] });
      expect(view.progress).toBeUndefined();
      expect(view.message).toBeUndefined();
      // nothing runs on its own
      await flush();
      expect(h.runs).toEqual([]);
      expect(h.clock.pending()).toBe(0);
      // Continue goes on from the row it was at, after a wait it had
      h.lists.continue();
      await settle(h);
      expect(ranAt(h)).toEqual(state === "running" ? [["second.one", 0], ["third.one", 0]] : [["second.one", 5], ["third.one", 5]]);
      expect(h.lists.view()!.state).toBe("finished");
    }
  });

  it("ignores a corrupt list file", async () => {
    const h = harness({ load: null });
    expect(h.lists.view()).toBeNull();
    expect(start(h, ["first.one"])).toEqual({ ok: true });
    await settle(h);
    expect(h.lists.view()!.state).toBe("finished");
  });

  it("keeps a loaded list that stopped on its own as it was", () => {
    const load: ProfileListView = { name: "friends.txt", rows: [{ username: "first.one", state: "waiting" }], index: 0, state: "rateLimited", message: RATE_LIMITED, options: OPTIONS, wait: { min: 2, max: 5 } };
    const h = harness({ load });
    expect(h.lists.view()).toEqual(load);
  });

  it("refuses a second list while one is unfinished", async () => {
    const h = harness({ script: { "first.one": ["hold"] } });
    start(h, ["first.one"]);
    await flush();
    const refused = { ok: false, error: "Close the list that is there first." };
    expect(start(h, ["second.one"])).toEqual(refused);
    await h.lists.stop();
    expect(start(h, ["second.one"])).toEqual(refused);
    expect(h.lists.close()).toEqual({ ok: true });
    expect(start(h, ["second.one"])).toEqual({ ok: true });
    await settle(h);
    expect(h.lists.view()!.state).toBe("finished");
    // a finished list makes way for the next one
    expect(start(h, ["third.one"])).toEqual({ ok: true });
    await settle(h);
    expect(h.lists.view()).toMatchObject({ state: "finished", rows: [{ username: "third.one", state: "done" }] });
    expect(ranAt(h).map(([name]) => name)).toEqual(["first.one", "second.one", "third.one"]);
  });

  it("refuses close() while running, and closes a finished or stopped list", async () => {
    const h = harness({ script: { "first.one": ["hold"], "third.one": [SLOWED] } });
    const busy = { ok: false, error: "Stop the list first." };
    start(h, ["first.one", "second.one"], { min: 2, max: 4 });
    await flush();
    expect(h.lists.close()).toEqual(busy);
    h.runs[0].end(DONE as Exclude<Outcome, "hold">);
    await flush();
    expect(h.lists.view()!.state).toBe("waiting");
    expect(h.lists.close()).toEqual(busy);
    await h.lists.stop();
    expect(h.lists.close()).toEqual({ ok: true });
    expect(h.lists.view()).toBeNull();
    expect(h.saved.at(-1)).toBeNull();
    expect(h.changes.at(-1)).toBeNull();

    start(h, ["third.one"]);
    await flush();
    expect(h.lists.view()!.state).toBe("slowedDown");
    expect(h.lists.close()).toEqual(busy);
    await settle(h);
    expect(h.lists.view()!.state).toBe("finished");
    expect(h.lists.close()).toEqual({ ok: true });
    expect(h.lists.view()).toBeNull();
  });

  it("keeps the list when its file can't be deleted on close()", async () => {
    const h = harness();
    start(h, ["first.one"]);
    await settle(h);
    const view = h.lists.view()!;
    const told = h.changes.length;
    const save = h.deps.save;
    h.deps.save = (list) => {
      if (list === null) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      save(list);
    };
    expect(h.lists.close()).toEqual({ ok: false, error: "TurboDL couldn't delete the list's file. Try again." });
    expect(h.lists.view()).toEqual(view);
    expect(h.changes.length).toBe(told);
    // once it can, it goes
    h.deps.save = save;
    expect(h.lists.close()).toEqual({ ok: true });
    expect(h.lists.view()).toBeNull();
    expect(h.saved.at(-1)).toBeNull();
    expect(h.changes.at(-1)).toBeNull();
  });

  it("continues only a list that stopped", async () => {
    const h = harness({ script: { "first.one": ["hold"] } });
    expect(h.lists.continue()).toEqual({ ok: false, error: "There is no list." });
    expect(h.lists.close()).toEqual({ ok: false, error: "There is no list." });
    start(h, ["first.one"]);
    await flush();
    expect(h.lists.continue()).toEqual({ ok: false, error: "The list is running." });
    h.runs[0].end(DONE as Exclude<Outcome, "hold">);
    await settle(h);
    expect(h.lists.continue()).toEqual({ ok: false, error: "The list has finished." });
  });
});

describe("isProfileListView", () => {
  const VALID: ProfileListView = {
    name: "friends.txt",
    rows: [
      { username: "first.one", state: "done", files: 12, fetched: 2, note: "1 post couldn't be saved." },
      { username: "second.one", state: "running" },
    ],
    index: 1,
    state: "running",
    nextAt: T0,
    message: "Instagram asked TurboDL to slow down — going on at 18:40.",
    options: OPTIONS,
    wait: { min: 2, max: 5 },
    progress: { done: 4, total: 10, note: "Signed out: reading each post from its own page" },
  };

  it("takes a list as the app saves it", () => {
    expect(isProfileListView(VALID)).toBe(true);
    expect(isProfileListView(JSON.parse(JSON.stringify(VALID)))).toBe(true);
    const { nextAt: _n, message: _m, progress: _p, ...bare } = VALID;
    expect(isProfileListView(bare)).toBe(true);
    // a finished list's index is past its last row
    expect(isProfileListView({ ...bare, index: 2, state: "finished" })).toBe(true);
  });

  it("refuses anything else", () => {
    const bad: unknown[] = [
      null,
      "friends.txt",
      [],
      { ...VALID, name: 3 },
      { ...VALID, rows: "first.one" },
      { ...VALID, rows: [] },
      { ...VALID, rows: [{ username: "first.one" }] },
      { ...VALID, rows: [{ username: "first.one", state: "lost" }] },
      { ...VALID, rows: [{ username: "First.One", state: "waiting" }] },
      { ...VALID, rows: [{ username: "not a name", state: "waiting" }] },
      { ...VALID, rows: [{ username: "first.one", state: "done", files: "12" }] },
      { ...VALID, rows: [null] },
      { ...VALID, rows: Array.from({ length: 1001 }, (_, k) => ({ username: `p${k}`, state: "waiting" })) },
      { ...VALID, index: -1 },
      { ...VALID, index: 3 },
      { ...VALID, index: 0.5 },
      { ...VALID, index: "1" },
      { ...VALID, state: "paused" },
      { ...VALID, nextAt: "soon" },
      { ...VALID, message: 5 },
      { ...VALID, options: { ...OPTIONS, posts: "yes" } },
      { ...VALID, options: undefined },
      { ...VALID, wait: { min: 5, max: 2 } },
      { ...VALID, wait: null },
      { ...VALID, progress: { total: 10 } },
    ];
    for (const v of bad) expect(isProfileListView(v), JSON.stringify(v)?.slice(0, 120)).toBe(false);
  });
});

describe("listNames", () => {
  it("takes profiles however they are written, lowercased, repeats dropped", () => {
    expect(listNames(["First.One", "@second.one", "https://www.instagram.com/third.one/", "first.one"])).toEqual({ names: ["first.one", "second.one", "third.one"] });
  });

  it("says why the names can't make a list", () => {
    const none = { error: "The list has no profiles." };
    expect(listNames([])).toEqual(none);
    expect(listNames("first.one")).toEqual(none);
    expect(listNames(undefined)).toEqual(none);
    expect(listNames(["first.one", "not a name"])).toEqual({ error: '"not a name" isn\'t a profile.' });
    expect(listNames(["first.one", 7])).toEqual({ error: "The list holds something that isn't a profile's name." });
    const many = Array.from({ length: 1001 }, (_, k) => `p${k}`);
    expect(listNames(many)).toEqual({ error: "A list can hold at most 1,000 profiles." });
    expect(listNames(many.slice(0, 1000))).toMatchObject({ names: { length: 1000 } });
    // repeats count once
    expect(listNames([...many.slice(0, 1000), "P0"])).toMatchObject({ names: { length: 1000 } });
  });
});
