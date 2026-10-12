import { classifyMedia, type MediaItem } from "@turbodl/shared";
import { sendMedia } from "./bridge";
import { isHttpUrl } from "./headers";
import { getMedia } from "./media-store";
import { cookieHeader, flashBadge } from "./util";

/** Send the page plus everything detected in the tab (newest first) to the app. */
export async function sendMediaForTab(tabId: number | undefined, pageUrl: string, title: string, srcUrl?: string): Promise<boolean> {
  const detected = tabId !== undefined ? await getMedia(tabId) : [];
  const items: MediaItem[] = [...detected].reverse();
  if (isHttpUrl(srcUrl) && !items.some((m) => m.url === srcUrl)) {
    items.unshift({ url: srcUrl, kind: classifyMedia({ url: srcUrl }) ?? "file" });
  }
  const withCookies = await Promise.all(items.map(async (m) => ({ ...m, cookies: await cookieHeader(m.url) })));
  const ok = await sendMedia({
    pageUrl,
    title,
    items: withCookies,
    cookies: await cookieHeader(pageUrl),
    referrer: pageUrl,
    userAgent: navigator.userAgent,
  });
  if (!ok) flashBadge();
  return ok;
}
