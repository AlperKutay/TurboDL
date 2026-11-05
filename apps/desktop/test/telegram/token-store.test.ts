import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READ_TIMEOUT_MS, TokenStore, type TokenCrypt } from "../../src/main/telegram/token-store";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

let dir: string;
const bin = () => path.join(dir, "telegram-token.bin");
const plain = () => path.join(dir, "telegram-token");

/** A stand-in for safeStorage: "enc:" + the text, reversed on decrypt; anything else does not decrypt. */
function crypt(available: boolean): TokenCrypt {
  return {
    available: () => available,
    encrypt: (text) => Buffer.from(`enc:${text}`),
    decrypt: async (data) => {
      const text = data.toString();
      if (!text.startsWith("enc:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text.slice(4);
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-token-"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("token store", () => {
  it("encrypted when the system can", async () => {
    const store = new TokenStore(dir, crypt(true));
    store.save(TOKEN);
    expect(existsSync(bin())).toBe(true);
    expect(existsSync(plain())).toBe(false);
    expect(readFileSync(bin()).toString()).toBe(`enc:${TOKEN}`);
    expect(await store.load()).toEqual({ token: TOKEN });
  });

  it("plain with mode 600 when it can't", async () => {
    const store = new TokenStore(dir, crypt(false));
    store.save(TOKEN);
    expect(existsSync(plain())).toBe(true);
    expect(existsSync(bin())).toBe(false);
    expect(readFileSync(plain(), "utf8")).toBe(TOKEN);
    // Windows keeps no Unix mode bits
    if (process.platform !== "win32") expect(statSync(plain()).mode & 0o777).toBe(0o600);
    expect(await store.load()).toEqual({ token: TOKEN });
  });

  it("saving replaces the other file", async () => {
    new TokenStore(dir, crypt(false)).save("111:old-old-old-old-old-old-old");
    const encrypting = new TokenStore(dir, crypt(true));
    encrypting.save(TOKEN);
    expect(existsSync(plain())).toBe(false);
    expect(await encrypting.load()).toEqual({ token: TOKEN });
    const plainStore = new TokenStore(dir, crypt(false));
    plainStore.save("222:new-new-new-new-new-new-new");
    expect(existsSync(bin())).toBe(false);
    expect(await plainStore.load()).toEqual({ token: "222:new-new-new-new-new-new-new" });
  });

  it("null removes both", async () => {
    const store = new TokenStore(dir, crypt(true));
    store.save(TOKEN);
    writeFileSync(plain(), "left over");
    store.save(null);
    expect(existsSync(bin())).toBe(false);
    expect(existsSync(plain())).toBe(false);
    expect(await store.load()).toBeNull();
  });

  it("a decrypt that never ends is unreadable after 5 s", async () => {
    vi.useFakeTimers();
    writeFileSync(bin(), `enc:${TOKEN}`);
    const store = new TokenStore(dir, { ...crypt(true), decrypt: () => new Promise<string>(() => undefined) });
    let result: unknown;
    void store.load().then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ unreadable: true });
  });

  it("a broken file is unreadable", async () => {
    writeFileSync(bin(), "garbage that no keyring wrote");
    expect(await new TokenStore(dir, crypt(true)).load()).toEqual({ unreadable: true });
    // an encrypted token while the system can't decrypt any more (a Linux keyring gone)
    writeFileSync(bin(), `enc:${TOKEN}`);
    const gone: TokenCrypt = { ...crypt(false), decrypt: () => Promise.reject(new Error("no keyring")) };
    expect(await new TokenStore(dir, gone).load()).toEqual({ unreadable: true });
    rmSync(bin());
    writeFileSync(plain(), "  \n");
    expect(await new TokenStore(dir, crypt(false)).load()).toEqual({ unreadable: true });
  });

  it("no file is no token", async () => {
    expect(await new TokenStore(dir, crypt(true)).load()).toBeNull();
  });
});
