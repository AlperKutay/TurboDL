import { randomInt } from "node:crypto";
import path from "node:path";
import {
  PAIRING_MS,
  chatIdProblem,
  type ProfileListView,
  type Result,
  type TelegramPairResult,
  type TelegramPairing,
  type TelegramSettings,
  type TelegramState,
  type TelegramStatus,
} from "@turbodl/shared";
import { delay } from "../engine/http";
import { JsonStore } from "../store";
import { BotApi, scrub } from "./bot-api";
import { TelegramBot, type BotApp } from "./bot";
import type { BotStateFile } from "./state";
import { TokenStore, type TokenCrypt } from "./token-store";

/** what @BotFather hands out: the bot's number, a colon and a secret */
export const TOKEN_FORMAT = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;

const BAD_TOKEN = "That doesn't look like a bot token from @BotFather.";
const NO_TOKEN = "Save the bot token first.";

export interface TelegramServiceDeps {
  userDataDir: string;
  crypt: TokenCrypt;
  /** the Bot API's address (default Telegram's own); tests point it at a fake */
  apiBase?: string;
  fetch?: typeof fetch;
  settings(): TelegramSettings;
  saveSettings(next: Partial<TelegramSettings>): Promise<void>;
  app: BotApp;
  onStatus(status: TelegramStatus): void;
  now?(): number;
  log?(text: string): void;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Telegram bot's life in the app: its token, its pairing code, and one bot at a time that runs while it is on (or
 * a pairing waits for its code) and a token is there. Changes to it run one after another, and a bot that goes is
 * stopped before the next one starts, so there is never more than one long poll. Nothing here waits on Telegram.
 */
export class TelegramService {
  private readonly d: TelegramServiceDeps;
  private readonly tokens: TokenStore;
  /** the bot's state file, kept by every bot in turn */
  private readonly store: JsonStore<BotStateFile>;
  private readonly now: () => number;
  /** lifecycle changes, one after another */
  private chain: Promise<void> = Promise.resolve();
  private token: string | null = null;
  /** a token file is there, but it couldn't be read */
  private unreadable = false;
  /** the saved token is known (read, or set since) */
  private loaded = false;
  /** bumped by setToken: a read that started before it must not undo it */
  private tokenVersion = 0;
  private started = false;
  private closed = false;
  private bot: TelegramBot | null = null;
  /** the token the running bot uses */
  private botToken: string | null = null;
  /** the bot's own state while it runs, and the error that goes with it */
  private botState: TelegramState = "connecting";
  private botError: string | undefined;
  /** the bot's @name, as getMe said, for the token it was said for */
  private botName: { token: string; name: string } | null = null;
  /**
   * A bot reached Telegram in this run of the app, and so took up what the last run left open (a bot reports ok in
   * the same turn as it recovers). Until then every new bot may tell of a restart: one turned off or refused before it
   * got there told nothing.
   */
  private recovered = false;
  private pairing: TelegramPairing | null = null;
  private pairingTimer: NodeJS.Timeout | null = null;
  /** when the last pairing succeeded */
  private pairedAt: number | undefined;

  constructor(d: TelegramServiceDeps) {
    this.d = d;
    this.tokens = new TokenStore(d.userDataDir, d.crypt);
    this.store = new JsonStore<BotStateFile>(path.join(d.userDataDir, "telegram-state.json"));
    this.now = d.now ?? (() => Date.now());
  }

  /** Reads the token (never longer than the store's timeout), then runs the bot if it should run. Never throws. */
  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    try {
      const version = this.tokenVersion;
      const loaded = await this.tokens.load();
      // a token set meanwhile is newer than the one read
      if (version === this.tokenVersion) {
        this.token = loaded && "token" in loaded ? loaded.token : null;
        this.unreadable = loaded !== null && "unreadable" in loaded;
        if (this.unreadable) this.log("the saved bot token couldn't be read");
      }
      this.loaded = true;
      await this.apply();
    } catch (err) {
      this.log(`could not start: ${message(err)}`);
    }
  }

  /** After a settings change: starts, stops or keeps the bot. */
  apply(): Promise<void> {
    return this.serial(() => this.reconcile());
  }

  status(): TelegramStatus {
    const { enabled, chatId } = this.d.settings();
    const status: TelegramStatus = { state: this.state(), tokenSet: this.token !== null || this.unreadable, chatId, enabled };
    const name = this.name();
    if (name) status.bot = name;
    const pairing = this.activePairing();
    if (pairing) status.pairing = { ...pairing };
    if (this.pairedAt !== undefined) status.pairedAt = this.pairedAt;
    const error = this.bot ? this.botError : undefined;
    if (error) status.error = this.scrub(error);
    return status;
  }

  async setToken(token: string | null): Promise<Result> {
    const value = typeof token === "string" ? token.trim() : null;
    if (token !== null && (value === null || !TOKEN_FORMAT.test(value))) return { ok: false, error: BAD_TOKEN };
    return this.serial(async (): Promise<Result> => {
      try {
        this.tokens.save(value);
      } catch (err) {
        return { ok: false, error: `TurboDL couldn't save the token: ${value ? scrub(message(err), value) : message(err)}` };
      }
      this.tokenVersion++;
      this.token = value;
      this.unreadable = false;
      this.loaded = true;
      if (value === null) this.endPairing();
      // a new token is a new bot (one that was refused gets another try with it): the old one goes first
      await this.stopBot();
      await this.reconcile();
      return { ok: true };
    });
  }

  /** Binds the chat (null: unbinds it); a chat bound by hand ends the pairing. */
  async setChat(chatId: number | null): Promise<Result> {
    if (chatId !== null) {
      const problem = chatIdProblem(chatId);
      if (problem) return { ok: false, error: problem };
      this.endPairing();
    }
    return this.save({ chatId });
  }

  setEnabled(enabled: boolean): Promise<Result> {
    return this.save({ enabled });
  }

  /** A code the chat to bind sends the bot (`/start <code>`), valid for 10 minutes; the bot runs meanwhile. */
  async pair(): Promise<TelegramPairResult> {
    if (this.closed) return { ok: false, error: "TurboDL is quitting." };
    if (this.token === null) return { ok: false, error: NO_TOKEN };
    const pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: this.now() + PAIRING_MS };
    this.endPairing();
    this.pairing = pairing;
    this.pairingTimer = setTimeout(() => this.pairingRanOut(pairing), PAIRING_MS);
    this.pairingTimer.unref?.();
    await this.apply();
    const name = this.name();
    return { ok: true, ...(name ? { bot: name } : {}), ...pairing };
  }

  listChanged(list: ProfileListView | null): void {
    this.bot?.listChanged(list);
  }

  listNotice(text: string): void {
    this.bot?.listNotice(text);
  }

  /** Stops the bot for good (the app quits); nothing starts after it. */
  stop(): Promise<void> {
    this.closed = true;
    this.endPairing();
    return this.serial(() => this.stopBot());
  }

  private state(): TelegramState {
    if (this.unreadable) return "tokenUnreadable";
    if (!this.loaded) return this.wanted() ? "connecting" : "off";
    if (this.token === null) return "noToken";
    return this.bot ? this.botState : "off";
  }

  /** The bot should run: it is on, or a pairing waits for its code. */
  private wanted(): boolean {
    return this.d.settings().enabled || this.activePairing() !== null;
  }

  private name(): string | undefined {
    return this.botName && this.botName.token === this.token ? this.botName.name : undefined;
  }

  private activePairing(): TelegramPairing | null {
    return this.pairing && this.now() < this.pairing.expiresAt ? this.pairing : null;
  }

  private endPairing(): void {
    this.pairing = null;
    if (this.pairingTimer) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
  }

  private pairingRanOut(pairing: TelegramPairing): void {
    if (this.pairing !== pairing) return;
    this.endPairing();
    void this.apply();
  }

  /** The chat that sent the code is bound and the bot stays on; the code is used up. */
  private paired(chatId: number): void {
    this.pairedAt = this.now();
    this.endPairing();
    // the controller takes the change at once; the bot keeps running for the chat it now answers
    void this.d
      .saveSettings({ chatId, enabled: true })
      .then(() => this.apply())
      .catch((err: unknown) => this.log(`could not save the paired chat: ${message(err)}`));
  }

  /** A settings change, then the bot as the settings now want it. */
  private async save(next: Partial<TelegramSettings>): Promise<Result> {
    try {
      await this.d.saveSettings(next);
    } catch (err) {
      return { ok: false, error: `TurboDL couldn't save the settings: ${message(err)}` };
    }
    await this.apply();
    return { ok: true };
  }

  /** Runs `fn` after every change before it; the chain goes on whatever `fn` does. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.then(
      () => undefined,
      (err: unknown) => this.log(`lifecycle change failed: ${message(err)}`),
    );
    return run;
  }

  /** In the chain only: the bot as the token and settings want it, then the status. */
  private async reconcile(): Promise<void> {
    const token = this.closed || !this.loaded || !this.wanted() ? null : this.token;
    if (this.bot && this.botToken !== token) await this.stopBot();
    if (token !== null && !this.bot) this.startBot(token);
    this.publish();
  }

  private startBot(token: string): void {
    const api = new BotApi({ token, base: this.d.apiBase, fetch: this.d.fetch });
    const bot: TelegramBot = new TelegramBot({
      api,
      app: this.d.app,
      chatId: () => this.d.settings().chatId,
      pairing: () => this.activePairing(),
      onPaired: (chatId) => {
        if (this.bot === bot) this.paired(chatId);
      },
      onStatus: (state, info) => {
        if (state === "ok") this.recovered = true;
        if (this.bot !== bot) return;
        this.botState = state;
        this.botError = info.error;
        if (info.bot) this.botName = { token, name: info.bot };
        this.publish();
      },
      store: this.store,
      afterAppStart: !this.recovered,
      now: () => this.now(),
      wait: (ms, signal) => delay(ms, signal),
      log: (text) => this.log(text),
      token,
    });
    this.bot = bot;
    this.botToken = token;
    this.botState = "connecting";
    this.botError = undefined;
    bot.start();
  }

  /** In the chain only: the running bot stops, and is awaited. */
  private async stopBot(): Promise<void> {
    const bot = this.bot;
    if (!bot) return;
    this.bot = null;
    this.botToken = null;
    this.botError = undefined;
    try {
      await bot.stop();
    } catch (err) {
      this.log(`could not stop the bot: ${message(err)}`);
    }
  }

  private publish(): void {
    try {
      this.d.onStatus(this.status());
    } catch (err) {
      this.log(`status callback failed: ${message(err)}`);
    }
  }

  private scrub(text: string): string {
    let clean = text;
    for (const token of [this.token, this.botToken]) if (token) clean = scrub(clean, token);
    return clean;
  }

  private log(text: string): void {
    try {
      const clean = this.scrub(text);
      if (this.d.log) this.d.log(clean);
      else console.warn(`Telegram: ${clean}`);
    } catch {
      // a broken logger must not stop the bot
    }
  }
}
