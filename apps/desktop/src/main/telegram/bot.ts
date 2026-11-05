import { effectiveSaveOptions, parseProfileList, profileUrl, saveJobOptions } from "@turbodl/shared";
import type { ApiInfo, Job, JobEvent, JobRequest, ListWait, ProfileListView, ProfileSaveOptions, Result, TelegramPairing, TelegramState } from "@turbodl/shared";
import type { ParsedListRequest } from "../api-routes";
import { UNFINISHED, listNames } from "../instagram/profile-lists";
import type { JsonStore } from "../store";
import { TelegramError, scrub, type BotApi } from "./bot-api";
import { JobFollower } from "./bot-jobs";
import { ownerUpdate, pairingStart, type OwnerUpdate } from "./gate";
import { readIntent, type Command, type Intent } from "./intent";
import { Outbox } from "./outbox";
import { Prompts, promptKeyboard, promptText, type ListPrompt, type ProfilePrompt } from "./prompts";
import { EMPTY_STATE, isBotStateFile, type BotStateFile } from "./state";
import {
  CANCELLED,
  EXPIRED,
  FILE_NOT_RECEIVED,
  HELP,
  LIST_TOO_LARGE,
  NOTHING_RUNNING,
  NO_LIST,
  PAIRED,
  SAVED_REFUSED,
  SEND_SOMETHING,
  SHOW_LIST_KEYBOARD,
  STOP_WHAT,
  clip,
  jobLabel,
  listKeyboard,
  listText,
  notStartedText,
  statusText,
  stopKeyboard,
} from "./texts";
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
/** The largest .txt list the bot reads, as the app's own list requests. */
const LIST_FILE_MAX = 1024 * 1024;
/** Telegram shows at most 200 characters of a button's answer. */
const TOAST_MAX = 200;

type Press = Extract<OwnerUpdate, { type: "press" }>;

/** The list goes on by itself: running, waiting for its next profile, or slowed down. */
function isActive(list: ProfileListView | null): boolean {
  return list !== null && (list.state === "running" || list.state === "waiting" || list.state === "slowedDown");
}

/** A refused Result's words, for the button's answer. */
function failure(result: Result): string | undefined {
  return result.ok ? undefined : result.error;
}

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
  private readonly prompts = new Prompts({ now: () => this.o.now() });
  private readonly jobs: JobFollower;
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
        await this.handleOwner(owner);
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

  /** Runs work without holding up the poll loop or stop() (a download from Telegram, a message's id); failures are logged. */
  private detach(work: Promise<unknown>, what: string): void {
    work.catch((err) => this.log(`${what} failed: ${this.text(err)}`));
  }

  /** The one place an update from the bound chat is handled. */
  private async handleOwner(update: OwnerUpdate): Promise<void> {
    if (update.type === "press") return this.onPress(update);
    const chatId = update.message.chat.id;
    const intent = readIntent(update.message);
    switch (intent.type) {
      case "command":
        return this.command(chatId, intent.name);
      case "profile":
        return this.openProfile(chatId, intent.name);
      case "names": {
        const names = listNames(intent.names);
        if ("error" in names) void this.send(chatId, names.error);
        else await this.openList(chatId, "Telegram list", names.names, []);
        return;
      }
      case "links":
        return this.startLinks(chatId, intent.urls, intent.saved);
      case "document":
        return this.detach(this.readList(chatId, intent), `reading ${intent.fileName}`);
      case "otherFile":
        void this.send(chatId, SEND_SOMETHING);
        return;
      case "unknown":
        void this.send(chatId, HELP);
        return;
    }
  }

  private async command(chatId: number, name: Command): Promise<void> {
    switch (name) {
      case "start":
      case "help":
        void this.send(chatId, HELP);
        return;
      case "status": {
        const info = await this.o.app.info();
        if (this.stopped) return;
        void this.send(chatId, statusText({ version: info.version, instagram: info.instagram, jobs: this.jobs.running(), list: this.o.app.list() }));
        return;
      }
      case "stop": {
        const keyboard = stopKeyboard(this.jobs.running(), isActive(this.o.app.list()));
        void this.send(chatId, keyboard ? STOP_WHAT : NOTHING_RUNNING, keyboard ? { keyboard } : {});
        return;
      }
      case "list":
        if (!this.showList(chatId)) void this.send(chatId, NO_LIST);
        return;
    }
  }

  private async openProfile(chatId: number, name: string): Promise<void> {
    const { signedIn, username } = (await this.o.app.info()).instagram;
    if (this.stopped) return;
    const prompt = this.prompts.openProfile(name, this.o.app.defaults().save, signedIn, username);
    void this.send(chatId, promptText(prompt), { keyboard: promptKeyboard(prompt) });
  }

  private async openList(chatId: number, listName: string, usernames: string[], skipped: string[]): Promise<void> {
    const { signedIn, username } = (await this.o.app.info()).instagram;
    if (this.stopped) return;
    const { save, wait } = this.o.app.defaults();
    const prompt = this.prompts.openList(listName, usernames, skipped, save, wait, signedIn, username);
    void this.send(chatId, promptText(prompt), { keyboard: promptKeyboard(prompt) });
  }

  /** A .txt of profiles, read as the app reads its own lists. */
  private async readList(chatId: number, doc: Extract<Intent, { type: "document" }>): Promise<void> {
    if (doc.size !== undefined && doc.size > LIST_FILE_MAX) {
      void this.send(chatId, LIST_TOO_LARGE);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await this.o.api.downloadDocument(doc.fileId, LIST_FILE_MAX);
    } catch (err) {
      if (this.stopped) return;
      const tooLarge = err instanceof TelegramError && err.kind === "tooLarge";
      if (!tooLarge) this.log(`could not get ${doc.fileName}: ${this.text(err)}`);
      void this.send(chatId, tooLarge ? LIST_TOO_LARGE : FILE_NOT_RECEIVED);
      return;
    }
    if (this.stopped) return;
    const parsed = parseProfileList(bytes.toString("utf8").replace(/^\uFEFF/, ""));
    // no names, or more than a list holds: the app's own words
    const names = listNames(parsed.usernames);
    if ("error" in names) {
      void this.send(chatId, names.error);
      return;
    }
    const skipped = parsed.invalid.map((line) => line.text);
    await this.openList(chatId, doc.fileName.replace(/\.txt$/i, ""), names.names, skipped);
  }

  private startLinks(chatId: number, urls: string[], saved: number): void {
    if (saved > 0) void this.send(chatId, SAVED_REFUSED);
    for (const url of urls) {
      let job: Job;
      try {
        job = this.o.app.createJob({ url });
      } catch (err) {
        void this.send(chatId, notStartedText(url, this.text(err)));
        continue;
      }
      this.jobs.follow(chatId, job, jobLabel(job));
    }
  }

  /** Sends the list message anew; it becomes the one the bot follows. False when there is no list. */
  private showList(chatId: number): boolean {
    const list = this.o.app.list();
    if (!list) return false;
    const keyboard = listKeyboard(list);
    const sent = this.send(chatId, listText(list, this.o.now()), keyboard ? { keyboard } : {}).then((messageId) => {
      if (messageId === null || this.stopped) return;
      this.state.list = { chatId, messageId, active: isActive(this.o.app.list()) };
      this.saveState();
    });
    this.detach(sent, "showing the list");
    return true;
  }

  /** Every press is answered, so the phone stops waiting; with a toast only when it is refused or fails. */
  private async onPress(press: Press): Promise<void> {
    let toast: string | undefined;
    try {
      toast = await this.pressed(press);
    } catch (err) {
      toast = this.text(err);
      this.log(`button ${press.data} failed: ${toast}`);
    }
    if (this.stopped) return;
    await this.o.api.answerCallbackQuery(press.id, toast === undefined ? undefined : clip(toast, TOAST_MAX), this.ctl.signal).catch((err) => {
      if (!this.stopped) this.log(`could not answer a button: ${this.text(err)}`);
    });
  }

  /** What a button does; the toast when it is refused or fails. */
  private async pressed({ chatId, messageId, data }: Press): Promise<string | undefined> {
    if (data.startsWith("p:")) return this.pressPrompt(chatId, messageId, data);
    if (data.startsWith("s:")) {
      this.o.app.cancelJob(data.slice(2));
      return undefined;
    }
    switch (data) {
      case "sa":
        for (const { job } of this.jobs.running()) this.o.app.cancelJob(job.id);
        if (isActive(this.o.app.list())) this.detach(this.o.app.stopList(), "stopping the list");
        return undefined;
      case "sl":
        // it resolves once the list has stopped, which may take a while
        this.detach(this.o.app.stopList(), "stopping the list");
        return undefined;
      case "lc":
        return failure(await this.o.app.continueList());
      case "lx":
        return failure(await this.o.app.closeList());
      case "lv":
        return this.showList(chatId) ? undefined : NO_LIST;
      default:
        return EXPIRED;
    }
  }

  private async pressPrompt(chatId: number, messageId: number, data: string): Promise<string | undefined> {
    const out = this.prompts.press(data);
    switch (out.type) {
      case "expired":
        return EXPIRED;
      case "refused":
        return out.toast;
      case "changed":
        void this.edit(chatId, messageId, promptText(out.prompt), promptKeyboard(out.prompt), { final: true });
        return undefined;
      case "cancel":
        void this.edit(chatId, messageId, CANCELLED, null, { final: true });
        return undefined;
      case "start":
        if (out.prompt.kind === "profile") this.startProfile(chatId, messageId, out.prompt);
        else await this.startList(chatId, messageId, out.prompt);
        return undefined;
    }
  }

  /** The profile backup; the prompt message becomes the job's message. */
  private startProfile(chatId: number, messageId: number, p: ProfilePrompt): void {
    const job = this.o.app.createJob({ url: profileUrl(p.name), options: saveJobOptions(effectiveSaveOptions(p.options, p.signedIn)) });
    this.jobs.follow(chatId, job, jobLabel(job), messageId);
  }

  /** The profile list; the prompt message becomes the list message, or says why the list didn't start. */
  private async startList(chatId: number, messageId: number, p: ListPrompt): Promise<void> {
    const result = await this.o.app.startList({ name: p.listName, usernames: p.usernames, options: effectiveSaveOptions(p.options, p.signedIn), wait: p.wait });
    if (this.stopped) return;
    if (!result.ok) {
      void this.edit(chatId, messageId, result.error, result.error === UNFINISHED ? SHOW_LIST_KEYBOARD : null, { final: true });
      return;
    }
    const list = this.o.app.list();
    if (!list) return;
    this.state.list = { chatId, messageId, active: isActive(list) };
    this.saveState();
    void this.edit(chatId, messageId, listText(list, this.o.now()), listKeyboard(list), { final: true });
  }
}
