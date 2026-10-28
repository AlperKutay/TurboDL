import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unzip } from "../../src/main/media/unzip";
import { makeZip } from "../fixtures/zip";

let root: string;
let dest: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "turbodl-unzip-"));
  dest = path.join(root, "out");
  mkdirSync(dest);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function put(buf: Buffer): string {
  const file = path.join(root, "a.zip");
  writeFileSync(file, buf);
  return file;
}

describe("unzip", () => {
  it("extracts stored and deflated files, with folders", async () => {
    const big = Buffer.alloc(300 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 8) * 7) & 0xff;
    const zip = put(
      makeZip([
        { name: "deno", data: big },
        { name: "a/b.txt", data: "merhaba", method: 0 },
        { name: "empty", data: "", method: 0 },
        { name: "a/c/", method: 0 },
      ]),
    );
    await unzip(zip, dest);
    expect(readFileSync(path.join(dest, "deno")).equals(big)).toBe(true);
    expect(readFileSync(path.join(dest, "a", "b.txt"), "utf8")).toBe("merhaba");
    expect(readFileSync(path.join(dest, "empty")).length).toBe(0);
    expect(statSync(path.join(dest, "a", "c")).isDirectory()).toBe(true);
  });

  it("refuses entries that would land outside the folder", async () => {
    for (const name of ["../evil", "/abs", "a/../../x", "C:\\x"]) {
      const zip = put(makeZip([{ name, data: "x", method: 0 }]));
      await expect(unzip(zip, dest)).rejects.toThrow(`Unsafe path in the archive: ${name}`);
    }
    expect(existsSync(path.join(root, "evil"))).toBe(false);
    expect(existsSync(path.join(root, "x"))).toBe(false);
    expect(existsSync("/abs")).toBe(false);
  });

  it("reports a cut or damaged archive", async () => {
    const data = Buffer.alloc(5000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 17) & 0xff;
    const whole = makeZip([{ name: "deno", data }]);
    await expect(unzip(put(whole.subarray(0, whole.length - 30)), dest)).rejects.toThrow("Could not open the archive.");
    const bad = Buffer.from(whole);
    bad[30 + 4 + 100] ^= 0xff; // inside deno's compressed data
    await expect(unzip(put(bad), dest)).rejects.toThrow("The archive is damaged.");
    expect(existsSync(path.join(dest, "deno"))).toBe(false);
  });

  it("refuses compression it can't read", async () => {
    const zip = put(makeZip([{ name: "x", data: "abc", method: 12 }]));
    await expect(unzip(zip, dest)).rejects.toThrow("Unsupported compression method 12 in the archive.");
  });
});
