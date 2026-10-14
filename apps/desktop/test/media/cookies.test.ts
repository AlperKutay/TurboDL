import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BrowserCookie } from "@turbodl/shared";
import { cookiesFromHeader, netscapeCookies, withCookieFile } from "../../src/main/media/cookies";

const domainCookie: BrowserCookie = { domain: ".youtube.com", hostOnly: false, path: "/", secure: true, expires: 1999999999.75, name: "SAPISID", value: "a/b=c" };
const hostCookie: BrowserCookie = { domain: "www.youtube.com", hostOnly: true, path: "/", secure: false, expires: 0, name: "PREF", value: 'f6="40000000"' };

describe("netscapeCookies", () => {
  it("writes one tab-separated line per cookie under the Netscape header", () => {
    expect(netscapeCookies([domainCookie, hostCookie]).split("\n")).toEqual([
      "# Netscape HTTP Cookie File",
      ".youtube.com\tTRUE\t/\tTRUE\t1999999999\tSAPISID\ta/b=c",
      'www.youtube.com\tFALSE\t/\tFALSE\t0\tPREF\tf6="40000000"',
      "",
    ]);
  });

  it("keeps the subdomain flag in step with the leading dot, as yt-dlp's loader requires", () => {
    const lines = netscapeCookies([{ ...domainCookie, domain: "youtube.com" }, { ...hostCookie, domain: ".www.youtube.com" }]).split("\n");
    expect(lines[1].startsWith(".youtube.com\tTRUE\t")).toBe(true);
    expect(lines[2].startsWith("www.youtube.com\tFALSE\t")).toBe(true);
  });

  it("drops cookies that would break the file", () => {
    const text = netscapeCookies([
      { ...hostCookie, value: "a\tb" },
      { ...hostCookie, name: "" },
      { ...hostCookie, name: "x\ny" },
      { ...hostCookie, domain: "." },
    ]);
    expect(text).toBe("# Netscape HTTP Cookie File\n");
  });
});

describe("cookiesFromHeader", () => {
  it("turns a Cookie header into session cookies for that host only", () => {
    expect(cookiesFromHeader("a=1; b=x=y ;bad; =z", "https://cdn.example.com/v/master.m3u8")).toEqual([
      { domain: "cdn.example.com", hostOnly: true, path: "/", secure: true, expires: 0, name: "a", value: "1" },
      { domain: "cdn.example.com", hostOnly: true, path: "/", secure: true, expires: 0, name: "b", value: "x=y" },
    ]);
    expect(cookiesFromHeader(undefined, "https://x.example/")).toEqual([]);
    expect(cookiesFromHeader("a=1", "not a url")).toEqual([]);
  });
});

describe("withCookieFile", () => {
  it("hands over a private cookie file and deletes it afterwards", async () => {
    let seen = "";
    const result = await withCookieFile([hostCookie], async (file) => {
      seen = file!;
      expect(readFileSync(file!, "utf8")).toContain("\tPREF\t");
      if (process.platform !== "win32") expect(statSync(file!).mode & 0o777).toBe(0o600);
      return 7;
    });
    expect(result).toBe(7);
    expect(path.basename(path.dirname(seen))).toMatch(/^turbodl-ck-/);
    expect(existsSync(path.dirname(seen))).toBe(false);
  });

  it("deletes the file even when the work fails", async () => {
    let seen = "";
    await expect(
      withCookieFile([hostCookie], async (file) => {
        seen = file!;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(seen)).toBe(false);
  });

  it("passes null when there are no cookies", async () => {
    expect(await withCookieFile([], async (file) => file)).toBeNull();
    expect(await withCookieFile(undefined, async (file) => file)).toBeNull();
  });
});
