import { isJobEnded, type Job, type JobEvent, type JobKind } from "@turbodl/shared";
import type { OpenJob } from "./state";
import { jobFinalText, jobKeyboard, jobSummary, jobText } from "./texts";
import type { Keyboard } from "./types";

export interface JobFollowerDeps {
  app: {
    job(id: string): Job | undefined;
    subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined;
  };
  send(chatId: number, text: string, o?: { keyboard?: Keyboard; replyTo?: number }): Promise<number | null>;
  edit(chatId: number, messageId: number, text: string, keyboard: Keyboard | null, o?: { final?: boolean }): Promise<void>;
  /** the job has its message: it goes into the state file */
  opened(job: OpenJob): void;
  /** the job's summary went out: it leaves the state file */
  closed(jobId: string): void;
  stopped(): boolean;
  log(text: string): void;
}

interface Followed {
  chatId: number;
  label: string;
  kind: JobKind;
  /** the latest the bot heard of the job */
  job: Job;
  /** files that were already there */
  existing: number;
  /** its progress message: undefined while it is being sent, null when it couldn't be */
  messageId: number | null | undefined;
  ended: boolean;
  unsubscribe: (() => void) | undefined;
}

/** The jobs the bot started: each has one message that shows its progress, then its final words and a summary reply. */
export class JobFollower {
  private readonly followed = new Map<string, Followed>();

  constructor(private readonly d: JobFollowerDeps) {}

  /** Follows a job the bot just started; `messageId` is a message to take over (a prompt's), else one is sent. */
  follow(chatId: number, created: Job, label: string, messageId?: number): void {
    const f: Followed = { chatId, label, kind: created.kind, job: created, existing: 0, messageId: undefined, ended: false, unsubscribe: undefined };
    const id = created.id;
    this.followed.set(id, f);
    // events aren't replayed: subscribe, then read the job once, so nothing in between is missed
    f.unsubscribe = this.d.app.subscribe(id, (event) => this.hear(f, event));
    f.job = this.d.app.job(id) ?? f.job;
    if (isJobEnded(f.job.state)) this.end(f);
    else if (!f.unsubscribe) {
      this.followed.delete(id);
      this.d.log(`job ${id} is not in the app; the bot can't follow it`);
      return;
    }
    if (messageId !== undefined) {
      this.attach(f, messageId);
      return;
    }
    const keyboard = f.ended ? undefined : jobKeyboard(id);
    this.quietly(this.d.send(chatId, this.text(f), keyboard ? { keyboard } : {}).then((sentId) => this.attach(f, sentId)));
  }

  /** The bot's jobs that haven't ended, newest first. */
  running(): { label: string; job: Job }[] {
    return [...this.followed.values()]
      .filter((f) => !f.ended)
      .reverse()
      .map((f) => ({ label: f.label, job: f.job }));
  }

  /** The bot stops: no more listening (the state file keeps the open messages for the next start). */
  stop(): void {
    for (const f of this.followed.values()) f.unsubscribe?.();
    this.followed.clear();
  }

  /** Fire and forget, but a failure is logged rather than left unhandled. */
  private quietly(work: Promise<unknown>): void {
    work.catch((err) => this.d.log(`following a job failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private text(f: Followed): string {
    return f.ended ? jobFinalText(f.job, f.label, f.existing) : jobText(f.job, f.label);
  }

  private hear(f: Followed, event: JobEvent): void {
    if (f.ended || this.d.stopped()) return;
    switch (event.type) {
      case "job":
        f.job = event.job;
        break;
      case "state":
        // an ended state comes with its `end`, which finishes the message
        if (isJobEnded(event.state)) return;
        f.job = { ...f.job, state: event.state };
        break;
      case "progress":
        f.job = { ...f.job, progress: event.progress };
        break;
      case "file":
        if (event.existing) f.existing += 1;
        return;
      case "end":
        f.job = event.job;
        this.end(f);
        return;
      default:
        return;
    }
    this.show(f, false);
  }

  /** Its message is there (or couldn't be sent). */
  private attach(f: Followed, messageId: number | null): void {
    if (this.d.stopped()) return;
    f.messageId = messageId;
    if (messageId !== null) this.d.opened({ jobId: f.job.id, chatId: f.chatId, messageId, kind: f.kind, label: f.label });
    if (f.ended) this.quietly(this.conclude(f));
    // a prompt turning into the job's message changes at once
    else this.show(f, true);
  }

  private show(f: Followed, now: boolean): void {
    if (typeof f.messageId !== "number") return;
    void this.d.edit(f.chatId, f.messageId, jobText(f.job, f.label), jobKeyboard(f.job.id), now ? { final: true } : {});
  }

  private end(f: Followed): void {
    if (f.ended) return;
    f.ended = true;
    f.unsubscribe?.();
    f.unsubscribe = undefined;
    if (f.messageId !== undefined) this.quietly(this.conclude(f));
  }

  /** The final words on its message, then a summary as a new message (edits don't make the phone notify). */
  private async conclude(f: Followed): Promise<void> {
    this.followed.delete(f.job.id);
    const { chatId, messageId, job, label, existing } = f;
    if (typeof messageId === "number") void this.d.edit(chatId, messageId, jobFinalText(job, label, existing), null, { final: true });
    const sent = await this.d.send(chatId, jobSummary(job, label, existing), typeof messageId === "number" ? { replyTo: messageId } : {});
    // stopped before the summary went: the state file keeps the job, so the next start can finish it
    if (sent === null && this.d.stopped()) return;
    if (typeof messageId === "number") this.d.closed(job.id);
  }
}
