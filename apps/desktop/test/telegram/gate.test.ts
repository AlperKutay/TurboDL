import { describe, expect, it } from "vitest";
import { ownerUpdate, pairingStart } from "../../src/main/telegram/gate";
import type { TgMessage, Update } from "../../src/main/telegram/types";

function msg(chatId: number, text: string, type: "private" | "group" = "private"): TgMessage {
  return { message_id: 1, date: 0, chat: { id: chatId, type }, from: { id: chatId }, text };
}

describe("gate drops everything not from the bound private chat", () => {
  it("answers a text message from the bound private chat", () => {
    const m = msg(42, "nasa");
    expect(ownerUpdate({ update_id: 1, message: m }, 42)).toEqual({ type: "message", message: m });
  });

  it("answers a press from the bound chat's owner", () => {
    const update: Update = {
      update_id: 1,
      callback_query: { id: "c1", from: { id: 42 }, message: msg(42, "x"), data: "go" },
    };
    expect(ownerUpdate(update, 42)).toEqual({ type: "press", id: "c1", chatId: 42, messageId: 1, data: "go" });
  });

  it("drops the rest", () => {
    expect(ownerUpdate({ update_id: 1, message: msg(43, "hi") }, 42)).toBeNull();
    expect(ownerUpdate({ update_id: 1, message: msg(42, "hi", "group") }, 42)).toBeNull();
    expect(ownerUpdate({ update_id: 1, edited_message: msg(42, "hi") }, 42)).toBeNull();
    expect(ownerUpdate({ update_id: 1, channel_post: msg(42, "hi") }, 42)).toBeNull();
    expect(
      ownerUpdate({ update_id: 1, callback_query: { id: "c", from: { id: 99 }, message: msg(42, "x"), data: "go" } }, 42),
    ).toBeNull();
    expect(
      ownerUpdate({ update_id: 1, callback_query: { id: "c", from: { id: 42 }, message: msg(42, "x", "group"), data: "go" } }, 42),
    ).toBeNull();
    expect(ownerUpdate({ update_id: 1, callback_query: { id: "c", from: { id: 42 }, data: "go" } }, 42)).toBeNull();
    expect(ownerUpdate({ update_id: 1, callback_query: { id: "c", from: { id: 42 }, message: msg(42, "x") } }, 42)).toBeNull();
    expect(ownerUpdate({ update_id: 1, message: msg(42, "hi") }, null)).toBeNull();
  });
});

describe("pairingStart reads the code", () => {
  it("reads /start with a six-digit code from a private chat", () => {
    expect(pairingStart({ update_id: 1, message: msg(7, "/start 123456") })).toEqual({ chatId: 7, code: "123456" });
    expect(pairingStart({ update_id: 1, message: msg(7, "/start@turbo_bot 123456") })).toEqual({ chatId: 7, code: "123456" });
  });

  it("ignores groups, a missing code and a short code", () => {
    expect(pairingStart({ update_id: 1, message: msg(7, "/start 123456", "group") })).toBeNull();
    expect(pairingStart({ update_id: 1, message: msg(7, "/start") })).toBeNull();
    expect(pairingStart({ update_id: 1, message: msg(7, "/start 12345") })).toBeNull();
    expect(pairingStart({ update_id: 1, message: msg(7, "hello 123456") })).toBeNull();
    expect(pairingStart({ update_id: 1 })).toBeNull();
  });
});
