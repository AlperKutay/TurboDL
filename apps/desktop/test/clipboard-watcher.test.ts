import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardWatcher } from "../src/main/clipboard-watcher";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardWatcher", () => {
  it("reports newly copied text once, ignoring what was there at start", async () => {
    let clip = "https://old.example/a.zip";
    const seen: string[] = [];
    const w = new ClipboardWatcher({ read: () => clip, onText: (t) => seen.push(t), intervalMs: 1000 });
    w.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen).toEqual([]);
    clip = "https://new.example/b.zip";
    await vi.advanceTimersByTimeAsync(4000);
    expect(seen).toEqual(["https://new.example/b.zip"]);
    clip = "";
    await vi.advanceTimersByTimeAsync(1000);
    clip = "https://new.example/b.zip";
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["https://new.example/b.zip", "https://new.example/b.zip"]);
    w.stop();
    clip = "https://after.example/c.zip";
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toHaveLength(2);
  });

  it("keeps going when the clipboard cannot be read", async () => {
    let fail = false;
    let clip = "a";
    const seen: string[] = [];
    const w = new ClipboardWatcher({
      read: () => {
        if (fail) throw new Error("busy");
        return clip;
      },
      onText: (t) => seen.push(t),
    });
    w.start();
    fail = true;
    await vi.advanceTimersByTimeAsync(2000);
    fail = false;
    clip = "b";
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["b"]);
    w.stop();
  });
});

describe("ClipboardWatcher with Electron's asynchronous clipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads through a promise and ignores the text that was there at start", async () => {
    let clip = "https://old.example/a.zip";
    const seen: string[] = [];
    const w = new ClipboardWatcher({ read: async () => clip, onText: (t) => seen.push(t), intervalMs: 1000 });
    w.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen).toEqual([]);
    clip = "https://new.example/b.zip";
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["https://new.example/b.zip"]);
    w.stop();
  });

  it("keeps going when an asynchronous read fails", async () => {
    let fail = true;
    const seen: string[] = [];
    const w = new ClipboardWatcher({
      read: async () => {
        if (fail) throw new Error("busy");
        return "c";
      },
      onText: (t) => seen.push(t),
    });
    w.start();
    await vi.advanceTimersByTimeAsync(2000);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual(["c"]);
    w.stop();
  });
});
