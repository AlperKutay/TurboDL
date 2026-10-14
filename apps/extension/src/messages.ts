import type { MediaItem } from "@turbodl/shared";
import { ping } from "./bridge";
import { ensureApp } from "./launcher";
import { buildMediaRequest, deliverMedia, sendMediaForTab } from "./media-request";

export type ExtensionMessage =
  | { type: "status" }
  | { type: "launch" }
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
      void buildMediaRequest(msg.pageUrl, msg.title, [msg.item])
        .then(deliverMedia)
        .then((ok) => sendResponse({ ok }));
      return true;
    }
    if (msg?.type === "launch") {
      void ensureApp().then((ok) => sendResponse({ ok }));
      return true;
    }
    return false;
  });
}
