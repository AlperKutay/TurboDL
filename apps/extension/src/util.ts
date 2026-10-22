import type { BrowserCookie } from "@turbodl/shared";

export async function cookieHeader(url: string): Promise<string | undefined> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.length > 0 ? cookies.map((c) => `${c.name}=${c.value}`).join("; ") : undefined;
  } catch {
    return undefined;
  }
}

/** The browser's cookies for a URL with their domains, for yt-dlp's cookie file. */
export async function cookieJar(url: string): Promise<BrowserCookie[]> {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return cookies.map((c) => ({
      domain: c.domain,
      hostOnly: c.hostOnly,
      path: c.path,
      secure: c.secure,
      expires: c.expirationDate ? Math.floor(c.expirationDate) : 0,
      name: c.name,
      value: c.value,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
    }));
  } catch {
    return [];
  }
}

/** Show a red "!" on the toolbar icon for a few seconds (app unreachable, request declined). */
export function flashBadge(text = "!"): void {
  void chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
  void chrome.action.setBadgeText({ text });
  setTimeout(() => void chrome.action.setBadgeText({ text: "" }), 4000);
}
