import { describe, expect, it } from "vitest";
import { readIntent } from "../../src/main/telegram/intent";
import type { TgMessage } from "../../src/main/telegram/types";

function text(t: string): TgMessage {
  return { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: t };
}

describe("readIntent", () => {
  it("reads one profile name or link", () => {
    expect(readIntent(text("nasa"))).toEqual({ type: "profile", name: "nasa" });
    expect(readIntent(text("@NASA"))).toEqual({ type: "profile", name: "nasa" });
    expect(readIntent(text("https://www.instagram.com/nasa/?igsh=x"))).toEqual({ type: "profile", name: "nasa" });
    expect(readIntent(text("nasa nasa"))).toEqual({ type: "profile", name: "nasa" });
  });

  it("reads several names split on spaces and commas", () => {
    expect(readIntent(text("nasa vercel, raycast"))).toEqual({ type: "names", names: ["nasa", "vercel", "raycast"] });
  });

  it("reads links and counts saved links", () => {
    const a = "https://youtu.be/aaaaaaaaaaa";
    const b = "https://www.youtube.com/watch?v=bbbbbbbbbbb";
    expect(readIntent(text(`${a}\n${b}`))).toEqual({ type: "links", urls: [a, b], saved: 0 });
    expect(readIntent(text("https://www.instagram.com/demo.user/saved/"))).toEqual({ type: "links", urls: [], saved: 1 });
    expect(readIntent(text(`${a} https://www.instagram.com/demo.user/saved/`))).toEqual({ type: "links", urls: [a], saved: 1 });
  });

  it("reads commands and ignores the bot suffix", () => {
    expect(readIntent(text("/status@turbo_bot"))).toEqual({ type: "command", name: "status" });
    expect(readIntent(text("/start"))).toEqual({ type: "command", name: "start" });
    expect(readIntent(text("/LIST"))).toEqual({ type: "command", name: "list" });
    expect(readIntent(text("/foo"))).toEqual({ type: "unknown" });
  });

  it("calls anything else unknown", () => {
    expect(readIntent(text("hello there!"))).toEqual({ type: "unknown" });
    expect(readIntent(text("nasa https://x.y/a.zip"))).toEqual({ type: "unknown" });
    expect(readIntent(text("https://www.instagram.com/nasa/ https://x.y/a.zip"))).toEqual({ type: "unknown" });
    expect(readIntent(text("   "))).toEqual({ type: "unknown" });
  });

  it("reads documents", () => {
    const doc = (file_name: string | undefined): TgMessage => ({
      ...text(""),
      text: undefined,
      document: { file_id: "F1", file_name, file_size: 12 },
    });
    expect(readIntent(doc("List.TXT"))).toEqual({ type: "document", fileId: "F1", fileName: "List.TXT", size: 12 });
    expect(readIntent(doc("a.pdf"))).toEqual({ type: "otherFile" });
    expect(readIntent(doc(undefined))).toEqual({ type: "otherFile" });
    expect(readIntent({ message_id: 1, date: 0, chat: { id: 1, type: "private" } })).toEqual({ type: "otherFile" });
  });
});
