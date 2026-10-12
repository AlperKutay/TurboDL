import { classifyMedia } from "@turbodl/shared";
import { headerValue, sizeFromHeaders } from "./headers";
import { addMedia, clearMedia, clearMediaBefore } from "./media-store";

export function registerSniffer(): void {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0 || details.statusCode >= 400) return undefined;
      const contentType = headerValue(details.responseHeaders, "content-type");
      const size = sizeFromHeaders(details.responseHeaders);
      const kind = classifyMedia({ url: details.url, contentType, size });
      if (kind) void addMedia(details.tabId, { url: details.url, kind, contentType, size }, details.timeStamp);
      return undefined;
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
    ["responseHeaders"],
  );
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0) void clearMediaBefore(details.tabId, details.timeStamp);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void clearMedia(tabId);
  });
}
