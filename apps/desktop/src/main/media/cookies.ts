import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserCookie } from "@turbodl/shared";

const BREAKS_LINE = /[\t\r\n]/;

/**
 * Netscape cookies.txt for yt-dlp (--cookies). Python's loader insists that the
 * "include subdomains" flag matches a leading dot on the domain, so both come from hostOnly.
 */
export function netscapeCookies(cookies: BrowserCookie[]): string {
  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of cookies) {
    const host = c.domain.replace(/^\.+/, "");
    const cookiePath = c.path || "/";
    if (!host || !c.name || BREAKS_LINE.test(host + cookiePath + c.name + c.value)) continue;
    const expires = Number.isFinite(c.expires) && c.expires > 0 ? Math.floor(c.expires) : 0;
    lines.push(
      [c.hostOnly ? host : `.${host}`, c.hostOnly ? "FALSE" : "TRUE", cookiePath, c.secure ? "TRUE" : "FALSE", String(expires), c.name, c.value].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** A Cookie request header as session cookies for the URL's host only. */
export function cookiesFromHeader(header: string | undefined, url: string): BrowserCookie[] {
  if (!header) return [];
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: BrowserCookie[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    const name = eq > 0 ? part.slice(0, eq).trim() : "";
    if (!name) continue;
    out.push({ domain: u.hostname, hostOnly: true, path: "/", secure: u.protocol === "https:", expires: 0, name, value: part.slice(eq + 1).trim() });
  }
  return out;
}

/** Runs fn with a private temporary cookie file (null when there are no cookies) and deletes it afterwards. */
export async function withCookieFile<T>(cookies: BrowserCookie[] | undefined, fn: (file: string | null) => Promise<T>): Promise<T> {
  if (!cookies || cookies.length === 0) return fn(null);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "turbodl-ck-"));
  try {
    const file = path.join(dir, "cookies.txt");
    await fsp.writeFile(file, netscapeCookies(cookies), { mode: 0o600 });
    return await fn(file);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
