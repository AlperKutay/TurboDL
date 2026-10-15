import { createCipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { downloadFragments, headersFor, sequenceIv, type FragmentPlan, type FragmentProgress } from "../../src/main/engine/fragments";
import { startTestServer, type TestServer } from "../fixtures/test-server";

let server: TestServer;
let dir: string;
beforeEach(async () => {
  server = await startTestServer();
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-frag-"));
});
afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const fresh = (): FragmentProgress => ({ count: 0, initDone: false, done: 0, bytes: 0 });
const run = (plan: FragmentPlan, progress: FragmentProgress, extra: Partial<Parameters<typeof downloadFragments>[0]> = {}) =>
  downloadFragments({
    path: path.join(dir, "out.bin"),
    plan,
    progress,
    headers: {},
    signal: new AbortController().signal,
    connections: () => 3,
    onBytes: () => undefined,
    retryBaseMs: 10,
    idleTimeoutMs: 5000,
    ...extra,
  });
const out = () => readFileSync(path.join(dir, "out.bin"));

function serveParts(count: number, size = 100 * 1024, slowFirst = false): Buffer[] {
  const parts = Array.from({ length: count }, () => randomBytes(size));
  parts.forEach((data, i) => server.setFile(`/p${i}.ts`, { data, throttle: slowFirst && i === 0 ? 200 * 1024 : undefined }));
  return parts;
}
const planOf = (count: number): FragmentPlan => ({ fragments: Array.from({ length: count }, (_, i) => ({ url: server.url(`/p${i}.ts`), sequence: i })) });

describe("downloadFragments", () => {
  it("appends fragments in order even when a later one finishes first", async () => {
    const parts = serveParts(6, 100 * 1024, true);
    const progress = fresh();
    await run(planOf(6), progress);
    expect(out().equals(Buffer.concat(parts))).toBe(true);
    expect(progress).toEqual({ count: 6, initDone: false, done: 6, bytes: 600 * 1024 });
    expect(server.maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  it("writes the init fragment first", async () => {
    const parts = serveParts(2);
    const init = randomBytes(1000);
    server.setFile("/init.mp4", { data: init });
    const progress = fresh();
    await run({ init: { url: server.url("/init.mp4"), sequence: 0 }, fragments: planOf(2).fragments }, progress);
    expect(out().equals(Buffer.concat([init, ...parts]))).toBe(true);
    expect(progress.initDone).toBe(true);
  });

  it("fetches byte ranges of one file", async () => {
    const whole = randomBytes(300 * 1024);
    server.setFile("/main.mp4", { data: whole });
    const plan: FragmentPlan = {
      init: { url: server.url("/main.mp4"), range: { start: 0, end: 999 }, sequence: 0 },
      fragments: [
        { url: server.url("/main.mp4"), range: { start: 1000, end: 149_999 }, sequence: 1 },
        { url: server.url("/main.mp4"), range: { start: 150_000, end: whole.length - 1 }, sequence: 2 },
      ],
    };
    await run(plan, fresh());
    expect(out().equals(whole)).toBe(true);
  });

  it("decrypts AES-128 fragments with an explicit IV and with the sequence-number IV", async () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    server.setFile("/key.bin", { data: key });
    const clear = [randomBytes(5000), randomBytes(7000)];
    const encrypt = (data: Buffer, v: Buffer) => {
      const c = createCipheriv("aes-128-cbc", key, v);
      return Buffer.concat([c.update(data), c.final()]);
    };
    server.setFile("/e0.ts", { data: encrypt(clear[0], iv) });
    server.setFile("/e1.ts", { data: encrypt(clear[1], sequenceIv(41)) });
    const plan: FragmentPlan = {
      fragments: [
        { url: server.url("/e0.ts"), sequence: 40, key: { url: server.url("/key.bin"), iv } },
        { url: server.url("/e1.ts"), sequence: 41, key: { url: server.url("/key.bin"), iv: null } },
      ],
    };
    await run(plan, fresh());
    expect(out().equals(Buffer.concat(clear))).toBe(true);
    expect(server.requests.filter((r) => r.path === "/key.bin")).toHaveLength(1);
  });

  it("retries a dropped fragment", async () => {
    const data = randomBytes(200 * 1024);
    server.setFile("/drop.ts", { data, dropAfter: 50 * 1024, dropCount: 2 });
    await run({ fragments: [{ url: server.url("/drop.ts"), sequence: 0 }] }, fresh());
    expect(out().equals(data)).toBe(true);
  });

  it("fails with a readable message when a fragment is gone", async () => {
    serveParts(1);
    const plan: FragmentPlan = { fragments: [{ url: server.url("/p0.ts"), sequence: 0 }, { url: server.url("/missing.ts"), sequence: 1 }] };
    await expect(run(plan, fresh())).rejects.toThrow("404");
  });

  it("resumes after a pause without fetching appended fragments again", async () => {
    const parts = Array.from({ length: 8 }, () => randomBytes(100 * 1024));
    parts.forEach((data, i) => server.setFile(`/s${i}.ts`, { data, throttle: 400 * 1024 }));
    const plan: FragmentPlan = { fragments: parts.map((_, i) => ({ url: server.url(`/s${i}.ts`), sequence: i })) };
    const progress = fresh();
    const controller = new AbortController();
    const first = run(plan, progress, { signal: controller.signal, connections: () => 2 });
    while (progress.done < 2) await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(first).rejects.toThrow();
    const doneBefore = progress.done;
    expect(statSync(path.join(dir, "out.bin")).size).toBeGreaterThanOrEqual(progress.bytes);
    await run(plan, progress, { connections: () => 2 });
    expect(out().equals(Buffer.concat(parts))).toBe(true);
    for (let i = 0; i < doneBefore; i++) expect(server.requests.filter((r) => r.path === `/s${i}.ts`)).toHaveLength(1);
  });

  it("starts over when the plan has a different number of fragments", async () => {
    const parts = serveParts(3);
    const progress: FragmentProgress = { count: 5, initDone: false, done: 2, bytes: 1234 };
    await run(planOf(3), progress);
    expect(out().equals(Buffer.concat(parts))).toBe(true);
    expect(progress).toMatchObject({ count: 3, done: 3 });
  });

  it("never runs more than the connection limit at once", async () => {
    const parts = Array.from({ length: 20 }, () => randomBytes(20 * 1024));
    parts.forEach((data, i) => server.setFile(`/w${i}.ts`, { data, throttle: (i === 0 ? 20 : 400) * 1024 }));
    await run({ fragments: parts.map((_, i) => ({ url: server.url(`/w${i}.ts`), sequence: i })) }, fresh(), { connections: () => 3 });
    expect(out().equals(Buffer.concat(parts))).toBe(true);
    expect(server.maxConcurrent).toBeLessThanOrEqual(3);
  });

  it("sends the Cookie header only to the playlist's host", async () => {
    serveParts(1);
    const other = server.url("/p0.ts").replace("127.0.0.1", "localhost");
    const plan: FragmentPlan = { fragments: [{ url: server.url("/p0.ts"), sequence: 0 }, { url: other, sequence: 1 }] };
    await run(plan, fresh(), { headers: { Cookie: "s=1", Referer: "https://site.example/" }, cookieHost: "127.0.0.1" });
    const hits = server.requests.filter((r) => r.path === "/p0.ts");
    const same = hits.find((r) => r.headers.host?.startsWith("127.0.0.1"))!;
    const cross = hits.find((r) => r.headers.host?.startsWith("localhost"))!;
    expect(same.headers.cookie).toBe("s=1");
    expect(cross.headers.cookie).toBeUndefined();
    expect(cross.headers.referer).toBe("https://site.example/");
    expect(headersFor({ Cookie: "a" }, "https://x.example/", undefined)).toEqual({ Cookie: "a" });
  });

  it("leaves an empty file for an empty plan", async () => {
    await run({ fragments: [] }, fresh());
    expect(existsSync(path.join(dir, "out.bin"))).toBe(true);
    expect(out().length).toBe(0);
  });
});
