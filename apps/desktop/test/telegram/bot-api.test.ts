import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotApi, TelegramError, scrub } from "../../src/main/telegram/bot-api";
import { startFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram";

let fake: FakeTelegram;
let api: BotApi;

beforeEach(async () => {
  fake = await startFakeTelegram();
  api = new BotApi({ token: fake.token, base: fake.url });
});

afterEach(async () => {
  await fake.close();
});

async function rejection(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TelegramError);
    return err as TelegramError;
  }
  throw new Error("expected a rejection");
}

describe("BotApi", () => {
  it("getMe returns the bot", async () => {
    expect(await api.getMe()).toMatchObject(fake.bot);
  });

  it("sendMessage returns the message id and sends the keyboard", async () => {
    const keyboard = [[{ text: "Yes", callback_data: "y" }]];
    const id = await api.sendMessage(7, "hello", { keyboard, replyTo: 5 });
    expect(fake.sent(7)).toEqual([{ messageId: id, text: "hello", keyboard, replyTo: 5 }]);
    expect(fake.calls.at(-1)?.body).not.toHaveProperty("parse_mode");
  });

  it("editMessageText with null removes the buttons", async () => {
    const id = await api.sendMessage(7, "one", { keyboard: [[{ text: "A", callback_data: "a" }]] });
    await api.editMessageText(7, id, "two", null);
    expect(fake.sent(7)[0]).toMatchObject({ messageId: id, text: "two", keyboard: undefined });
  });

  it("401 is unauthorized", async () => {
    const bad = new BotApi({ token: "0:wrong", base: fake.url });
    const err = await rejection(bad.getMe());
    expect(err.kind).toBe("unauthorized");
    expect(String(err.message)).not.toContain("0:wrong");
  });

  it("409 is conflict", async () => {
    fake.failNext("getUpdates", 409);
    expect((await rejection(api.getUpdates(0, 0, new AbortController().signal))).kind).toBe("conflict");
  });

  it("429 carries retryAfter", async () => {
    fake.failNext("sendMessage", 429, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 7 } });
    const err = await rejection(api.sendMessage(1, "x"));
    expect(err.kind).toBe("rateLimited");
    expect(err.retryAfter).toBe(7);
  });

  it("not modified and not found are told apart", async () => {
    const id = await api.sendMessage(1, "same");
    expect((await rejection(api.editMessageText(1, id, "same", null))).kind).toBe("notModified");
    expect((await rejection(api.editMessageText(1, id + 999, "x", null))).kind).toBe("notFound");
  });

  it("other 400 is badRequest and 5xx is server", async () => {
    fake.failNext("sendMessage", 400, { ok: false, description: "Bad Request: chat not found" });
    expect((await rejection(api.sendMessage(1, "x"))).kind).toBe("badRequest");
    fake.failNext("sendMessage", 502);
    expect((await rejection(api.sendMessage(1, "x"))).kind).toBe("server");
  });

  it("a refused connection is network", async () => {
    const url = fake.url;
    await fake.close();
    const err = await rejection(new BotApi({ token: fake.token, base: url }).getMe());
    expect(err.kind).toBe("network");
    fake = await startFakeTelegram();
  });

  it("errors never contain the token", async () => {
    const token = "99:secret-token";
    const unauthorized = await rejection(new BotApi({ token, base: fake.url }).getMe());
    expect(String(unauthorized.message)).not.toContain(token);

    const failing = (async (url: string | URL | Request) => {
      throw new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${String(url)}`) });
    }) as typeof fetch;
    const network = await rejection(new BotApi({ token, base: "http://127.0.0.1:1", fetch: failing }).getMe());
    expect(network.kind).toBe("network");
    expect(String(network.message)).not.toContain(token);
    expect(String(network.message)).toContain("<token>");
  });

  it("scrub replaces every occurrence", () => {
    expect(scrub("a tok b tok", "tok")).toBe("a <token> b <token>");
  });

  it("downloadDocument returns the content and refuses a file over maxBytes as tooLarge", async () => {
    fake.document(1, "links.txt", Buffer.from("https://example.com/a"));
    const updates = await api.getUpdates(0, 0, new AbortController().signal);
    const doc = updates[0].message!.document!;
    expect((await api.downloadDocument(doc.file_id, 1000)).toString()).toBe("https://example.com/a");
    expect((await rejection(api.downloadDocument(doc.file_id, 5))).kind).toBe("tooLarge");
  });

  it("getUpdates passes offset and allowed_updates", async () => {
    fake.text(1, "a");
    fake.text(1, "b");
    const first = await api.getUpdates(0, 0, new AbortController().signal);
    expect(first).toHaveLength(2);
    const call = fake.calls.at(-1)!;
    expect(call.body).toMatchObject({ offset: 0, allowed_updates: ["message", "callback_query"] });
    const next = await api.getUpdates(first[0].update_id + 1, 0, new AbortController().signal);
    expect(next.map((u) => u.message?.text)).toEqual(["b"]);
  });

  it("an aborted getUpdates rejects without a network error", async () => {
    const ctl = new AbortController();
    const p = api.getUpdates(0, 50, ctl.signal);
    setTimeout(() => ctl.abort(), 50);
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TelegramError);
    expect((err as Error).name).toBe("AbortError");
  });
});
