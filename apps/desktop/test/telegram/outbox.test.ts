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
}

let clock: number;
let calls: Call[];
let logs: string[];
let nextId: number;
/** errors to throw on the next calls, in order (a null entry lets a call through) */
let failures: (TelegramError | null)[];
let outbox: Outbox;

function fail(kind: TelegramErrorKind, retryAfter?: number): TelegramError {
  return new TelegramError(kind, `${kind} error`, retryAfter);
}

function makeOutbox(): Outbox {
  return new Outbox({
    api: {
      async sendMessage(chatId, text, o) {
        const failure = failures.shift();
        if (failure) throw failure;
        calls.push({ at: clock, method: "send", chatId, text, keyboard: o?.keyboard });
        return nextId++;
      },
      async editMessageText(chatId, messageId, text, keyboard) {
        const failure = failures.shift();
        if (failure) throw failure;
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
    await outbox.send(1, "a", { keyboard });
    expect(calls[0].keyboard).toBe(keyboard);
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
    failures.push(fail("rateLimited", 3), fail("rateLimited", 3));
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => outbox.send(1, `m${i}`)));
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => 100 + i));
    const edits: Promise<void>[] = [];
    for (const id of ids) {
      edits.push(outbox.edit(1, id!, `first ${id}`, null), outbox.edit(1, id!, `last ${id}`, null));
    }
    await Promise.all(edits);
    // nothing is sent twice
    expect(new Set(calls.map((c) => `${c.method}|${c.messageId}|${c.text}`)).size).toBe(calls.length);
    expect(calls.filter((c) => c.method === "send").map((c) => c.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i}`));
    for (const id of ids) {
      const mine = calls.filter((c) => c.messageId === id);
      expect(mine[mine.length - 1].text).toBe(`last ${id}`);
    }
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(GAP_MS);
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
    failures.push(fail("network"), fail("server"), fail("network"), fail("network"));
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
    failures.push(fail("network"), fail("network"));
    expect(await outbox.send(1, "a")).toBe(100);
    expect(logs).toEqual([]);
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

  it("close resolves a call that is waiting to retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = new Outbox({
      api: {
        sendMessage: async () => {
          throw fail("rateLimited", 3);
        },
        editMessageText: async () => undefined,
      },
      now: () => clock,
      wait: () => gate,
      log: () => undefined,
    });
    const sent = slow.send(1, "a");
    await Promise.resolve();
    slow.close();
    release();
    expect(await sent).toBeNull();
  });
});
