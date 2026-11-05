import type { ApiInfo, Job, JobEvent, JobRequest, ListWait, ProfileListView, ProfileSaveOptions, Result, TelegramPairing, TelegramState } from "@turbodl/shared";
import type { ParsedListRequest } from "../api-routes";
import type { JsonStore } from "../store";
import { TelegramError, scrub, type BotApi } from "./bot-api";
import { JobFollower } from "./bot-jobs";
import { OwnerHandler } from "./bot-owner";
import { ownerUpdate, pairingStart } from "./gate";
import { Outbox } from "./outbox";
import { EMPTY_STATE, isBotStateFile, type BotStateFile } from "./state";
import { HELP, PAIRED } from "./texts";
import type { Keyboard, Update } from "./types";

/** What the bot may ask of the app: ApiHandlers' job and list calls, plus the settings' defaults. */
export interface BotApp {
  info(): Promise<ApiInfo>;
  createJob(request: JobRequest): Job;
  job(id: string): Job | undefined;
  cancelJob(id: string): Job | undefined;
  subscribe(id: string, listener: (event: JobEvent) => void): (() => void) | undefined;
  list(): ProfileListView | null;
  startList(request: ParsedListRequest): Promise<Result>;
  stopList(): Promise<void>;
  continueList(): Promise<Result>;
  closeList(): Promise<Result>;
  defaults(): { save: ProfileSaveOptions; wait: ListWait };
}

export interface BotOptions {
  api: BotApi;
  app: BotApp;
  chatId(): number | null;
  pairing(): TelegramPairing | null;
  onPaired(chatId: number): void;
  onStatus(state: TelegramState, info: { bot?: string; error?: string }): void;
  store: JsonStore<BotStateFile>; // <userData>/telegram-state.json
  /** true only for the bot's first start since the app started: open jobs not in the app are then a restart's */
  afterAppStart: boolean;
  now(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
  log(text: string): void;
  /** the bot token, so that any error text can be scrubbed before it is logged or reported */
  token?: string;
}

const POLL_TIMEOUT_S = 50;
const BACKOFF_START_MS = 5000;
const BACKOFF_MAX_MS = 60_000;
const CONFLICT_RETRY_MS = 30_000;
const DEFAULT_RETRY_AFTER_S = 5;

const COMMANDS = [
  { command: "status", description: "What is running" },
  { command: "stop", description: "Stop a download or the list" },
  { command: "list", description: "Show the profile list" },
  { command: "help", description: "What the bot understands" },
];

export class TelegramBot {
  private readonly o: BotOptions;
  private readonly ctl = new AbortController();
  private readonly outbox: Outbox;
  private readonly jobs: JobFollower;
  private readonly owner: OwnerHandler;
  private readonly timers = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  private state: BotStateFile;
  private running: Promise<void> | null = null;
  private stopped = false;
  private ready = false;
  private current: TelegramState = "off";
  private botName: string | undefined;
  private backoffMs = BACKOFF_START_MS;

  constructor(o: BotOptions) {
    this.o = o;
    this.state = this.loadState();
    this.outbox = new Outbox({ api: o.api, now: () => o.now(), wait: (ms) => this.pause(ms), log: (text) => this.log(text) });
    this.jobs = new JobFollower({
      app: o.app,
      send: (chatId, text, opts) => this.send(chatId, text, opts),
      edit: (chatId, messageId, text, keyboard, opts) => this.edit(chatId, messageId, text, keyboard, opts),
      opened: (job) => {
        this.state.jobs.push(job);
        this.saveState();
      },
      closed: (jobId) => {
        this.state.jobs = this.state.jobs.filter((j) => j.jobId !== jobId);
        this.saveState();
      },
      stopped: () => this.stopped,
      log: (text) => this.log(text),
    });
    this.owner = new OwnerHandler({
      app: o.app,
      api: o.api,
      jobs: this.jobs,
      signal: this.ctl.signal,
      now: () => o.now(),
      send: (chatId, text, opts) => this.send(chatId, text, opts),
      edit: (chatId, messageId, text, keyboard, opts) => this.edit(chatId, messageId, text, keyboard, opts),
      listOpened: (chatId, messageId, active) => {
        this.state.list = { chatId, messageId, active };
        this.saveState();
      },
      stopped: () => this.stopped,
      text: (err) => this.text(err),
      log: (text) => this.log(text),
    });
  }

  /** Runs in the background; never throws. */
  start(): void {
    if (this.running || this.stopped) return;
    this.running = this.run().catch((err) => this.log(`bot loop ended: ${this.text(err)}`));
  }

  async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.jobs.stop();
      this.outbox.close();
      this.ctl.abort();
      for (const t of [...this.timers]) {
        clearTimeout(t.timer);
        t.resolve();
      }
      this.timers.clear();
    }
    await this.running;
    try {
      this.o.store.flush();
    } catch (err) {
      this.log(`could not save the bot state: ${this.text(err)}`);
    }
  }

  /** Task 8: the profile list changed. */
  listChanged(_list: ProfileListView | null): void {
    // filled in by the list tracking
  }

  /** Task 8: something to tell the chat about the list. */
  listNotice(_text: string): void {
    // filled in by the list tracking
  }

  private loadState(): BotStateFile {
    try {
      const loaded = this.o.store.load(() => structuredClone(EMPTY_STATE));
      if (isBotStateFile(loaded)) return loaded;
    } catch {
      // an unreadable file starts from scratch
    }
    return structuredClone(EMPTY_STATE);
  }

  private saveState(): void {
    try {
      this.o.store.save(this.state);
    } catch (err) {
      this.log(`could not save the bot state: ${this.text(err)}`);
    }
  }

  private text(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.o.token ? scrub(raw, this.o.token) : raw;
  }

  private log(text: string): void {
    try {
      this.o.log(this.o.token ? scrub(text, this.o.token) : text);
    } catch {
      // a broken logger must not stop the bot
    }
  }

  private report(state: TelegramState, info: { bot?: string; error?: string } = {}): void {
    if (this.stopped || (state === this.current && state !== "ok")) return;
    this.current = state;
    try {
      this.o.onStatus(state, info);
    } catch (err) {
      this.log(`status callback failed: ${this.text(err)}`);
    }
  }

  /** A timer wait for the outbox: never rejects, and ends at once on stop. */
  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const entry = {
        timer: setTimeout(() => {
          this.timers.delete(entry);
          resolve();
        }, ms),
        resolve,
      };
      entry.timer.unref?.();
      this.timers.add(entry);
    });
  }

  private async sleep(ms: number): Promise<void> {
    try {
      await this.o.wait(ms, this.ctl.signal);
    } catch {
      // an aborted wait ends the wait, nothing more
    }
  }

  private async run(): Promise<void> {
    this.report("connecting");
    while (!this.stopped) {
      try {
        if (!this.ready) await this.setup();
        const updates = await this.o.api.getUpdates(this.state.offset, POLL_TIMEOUT_S, this.ctl.signal);
        this.succeeded();
        for (const update of updates) {
          if (this.stopped) break;
          await this.handle(update);
        }
      } catch (err) {
        if (this.stopped) break;
        if (!(await this.recover(err))) break;
      }
    }
  }

  private async setup(): Promise<void> {
    const me = await this.o.api.getMe(this.ctl.signal);
    if (this.stopped) return;
    this.botName = me.username;
    this.succeeded();
    if (this.state.botId !== me.id) {
      this.state = { ...structuredClone(EMPTY_STATE), botId: me.id };
      this.saveState();
    }
    // Task 8: recovery of open jobs and the list goes here
    try {
      await this.o.api.setMyCommands(COMMANDS, this.ctl.signal);
    } catch (err) {
      // the commands menu is a nicety: without it the bot still works
      if (this.stopped) return;
      this.log(`could not register the commands: ${this.text(err)}`);
    }
    this.ready = true;
  }

  /** A call went through: the connection is fine again. */
  private succeeded(): void {
    this.backoffMs = BACKOFF_START_MS;
    if (this.current !== "ok") this.report("ok", { bot: this.botName });
  }

  /** Reports the error and waits as long as it needs; false when the loop must end. */
  private async recover(err: unknown): Promise<boolean> {
    const error = this.text(err);
    const kind = err instanceof TelegramError ? err.kind : "network";
    switch (kind) {
      case "unauthorized":
      case "notFound": // Telegram answers 404 for a malformed token
        this.report("tokenRejected", { error });
        return false;
      case "conflict":
        this.report("conflict", { error });
        await this.sleep(CONFLICT_RETRY_MS);
        return true;
      case "rateLimited":
        await this.sleep(((err as TelegramError).retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
        return true;
      default: {
        this.report("offline", { error });
        const ms = this.backoffMs;
        this.backoffMs = Math.min(ms * 2, BACKOFF_MAX_MS);
        await this.sleep(ms);
        return true;
      }
    }
  }

  /** Writes the state to disk now (ignored updates keep the debounced save). */
  private persistNow(): void {
    try {
      this.o.store.flush();
    } catch (err) {
      this.log(`could not save the bot state: ${this.text(err)}`);
    }
  }

  /** One update: the offset moves first, and is on disk before an update that gets handled, so a crash does not replay it. */
  private async handle(update: Update): Promise<void> {
    if (this.stopped) return;
    this.state.offset = update.update_id + 1;
    this.saveState();
    try {
      const start = pairingStart(update);
      const pairing = this.o.pairing();
      if (start && pairing && start.code === pairing.code && this.o.now() < pairing.expiresAt) {
        this.persistNow();
        this.o.onPaired(start.chatId);
        void this.outbox.send(start.chatId, `${PAIRED}\n\n${HELP}`);
        return;
      }
      const owner = ownerUpdate(update, this.o.chatId());
      if (owner) {
        this.persistNow();
        await this.owner.handle(owner);
      }
    } catch (err) {
      this.log(`update ${update.update_id} failed: ${this.text(err)}`);
    }
  }

  /** Sends to the bound chat only; anything for another chat is dropped (null). */
  private send(chatId: number, text: string, o: { keyboard?: Keyboard; replyTo?: number } = {}): Promise<number | null> {
    return chatId === this.o.chatId() ? this.outbox.send(chatId, text, o) : Promise.resolve(null);
  }

  private edit(chatId: number, messageId: number, text: string, keyboard: Keyboard | null, o: { final?: boolean } = {}): Promise<void> {
    return chatId === this.o.chatId() ? this.outbox.edit(chatId, messageId, text, keyboard, o) : Promise.resolve();
  }
}
