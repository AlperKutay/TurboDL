import { describe, expect, it } from "vitest";
import { InstagramLane } from "../../src/main/jobs/instagram-lane";
import { JobRecord } from "../../src/main/jobs/job-record";

/** A lane whose clock never moves and whose backup slot is always free. */
function lane(): InstagramLane {
  return new InstagramLane({ wait: async () => undefined, now: () => 0, random: () => 0, held: () => false, settled: async () => undefined });
}

function job(id: string): JobRecord {
  return new JobRecord(id, { url: `https://www.instagram.com/${id}/` }, "instagramProfile", () => 0);
}

/** Lets everything that is ready run (no timer passes). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe("InstagramLane.busy", () => {
  it("is busy while a job holds the turn or waits for it, and free once they end", async () => {
    const l = lane();
    expect(l.busy()).toBe(false);
    const a = job("a");
    const b = job("b");
    expect(await l.backup(a, async () => ({ ok: true }))).toEqual({ ok: true });
    // a keeps the turn after its backup started, until it ends
    expect(l.busy()).toBe(true);
    const second = l.backup(b, async () => ({ ok: true }));
    await flush();
    a.end({ state: "done" });
    await flush();
    // the turn went to b, which waited for it
    expect(l.busy()).toBe(true);
    expect(await second).toEqual({ ok: true });
    b.end({ state: "done" });
    await flush();
    expect(l.busy()).toBe(false);
  });

  it("leaves a cancelled waiting job out", async () => {
    const l = lane();
    const a = job("a");
    const b = job("b");
    await l.backup(a, async () => ({ ok: true }));
    const waiting = l.backup(b, async () => ({ ok: true }));
    await flush();
    b.cancel();
    expect(await waiting).toBe("cancelled");
    expect(l.busy()).toBe(true);
    a.end({ state: "done" });
    await flush();
    expect(l.busy()).toBe(false);
  });

  it("is free again after a job whose backup was refused", async () => {
    const l = lane();
    const a = job("a");
    expect(await l.backup(a, async () => ({ ok: false, error: "This account is private.", reason: "private" }))).toMatchObject({ ok: false, reason: "private" });
    expect(l.busy()).toBe(false);
  });
});
