import { formatBytes, formatSpeed, type InstagramLoginResult, type Job, type JobEvent, type JobProgress } from "@turbodl/shared";

/** Everything the turbodl command prints, as text for people or as JSON lines for scripts. */
export interface Output {
  /** a followed job's event */
  event(e: JobEvent): void;
  /** a job `add` started */
  added(job: Job): void;
  /** one job, for `status` and `cancel` */
  job(job: Job): void;
  /** the jobs, for `list` */
  list(jobs: Job[]): void;
  instagram(i: InstagramLoginResult): void;
  error(message: string): void;
  /** ends an in-place progress line */
  close(): void;
}

export interface OutputOptions {
  json: boolean;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** stderr is a terminal: progress is shown there on one line rewritten in place */
  tty: boolean;
}

/** Text: stdout gets only paths, ids and job details; the rest goes to stderr. JSON: one object per line on stdout. */
export function createOutput(o: OutputOptions): Output {
  return o.json ? jsonOutput(o) : textOutput(o);
}

function jsonOutput(o: OutputOptions): Output {
  const line = (value: unknown) => o.stdout.write(`${JSON.stringify(value)}\n`);
  const job = (j: Job) => line({ type: "job", jobId: j.id, job: j });
  return {
    event: line,
    added: job,
    job,
    list: (jobs) => jobs.forEach(job),
    instagram: (i) => line({ type: "instagram", signedIn: i.signedIn, ...(i.username ? { username: i.username } : {}) }),
    error: (message) => {
      line({ type: "error", message });
      o.stderr.write(`turbodl: ${message}\n`);
    },
    close: () => undefined,
  };
}

/** "3/12  1.5 MB / 10 MB  2.0 MB/s"; empty when nothing is known yet. */
function progressText(p: JobProgress): string {
  const parts: string[] = [];
  if (p.total !== undefined) parts.push(`${p.done}/${p.total}`);
  else if (p.done > 0) parts.push(String(p.done));
  if (p.bytes !== undefined) parts.push(p.totalBytes ? `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}` : formatBytes(p.bytes));
  if (p.speed) parts.push(formatSpeed(p.speed));
  return parts.join("  ");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "job1: failed (notFound), 0 files: That post doesn't exist." */
function endLine(job: Job): string {
  const reason = job.reason ? ` (${job.reason})` : "";
  const error = job.error ? `: ${job.error}` : "";
  return `${job.id}: ${job.state}${reason}, ${plural(job.files.length, "file")}${error}`;
}

/** `key: value` lines describing a job. */
function describe(job: Job): string[] {
  const lines = [`id: ${job.id}`, `url: ${job.url}`, `kind: ${job.kind}`, `state: ${job.state}`];
  if (job.reason) lines.push(`reason: ${job.reason}`);
  if (job.error) lines.push(`error: ${job.error}`);
  if (job.limited) lines.push("limited: true");
  const progress = progressText(job.progress);
  if (progress) lines.push(`progress: ${progress}`);
  if (job.failedItems > 0) lines.push(`failedItems: ${job.failedItems}`);
  for (const w of job.warnings) lines.push(`warning: ${w}`);
  for (const f of job.files) lines.push(`file: ${f}`);
  lines.push(`created: ${new Date(job.createdAt).toISOString()}`);
  if (job.endedAt !== undefined) lines.push(`ended: ${new Date(job.endedAt).toISOString()}`);
  return lines;
}

function textOutput(o: OutputOptions): Output {
  /** characters of the progress line now on screen */
  let shown = 0;
  let blocks = 0;
  const printed = new Map<string, Set<string>>();

  const clear = () => {
    if (shown === 0) return;
    o.stderr.write(`\r${" ".repeat(shown)}\r`);
    shown = 0;
  };
  const out = (text: string) => {
    clear();
    o.stdout.write(`${text}\n`);
  };
  const err = (text: string) => {
    clear();
    o.stderr.write(`${text}\n`);
  };
  /** each path once per job, whether it came in a `file` event or in a job's list after a re-subscription */
  const file = (jobId: string, p: string) => {
    let seen = printed.get(jobId);
    if (!seen) printed.set(jobId, (seen = new Set()));
    if (seen.has(p)) return;
    seen.add(p);
    out(p);
  };
  const progress = (jobId: string, p: JobProgress) => {
    if (!o.tty) return;
    const width = Math.max(20, ((o.stderr as { columns?: number }).columns ?? 80) - 1);
    const text = `${jobId}  ${progressText(p)}`.trimEnd().slice(0, width);
    o.stderr.write(`\r${text}${" ".repeat(Math.max(0, shown - text.length))}`);
    shown = Math.max(shown, text.length);
  };

  return {
    event(e) {
      switch (e.type) {
        case "job":
          for (const f of e.job.files) file(e.jobId, f);
          break;
        case "file":
          file(e.jobId, e.path);
          break;
        case "progress":
          progress(e.jobId, e.progress);
          break;
        case "warning":
          err(`${e.jobId}: warning: ${e.message}`);
          break;
        case "end":
          for (const f of e.job.files) file(e.jobId, f);
          err(endLine(e.job));
          break;
      }
    },
    added: (job) => out(job.id),
    job(job) {
      if (blocks++ > 0) out("");
      for (const line of describe(job)) out(line);
    },
    list(jobs) {
      const width = (key: "id" | "state" | "kind") => Math.max(0, ...jobs.map((j) => j[key].length));
      const [id, state, kind] = [width("id"), width("state"), width("kind")];
      for (const j of jobs) out(`${j.id.padEnd(id)}  ${j.state.padEnd(state)}  ${j.kind.padEnd(kind)}  ${j.url}`);
    },
    instagram(i) {
      out(`signedIn: ${i.signedIn}`);
      if (i.username) out(`username: ${i.username}`);
    },
    error: (message) => err(`turbodl: ${message}`),
    close: clear,
  };
}
