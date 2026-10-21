import { parseInstagramLink } from "@turbodl/shared";

const PATHS = ["/p/*", "/reel/*", "/reels/*", "/tv/*", "/stories/*", "/s/*", "/*/p/*", "/*/reel/*"];

/** Where "Open in TurboDL" shows: the Instagram pages TurboDL reads (posts, reels, stories, highlights). */
export const INSTAGRAM_PAGES = ["https://www.instagram.com", "https://instagram.com"].flatMap((site) => PATHS.map((path) => site + path));

/** The post, reel, story or highlight a right-clicked picture links to, otherwise the page itself. */
export function instagramTarget(pageUrl: string, linkUrl?: string): string {
  const link = linkUrl ? parseInstagramLink(linkUrl) : null;
  return link && (link.kind === "post" || link.kind === "story" || link.kind === "highlight") ? (linkUrl as string) : pageUrl;
}
