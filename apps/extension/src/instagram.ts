import { parseInstagramLink } from "@turbodl/shared";

/** Posts, reels, stories, highlights, saved pages, and profiles (whose addresses end with "/"). */
const PATHS = ["/p/*", "/reel/*", "/reels/*", "/tv/*", "/stories/*", "/s/*", "/*/p/*", "/*/reel/*", "/*/saved/*", "/*/", "/*/reels/*", "/*/tagged/*"];

/** Where "Open in TurboDL" shows: the Instagram pages TurboDL reads (a few others match too; nothing is sent from them). */
export const INSTAGRAM_PAGES = ["https://www.instagram.com", "https://instagram.com"].flatMap((site) => PATHS.map((path) => site + path));

/** Whether TurboDL reads this Instagram address. */
const reads = (address: string) => parseInstagramLink(address) !== null;

/** The post, story, highlight, saved page or profile a right-clicked picture links to, else the page itself; null when TurboDL reads neither. */
export function instagramTarget(pageUrl: string, linkUrl?: string): string | null {
  if (linkUrl && reads(linkUrl)) return linkUrl;
  return reads(pageUrl) ? pageUrl : null;
}
