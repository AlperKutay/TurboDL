import { isSignInPath, loggedOutView, postItems, postNeedsSignIn, storyItems, type InstagramItem, type InstagramLink } from "@turbodl/shared";

/** An Instagram page in a hidden window, as the finder needs it (`ElectronInstagramPage`, or a stand-in in tests). */
export interface PageDriver {
  load(url: string): Promise<void>;
  /** The JSON the page has received so far, and the JSON embedded in it. */
  documents(): Promise<string[]>;
  finalUrl(): string;
  close(): void;
}

/** `signedOut.at`: the check page (not the sign-in page) Instagram sent the page to, for the sign-in window to open. */
export type FindOutcome = { type: "items"; items: InstagramItem[] } | { type: "signedOut"; at?: string } | { type: "nothing" };

export interface FinderOptions {
  /** ms between looks at the page */
  poll?: number;
  /** ms before giving up */
  timeout?: number;
  /** what the page held when nothing was found, for a debug dump */
  report?: (url: string, documents: string[]) => void;
  /** where the pages are loaded from: Instagram, or a stand-in in end-to-end tests */
  site?: string;
}

const SITE = "https://www.instagram.com";

/** The page a link's items are read from; profiles and saved pages are read elsewhere. */
export function pageFor(link: InstagramLink, site = SITE): string | null {
  switch (link.kind) {
    case "post":
      return `${site}/p/${encodeURIComponent(link.code)}/`;
    case "story":
      return `${site}/stories/${encodeURIComponent(link.username)}/${encodeURIComponent(link.item)}/`;
    case "highlight":
      return `${site}/stories/highlights/${encodeURIComponent(link.id)}/`;
    default:
      return null;
  }
}

/** Reads a post's, story's or highlight's items from its signed-in page, the way the iPhone app's share sheet does. */
export class InstagramFinder {
  private readonly poll: number;
  private readonly timeout: number;

  constructor(
    private readonly page: () => PageDriver,
    private readonly o: FinderOptions = {},
  ) {
    this.poll = o.poll ?? 500;
    this.timeout = o.timeout ?? 12_000;
  }

  /**
   * Looks while the page loads (its JSON comes long before its last picture, and a load may never end), until the
   * deadline; `signal` calls it off. Whatever happens, the page is closed afterwards.
   */
  async find(link: InstagramLink, signal?: AbortSignal): Promise<FindOutcome> {
    const url = pageFor(link, this.o.site);
    if (!url || signal?.aborted) return { type: "nothing" };
    const deadline = Date.now() + this.timeout;
    let page: PageDriver | null = null;
    try {
      page = this.page();
      let failed = false;
      page.load(url).catch(() => {
        failed = true;
      });
      let documents: string[] = [];
      for (;;) {
        if (failed) return { type: "nothing" };
        const landing = signInLanding(page.finalUrl());
        if (landing) return landing;
        // a look at a page between loads may never answer
        const seen = await within(page.documents(), Math.min(deadline, Date.now() + LOOK), signal);
        if (signal?.aborted) return { type: "nothing" };
        if (seen) {
          documents = seen;
          const items = link.kind === "post" ? postItems(documents, link.code) : link.kind === "story" || link.kind === "highlight" ? storyItems(documents, link) : [];
          if (items.length > 0) return { type: "items", items };
          // the signed-out page keeps a post it won't show as an empty field: no need to wait for it
          if (link.kind === "post" && postNeedsSignIn(documents, link.code)) return { type: "signedOut" };
        }
        if (Date.now() >= deadline) break;
        await within(new Promise((r) => setTimeout(r, this.poll)), Infinity, signal);
        if (signal?.aborted) return { type: "nothing" };
      }
      // the session TurboDL keeps no longer works: Instagram served the page as to a signed-out visitor
      if (loggedOutView(documents)) return { type: "signedOut" };
      this.o.report?.(url, documents);
      return { type: "nothing" };
    } catch {
      return { type: "nothing" };
    } finally {
      page?.close();
    }
  }
}

/** ms one look at the page may take */
const LOOK = 3000;

/** What `work` gives, or undefined when the deadline passes or `signal` aborts first. */
function within<T>(work: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    const timer = Number.isFinite(deadline) ? setTimeout(() => finish(undefined), Math.max(0, deadline - Date.now())) : undefined;
    const onAbort = () => finish(undefined);
    signal?.addEventListener("abort", onAbort);
    function finish(value: T | undefined) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    }
    work.then(finish, () => finish(undefined));
  });
}

/** Instagram sent the page to sign-in, or to a check (kept as `at`, the sign-in window opens there). */
function signInLanding(address: string): FindOutcome | null {
  let u: URL;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  if (!isSignInPath(u.pathname)) return null;
  return u.pathname.startsWith("/challenge") ? { type: "signedOut", at: u.href } : { type: "signedOut" };
}
