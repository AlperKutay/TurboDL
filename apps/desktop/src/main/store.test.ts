import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("JsonStore", () => {
  it("returns the fallback when the file is missing", () => {
    const store = new JsonStore<{ n: number }>(path.join(dir, "s.json"));
    expect(store.load(() => ({ n: 1 }))).toEqual({ n: 1 });
  });

  it("debounces saves and flushes atomically", async () => {
    const file = path.join(dir, "nested", "s.json");
    const store = new JsonStore<{ n: number }>(file, 50);
    store.save({ n: 1 });
    store.save({ n: 2 });
    expect(existsSync(file)).toBe(false);
    await new Promise((r) => setTimeout(r, 120));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ n: 2 });
    store.save({ n: 3 });
    store.flush();
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ n: 3 });
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it("backs up a corrupt file and falls back", () => {
    const file = path.join(dir, "s.json");
    writeFileSync(file, "{ not json");
    const store = new JsonStore<{ n: number }>(file);
    expect(store.load(() => ({ n: 0 }))).toEqual({ n: 0 });
    expect(readFileSync(`${file}.bak`, "utf8")).toBe("{ not json");
  });
});
