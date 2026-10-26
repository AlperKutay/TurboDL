import { isJobEnded, type Job, type JobEvent, type JobEventBody, type JobKind, type JobProgress, type JobReason, type JobRequest } from "@turbodl/shared";

/** How a job finished. */
export type JobOutcome =
  | { state: "done"; limited?: boolean }
  | { state: "failed"; reason: JobReason; error: string }
  | { state: "cancelled"; reason?: "stopped"; error?: string };

const PROGRESS_INTERVAL_MS = 250;

/** One job's state, its event stream and its cancel signal. */
export class JobRecord {
  readonly request: JobRequest;
  /** aborted when a client cancels */
  readonly signal: AbortSignal;
  readonly ended: Promise<Job>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private readonly job: Job;
  private resolveEnded!: (job: Job) => void;
  private lastProgressAt: number | undefined;
  private cancelled = false;

  constructor(
    readonly id: string,
    request: JobRequest,
    kind: JobKind,
    private readonly now: () => number,
  ) {
    this.request = request;
    this.signal = this.controller.signal;
    this.ended = new Promise((resolve) => (this.resolveEnded = resolve));
    this.job = { id, url: request.url, kind, state: "queued", warnings: [], files: [], failedItems: 0, progress: { done: 0 }, createdAt: now() };
  }

  get cancelledByClient(): boolean {
    return this.cancelled;
  }

  view(): Job {
    return { ...this.job, warnings: [...this.job.warnings], files: [...this.job.files], progress: { ...this.job.progress } };
  }

  setKind(kind: JobKind): void {
    if (this.isEnded() || kind === this.job.kind) return;
    this.job.kind = kind;
    this.emit({ type: "job", job: this.view() });
  }

  start(): void {
    if (this.job.state !== "queued") return;
    this.job.state = "running";
    this.emit({ type: "state", state: "running" });
  }

  progress(p: JobProgress): void {
    if (this.isEnded()) return;
    this.job.progress = { ...p };
    const at = this.now();
    if (this.lastProgressAt !== undefined && at - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = at;
    this.emit({ type: "progress", progress: { ...p } });
  }

  file(path: string, existing?: boolean): void {
    if (this.isEnded()) return;
    this.job.files.push(path);
    this.emit(existing === undefined ? { type: "file", path } : { type: "file", path, existing });
  }

  warn(message: string): void {
    if (this.isEnded()) return;
    this.job.warnings.push(message);
    this.emit({ type: "warning", message });
  }

  failItem(): void {
    if (this.isEnded()) return;
    this.job.failedItems += 1;
  }

  /** once; later calls do nothing. limited → reason "signInRequired" */
  end(outcome: JobOutcome): void {
    if (this.isEnded()) return;
    this.job.state = outcome.state;
    if (outcome.state === "done") {
      if (outcome.limited) {
        this.job.limited = true;
        this.job.reason = "signInRequired";
      }
    } else if (outcome.state === "failed") {
      this.job.reason = outcome.reason;
      this.job.error = outcome.error;
    } else {
      if (outcome.reason) this.job.reason = outcome.reason;
      if (outcome.error) this.job.error = outcome.error;
    }
    this.job.endedAt = this.now();
    this.emit({ type: "state", state: outcome.state });
    const final = this.view();
    this.emit({ type: "end", job: final });
    this.resolveEnded(final);
  }

  /** a client's cancel: aborts `signal`; a job still queued ends cancelled at once */
  cancel(): void {
    if (this.isEnded() || this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    if (this.job.state === "queued") this.end({ state: "cancelled" });
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private isEnded(): boolean {
    return isJobEnded(this.job.state);
  }

  private emit(body: JobEventBody): void {
    const event = { ...body, jobId: this.id } as JobEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // a broken follower must not stop the job
      }
    }
  }
}
