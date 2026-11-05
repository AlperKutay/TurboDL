import { beforeEach, describe, expect, it } from "vitest";
import { TelegramError, type TelegramErrorKind } from "../../src/main/telegram/bot-api";
import { EDIT_EVERY_MS, GAP_MS, Outbox } from "../../src/main/telegram/outbox";
import type { Keyboard } from "../../src/main/telegram/types";

interface Call {
  at: number;
  method: "send" | "edit";
  chatId: number;
  messageId?: number;
  text: string;
  keyboard?: Keyboard | null;
  replyTo?: number;
}

let clock: number;
let calls: Call[];
let logs: string[];
let nextId: number;
/** errors to throw on the next calls, in order (a null entry lets a call through) */
let failures: (TelegramError | null)[];
/** every n-th API call (counting retries) answers 429 */
let rateLimitEvery = 0;
let attempts: number;
let outbox: Outbox;

function fail(kind: TelegramErrorKind, retryAfter?: number, unsent?: boolean): TelegramError {
  return new TelegramError(kind, `${kind} error`, retryAfter, unsent);
}

function maybeFail(): void {
  attempts++;
  if (rateLimitEvery && attempts % rateLimitEvery === 0) throw fail("rateLimited", 3);
  const failure = failures.shift();
  if (failure) throw failure;
}

function makeOutbox(): Outbox {
  return new Outbox({
    api: {
      async sendMessage(chatId, text, o) {
        maybeFail();
        calls.push({ at: clock, method: "send", chatId, text, keyboard: o?.keyboard, replyTo: o?.replyTo });
        return nextId++;
      },
      async editMessageText(chatId, messageId, text, keyboard) {
        maybeFail();
        calls.push({ at: clock, method: "edit", chatId, messageId, text, keyboard });
      },
    },
    now: () => clock,
    // a fake clock: waiting jumps the clock forward
    wait: async (ms) => {
      clock += ms;
    },
    log: (text) => logs.push(text),
  });
}

beforeEach(() => {
  clock = 1_000_000;
  calls = [];
  logs = [];
  nextId = 100;
  failures = [];
  rateLimitEvery = 0;
  attempts = 0;
  outbox = makeOutbox();
});

const texts = () => calls.map((c) => c.text);

describe("Outbox", () => {
  it("calls go one at a time, a second apart", async () => {
    const ids = await Promise.all([outbox.send(1, "a"), outbox.send(1, "b"), outbox.send(2, "c")]);
    expect(ids).toEqual([100, 101, 102]);
    expect(texts()).toEqual(["a", "b", "c"]);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(GAP_MS);
  });

  it("passes the keyboard and reply target on", async () => {
    const keyboard: Keyboard = [[{ text: "Go", callback_data: "go" }]];
    await outbox.send(1, "a", { keyboard, replyTo: 42 });
    expect(calls[0].keyboard).toBe(keyboard);
    expect(calls[0].replyTo).toBe(42);
  });

  it("edits within 5 s coalesce to the latest", async () => {
    const first = await outbox.send(1, "msg");
    await outbox.edit(1, first!, "one", null);
    const sentAt = calls[1].at;
    const pending = [
      outbox.edit(1, first!, "two", null),
      outbox.edit(1, first!, "three", [[{ text: "Stop", callback_data: "stop" }]]),
      outbox.edit(1, first!, "four", [[{ text: "Pause", callback_data: "pause" }]]),
    ];
    await Promise.all(pending);
    expect(texts()).toEqual(["msg", "one", "four"]);
    expect(calls[2].keyboard).toEqual([[{ text: "Pause", callback_data: "pause" }]]);
    expect(calls[2].at - sentAt).toBeGreaterThanOrEqual(EDIT_EVERY_MS);
  });

  it("a held edit does not hold up other messages", async () => {
    const a = await outbox.send(1, "a");
    await outbox.edit(1, a!, "a1", null);
    const held = outbox.edit(1, a!, "a2", null);
    const other = await outbox.send(1, "b");
    expect(other).toBe(101);
    await held;
    expect(texts()).toEqual(["a", "a1", "b", "a2"]);
  });

  it("a final edit is not held back", async () => {
    const id = await outbox.send(1, "msg");
    await outbox.edit(1, id!, "one", null);
    const sentAt = calls[1].at;
    await outbox.edit(1, id!, "done", null, { final: true });
    expect(texts()).toEqual(["msg", "one", "done"]);
    expect(calls[2].at - sentAt).toBeLessThan(EDIT_EVERY_MS);
  });

  it("a final edit replaces a held one and a later send waits for it", async () => {
    const id = await outbox.send(1, "msg");
    await outbox.edit(1, id!, "one", null);
    const held = outbox.edit(1, id!, "two", null);
    const final = outbox.edit(1, id!, "done", null, { final: true });
    const summary = outbox.send(1, "summary");
    await Promise.all([held, final, summary]);
    expect(texts()).toEqual(["msg", "one", "done", "summary"]);
  });

  it("an unchanged edit is skipped", async () => {
    const id = await outbox.send(1, "msg");
    await outbox.edit(1, id!, "one", null);
    await outbox.edit(1, id!, "one", null, { final: true });
    await outbox.edit(1, id!, "msg", null, { final: true });
    await outbox.edit(1, id!, "msg", null, { final: true });
    expect(texts()).toEqual(["msg", "one", "msg"]);
  });

  it("an edit that only changes the keyboard is sent", async () => {
    const id = await outbox.send(1, "msg");
    await outbox.edit(1, id!, "msg", [[{ text: "Stop", callback_data: "stop" }]], { final: true });
    expect(calls).toHaveLength(2);
  });

  it("not modified counts as sent", async () => {
    const id = await outbox.send(1, "msg");
    failures.push(fail("notModified"));
    await outbox.edit(1, id!, "one", null, { final: true });
    await outbox.edit(1, id!, "one", null, { final: true });
    expect(texts()).toEqual(["msg"]);
    expect(logs).toEqual([]);
  });

  it("not found stops edits to that message", async () => {
    const gone = await outbox.send(1, "gone");
    const other = await outbox.send(1, "other");
    failures.push(fail("notFound"));
    await outbox.edit(1, gone!, "x", null, { final: true });
    await outbox.edit(1, gone!, "y", null, { final: true });
    await outbox.edit(1, other!, "z", null, { final: true });
    expect(texts()).toEqual(["gone", "other", "z"]);
  });

  it("outbox survives 429 during a burst", async () => {
    rateLimitEvery = 3;
    const ids = (await Promise.all(Array.from({ length: 10 }, (_, i) => outbox.send(1, `m${i}`)))) as number[];
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => 100 + i));
    const settled: Promise<unknown>[] = [];
    const tick = async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    };
    for (let round = 0; round < 3; round++) {
      for (const id of ids) settled.push(outbox.edit(1, id, `round ${round} ${id}`, null));
      await tick();
    }
    for (const id of ids) {
      settled.push(outbox.edit(1, id, `done ${id}`, null, { final: true }));
      settled.push(outbox.send(1, `summary ${id}`, { replyTo: id }));
    }
    await Promise.all(settled);

    // nothing is sent twice (a 429 never reaches the record, so a repeat would show here)
    const keys = calls.map((c) => `${c.method}|${c.messageId}|${c.text}|${c.replyTo}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of ids) {
      const mine = calls.filter((c) => c.method === "edit" && c.messageId === id);
      expect(mine[mine.length - 1].text).toBe(`done ${id}`);
      const finalAt = calls.findIndex((c) => c.method === "edit" && c.messageId === id && c.text === `done ${id}`);
      const summaryAt = calls.findIndex((c) => c.method === "send" && c.text === `summary ${id}`);
      expect(summaryAt).toBeGreaterThan(finalAt);
      expect(calls[summaryAt].replyTo).toBe(id);
    }
    expect(calls.filter((c) => c.method === "send")).toHaveLength(20);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(GAP_MS);
    expect(attempts).toBeGreaterThan(calls.length);
    expect(logs).toEqual([]);
  });

  it("waits retry_after before retrying the same call", async () => {
    failures.push(fail("rateLimited", 3));
    const start = clock;
    expect(await outbox.send(1, "a")).toBe(100);
    expect(calls).toHaveLength(1);
    expect(calls[0].at - start).toBeGreaterThanOrEqual(3000);
  });

  it("network errors retry three times and then give up with null", async () => {
    failures.push(fail("network", undefined, true), fail("server"), fail("network", undefined, true), fail("network", undefined, true));
    const start = clock;
    expect(await outbox.send(1, "a")).toBeNull();
    expect(failures).toEqual([]);
    expect(calls).toEqual([]);
    expect(clock - start).toBeGreaterThanOrEqual(2000 + 4000 + 8000);
    expect(logs).toHaveLength(1);
    // the queue keeps working
    expect(await outbox.send(1, "b")).toBe(100);
  });

  it("a network error that clears up within the retries succeeds", async () => {
    failures.push(fail("network", undefined, true), fail("server"));
    expect(await outbox.send(1, "a")).toBe(100);
    expect(logs).toEqual([]);
  });

  it("a send that may have reached Telegram is not repeated", async () => {
    failures.push(fail("network"));
    expect(await outbox.send(1, "a")).toBeNull();
    expect(calls).toEqual([]);
    expect(failures).toEqual([]);
    expect(attempts).toBe(1);
    expect(logs).toHaveLength(1);
    expect(await outbox.send(1, "b")).toBe(100);
  });

  it("an edit retries every network error", async () => {
    const id = await outbox.send(1, "a");
    failures.push(fail("network"), fail("network"));
    await outbox.edit(1, id!, "x", null, { final: true });
    expect(texts()).toEqual(["a", "x"]);
    expect(logs).toEqual([]);
  });

  it("a send that finds no chat is logged and gives up", async () => {
    failures.push(fail("notFound"));
    expect(await outbox.send(1, "a")).toBeNull();
    expect(logs).toHaveLength(1);
  });

  it("a given-up edit is logged and does not stop the queue", async () => {
    const id = await outbox.send(1, "a");
    failures.push(fail("server"), fail("server"), fail("server"), fail("server"));
    await outbox.edit(1, id!, "x", null, { final: true });
    expect(logs).toHaveLength(1);
    await outbox.edit(1, id!, "y", null, { final: true });
    expect(texts()).toEqual(["a", "y"]);
  });

  it("unauthorized gives up at once", async () => {
    failures.push(fail("unauthorized"));
    expect(await outbox.send(1, "a")).toBeNull();
    expect(logs).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it("drops a call the server rejects for good", async () => {
    for (const kind of ["badRequest", "tooLarge", "conflict"] as const) {
      logs = [];
      failures.push(fail(kind));
      expect(await outbox.send(1, "a")).toBeNull();
      expect(logs).toHaveLength(1);
      expect(failures).toEqual([]);
    }
  });

  it("close drops the queue", async () => {
    const first = outbox.send(1, "a");
    const second = outbox.send(1, "b");
    const edit = outbox.edit(1, 5, "x", null);
    outbox.close();
    expect(await first).toBeNull();
    expect(await second).toBeNull();
    await edit;
    expect(calls).toEqual([]);
    expect(await outbox.send(1, "c")).toBeNull();
    await outbox.edit(1, 5, "y", null, { final: true });
    expect(calls).toEqual([]);
  });

  it("close resolves a call that is waiting to retry and nothing goes out afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let apiCalls = 0;
    let waiting!: () => void;
    const reachedWait = new Promise<void>((r) => (waiting = r));
    const slow = new Outbox({
      api: {
        sendMessage: async () => {
          apiCalls++;
          throw fail("rateLimited", 3);
        },
        editMessageText: async () => undefined,
      },
      now: () => clock,
      wait: () => {
        waiting();
        return gate;
      },
      log: () => undefined,
    });
    const sent = slow.send(1, "a");
    await reachedWait; // the call was rejected and is waiting to retry
    expect(apiCalls).toBe(1);
    slow.close();
    expect(await sent).toBeNull();
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(apiCalls).toBe(1);
  });

  it("a call queued while the worker idles goes out at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const idleWaits: number[] = [];
    const idle = new Outbox({
      api: {
        sendMessage: async (_c, text) => {
          calls.push({ at: clock, method: "send", chatId: 1, text });
          return nextId++;
        },
        editMessageText: async (_c, id, text) => {
          calls.push({ at: clock, method: "edit", chatId: 1, messageId: id, text });
        },
      },
      now: () => clock,
      wait: (ms) => {
        if (ms <= GAP_MS) {
          clock += ms;
          return Promise.resolve();
        }
        idleWaits.push(ms);
        return gate; // the idle timeout: it never ends by itself
      },
      log: () => undefined,
    });
    const id = (await idle.send(1, "a"))!;
    await idle.edit(1, id, "one", null);
    const held = idle.edit(1, id, "two", null);
    await new Promise((r) => setTimeout(r, 0));
    expect(idleWaits).toHaveLength(1);
    expect(texts()).toEqual(["a", "one"]);
    expect(await idle.send(1, "b")).toBe(id + 1);
    expect(texts()).toEqual(["a", "one", "b"]);
    idle.close();
    release();
    await held;
  });

  it("a logger or a wait that throws does not stop the queue", async () => {
    let breakLog = true;
    const flaky = new Outbox({
      api: {
        sendMessage: async (_c, text) => {
          if (text === "bad") throw fail("badRequest");
          return nextId++;
        },
        editMessageText: async () => undefined,
      },
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      log: () => {
        if (breakLog) throw new Error("log broke");
      },
    });
    expect(await flaky.send(1, "bad")).toBeNull(); // the log call throws
    expect(await flaky.send(1, "ok")).toBe(100);
    breakLog = false;

    let waitBreaks = true;
    const waity = new Outbox({
      api: { sendMessage: async () => nextId++, editMessageText: async () => undefined },
      now: () => clock,
      wait: async (ms) => {
        if (waitBreaks && ms > 0) {
          waitBreaks = false;
          throw new Error("wait broke");
        }
        clock += ms;
      },
      log: () => undefined,
    });
    const first = waity.send(1, "a");
    const second = waity.send(1, "b");
    const third = waity.send(1, "c");
    expect(await first).not.toBeNull();
    expect(await second).toBeNull(); // the wait before it broke
    expect(await third).not.toBeNull();
  });

  it("remembers at most 500 messages", async () => {
    const ids = await Promise.all(Array.from({ length: 600 }, (_, i) => outbox.send(1, `m${i}`)));
    await outbox.edit(1, ids[599]!, "x", null, { final: true });
    const maps = outbox as unknown as { lastSent: Map<string, string>; lastEditAt: Map<string, number>; gone: Set<string> };
    expect(maps.lastSent.size).toBe(500);
    expect(maps.lastEditAt.size).toBeLessThanOrEqual(500);
    expect(maps.gone.size).toBeLessThanOrEqual(500);
  });
});
