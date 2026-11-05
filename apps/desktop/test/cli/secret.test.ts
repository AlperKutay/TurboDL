import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { SecretInterrupted } from "../../src/cli/main";
import { editSecret, readSecret } from "../../src/cli/secret";

/** A stdin that is a terminal (or a pipe) and sends what a test hands it. */
function fakeStdin(o: { tty: boolean; chunks?: string[] }) {
  const events = new EventEmitter();
  const raw: boolean[] = [];
  const stdin = {
    isTTY: o.tty,
    setRawMode: (on: boolean) => void raw.push(on),
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    on: (event: string, l: (...a: any[]) => void) => void events.on(event, l),
    off: (event: string, l: (...a: any[]) => void) => void events.off(event, l),
    async *[Symbol.asyncIterator]() {
      yield* o.chunks ?? [];
    },
  };
  return { stdin, events, raw };
}

const sink = () => {
  const writes: string[] = [];
  return { writes, write: (t: string) => void writes.push(t) };
};

describe("editSecret", () => {
  it("collects characters, drops one on backspace, ends on Enter, aborts on Ctrl+C", () => {
    expect(editSecret("ab", "c")).toEqual({ text: "abc" });
    expect(editSecret("abc", "\u007f")).toEqual({ text: "ab" });
    expect(editSecret("", "\u007f")).toEqual({ text: "" });
    expect(editSecret("ab", "c\r")).toEqual({ text: "abc", done: true });
    expect(editSecret("ab", "\u0003")).toEqual({ text: "ab", abort: true });
  });
});

describe("readSecret", () => {
  it("asks on stderr and reads a typed line without echoing it", async () => {
    const { stdin, events, raw } = fakeStdin({ tty: true });
    const err = sink();
    const got = readSecret("Bot token: ", stdin, err);
    events.emit("data", "12");
    events.emit("data", "3x\u007f:abc\r");
    expect(await got).toBe("123:abc");
    expect(raw).toEqual([true, false]);
    expect(err.writes.join("")).toBe("Bot token: \n");
    expect(events.listenerCount("data")).toBe(0);
  });

  it("rejects with SecretInterrupted on Ctrl+C and gives the terminal back", async () => {
    const { stdin, events, raw } = fakeStdin({ tty: true });
    const got = readSecret("Bot token: ", stdin, sink());
    events.emit("data", "12\u0003");
    await expect(got).rejects.toBeInstanceOf(SecretInterrupted);
    expect(raw).toEqual([true, false]);
  });

  it("reads piped stdin to its end, trimmed, and prints no prompt", async () => {
    const { stdin } = fakeStdin({ tty: false, chunks: ["123:", "abc\n"] });
    const err = sink();
    expect(await readSecret("Bot token: ", stdin, err)).toBe("123:abc");
    expect(err.writes).toEqual([]);
  });
});
