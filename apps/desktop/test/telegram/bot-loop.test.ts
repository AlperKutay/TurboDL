import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TelegramState } from "@turbodl/shared";
import { BotApi } from "../../src/main/telegram/bot-api";
import { TelegramBot, type BotApp, type BotOptions } from "../../src/main/telegram/bot";
import { EMPTY_STATE, isBotStateFile, type BotStateFile } from "../../src/main/telegram/state";
import { HELP, PAIRED } from "../../src/main/telegram/texts";
import { JsonStore } from "../../src/main/store";
import { startFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram";

const OWNER = 7;
const CODE = "123456";

let fake: FakeTelegram;
let dir: string;
let store: JsonStore<BotStateFile>;
let statuses: { state: TelegramState; info: { bot?: string; error?: string } }[];
let paired: number[];
let waits: number[];
let bots: TelegramBot[];
let logs: string[];
/** the wait injected into the bot: records the request and answers at once unless `holdWaits` */
let holdWaits: boolean;

function fakeApp(): BotApp {
  const unused = () => {
    throw new Error("not used in the loop tests");
  };
  return {
    info: unused,
    createJob: unused,
    job: () => undefined,
    cancelJob: () => undefined,
    subscribe: () => undefined,
    list: () => null,
    startList: unused,
    stopList: unused,
    continueList: unused,
    closeList: unused,
    defaults: unused,
  } as unknown as BotApp;
}

function makeBot(o: Partial<BotOptions> & { api?: BotApi } = {}): TelegramBot {
  const bot = new TelegramBot({
    api: o.api ?? new BotApi({ token: fake.token, base: fake.url, requestTimeoutMs: 2000, pollGraceMs: 1000 }),
    app: fakeApp(),
    chatId: () => OWNER,
    pairing: () => null,
    onPaired: (id) => paired.push(id),
    onStatus: (state, info) => statuses.push({ state, info }),
    store,
    afterAppStart: false,
    now: () => Date.now(),
    wait: (ms, signal) => {
      waits.push(ms);
      if (!holdWaits) return Promise.resolve();
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    },
    log: (text) => logs.push(text),
    ...o,
  });
  bots.push(bot);
  return bot;
}

const states = () => statuses.map((s) => s.state);
const polls = () => fake.calls.filter((c) => c.method === "getUpdates");
const repliesTo = (chatId: number) => fake.calls.filter((c) => ["sendMessage", "answerCallbackQuery"].includes(c.method) && (c.body.chat_id === chatId || c.body.callback_query_id !== undefined));

beforeEach(async () => {
  fake = await startFakeTelegram();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-bot-"));
  store = new JsonStore<BotStateFile>(path.join(dir, "telegram-state.json"), 0);
  statuses = [];
  paired = [];
  waits = [];
  bots = [];
  logs = [];
  holdWaits = false;
});

afterEach(async () => {
  for (const bot of bots) await bot.stop();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("bot loop", () => {
  it("start reports ok with the bot's name", async () => {
    makeBot().start();
    await fake.waitFor(() => states().includes("ok"));
    expect(states()[0]).toBe("connecting");
    expect(statuses.find((s) => s.state === "ok")?.info.bot).toBe("turbodl_test_bot");
  });

  it("start never throws and reports a bad connection", async () => {
    const bot = makeBot({ api: new BotApi({ token: fake.token, base: "http://127.0.0.1:1", requestTimeoutMs: 500 }), wait: (_ms, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })) });
    expect(() => bot.start()).not.toThrow();
    await fake.waitFor(() => states().includes("offline"));
  });

  it("commands are registered", async () => {
    makeBot().start();
    await fake.waitFor(() => fake.calls.some((c) => c.method === "setMyCommands"));
    const call = fake.calls.find((c) => c.method === "setMyCommands")!;
    expect((call.body.commands as { command: string }[]).map((c) => c.command)).toEqual(["status", "stop", "list", "help"]);
    await fake.waitFor(() => polls().length > 0);
    expect(polls()[0].body).toMatchObject({ offset: 0, timeout: 50 });
  });

  it("the offset survives a restart", async () => {
    const first = makeBot();
    first.start();
    await fake.waitFor(() => polls().length > 0);
    fake.text(OWNER, "/help");
    await fake.waitFor(() => fake.sent(OWNER).length === 1);
    await first.stop();
    const before = fake.calls.length;
    makeBot().start();
    await fake.waitFor(() => polls().length > 0 && fake.calls.length > before);
    await new Promise((r) => setTimeout(r, 300));
    expect(fake.sent(OWNER)).toHaveLength(1);
    // the handled update is 101: the new bot's first poll asks from 102
    expect(fake.calls.slice(before).find((c) => c.method === "getUpdates")?.body.offset).toBe(102);
  });

  it("a rejected token ends the loop as tokenRejected", async () => {
    const bot = makeBot({ api: new BotApi({ token: "1:wrong", base: fake.url, requestTimeoutMs: 2000 }) });
    bot.start();
    await fake.waitFor(() => states().includes("tokenRejected"));
    expect(states().at(-1)).toBe("tokenRejected");
    expect(statuses.at(-1)?.info.error).toBeTruthy();
    await new Promise((r) => setTimeout(r, 150));
    expect(waits).toEqual([]);
    await bot.stop();
  });

  it("conflict retries every 30 s", async () => {
    fake.failNext("getUpdates", 409);
    fake.failNext("getUpdates", 409);
    makeBot().start();
    await fake.waitFor(() => states().includes("conflict") && states().at(-1) === "ok");
    expect(waits.slice(0, 2)).toEqual([30_000, 30_000]);
  });

  it("a rate limit waits for retry_after", async () => {
    fake.failNext("getUpdates", 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } });
    makeBot().start();
    await fake.waitFor(() => waits.length > 0 && polls().length >= 2);
    expect(waits[0]).toBe(7000);
  });

  it("network failure backs off and recovers", async () => {
    let refused = 2;
    const flaky = ((input: string | URL | Request, init?: RequestInit) => {
      if (refused > 0) {
        refused--;
        const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
        return Promise.reject(new TypeError("fetch failed", { cause }));
      }
      return fetch(input, init);
    }) as typeof fetch;
    makeBot({ api: new BotApi({ token: fake.token, base: fake.url, fetch: flaky, requestTimeoutMs: 2000, pollGraceMs: 1000 }) }).start();
    await fake.waitFor(() => states().includes("ok"));
    expect(states().filter((s) => s !== "connecting")).toEqual(["offline", "ok"]);
    expect(waits.slice(0, 2)).toEqual([5000, 10_000]);
  });

  it("pairing binds the chat that sends the code", async () => {
    makeBot({ chatId: () => null, pairing: () => ({ code: CODE, expiresAt: Date.now() + 60_000 }) }).start();
    await fake.waitFor(() => polls().length > 0);
    fake.text(OWNER, `/start ${CODE}`);
    await fake.waitFor(() => fake.sent(OWNER).length === 1);
    expect(paired).toEqual([OWNER]);
    expect(fake.sent(OWNER)[0].text.startsWith(PAIRED)).toBe(true);
    expect(fake.sent(OWNER)[0].text).toContain(HELP);
  });

  it("a wrong or expired code gets no reply", async () => {
    let expiresAt = Date.now() + 60_000;
    makeBot({ chatId: () => null, pairing: () => ({ code: CODE, expiresAt }) }).start();
    await fake.waitFor(() => polls().length > 0);
    // a wrong code while the pairing is valid
    fake.text(OWNER, "/start 999999");
    await fake.waitFor(() => polls().some((c) => Number(c.body.offset) >= 102));
    // the right code once it expired
    expiresAt = Date.now() - 1;
    fake.text(OWNER, `/start ${CODE}`);
    await fake.waitFor(() => polls().some((c) => Number(c.body.offset) >= 103));
    expect(paired).toEqual([]);
    expect(repliesTo(OWNER)).toEqual([]);
  });

  it("nothing from an unbound chat gets a reply", async () => {
    makeBot().start();
    await fake.waitFor(() => polls().length > 0);
    fake.text(99, "hello");
    fake.text(99, "/status");
    fake.text(99, "hi", {}, "group");
    fake.press(99, 5, "x");
    await fake.waitFor(() => polls().some((c) => Number(c.body.offset) >= 106));
    expect(repliesTo(99)).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "answerCallbackQuery")).toEqual([]);
    expect(fake.sent()).toEqual([]);
  });

  it("the owner's /help is answered with the help", async () => {
    makeBot().start();
    await fake.waitFor(() => polls().length > 0);
    fake.text(OWNER, "/help");
    await fake.waitFor(() => fake.sent(OWNER).length === 1);
    expect(fake.sent(OWNER)[0].text).toBe(HELP);
  });

  it("a new bot id empties the state", async () => {
    store.save({ botId: 1, offset: 500, jobs: [{ jobId: "j", chatId: OWNER, messageId: 1, kind: "file", label: "x" }], list: null });
    store.flush();
    makeBot().start();
    await fake.waitFor(() => polls().length > 0);
    expect(polls()[0].body.offset).toBe(0);
    const saved = store.load(() => structuredClone(EMPTY_STATE));
    expect(saved).toEqual({ ...EMPTY_STATE, botId: 424242 });
  });

  it("the offset is on disk before an owner update is handled", async () => {
    const file = path.join(dir, "slow-state.json");
    // a debounce that never fires in the test: only an explicit flush writes the file
    const slow = new JsonStore<BotStateFile>(file, 60_000);
    makeBot({ store: slow }).start();
    await fake.waitFor(() => polls().length > 0);
    fake.text(OWNER, "/help");
    await fake.waitFor(() => fake.sent(OWNER).length === 1);
    expect(JSON.parse(readFileSync(file, "utf8")).offset).toBe(102);
  });

  it("a failing setMyCommands does not stop the polling", async () => {
    fake.failNext("setMyCommands", 400);
    makeBot().start();
    await fake.waitFor(() => polls().length > 0);
    expect(states()).toEqual(["connecting", "ok"]);
    expect(logs.some((l) => l.includes("commands"))).toBe(true);
  });

  it("a 404 from getMe counts as a rejected token", async () => {
    fake.failNext("getMe", 404);
    makeBot().start();
    await fake.waitFor(() => states().includes("tokenRejected"));
    await new Promise((r) => setTimeout(r, 100));
    expect(states().at(-1)).toBe("tokenRejected");
    expect(waits).toEqual([]);
  });

  it("stopping while getMe hangs returns at once and reports nothing after", async () => {
    const hung = ((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const bot = makeBot({ api: new BotApi({ token: fake.token, base: fake.url, fetch: hung }) });
    bot.start();
    await new Promise((r) => setTimeout(r, 50));
    const seen = statuses.length;
    const started = Date.now();
    await bot.stop();
    expect(Date.now() - started).toBeLessThan(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(statuses.length).toBe(seen);
    expect(fake.calls).toEqual([]);
  });

  it("stop ends the long poll at once", async () => {
    const bot = makeBot();
    bot.start();
    await fake.waitFor(() => polls().length > 0);
    const started = Date.now();
    await bot.stop();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("a stopped bot sends nothing more", async () => {
    const bot = makeBot();
    bot.start();
    await fake.waitFor(() => polls().length > 0);
    await bot.stop();
    const calls = fake.calls.length;
    fake.text(OWNER, "late");
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.calls.length).toBe(calls);
  });
});

describe("bot state file", () => {
  it("accepts the empty state and rejects other shapes", () => {
    expect(isBotStateFile(EMPTY_STATE)).toBe(true);
    expect(isBotStateFile({ botId: 1, offset: 2, jobs: [], list: { chatId: 1, messageId: 2, active: true } })).toBe(true);
    expect(isBotStateFile({ botId: 1, offset: "2", jobs: [], list: null })).toBe(false);
    expect(isBotStateFile({ botId: null, offset: 0, jobs: [{ jobId: 1 }], list: null })).toBe(false);
    expect(isBotStateFile(null)).toBe(false);
  });
});
