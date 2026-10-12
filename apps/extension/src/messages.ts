import type { MediaItem } from "@turbodl/shared";
import { ping, sendMedia } from "./bridge";
import { sendMediaForTab } from "./media-request";
import { cookieHeader, flashBadge } from "./util";

export type ExtensionMessage =
  | { type: "status" }
  | { type: "media-request"; tabId?: number; pageUrl: string; title: string; srcUrl?: string }
  | { type: "send-media-item"; pageUrl: string; title: string; item: MediaItem };

export interface MessageReply {
  ok: boolean;
}

export function registerMessages(): void {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse: (reply: MessageReply) => void) => {
    const msg = raw as ExtensionMessage;
    if (msg?.type === "status") {
      void ping().then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === "media-request") {
      const tabId = msg.tabId ?? sender.tab?.id;
      void sendMediaForTab(tabId, msg.pageUrl, msg.title || sender.tab?.title || "", msg.srcUrl).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === "send-media-item") {
      void (async () => {
        const ok = await sendMedia({
          pageUrl: msg.pageUrl,
          title: msg.title,
          items: [{ ...msg.item, cookies: await cookieHeader(msg.item.url) }],
          cookies: await cookieHeader(msg.pageUrl),
          referrer: msg.pageUrl,
          userAgent: navigator.userAgent,
        });
        if (!ok) flashBadge();
        sendResponse({ ok });
      })();
      return true;
    }
    return false;
  });
}
