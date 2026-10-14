import { sendDownload } from "./bridge";
import { ensureApp } from "./launcher";
import { sendMediaForTab } from "./media-request";
import { cookieHeader, cookieJar, flashBadge } from "./util";

export function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "turbodl-link", title: "Download with TurboDL", contexts: ["link"] });
    chrome.contextMenus.create({ id: "turbodl-media", title: "Download with TurboDL", contexts: ["video", "audio"] });
  });
}

export function registerMenuHandlers(): void {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    void (async () => {
      if (info.menuItemId === "turbodl-link" && info.linkUrl) {
        const result = (await ensureApp())
          ? await sendDownload({
              url: info.linkUrl,
              referrer: info.pageUrl,
              cookies: await cookieHeader(info.linkUrl),
              cookieJar: await cookieJar(info.linkUrl),
              userAgent: navigator.userAgent,
              source: "context-menu",
            })
          : { ok: false };
        if (!result.ok) flashBadge();
        return;
      }
      if (info.menuItemId === "turbodl-media") {
        await sendMediaForTab(tab?.id, info.frameUrl ?? info.pageUrl ?? tab?.url ?? "", tab?.title ?? "", info.srcUrl);
      }
    })();
  });
}
