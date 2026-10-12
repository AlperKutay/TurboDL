import type { AfterAllAction, CountdownState, SchedulerSettings } from "@turbodl/shared";

export function parseTime(hhmm: string): { h: number; m: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

/** True when the wall-clock time hh:mm happened in the interval (prev, now]. */
export function crossed(prev: Date, now: Date, hhmm: string): boolean {
  const t = parseTime(hhmm);
  if (!t) return false;
  for (const dayOffset of [0, -1]) {
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, t.h, t.m, 0, 0);
    if (candidate > prev && candidate <= now) return true;
  }
  return false;
}

export interface SchedulerTarget {
  activateScheduled(): number;
  suspendScheduled(): Promise<void>;
  schedulerWorkRemaining(): boolean;
  clearSchedulerFlags(): void;
}

export interface SchedulerOptions {
  target: SchedulerTarget;
  settings: () => SchedulerSettings;
  runAction: (action: Exclude<AfterAllAction, "none">) => void;
  onCountdown: (state: CountdownState | null) => void;
  now?: () => Date;
  countdownSeconds?: number;
}

export class Scheduler {
  private last: Date;
  private cycleActive = false;
  private interval: NodeJS.Timeout | null = null;
  private countdownTimer: NodeJS.Timeout | null = null;
  private countdownState: CountdownState | null = null;

  constructor(private readonly opts: SchedulerOptions) {
    this.last = this.now();
  }

  get countdown(): CountdownState | null {
    return this.countdownState ? { ...this.countdownState } : null;
  }

  start(intervalMs = 15000): void {
    this.stop();
    this.last = this.now();
    this.interval = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.cancelCountdown();
  }

  async tick(): Promise<void> {
    const now = this.now();
    const prev = this.last;
    this.last = now;
    const s = this.opts.settings();
    if (!s.enabled) return;
    if (crossed(prev, now, s.startTime)) {
      if (this.opts.target.activateScheduled() > 0) this.cycleActive = true;
    }
    if (s.stopTime && crossed(prev, now, s.stopTime)) {
      this.cycleActive = false;
      await this.opts.target.suspendScheduled();
    }
  }

  /** Call whenever the download manager becomes idle. */
  onIdle(): void {
    if (!this.cycleActive || this.opts.target.schedulerWorkRemaining()) return;
    this.cycleActive = false;
    this.opts.target.clearSchedulerFlags();
    const action = this.opts.settings().afterAll;
    if (action !== "none") this.beginCountdown(action);
  }

  cancelCountdown(): void {
    if (!this.countdownTimer) return;
    clearInterval(this.countdownTimer);
    this.countdownTimer = null;
    this.countdownState = null;
    this.opts.onCountdown(null);
  }

  private beginCountdown(action: Exclude<AfterAllAction, "none">): void {
    this.cancelCountdown();
    const state: CountdownState = { action, secondsLeft: this.opts.countdownSeconds ?? 60 };
    this.countdownState = state;
    this.opts.onCountdown({ ...state });
    this.countdownTimer = setInterval(() => {
      state.secondsLeft -= 1;
      if (state.secondsLeft <= 0) {
        this.cancelCountdown();
        this.opts.runAction(action);
        return;
      }
      this.opts.onCountdown({ ...state });
    }, 1000);
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }
}
