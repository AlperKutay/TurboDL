import { classifyMedia, type MediaItem, type MediaRequest } from "@turbodl/shared";
import { sendMedia } from "./bridge";
import { isHttpUrl } from "./headers";
import { ensureApp } from "./launcher";
import { getMedia } from "./media-store";
import { cookieHeader, cookieJar, flashBadge } from "./util";

/** Everything the app needs for a page: detected media with their cookies, and the page's own cookies. */
export async function buildMediaRequest(pageUrl: string, title: string, items: MediaItem[]): Promise<MediaRequest> {
  const withCookies = await Promise.all(items.map(async (m) => ({ ...m, cookies: await cookieHeader(m.url) })));
  return {
    pageUrl,
    title,
    items: withCookies,
    cookies: await cookieHeader(pageUrl),
    cookieJar: await cookieJar(pageUrl),
    referrer: pageUrl,
    userAgent: navigator.userAgent,
  };
}

/** Send a media request, starting TurboDL first if it is closed. */
export async function deliverMedia(req: MediaRequest): Promise<boolean> {
  const ok = (await ensureApp()) && (await sendMedia(req));
  if (!ok) flashBadge();
  return ok;
}

/** Send the page plus everything detected in the tab (newest first) to the app. */
export async function sendMediaForTab(tabId: number | undefined, pageUrl: string, title: string, srcUrl?: string): Promise<boolean> {
  const detected = tabId !== undefined ? await getMedia(tabId) : [];
  const items: MediaItem[] = [...detected].reverse();
  if (isHttpUrl(srcUrl) && !items.some((m) => m.url === srcUrl)) {
    items.unshift({ url: srcUrl, kind: classifyMedia({ url: srcUrl }) ?? "file" });
  }
  return deliverMedia(await buildMediaRequest(pageUrl, title, items));
}
