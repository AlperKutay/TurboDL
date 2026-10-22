import type { Cookie, CookiesSetDetails } from "electron";
import { isSignInPath, type BrowserCookie } from "@turbodl/shared";

/**
 * The session the hidden pages and the sign-in window share, in memory only: Electron writes a `persist:`
 * partition's cookies to disk unencrypted. The session itself is kept by `InstagramSession`, through safeStorage.
 */
export const INSTAGRAM_PARTITION = "instagram";

/** Pages and requests the hidden windows may load: Instagram itself. */
export function isInstagramAddress(address: string): boolean {
  try {
    const u = new URL(address);
    const host = u.hostname.toLowerCase();
    return u.protocol === "https:" && (host === "instagram.com" || host.endsWith(".instagram.com"));
  } catch {
    return false;
  }
}

/** Pages and frames come from Instagram only, also after a redirect; pictures, scripts and the rest from anywhere. */
export function blockedFrame(resourceType: string, url: string): boolean {
  return (resourceType === "mainFrame" || resourceType === "subFrame") && !isInstagramAddress(url);
}

/** A kept cookie as Electron sets it. */
export function electronCookie(c: BrowserCookie): CookiesSetDetails {
  const host = c.domain.replace(/^\.+/, "");
  return {
    url: `https://${host}${c.path || "/"}`,
    name: c.name,
    value: c.value,
    ...(c.hostOnly ? {} : { domain: c.domain }),
    path: c.path || "/",
    secure: c.secure,
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
  };
}

/** An Electron cookie as TurboDL keeps it. */
export function fromElectronCookie(c: Cookie): BrowserCookie {
  return {
    domain: c.domain ?? "",
    hostOnly: c.hostOnly ?? false,
    path: c.path ?? "/",
    secure: c.secure ?? true,
    expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
    name: c.name,
    value: c.value,
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

/**
 * Whether the sign-in window is done: a session is there, and it is new or the page has left Instagram's sign-in and
 * check pages. An old session that Instagram wants checked doesn't count.
 */
export function signedInNow(initial: string | undefined, current: string | undefined, url: string): boolean {
  if (!current) return false;
  if (current !== initial) return true;
  try {
    return !isSignInPath(new URL(url).pathname);
  } catch {
    return false;
  }
}
