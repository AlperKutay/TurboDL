import { sendDownload } from "./bridge";
import { INSTAGRAM_PAGES, instagramTarget } from "./instagram";
import { ensureApp } from "./launcher";
import { sendMediaForTab } from "./media-request";
import { cookieHeader, cookieJar, flashBadge } from "./util";

export function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "turbodl-link", title: "Download with TurboDL", contexts: ["link"] });
    chrome.contextMenus.create({ id: "turbodl-media", title: "Download with TurboDL", contexts: ["video", "audio"] });
    // the page's own post, story or highlight, read by TurboDL with the browser's Instagram session
    chrome.contextMenus.create({ id: "turbodl-instagram", title: "Open in TurboDL", contexts: ["page", "image"], documentUrlPatterns: INSTAGRAM_PAGES });
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
      if (info.menuItemId === "turbodl-instagram" && info.pageUrl) {
        const target = instagramTarget(info.pageUrl, info.linkUrl);
        // an Instagram page TurboDL doesn't read (home, explore, messages): nothing to send
        if (!target) {
          flashBadge();
          return;
        }
        const result = (await ensureApp())
          ? await sendDownload({
              url: target,
              referrer: info.pageUrl,
              cookieJar: await cookieJar(target),
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
