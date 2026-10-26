import type { StartResult } from "../instagram/backups";
import { SLOW_DOWN } from "../instagram/pacer";
import type { JobRecord } from "./job-record";

/** ms between the pages jobs read, picked at random in the range (the gap highlight backups leave between pages) */
const READ_GAP: [number, number] = [3000, 6000];
/** ms before a lane job looks at the backup slot again after a screen took it first */
const BUSY_AGAIN = 250;

/** A backup Instagram's slow-down kept from starting. */
export const SLOWED_DOWN: Extract<StartResult, { ok: false }> = { ok: false, error: SLOW_DOWN, reason: "rateLimited" };

/** What the lane needs from the app: the account's clock and pace, and its one backup slot. */
export interface InstagramLaneDeps {
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** 0…1 */
  random(): number;
  /** Instagram asked to slow down a moment ago */
  held(): boolean;
  /** resolves when no backup is going on, the screens' included */
  settled(): Promise<void>;
}

type Wake = "go" | "cancelled" | "rateLimited";

/**
 * How Instagram jobs share the account: their backups one job at a time in arrival order, after the screens' backups
 * too, and the pages they read 3–6 s apart, whoever reads them.
 */
export class InstagramLane {
  /** the job whose backups run now; it keeps the turn until it ends */
  private holder: JobRecord | null = null;
  /** jobs waiting for the turn, in arrival order */
  private readonly queue: { job: JobRecord; go(): void }[] = [];
  /** every wait in the lane, ended at once when Instagram asks a job to slow down */
  private readonly waits = new Set<() => void>();
  private nextReadAt = 0;

  constructor(private readonly o: InstagramLaneDeps) {}

  /**
   * Starts a backup in its turn: one lane job at a time in arrival order, then once the backup slot is free (also of
   * the screens' backups); "busy" means a screen started one first, so it waits again. "cancelled" when the job is.
   */
  async backup(job: JobRecord, start: () => Promise<StartResult>): Promise<StartResult | "cancelled"> {
    if (job.signal.aborted) return "cancelled";
    if (this.holder !== job) {
      const turn = await this.until(job, this.take(job));
      if (turn !== "go") return this.leave(job, turn);
    }
    for (;;) {
      const free = await this.until(job, this.o.settled());
      if (free !== "go") return this.leave(job, free);
      if (this.o.held()) return this.leave(job, "rateLimited");
      const result = await start();
      // the turn stays the job's until it ends: its next part goes next
      if (result.ok) return result;
      if (job.signal.aborted) return this.leave(job, "cancelled");
      if (result.reason === "rateLimited") return this.leave(job, "rateLimited");
      if (result.reason !== "busy") {
        this.release(job);
        return result;
      }
      const again = await this.until(job, this.o.wait(BUSY_AGAIN, job.signal).catch(() => undefined));
      if (again !== "go") return this.leave(job, again);
    }
  }

  /** Waits so the pages jobs read come 3–6 s apart (uniform random), whoever reads them. */
  async gap(signal?: AbortSignal): Promise<void> {
    const now = this.o.now();
    const at = Math.max(now, this.nextReadAt);
    this.nextReadAt = at + Math.round(READ_GAP[0] + this.o.random() * (READ_GAP[1] - READ_GAP[0]));
    if (at > now) await this.o.wait(at - now, signal).catch(() => undefined);
  }

  /** Instagram asked a job to slow down: every job still waiting in the lane gets the same answer, at once. */
  slowDown(): void {
    for (const wake of [...this.waits]) wake();
  }

  /** Resolves once `job` holds the turn; it is given up when the job ends. */
  private take(job: JobRecord): Promise<void> {
    void job.ended.then(() => this.release(job));
    if (!this.holder) {
      this.holder = job;
      return Promise.resolve();
    }
    return new Promise((go) => this.queue.push({ job, go }));
  }

  /** The job leaves the lane without a backup; a slow-down ends every other waiting job first. */
  private leave(job: JobRecord, why: "cancelled" | "rateLimited"): StartResult | "cancelled" {
    const waiting = this.queue.findIndex((w) => w.job === job);
    if (waiting >= 0) this.queue.splice(waiting, 1);
    if (why === "rateLimited") this.slowDown();
    this.release(job);
    return why === "cancelled" ? "cancelled" : SLOWED_DOWN;
  }

  /** The turn goes to the next job waiting. */
  private release(job: JobRecord): void {
    if (this.holder !== job) return;
    const next = this.queue.shift();
    this.holder = next?.job ?? null;
    next?.go();
  }

  /** What comes first: `work`, the job's cancel, or a slow-down. */
  private until(job: JobRecord, work: Promise<unknown>): Promise<Wake> {
    return new Promise((resolve) => {
      if (job.signal.aborted) return resolve("cancelled");
      const finish = (wake: Wake) => {
        job.signal.removeEventListener("abort", onAbort);
        this.waits.delete(onSlowDown);
        resolve(wake);
      };
      const onAbort = () => finish("cancelled");
      const onSlowDown = () => finish("rateLimited");
      job.signal.addEventListener("abort", onAbort);
      this.waits.add(onSlowDown);
      work.then(
        () => finish("go"),
        () => finish("go"),
      );
    });
  }
}
