import { TelegramError, type BotApi } from "./bot-api";
import type { Keyboard } from "./types";

/** Minimum time between two calls to Telegram. */
export const GAP_MS = 1000;
/** Minimum time between two (non-final) edits of one message. */
export const EDIT_EVERY_MS = 5000;
/** Waits before the retries of a network or server error; after the last one the call is given up. */
const RETRY_DELAYS_MS = [2000, 4000, 8000];
/** Used when Telegram asks to slow down without saying for how long. */
const DEFAULT_RETRY_AFTER_S = 5;

export interface OutboxDeps {
  api: Pick<BotApi, "sendMessage" | "editMessageText">;
  now(): number;
  wait(ms: number): Promise<void>;
  log(text: string): void;
}

interface SendEntry {
  kind: "send";
  chatId: number;
  text: string;
  opts: { keyboard?: Keyboard; replyTo?: number };
  settle: (id: number | null) => void;
}

interface EditEntry {
  kind: "edit";
  key: string;
  chatId: number;
  messageId: number;
  text: string;
  keyboard: Keyboard | null;
  final: boolean;
  settles: (() => void)[];
}

type Entry = SendEntry | EditEntry;

type Outcome<T> = { status: "ok"; value: T } | { status: "notModified" | "notFound" | "dropped" };

/**
 * Every message and edit of the bot goes through here: one call at a time, at least GAP_MS apart, edits of one
 * message coalesced to at most one per EDIT_EVERY_MS (final edits excepted), failures retried or dropped.
 */
export class Outbox {
  private readonly d: OutboxDeps;
  private queue: Entry[] = [];
  /** the waiting edit of each message; a later edit of the message folds into it */
  private readonly pendingEdits = new Map<string, EditEntry>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly lastSent = new Map<string, string>();
  private readonly gone = new Set<string>();
  private current: Entry | null = null;
  private lastCallAt = Number.NEGATIVE_INFINITY;
  private running = false;
  private closed = false;
  private wake: (() => void) | null = null;

  constructor(d: OutboxDeps) {
    this.d = d;
  }

  send(chatId: number, text: string, o: { keyboard?: Keyboard; replyTo?: number } = {}): Promise<number | null> {
    if (this.closed) return Promise.resolve(null);
    return new Promise((settle) => {
      this.queue.push({ kind: "send", chatId, text, opts: o, settle });
      this.kick();
    });
  }

  edit(chatId: number, messageId: number, text: string, keyboard: Keyboard | null, o: { final?: boolean } = {}): Promise<void> {
    const key = messageKey(chatId, messageId);
    if (this.closed || this.gone.has(key)) return Promise.resolve();
    return new Promise((settle) => {
      const waiting = this.pendingEdits.get(key);
      if (waiting) {
        waiting.text = text;
        waiting.keyboard = keyboard;
        waiting.final ||= Boolean(o.final);
        waiting.settles.push(settle);
      } else {
        const entry: EditEntry = { kind: "edit", key, chatId, messageId, text, keyboard, final: Boolean(o.final), settles: [settle] };
        this.pendingEdits.set(key, entry);
        this.queue.push(entry);
      }
      this.kick();
    });
  }

  /** Drops what is queued; later calls resolve at once (a send with null). */
  close(): void {
    this.closed = true;
    const dropped = this.current ? [...this.queue, this.current] : this.queue;
    this.queue = [];
    this.pendingEdits.clear();
    for (const entry of dropped) settleEntry(entry, null);
    this.wake?.();
  }

  private kick(): void {
    if (this.wake) this.wake();
    if (this.running) return;
    this.running = true;
    // a microtask, so edits made in the same tick still coalesce
    queueMicrotask(() => void this.run());
  }

  private async run(): Promise<void> {
    try {
      while (!this.closed && this.queue.length > 0) {
        const gap = this.lastCallAt + GAP_MS - this.d.now();
        if (gap > 0) await this.d.wait(gap);
        if (this.closed) break;
        const entry = this.takeDue();
        if (!entry) {
          await this.idle();
          continue;
        }
        this.current = entry;
        try {
          await this.process(entry);
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Takes the first queued call that may go now; null when only held edits are left. */
  private takeDue(): Entry | null {
    const t = this.d.now();
    const index = this.queue.findIndex((e) => this.dueAt(e) <= t);
    if (index < 0) return null;
    const [entry] = this.queue.splice(index, 1);
    // from here on a newer edit of the same message starts an entry of its own
    if (entry.kind === "edit") this.pendingEdits.delete(entry.key);
    return entry;
  }

  private dueAt(e: Entry): number {
    if (e.kind === "send" || e.final) return 0;
    return (this.lastEditAt.get(e.key) ?? Number.NEGATIVE_INFINITY) + EDIT_EVERY_MS;
  }

  /** Waits for the earliest held edit, or until a new call arrives. */
  private async idle(): Promise<void> {
    const t = this.d.now();
    const until = Math.min(...this.queue.map((e) => this.dueAt(e)));
    const woken = new Promise<void>((resolve) => (this.wake = resolve));
    try {
      await Promise.race([this.d.wait(Math.max(0, until - t)), woken]);
    } finally {
      this.wake = null;
    }
  }

  private async process(entry: Entry): Promise<void> {
    if (entry.kind === "send") {
      const out = await this.callWithRetry(() => this.d.api.sendMessage(entry.chatId, entry.text, entry.opts), "sendMessage");
      if (out.status === "ok") this.lastSent.set(messageKey(entry.chatId, out.value), sentState(entry.text, entry.opts.keyboard ?? null));
      entry.settle(out.status === "ok" ? out.value : null);
      return;
    }
    if (this.gone.has(entry.key) || this.lastSent.get(entry.key) === sentState(entry.text, entry.keyboard)) {
      settleEntry(entry, null);
      return;
    }
    const out = await this.callWithRetry(() => this.d.api.editMessageText(entry.chatId, entry.messageId, entry.text, entry.keyboard), "editMessageText");
    if (out.status === "ok" || out.status === "notModified") {
      this.lastSent.set(entry.key, sentState(entry.text, entry.keyboard));
      this.lastEditAt.set(entry.key, this.d.now());
    } else if (out.status === "notFound") {
      this.gone.add(entry.key);
    }
    settleEntry(entry, null);
  }

  /** Runs one call, retrying what is worth retrying. Never throws. */
  private async callWithRetry<T>(fn: () => Promise<T>, what: string): Promise<Outcome<T>> {
    let retries = 0;
    for (;;) {
      const gap = this.lastCallAt + GAP_MS - this.d.now();
      if (gap > 0) await this.d.wait(gap);
      if (this.closed) return { status: "dropped" };
      try {
        const value = await fn();
        this.lastCallAt = this.d.now();
        return { status: "ok", value };
      } catch (err) {
        this.lastCallAt = this.d.now();
        if (!(err instanceof TelegramError)) {
          this.d.log(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
          return { status: "dropped" };
        }
        switch (err.kind) {
          case "notModified":
          case "notFound":
            return { status: err.kind };
          case "rateLimited":
            await this.d.wait((err.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
            continue;
          case "network":
          case "server":
            if (retries >= RETRY_DELAYS_MS.length) {
              this.d.log(`${what} given up after ${retries} retries: ${err.message}`);
              return { status: "dropped" };
            }
            await this.d.wait(RETRY_DELAYS_MS[retries++]);
            continue;
          default:
            // unauthorized, conflict, tooLarge, badRequest: retrying would not change the answer
            this.d.log(`${what} failed (${err.kind}): ${err.message}`);
            return { status: "dropped" };
        }
      }
    }
  }
}

function messageKey(chatId: number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function sentState(text: string, keyboard: Keyboard | null): string {
  return JSON.stringify([text, keyboard]);
}

function settleEntry(entry: Entry, id: number | null): void {
  if (entry.kind === "send") entry.settle(id);
  else for (const settle of entry.settles) settle();
}
