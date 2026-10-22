/**
 * Electron's user agent without what marks it as Electron or as TurboDL: Instagram's pages and its CDN then see the
 * Chrome the app is built on, as in the browser the session came from.
 */
export function chromeAgent(electronAgent: string): string {
  return electronAgent
    .replace(/\s(?:Electron|TurboDL|@turbodl\/desktop|turbodl)\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
