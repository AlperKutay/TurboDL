import { effectiveSaveOptions, parseProfileList, profileUrl, saveJobOptions } from "@turbodl/shared";
import type { Job, ProfileListView, Result } from "@turbodl/shared";
import { UNFINISHED, listNames } from "../instagram/profile-lists";
import type { BotApp } from "./bot";
import { TelegramError, type BotApi } from "./bot-api";
import type { JobFollower } from "./bot-jobs";
import type { OwnerUpdate } from "./gate";
import { readIntent, type Command, type Intent } from "./intent";
import { Prompts, promptKeyboard, promptText, type ListPrompt, type ProfilePrompt } from "./prompts";
import {
  CANCELLED,
  EXPIRED,
  FILE_NOT_RECEIVED,
  HELP,
  LIST_TOO_LARGE,
  NOTHING_RUNNING,
  NO_LIST,
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
import type { Keyboard } from "./types";

/** The largest .txt list the bot reads, as the app's own list requests. */
const LIST_FILE_MAX = 1024 * 1024;
/** Telegram shows at most 200 characters of a button's answer. */
const TOAST_MAX = 200;

type Press = Extract<OwnerUpdate, { type: "press" }>;

/** The list goes on by itself: running, waiting for its next profile, or slowed down. */
export function isActive(list: ProfileListView | null): boolean {
  return list !== null && (list.state === "running" || list.state === "waiting" || list.state === "slowedDown");
}

/** A refused Result's words, for the button's answer. */
function failure(result: Result): string | undefined {
  return result.ok ? undefined : result.error;
}

export interface OwnerDeps {
  app: BotApp;
  api: Pick<BotApi, "downloadDocument" | "answerCallbackQuery">;
  jobs: JobFollower;
  /** the bot's stop signal */
  signal: AbortSignal;
  now(): number;
  send(chatId: number, text: string, o?: { keyboard?: Keyboard; replyTo?: number }): Promise<number | null>;
  edit(chatId: number, messageId: number, text: string, keyboard: Keyboard | null, o?: { final?: boolean }): Promise<void>;
  /** the list message the bot follows from now on */
  listOpened(chatId: number, messageId: number, active: boolean): void;
  stopped(): boolean;
  /** an error's words, scrubbed */
  text(err: unknown): string;
  log(text: string): void;
}

/** What the bound chat asks for: its messages and its button presses. */
export class OwnerHandler {
  private readonly prompts: Prompts;

  constructor(private readonly d: OwnerDeps) {
    this.prompts = new Prompts({ now: () => d.now() });
  }

  /** The one place an update from the bound chat is handled. */
  async handle(update: OwnerUpdate): Promise<void> {
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
        if ("error" in names) void this.d.send(chatId, names.error);
        else await this.openList(chatId, "Telegram list", names.names, []);
        return;
      }
      case "links":
        return this.startLinks(chatId, intent.urls, intent.saved);
      case "document":
        return this.detach(this.readList(chatId, intent), `reading ${intent.fileName}`);
      case "otherFile":
        void this.d.send(chatId, SEND_SOMETHING);
        return;
      case "unknown":
        void this.d.send(chatId, HELP);
        return;
    }
  }

  /** Runs work without holding up the poll loop or stop() (a download from Telegram, a message's id); failures are logged. */
  private detach(work: Promise<unknown>, what: string): void {
    work.catch((err) => this.d.log(`${what} failed: ${this.d.text(err)}`));
  }

  private async command(chatId: number, name: Command): Promise<void> {
    switch (name) {
      case "start":
      case "help":
        void this.d.send(chatId, HELP);
        return;
      case "status": {
        const info = await this.d.app.info();
        if (this.d.stopped()) return;
        void this.d.send(chatId, statusText({ version: info.version, instagram: info.instagram, jobs: this.d.jobs.running(), list: this.d.app.list() }));
        return;
      }
      case "stop": {
        const keyboard = stopKeyboard(this.d.jobs.running(), isActive(this.d.app.list()));
        void this.d.send(chatId, keyboard ? STOP_WHAT : NOTHING_RUNNING, keyboard ? { keyboard } : {});
        return;
      }
      case "list":
        if (!this.showList(chatId)) void this.d.send(chatId, NO_LIST);
        return;
    }
  }

  private async openProfile(chatId: number, name: string): Promise<void> {
    const { signedIn, username } = (await this.d.app.info()).instagram;
    if (this.d.stopped()) return;
    const prompt = this.prompts.openProfile(name, this.d.app.defaults().save, signedIn, username);
    void this.d.send(chatId, promptText(prompt), { keyboard: promptKeyboard(prompt) });
  }

  private async openList(chatId: number, listName: string, usernames: string[], skipped: string[]): Promise<void> {
    const { signedIn, username } = (await this.d.app.info()).instagram;
    if (this.d.stopped()) return;
    const { save, wait } = this.d.app.defaults();
    const prompt = this.prompts.openList(listName, usernames, skipped, save, wait, signedIn, username);
    void this.d.send(chatId, promptText(prompt), { keyboard: promptKeyboard(prompt) });
  }

  /** A .txt of profiles, read as the app reads its own lists. */
  private async readList(chatId: number, doc: Extract<Intent, { type: "document" }>): Promise<void> {
    if (doc.size !== undefined && doc.size > LIST_FILE_MAX) {
      void this.d.send(chatId, LIST_TOO_LARGE);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await this.d.api.downloadDocument(doc.fileId, LIST_FILE_MAX);
    } catch (err) {
      if (this.d.stopped()) return;
      const tooLarge = err instanceof TelegramError && err.kind === "tooLarge";
      if (!tooLarge) this.d.log(`could not get ${doc.fileName}: ${this.d.text(err)}`);
      void this.d.send(chatId, tooLarge ? LIST_TOO_LARGE : FILE_NOT_RECEIVED);
      return;
    }
    if (this.d.stopped()) return;
    const parsed = parseProfileList(bytes.toString("utf8").replace(/^﻿/, ""));
    // no names, or more than a list holds: the app's own words
    const names = listNames(parsed.usernames);
    if ("error" in names) {
      void this.d.send(chatId, names.error);
      return;
    }
    const skipped = parsed.invalid.map((line) => line.text);
    await this.openList(chatId, doc.fileName.replace(/\.txt$/i, ""), names.names, skipped);
  }

  private startLinks(chatId: number, urls: string[], saved: number): void {
    if (saved > 0) void this.d.send(chatId, SAVED_REFUSED);
    for (const url of urls) {
      let job: Job;
      try {
        job = this.d.app.createJob({ url });
      } catch (err) {
        void this.d.send(chatId, notStartedText(url, this.d.text(err)));
        continue;
      }
      this.d.jobs.follow(chatId, job, jobLabel(job));
    }
  }

  /** Sends the list message anew; it becomes the one the bot follows. False when there is no list. */
  private showList(chatId: number): boolean {
    const list = this.d.app.list();
    if (!list) return false;
    const keyboard = listKeyboard(list);
    const sent = this.d.send(chatId, listText(list, this.d.now()), keyboard ? { keyboard } : {}).then((messageId) => {
      if (messageId === null || this.d.stopped()) return;
      this.d.listOpened(chatId, messageId, isActive(this.d.app.list()));
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
      toast = this.d.text(err);
      this.d.log(`button ${press.data} failed: ${toast}`);
    }
    if (this.d.stopped()) return;
    await this.d.api.answerCallbackQuery(press.id, toast === undefined ? undefined : clip(toast, TOAST_MAX), this.d.signal).catch((err) => {
      if (!this.d.stopped()) this.d.log(`could not answer a button: ${this.d.text(err)}`);
    });
  }

  /** What a button does; the toast when it is refused or fails. */
  private async pressed({ chatId, messageId, data }: Press): Promise<string | undefined> {
    if (data.startsWith("p:")) return this.pressPrompt(chatId, messageId, data);
    if (data.startsWith("s:")) {
      this.d.app.cancelJob(data.slice(2));
      return undefined;
    }
    switch (data) {
      case "sa":
        for (const { job } of this.d.jobs.running()) this.d.app.cancelJob(job.id);
        if (isActive(this.d.app.list())) this.detach(this.d.app.stopList(), "stopping the list");
        return undefined;
      case "sl":
        // it resolves once the list has stopped, which may take a while
        this.detach(this.d.app.stopList(), "stopping the list");
        return undefined;
      case "lc":
        return failure(await this.d.app.continueList());
      case "lx":
        return failure(await this.d.app.closeList());
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
        void this.d.edit(chatId, messageId, promptText(out.prompt), promptKeyboard(out.prompt), { final: true });
        return undefined;
      case "cancel":
        void this.d.edit(chatId, messageId, CANCELLED, null, { final: true });
        return undefined;
      case "start":
        if (out.prompt.kind === "profile") this.startProfile(chatId, messageId, out.prompt);
        else await this.startList(chatId, messageId, out.prompt);
        return undefined;
    }
  }

  /** The profile backup; the prompt message becomes the job's message. */
  private startProfile(chatId: number, messageId: number, p: ProfilePrompt): void {
    const job = this.d.app.createJob({ url: profileUrl(p.name), options: saveJobOptions(effectiveSaveOptions(p.options, p.signedIn)) });
    this.d.jobs.follow(chatId, job, jobLabel(job), messageId);
  }

  /** The profile list; the prompt message becomes the list message, or says why the list didn't start. */
  private async startList(chatId: number, messageId: number, p: ListPrompt): Promise<void> {
    const result = await this.d.app.startList({ name: p.listName, usernames: p.usernames, options: effectiveSaveOptions(p.options, p.signedIn), wait: p.wait });
    if (this.d.stopped()) return;
    if (!result.ok) {
      void this.d.edit(chatId, messageId, result.error, result.error === UNFINISHED ? SHOW_LIST_KEYBOARD : null, { final: true });
      return;
    }
    const list = this.d.app.list();
    if (!list) return;
    this.d.listOpened(chatId, messageId, isActive(list));
    void this.d.edit(chatId, messageId, listText(list, this.d.now()), listKeyboard(list), { final: true });
  }
}
