import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClipboardWatcher } from "../src/main/clipboard-watcher";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ClipboardWatcher", () => {
  it("reports newly copied text once, ignoring what was there at start", () => {
    let clip = "https://old.example/a.zip";
    const seen: string[] = [];
    const w = new ClipboardWatcher({ read: () => clip, onText: (t) => seen.push(t), intervalMs: 1000 });
    w.start();
    vi.advanceTimersByTime(3000);
    expect(seen).toEqual([]);
    clip = "https://new.example/b.zip";
    vi.advanceTimersByTime(4000);
    expect(seen).toEqual(["https://new.example/b.zip"]);
    clip = "";
    vi.advanceTimersByTime(1000);
    clip = "https://new.example/b.zip";
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["https://new.example/b.zip", "https://new.example/b.zip"]);
    w.stop();
    clip = "https://after.example/c.zip";
    vi.advanceTimersByTime(5000);
    expect(seen).toHaveLength(2);
  });

  it("keeps going when the clipboard cannot be read", () => {
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
    vi.advanceTimersByTime(2000);
    fail = false;
    clip = "b";
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["b"]);
    w.stop();
  });
});
