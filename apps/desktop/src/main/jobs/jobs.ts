import { isJobEnded, type Job, type JobEvent, type JobRequest } from "@turbodl/shared";
import { JobRecord } from "./job-record";
import { jobKindOf } from "./kind";

/** Does the work of one job and ends it through the record. */
export type JobRunner = (job: JobRecord) => Promise<void>;

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** The registry of jobs: starts them, keeps the latest ones and follows their events. */
export class Jobs {
  private readonly records = new Map<string, JobRecord>();
  private readonly run: JobRunner;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly keep: number;

  constructor(o: { run: JobRunner; now?: () => number; newId?: () => string; keep?: number }) {
    this.run = o.run;
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? newId;
    this.keep = o.keep ?? 200;
  }

  create(request: JobRequest): Job {
    const record = new JobRecord(this.newId(), request, jobKindOf(request.url), this.now);
    this.records.set(record.id, record);
    const created = record.view();
    void (async () => {
      await this.run(record);
      record.end({ state: "failed", reason: "error", error: "The job ended without a result." });
    })().catch((err: unknown) => {
      record.end({ state: "failed", reason: "error", error: err instanceof Error ? err.message : String(err) });
    });
    this.trim(record);
    return created;
  }

  /** newest first */
  list(): Job[] {
    return [...this.records.values()].reverse().map((r) => r.view());
  }

  get(id: string): Job | undefined {
    return this.records.get(id)?.view();
  }

  cancel(id: string): Job | undefined {
    const record = this.records.get(id);
    record?.cancel();
    return record?.view();
  }

  subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined {
    return this.records.get(id)?.subscribe(listener);
  }

  /** resolves with the job once it has ended */
  ended(id: string): Promise<Job> | undefined {
    return this.records.get(id)?.ended;
  }

  /** Drops the oldest ended jobs past `keep`; never `created`, which its client is about to ask for (it may have ended at once). */
  private trim(created: JobRecord): void {
    for (const [id, record] of this.records) {
      if (this.records.size <= this.keep) return;
      if (record !== created && isJobEnded(record.view().state)) this.records.delete(id);
    }
  }
}
