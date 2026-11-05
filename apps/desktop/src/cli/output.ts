import {
  formatBytes,
  formatSpeed,
  type InstagramLoginResult,
  type InstagramPostInfo,
  type Job,
  type JobEvent,
  type JobProgress,
  type ProfileListRow,
  type ProfileListView,
  type TelegramStatus,
} from "@turbodl/shared";

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
  /** a followed profile list's row, once it ended (done, skipped or failed) */
  listRow(row: ProfileListRow): void;
  /** the followed profile list as it stopped going on */
  listEnd(list: ProfileListView): void;
  instagram(i: InstagramLoginResult): void;
  /** the Telegram bot's status */
  telegram(status: TelegramStatus): void;
  /** the code a pairing waits for, and the bot to send it to */
  pairing(p: { bot?: string; code: string; expiresAt: number }): void;
  /** a result worth saying that is not the command's output */
  notice(message: string): void;
  /** something the command goes on despite */
  warning(message: string): void;
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

/** a Telegram state in words */
const TELEGRAM_STATES: Record<TelegramStatus["state"], string> = {
  off: "off",
  noToken: "no token",
  connecting: "connecting",
  ok: "connected",
  tokenRejected: "token rejected",
  tokenUnreadable: "token unreadable",
  conflict: "another program is reading this bot's messages",
  offline: "can't reach Telegram",
};

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
    listRow: line,
    listEnd: (list) => line({ list }),
    instagram: (i) => line({ type: "instagram", signedIn: i.signedIn, ...(i.username ? { username: i.username } : {}) }),
    telegram: (status) => line(status),
    pairing: (p) => line({ type: "pairing", ...p }),
    notice: (message) => line({ type: "notice", message }),
    warning: (message) => {
      line({ type: "warning", message });
      o.stderr.write(`turbodl: warning: ${message}\n`);
    },
    error: (message) => {
      line({ type: "error", message });
      o.stderr.write(`turbodl: ${message}\n`);
    },
    close: () => undefined,
  };
}

/** "3/12  1.5 MB / 10 MB  2.0 MB/s", then the job's note if any; empty when nothing is known yet. */
function progressText(p: JobProgress): string {
  const parts: string[] = [];
  if (p.total !== undefined) parts.push(`${p.done}/${p.total}`);
  else if (p.done > 0) parts.push(String(p.done));
  if (p.bytes !== undefined) parts.push(p.totalBytes ? `${formatBytes(p.bytes)} / ${formatBytes(p.totalBytes)}` : formatBytes(p.bytes));
  if (p.speed) parts.push(formatSpeed(p.speed));
  if (p.note) parts.push(p.note);
  return parts.join("  ");
}

/** "CODE	2026-03-01T10:00:00.000Z	2 items	pinned" */
function postLine(post: InstagramPostInfo): string {
  const cols = [post.code, post.takenAt ?? "-", plural(post.items.length, "item")];
  if (post.pinned) cols.push("pinned");
  if (post.signInOnly) cols.push("sign-in only");
  if (post.known) cols.push("known");
  return cols.join("	");
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "job1: failed (notFound), 0 files: That post doesn't exist." */
function endLine(job: Job): string {
  const reason = job.reason ? ` (${job.reason})` : "";
  const error = job.error ? `: ${job.error}` : "";
  return `${job.id}: ${job.state}${reason}, ${plural(job.files.length, "file")}${error}`;
}

/** "nasa: done, 12 files, 3 new", "someone: skipped: This account is private." */
function rowLine(row: ProfileListRow): string {
  const note = row.note ? `: ${row.note}` : "";
  if (row.state !== "done") return `${row.username}: ${row.state}${note}`;
  const files = row.files !== undefined ? `${plural(row.files, "file")}, ` : "";
  return `${row.username}: done, ${files}${row.fetched ?? 0} new${note}`;
}

/** How the list stopped going on, in the app's words. */
function listEndLine(list: ProfileListView): string {
  const rows = (state: ProfileListRow["state"]) => list.rows.filter((r) => r.state === state).length;
  switch (list.state) {
    case "finished": {
      const failed = rows("failed");
      return `Finished: ${rows("done")} backed up, ${rows("skipped")} skipped${failed ? `, ${failed} failed` : ""}`;
    }
    case "rateLimited":
      return list.message ?? "Instagram asked TurboDL to slow down 3 times in a row. Continue later.";
    case "signedOut":
      return list.message ?? "Instagram signed TurboDL out. Sign in, then continue.";
    case "stopped":
      return "Stopped. Continue the list in TurboDL.";
    default:
      return list.message ?? list.state;
  }
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
        case "post":
          out(postLine(e.post));
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
    listRow: (row) => out(rowLine(row)),
    listEnd: (list) => err(listEndLine(list)),
    instagram(i) {
      out(`signedIn: ${i.signedIn}`);
      if (i.username) out(`username: ${i.username}`);
    },
    telegram(status) {
      if (status.bot) out(`Bot: @${status.bot}`);
      out(`State: ${TELEGRAM_STATES[status.state]}`);
      if (status.error) out(`Error: ${status.error}`);
      out(`Chat: ${status.chatId ?? "not bound"}`);
      out(`On: ${status.enabled ? "yes" : "no"}`);
    },
    pairing(p) {
      out(p.bot ? `Send this to @${p.bot} in Telegram: /start ${p.code}` : `Send this to your bot in Telegram: /start ${p.code}`);
      if (p.bot) out(`https://t.me/${p.bot}?start=${p.code}`);
    },
    notice: err,
    warning: (message) => err(`turbodl: warning: ${message}`),
    error: (message) => err(`turbodl: ${message}`),
    close: clear,
  };
}
