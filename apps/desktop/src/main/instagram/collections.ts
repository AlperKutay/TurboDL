import { isSignInPath, savedCollections, type SavedCollection } from "@turbodl/shared";
import { within, type PageDriver } from "./finder";

export interface CollectionsOptions {
  /** ms between looks at the page */
  poll?: number;
  /** ms before giving up */
  timeout?: number;
  maxScrolls?: number;
  /** where the page is loaded from: Instagram, or a stand-in in end-to-end tests */
  site?: string;
}

/** ms a look at the page, or a scroll, may take */
const LOOK = 2000;
/** looks without a new collection, after a scroll, before the list counts as complete */
const QUIET_LOOKS = 4;

/**
 * The account's collections, read from its desktop saved page (Instagram's REST list isn't open to web clients),
 * scrolled once per new batch while more are listed. Null when the page listed nothing in time; closed afterwards.
 */
export async function loadCollections(page: () => PageDriver, username: string, o: CollectionsOptions = {}): Promise<SavedCollection[] | null> {
  const poll = o.poll ?? 500;
  const maxScrolls = o.maxScrolls ?? 10;
  const deadline = Date.now() + (o.timeout ?? 20_000);
  let list: SavedCollection[] = [];
  let driver: PageDriver | null = null;
  try {
    driver = page();
    let failed = false;
    driver.load(`${o.site ?? "https://www.instagram.com"}/${encodeURIComponent(username)}/saved/`).catch(() => {
      failed = true;
    });
    let scrolls = 0;
    let countAtScroll = 0;
    let quiet = 0;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, poll));
      if (failed || onSignInPage(driver.finalUrl())) break;
      const documents = await within(driver.documents(), Math.min(deadline, Date.now() + LOOK));
      const found = savedCollections(documents ?? []);
      if (found.list.length === 0) continue;
      list = found.list;
      if (!found.hasMore || scrolls >= maxScrolls) break;
      if (list.length > countAtScroll) {
        // more are listed as the page scrolls: one scroll per new batch
        countAtScroll = list.length;
        quiet = 0;
        await within(driver.scrollToEnd(), Date.now() + LOOK);
        scrolls++;
      } else if (++quiet >= QUIET_LOOKS) {
        break;
      }
    }
  } catch {
    // what was listed before the page failed still counts
  } finally {
    driver?.close();
  }
  return list.length > 0 ? list : null;
}

function onSignInPage(address: string): boolean {
  try {
    return isSignInPath(new URL(address).pathname);
  } catch {
    return false;
  }
}
