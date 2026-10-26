import { sanitizeFilename, type InstagramItem, type NewDownload } from "@turbodl/shared";
import { instagramExtension } from "./files";
import { itemFolder } from "./folders";

export interface ItemTarget {
  defaultDir: string;
  baseDir: string;
  byAccount: boolean;
  highlight: boolean;
  fallback: string;
  pageUrl: string;
  agent: string;
}

/** One picked Instagram item as the manager takes it: its account's folder, named by Instagram's id, the CDN's headers. */
export function itemDownload(item: InstagramItem, index: number, t: ItemTarget): NewDownload {
  return {
    kind: "http",
    url: item.url,
    pageUrl: t.pageUrl,
    filename: sanitizeFilename(`${item.mediaId ?? `${t.fallback}-${index + 1}`}.${instagramExtension(item)}`),
    dir: itemFolder(t.defaultDir, item, { baseDir: t.baseDir, byAccount: t.byAccount, highlight: t.highlight }),
    category: item.kind === "video" ? "video" : "images",
    size: null,
    resumable: true,
    headers: { Referer: "https://www.instagram.com/", ...(t.agent ? { "User-Agent": t.agent } : {}) },
  };
}
