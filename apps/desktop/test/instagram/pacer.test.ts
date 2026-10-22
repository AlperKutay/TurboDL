import { describe, expect, it } from "vitest";
import { SavedError } from "@turbodl/shared";
import { InstagramPacer } from "../../src/main/instagram/pacer";

/** A pacer on a clock that only moves when it waits. */
function pacer() {
  let now = 0;
  const waits: number[] = [];
  const p = new InstagramPacer(
    () => now,
    async (ms) => {
      waits.push(ms);
      now += ms;
    },
  );
  return { p, waits, advance: (ms: number) => (now += ms) };
}

describe("InstagramPacer", () => {
  it("gives every request its own slot, 1.5 s after the one before", async () => {
    const { p, waits } = pacer();
    await Promise.all([p.pace(), p.pace(), p.pace()]);
    expect(waits).toEqual([1500, 1500]);
  });

  it("holds every request for 2 minutes after Instagram asks to slow down", async () => {
    const { p, advance } = pacer();
    await expect(p.ask(async () => Promise.reject(new SavedError("rateLimited")))).rejects.toThrow();
    expect(p.held()).toBe(true);
    advance(2 * 60_000 - 1);
    expect(p.held()).toBe(true);
    advance(1);
    expect(p.held()).toBe(false);
  });

  it("doesn't hold after other failures", async () => {
    const { p } = pacer();
    await expect(p.ask(async () => Promise.reject(new SavedError("http", 500)))).rejects.toThrow();
    await expect(p.ask(async () => Promise.reject(new Error("offline")))).rejects.toThrow();
    expect(p.held()).toBe(false);
    expect(await p.ask(async () => 7)).toBe(7);
  });
});
