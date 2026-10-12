import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CountdownState, SchedulerSettings } from "@turbodl/shared";
import { Scheduler, crossed, type SchedulerTarget } from "./scheduler";

const at = (h: number, m: number, s = 0, day = 12) => new Date(2026, 9, day, h, m, s);

describe("crossed", () => {
  it("detects a time inside (prev, now]", () => {
    expect(crossed(at(1, 59, 50), at(2, 0, 5), "02:00")).toBe(true);
    expect(crossed(at(2, 0, 5), at(2, 0, 20), "02:00")).toBe(false);
    expect(crossed(at(1, 0), at(1, 30), "02:00")).toBe(false);
  });

  it("works across midnight", () => {
    expect(crossed(at(23, 59, 50, 12), at(0, 0, 10, 13), "00:00")).toBe(true);
    expect(crossed(at(23, 59, 50, 12), at(0, 0, 10, 13), "23:59")).toBe(false);
  });
});

describe("Scheduler", () => {
  let now: Date;
  let settings: SchedulerSettings;
  let target: SchedulerTarget & { activated: number; suspended: number; remaining: boolean; cleared: number };
  let actions: string[];
  let countdowns: (CountdownState | null)[];

  beforeEach(() => {
    vi.useFakeTimers();
    now = at(1, 59, 50);
    settings = { enabled: true, startTime: "02:00", stopTime: "06:00", afterAll: "shutdown" };
    target = {
      activated: 0,
      suspended: 0,
      remaining: false,
      cleared: 0,
      activateScheduled() {
        this.activated++;
        return 2;
      },
      async suspendScheduled() {
        this.suspended++;
      },
      schedulerWorkRemaining() {
        return this.remaining;
      },
      clearSchedulerFlags() {
        this.cleared++;
      },
    };
    actions = [];
    countdowns = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () =>
    new Scheduler({
      target,
      settings: () => settings,
      runAction: (a) => actions.push(a),
      onCountdown: (s) => countdowns.push(s),
      now: () => now,
      countdownSeconds: 3,
    });

  it("activates scheduled downloads at the start time", async () => {
    const s = make();
    now = at(2, 0, 5);
    await s.tick();
    expect(target.activated).toBe(1);
    await s.tick();
    expect(target.activated).toBe(1);
  });

  it("does nothing when disabled", async () => {
    settings.enabled = false;
    const s = make();
    now = at(2, 0, 5);
    await s.tick();
    expect(target.activated).toBe(0);
  });

  it("suspends scheduler work at the stop time without an after-all action", async () => {
    const s = make();
    now = at(2, 0, 5);
    await s.tick();
    now = at(6, 0, 1);
    await s.tick();
    expect(target.suspended).toBe(1);
    s.onIdle();
    expect(countdowns).toEqual([]);
  });

  it("counts down and runs the after-all action when the cycle finishes", async () => {
    const s = make();
    now = at(2, 0, 5);
    await s.tick();
    target.remaining = true;
    s.onIdle();
    expect(countdowns).toEqual([]);
    target.remaining = false;
    s.onIdle();
    expect(target.cleared).toBe(1);
    expect(countdowns[0]).toEqual({ action: "shutdown", secondsLeft: 3 });
    vi.advanceTimersByTime(3000);
    expect(actions).toEqual(["shutdown"]);
    expect(countdowns.at(-1)).toBeNull();
  });

  it("can cancel the countdown", async () => {
    const s = make();
    now = at(2, 0, 5);
    await s.tick();
    s.onIdle();
    expect(s.countdown?.action).toBe("shutdown");
    s.cancelCountdown();
    vi.advanceTimersByTime(5000);
    expect(actions).toEqual([]);
    expect(countdowns.at(-1)).toBeNull();
  });

  it("ignores idle when no scheduler cycle is active", () => {
    const s = make();
    s.onIdle();
    expect(countdowns).toEqual([]);
  });
});
