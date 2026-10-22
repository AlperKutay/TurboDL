import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserCookie } from "@turbodl/shared";
import { InstagramSession, type Crypt } from "../../src/main/instagram/session";

/** Reversible and unreadable enough to show the file never holds the cookies as written. */
const crypt: Crypt = {
  available: () => true,
  encrypt: (text) => Buffer.from(Buffer.from(text, "utf8").map((b) => b ^ 0x5a)),
  decrypt: (data) => Buffer.from(data.map((b) => b ^ 0x5a)).toString("utf8"),
};
const noCrypt: Crypt = { ...crypt, available: () => false };

const cookie = (name: string, value: string, domain = ".instagram.com", expires = 0): BrowserCookie => ({
  domain,
  hostOnly: false,
  path: "/",
  secure: true,
  expires,
  name,
  value,
});
const session = cookie("sessionid", "secret-session-value");

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "turbodl-ig-session-"));
  file = path.join(dir, "instagram-session.bin");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("InstagramSession", () => {
  it("keeps only Instagram's cookies from a jar", () => {
    const s = new InstagramSession(file, crypt);
    expect(s.take([session, cookie("csrftoken", "c", "www.instagram.com"), cookie("SID", "g", ".google.com")])).toBe(true);
    expect(s.cookies().map((c) => c.name)).toEqual(["sessionid", "csrftoken"]);
    expect(s.signedIn()).toBe(true);
  });

  it("keeps a working session when a jar comes without sessionid", () => {
    const s = new InstagramSession(file, crypt);
    s.take([session, cookie("csrftoken", "c")]);
    expect(s.take([cookie("csrftoken", "other"), cookie("mid", "m")])).toBe(false);
    expect(s.cookies().find((c) => c.name === "csrftoken")?.value).toBe("c");
    expect(s.signedIn()).toBe(true);
  });

  it("keeps the cookies encrypted on disk and reads them back", () => {
    new InstagramSession(file, crypt).take([session]);
    expect(readFileSync(file).toString("utf8")).not.toContain("secret-session-value");
    const again = new InstagramSession(file, crypt);
    again.load();
    expect(again.signedIn()).toBe(true);
    expect(again.cookies()[0].value).toBe("secret-session-value");
  });

  it("keeps them in memory only when the system can't encrypt", () => {
    const s = new InstagramSession(file, noCrypt);
    s.take([session]);
    expect(s.signedIn()).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("counts an expired session as signed out", () => {
    const s = new InstagramSession(file, crypt);
    s.take([cookie("sessionid", "v", ".instagram.com", 1_000_000)]);
    expect(s.signedIn(new Date(2_000_000_000 * 1000))).toBe(false);
    expect(s.signedIn(new Date(500_000 * 1000))).toBe(true);
  });

  it("reads a broken file as signed out", () => {
    writeFileSync(file, Buffer.from("not ours"));
    const s = new InstagramSession(file, crypt);
    s.load();
    expect(s.signedIn()).toBe(false);
    expect(s.cookies()).toEqual([]);
  });

  it("forgets everything on clear", () => {
    const s = new InstagramSession(file, crypt);
    s.take([session]);
    s.clear();
    expect(s.signedIn()).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});
