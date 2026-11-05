import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAIRING_MS, type TelegramSettings, type TelegramStatus } from "@turbodl/shared";
import { TOKEN_FORMAT, TelegramService, type TelegramServiceDeps } from "../../src/main/telegram/service";
import { READ_TIMEOUT_MS, TokenStore, type TokenCrypt } from "../../src/main/telegram/token-store";
import { PAIRED, RESTARTED_LINK } from "../../src/main/telegram/texts";
import type { BotStateFile } from "../../src/main/telegram/state";
import { makeApp } from "../fixtures/fake-bot-app";
import { FAKE_TOKEN, startFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram";

const OWNER = 7;
/** tokens in @BotFather's format: digits, a colon, 20 or more of [A-Za-z0-9_-] */
const TOKEN_A = "123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN_B = "654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const BAD_FORMAT = "That doesn't look like a bot token from @BotFather.";

/** The system can't encrypt: the token goes to the plain file. */
const PLAIN: TokenCrypt = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => Promise.reject(new Error("unused")) };
/** The system encrypts: "enc:" + the text. */
const ENCRYPTING: TokenCrypt = {
  available: () => true,
  encrypt: (text) => Buffer.from(`enc:${text}`),
  decrypt: async (data) => data.toString().slice(4),
};

/**
 * The system's encryption with a keyring that answers each read in turn: "locked" refuses, "hang" never answers; once
 * the list is used up it decrypts as ENCRYPTING does.
 */
function keyring(answers: ("locked" | "hang")[]): TokenCrypt & { reads: number } {
  const crypt = {
    reads: 0,
    available: () => true,
    encrypt: ENCRYPTING.encrypt,
    decrypt: (data: Buffer): Promise<string> => {
      const answer = answers[crypt.reads++];
      if (answer === "locked") return Promise.reject(new Error("The keyring is locked"));
      if (answer === "hang") return new Promise<string>(() => undefined);
      return ENCRYPTING.decrypt(data);
    },
  };
  return crypt;
}

let fake: FakeTelegram;
let dir: string;
let settings: TelegramSettings;
let statuses: TelegramStatus[];
let logs: string[];
let services: TelegramService[];

/** Every request the bots make, and how many getUpdates are open at once; requests for TOKEN_B reach the fake as its own token. */
interface Tracked {
  fetch: typeof fetch;
  urls: string[];
  open: () => number;
  maxOpen: () => number;
}

function tracked(): Tracked {
  const urls: string[] = [];
  let open = 0;
  let maxOpen = 0;
  const doFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const poll = url.endsWith("/getUpdates");
    if (poll) maxOpen = Math.max(maxOpen, ++open);
    const sent = fetch(url.replace(`/bot${TOKEN_B}/`, `/bot${fake.token}/`), init);
    if (poll) sent.then(() => open--, () => open--);
    return sent;
  }) as typeof fetch;
  return { fetch: doFetch, urls, open: () => open, maxOpen: () => maxOpen };
}

/** A fetch that never answers (until it is called off). */
const hung = ((_url: string, init: RequestInit) =>
  new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;

function makeService(o: Partial<TelegramServiceDeps> = {}): TelegramService {
  const service = new TelegramService({
    userDataDir: dir,
    crypt: PLAIN,
    apiBase: fake.url,
    settings: () => settings,
    // the controller merges at once and saves in the background
    saveSettings: async (next) => {
      settings = { ...settings, ...next };
    },
    app: makeApp().app,
    onStatus: (status) => statuses.push(status),
    log: (text) => logs.push(text),
    ...o,
  });
  services.push(service);
  return service;
}

function saveToken(token: string, crypt: TokenCrypt = PLAIN): void {
  new TokenStore(dir, crypt).save(token);
}

async function until(pred: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("until timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const isPoll = (url: string) => url.endsWith("/getUpdates");

beforeEach(async () => {
  fake = await startFakeTelegram({ token: TOKEN_A });
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-tg-service-"));
  settings = { enabled: true, chatId: OWNER };
  statuses = [];
  logs = [];
  services = [];
});

afterEach(async () => {
  for (const service of services) await service.stop();
  vi.useRealTimers();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("telegram service", () => {
  it("no token is noToken and starts nothing", async () => {
    const t = tracked();
    const service = makeService({ fetch: t.fetch });
    await service.start();
    expect(service.status()).toEqual({ state: "noToken", tokenSet: false, chatId: OWNER, enabled: true });
    expect(statuses.at(-1)).toEqual(service.status());
    await new Promise((r) => setTimeout(r, 100));
    expect(t.urls).toEqual([]);
  });

  it("token + enabled starts the bot", async () => {
    saveToken(TOKEN_A);
    const service = makeService();
    await service.start();
    await until(() => service.status().state === "ok");
    expect(service.status()).toEqual({ state: "ok", tokenSet: true, bot: "turbodl_test_bot", chatId: OWNER, enabled: true });
    expect(statuses.map((s) => s.state)).toContain("connecting");
    await fake.waitFor(() => fake.calls.some((c) => c.method === "getUpdates"));
  });

  it("replacing the token leaves one loop on the new token", async () => {
    saveToken(TOKEN_A);
    const t = tracked();
    const service = makeService({ fetch: t.fetch });
    await service.start();
    // a getUpdates is held by the fake
    await until(() => t.open() === 1);
    expect(await service.setToken(TOKEN_B)).toEqual({ ok: true });
    const after = t.urls.length;
    // two polls on the new token: an update ends the first at once
    await until(() => t.urls.slice(after).filter(isPoll).length >= 1);
    fake.text(99, "from a stranger");
    await until(() => t.urls.slice(after).filter(isPoll).length >= 2);
    const polls = t.urls.slice(after).filter(isPoll);
    expect(polls.every((url) => url.includes(`/bot${TOKEN_B}/`))).toBe(true);
    expect(t.maxOpen()).toBe(1);
    expect(await new TokenStore(dir, PLAIN).load()).toEqual({ token: TOKEN_B });
    // the chat stays bound across tokens
    expect(service.status()).toMatchObject({ state: "ok", tokenSet: true, chatId: OWNER });
  });

  it("turning it off stops polling", async () => {
    saveToken(TOKEN_A);
    const t = tracked();
    const service = makeService({ fetch: t.fetch });
    await service.start();
    await until(() => t.open() === 1);
    expect(await service.setEnabled(false)).toEqual({ ok: true });
    expect(settings.enabled).toBe(false);
    expect(service.status()).toMatchObject({ state: "off", enabled: false, tokenSet: true });
    expect(t.open()).toBe(0);
    const requests = t.urls.length;
    await new Promise((r) => setTimeout(r, 300));
    expect(t.urls.length).toBe(requests);
  });

  it("removing the token stops the bot and forgets it", async () => {
    saveToken(TOKEN_A);
    const t = tracked();
    const service = makeService({ fetch: t.fetch });
    await service.start();
    await until(() => service.status().state === "ok");
    expect(await service.setToken(null)).toEqual({ ok: true });
    expect(service.status()).toEqual({ state: "noToken", tokenSet: false, chatId: OWNER, enabled: true });
    expect(t.open()).toBe(0);
    expect(existsSync(path.join(dir, "telegram-token"))).toBe(false);
    expect(existsSync(path.join(dir, "telegram-token.bin"))).toBe(false);
  });

  it("pair needs a token", async () => {
    const service = makeService();
    await service.start();
    expect(await service.pair()).toEqual({ ok: false, error: "Save the bot token first." });
    expect(service.status().pairing).toBeUndefined();
  });

  it("pairing binds, turns the bot on and clears the code", async () => {
    settings = { enabled: false, chatId: null };
    saveToken(TOKEN_A);
    const t = tracked();
    const service = makeService({ fetch: t.fetch });
    await service.start();
    expect(service.status().state).toBe("off");
    expect(t.urls).toEqual([]);
    const before = Date.now();
    const result = await service.pair();
    if (!result.ok) throw new Error(result.error);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + PAIRING_MS);
    expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + PAIRING_MS);
    expect(service.status().pairing).toEqual({ code: result.code, expiresAt: result.expiresAt });
    await until(() => t.open() === 1);
    fake.text(OWNER, `/start ${result.code}`);
    await until(() => settings.chatId === OWNER);
    expect(settings.enabled).toBe(true);
    expect(service.status()).toMatchObject({ state: "ok", chatId: OWNER, enabled: true, bot: "turbodl_test_bot" });
    expect(service.status().pairing).toBeUndefined();
    expect(service.status().pairedAt).toBeGreaterThanOrEqual(before);
    expect(service.status().pairedAt).toBeLessThanOrEqual(Date.now());
    // a new code does not take the last pairing back
    const again = await service.pair();
    expect(again.ok).toBe(true);
    expect(service.status().pairedAt).toBeGreaterThanOrEqual(before);
    await fake.waitFor(() => fake.sent(OWNER).length === 1);
    expect(fake.sent(OWNER)[0].text.startsWith(PAIRED)).toBe(true);
    // the bot goes on answering: the owner's /help is answered
    fake.text(OWNER, "/help");
    await fake.waitFor(() => fake.sent(OWNER).length === 2);
  });

  it("a pairing code runs out after 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    settings = { enabled: false, chatId: null };
    saveToken(TOKEN_A);
    const signals: AbortSignal[] = [];
    const watched = ((url: string, init: RequestInit) => {
      if (init.signal) signals.push(init.signal);
      return hung(url, init);
    }) as unknown as typeof fetch;
    const service = makeService({ fetch: watched, now: () => Date.now() });
    await service.start();
    const result = await service.pair();
    expect(result.ok).toBe(true);
    expect(service.status()).toMatchObject({ state: "connecting", pairing: expect.any(Object) });
    await vi.advanceTimersByTimeAsync(PAIRING_MS - 1000);
    expect(service.status().pairing).toBeDefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(service.status().pairing).toBeUndefined();
    expect(service.status().state).toBe("off");
    // the bot that ran for the pairing has stopped: every request it made was called off
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(statuses.at(-1)).toMatchObject({ state: "off" });
    expect(statuses.at(-1)?.pairing).toBeUndefined();
  });

  it("the fake Telegram's own token is one the app takes", async () => {
    expect(TOKEN_FORMAT.test(FAKE_TOKEN)).toBe(true);
    const own = await startFakeTelegram();
    try {
      expect(own.token).toBe(FAKE_TOKEN);
    } finally {
      await own.close();
    }
  });

  it("bad token format is refused", async () => {
    const service = makeService();
    await service.start();
    for (const token of ["not a token", "12:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "123456:short", `${TOKEN_A} x`, "123456:AAAAAAAAAAAAAAAAAAAAAAAA/AAAA"]) {
      expect(await service.setToken(token)).toEqual({ ok: false, error: BAD_FORMAT });
    }
    expect(existsSync(path.join(dir, "telegram-token"))).toBe(false);
    expect(service.status().tokenSet).toBe(false);
  });

  it("a chat id is checked", async () => {
    const service = makeService();
    await service.start();
    expect(await service.setChat(-5)).toEqual({ ok: false, error: "A chat id is a whole number above 0." });
    expect(settings.chatId).toBe(OWNER);
    expect(await service.setChat(42)).toEqual({ ok: true });
    expect(service.status().chatId).toBe(42);
    expect(await service.setChat(null)).toEqual({ ok: true });
    expect(settings.chatId).toBeNull();
  });

  it("status never holds the token", async () => {
    // Telegram's answer repeats the address it was sent to, token and all
    const leaky = (async (input: string | URL | Request) =>
      new Response(JSON.stringify({ ok: false, error_code: 401, description: `Unauthorized: ${String(input)}` }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    saveToken(TOKEN_A);
    const service = makeService({ fetch: leaky });
    await service.start();
    await until(() => service.status().state === "tokenRejected");
    expect(service.status().error).toContain("Unauthorized");
    expect(JSON.stringify(service.status())).not.toContain(TOKEN_A);
    expect(JSON.stringify(statuses)).not.toContain(TOKEN_A);
    expect(JSON.stringify(logs)).not.toContain(TOKEN_A);
    expect(JSON.stringify(settings)).not.toContain(TOKEN_A);
  });

  it("start never waits on Telegram", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    saveToken(TOKEN_A, ENCRYPTING);
    const service = makeService({ crypt: ENCRYPTING, fetch: hung });
    let done = false;
    void service.start().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS + 100);
    expect(done).toBe(true);
    // the token was read, and the bot is still waiting for Telegram
    expect(service.status()).toMatchObject({ state: "connecting", tokenSet: true });
  });

  it("a token that couldn't be read is read again once the bot should run", async () => {
    settings = { enabled: false, chatId: OWNER };
    saveToken(TOKEN_A, ENCRYPTING);
    // the keyring is locked when the app starts, and unlocked later (a login after the app started)
    const crypt = keyring(["locked"]);
    const service = makeService({ crypt });
    await service.start();
    expect(service.status()).toEqual({ state: "tokenUnreadable", tokenSet: true, chatId: OWNER, enabled: false });
    expect(crypt.reads).toBe(1);

    // the bot is off: nothing to read the token for
    await service.apply();
    expect(crypt.reads).toBe(1);

    expect(await service.setEnabled(true)).toEqual({ ok: true });
    expect(crypt.reads).toBe(2);
    await until(() => service.status().state === "ok");
    expect(service.status()).toEqual({ state: "ok", tokenSet: true, bot: "turbodl_test_bot", chatId: OWNER, enabled: true });
    expect(logs.join("\n")).not.toContain(TOKEN_A);
  });

  it("apply reads an unreadable token again when the bot is on", async () => {
    saveToken(TOKEN_A, ENCRYPTING);
    const crypt = keyring(["locked", "locked"]);
    const service = makeService({ crypt });
    await service.start();
    expect(service.status().state).toBe("tokenUnreadable");
    // still locked
    await service.apply();
    expect(crypt.reads).toBe(2);
    expect(service.status().state).toBe("tokenUnreadable");
    expect(statuses.at(-1)).toMatchObject({ state: "tokenUnreadable" });
    await service.apply();
    expect(crypt.reads).toBe(3);
    await until(() => service.status().state === "ok");
  });

  it("pairing reads an unreadable token again", async () => {
    settings = { enabled: false, chatId: null };
    saveToken(TOKEN_A, ENCRYPTING);
    const crypt = keyring(["locked", "locked"]);
    const service = makeService({ crypt });
    await service.start();
    expect(await service.pair()).toEqual({ ok: false, error: "TurboDL couldn't read the saved bot token. Save it again." });
    expect(crypt.reads).toBe(2);
    expect(service.status()).toMatchObject({ state: "tokenUnreadable", tokenSet: true });
    expect(service.status().pairing).toBeUndefined();

    const result = await service.pair();
    if (!result.ok) throw new Error(result.error);
    expect(result.code).toMatch(/^\d{6}$/);
    expect(crypt.reads).toBe(3);
    await until(() => service.status().state === "ok");
    expect(service.status()).toMatchObject({ pairing: { code: result.code }, tokenSet: true, bot: "turbodl_test_bot" });
  });

  it("reading the token again waits no longer than the first read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    saveToken(TOKEN_A, ENCRYPTING);
    const crypt = keyring(["locked", "hang"]);
    const service = makeService({ crypt, fetch: hung });
    await service.start();
    let done = false;
    void service.apply().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 100);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(service.status().state).toBe("tokenUnreadable");
  });

  it("only the first bot that reaches Telegram since the app started tells of a restart", async () => {
    const state = (jobId: string): BotStateFile => ({
      botId: fake.bot.id,
      offset: 0,
      // a download that got under way: it goes on in the app after the restart
      jobs: [{ jobId, chatId: OWNER, messageId: 1, kind: "file", label: "a.zip", started: true }],
      list: null,
    });
    const stateFile = path.join(dir, "telegram-state.json");
    writeFileSync(stateFile, JSON.stringify(state("lost-in-restart")));
    saveToken(TOKEN_A);
    // Telegram can't be reached until `reachable`
    let reachable = false;
    let attempts = 0;
    const switchable = ((input: string | URL | Request, init: RequestInit) => {
      attempts++;
      return reachable ? fetch(input, init) : hung(String(input), init);
    }) as typeof fetch;
    let clock = 0;
    // 10 s further at every read: the outbox's gaps never hold the test up
    const service = makeService({ fetch: switchable, now: () => (clock += 10_000) });
    await service.start();
    // the first bot never gets an answer, and is turned off: what the last run left open is still to tell
    await until(() => attempts > 0);
    await service.setEnabled(false);
    expect(fake.sent(OWNER)).toEqual([]);
    reachable = true;
    await service.setEnabled(true);
    await fake.waitFor(() => fake.sent(OWNER).some((m) => m.text === RESTARTED_LINK));
    await service.setEnabled(false);
    // a job left open by a bot of this app run: the app let go of it, nothing to tell
    writeFileSync(stateFile, JSON.stringify(state("ended-this-run")));
    const sent = fake.sent(OWNER).length;
    const polls = fake.calls.filter((c) => c.method === "getUpdates").length;
    await service.setEnabled(true);
    await fake.waitFor(() => fake.calls.filter((c) => c.method === "getUpdates").length > polls);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.sent(OWNER).length).toBe(sent);
  });
});
