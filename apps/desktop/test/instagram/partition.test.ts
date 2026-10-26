import { describe, expect, it } from "vitest";
import type { BrowserCookie } from "@turbodl/shared";
import { INSTAGRAM_PARTITION, blockedFrame, electronCookie, fromElectronCookie, isInstagramScriptHost, signedInNow } from "../../src/main/instagram/partition";

const session: BrowserCookie = {
  domain: ".instagram.com",
  hostOnly: false,
  path: "/",
  secure: true,
  expires: 1_900_000_000,
  name: "sessionid",
  value: "s",
  httpOnly: true,
  sameSite: "lax",
};

describe("the Instagram partition", () => {
  it("lives in memory only: Electron writes persisted cookies unencrypted", () => {
    expect(INSTAGRAM_PARTITION.startsWith("persist:")).toBe(false);
  });

  it("loads pages and frames from Instagram only; images and scripts from anywhere", () => {
    expect(blockedFrame("mainFrame", "https://www.instagram.com/p/C1/")).toBe(false);
    expect(blockedFrame("mainFrame", "https://l.instagram.com/?u=https%3A%2F%2Fevil.example")).toBe(false);
    expect(blockedFrame("mainFrame", "https://evil.example/login")).toBe(true);
    expect(blockedFrame("subFrame", "https://evil.example/frame")).toBe(true);
    expect(blockedFrame("mainFrame", "http://www.instagram.com/")).toBe(true);
    expect(blockedFrame("image", "https://scontent.cdninstagram.com/a.jpg")).toBe(false);
  });

  it("knows Instagram's script hosts: its CDN's, over https", () => {
    expect(isInstagramScriptHost("https://static.cdninstagram.com/rsrc.php/v4/yX/r/abc.js")).toBe(true);
    expect(isInstagramScriptHost("https://scontent-ams2-1.cdninstagram.com/a.js")).toBe(true);
    expect(isInstagramScriptHost("http://static.cdninstagram.com/a.js")).toBe(false);
    expect(isInstagramScriptHost("https://www.instagram.com/a.js")).toBe(false);
    expect(isInstagramScriptHost("https://evilcdninstagram.com/a.js")).toBe(false);
    expect(isInstagramScriptHost("https://static.cdninstagram.com.evil.example/a.js")).toBe(false);
    expect(isInstagramScriptHost("not an address")).toBe(false);
  });

  it("keeps a cookie's HttpOnly and SameSite both ways", () => {
    expect(electronCookie(session)).toMatchObject({ url: "https://instagram.com/", domain: ".instagram.com", httpOnly: true, sameSite: "lax", expirationDate: 1_900_000_000 });
    expect(electronCookie({ ...session, hostOnly: true, domain: "www.instagram.com" })).not.toHaveProperty("domain");
    expect(fromElectronCookie({ ...session, expirationDate: 1_900_000_000, hostOnly: false } as never)).toMatchObject({ httpOnly: true, sameSite: "lax" });
  });

  it("counts a sign-in done only once a new session arrives or the page leaves sign-in and check pages", () => {
    // an old session sitting in the partition while Instagram asks for a check
    expect(signedInNow("old", "old", "https://www.instagram.com/challenge/abc/")).toBe(false);
    expect(signedInNow("old", "old", "https://www.instagram.com/accounts/login/")).toBe(false);
    expect(signedInNow("old", "new", "https://www.instagram.com/challenge/abc/")).toBe(true);
    expect(signedInNow(undefined, "s", "https://www.instagram.com/accounts/login/")).toBe(true);
    expect(signedInNow("old", "old", "https://www.instagram.com/")).toBe(true);
    expect(signedInNow(undefined, undefined, "https://www.instagram.com/")).toBe(false);
  });
});
