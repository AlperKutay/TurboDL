import { isSignInPath, postItems, storyItems, type InstagramItem, type InstagramLink } from "@turbodl/shared";

/** An Instagram page in a hidden window, as the finder needs it (`ElectronInstagramPage`, or a stand-in in tests). */
export interface PageDriver {
  load(url: string): Promise<void>;
  /** The JSON the page has received so far, and the JSON embedded in it. */
  documents(): Promise<string[]>;
  finalUrl(): string;
  close(): void;
}

export type FindOutcome = { type: "items"; items: InstagramItem[] } | { type: "signedOut" } | { type: "nothing" };

export interface FinderOptions {
  /** ms between looks at the page */
  poll?: number;
  /** ms before giving up */
  timeout?: number;
  /** what the page held when nothing was found, for a debug dump */
  report?: (url: string, documents: string[]) => void;
}

const SITE = "https://www.instagram.com";

/** The page a link's items are read from; profiles and saved pages are read elsewhere. */
export function pageFor(link: InstagramLink): string | null {
  switch (link.kind) {
    case "post":
      return `${SITE}/p/${encodeURIComponent(link.code)}/`;
    case "story":
      return `${SITE}/stories/${encodeURIComponent(link.username)}/${encodeURIComponent(link.item)}/`;
    case "highlight":
      return `${SITE}/stories/highlights/${encodeURIComponent(link.id)}/`;
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

  async find(link: InstagramLink): Promise<FindOutcome> {
    const url = pageFor(link);
    if (!url) return { type: "nothing" };
    const page = this.page();
    try {
      await page.load(url);
      const deadline = Date.now() + this.timeout;
      let documents: string[] = [];
      for (;;) {
        if (signInPage(page.finalUrl())) return { type: "signedOut" };
        documents = await page.documents();
        const items = link.kind === "post" ? postItems(documents, link.code) : link.kind === "story" || link.kind === "highlight" ? storyItems(documents, link) : [];
        if (items.length > 0) return { type: "items", items };
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, this.poll));
      }
      this.o.report?.(url, documents);
      return { type: "nothing" };
    } finally {
      page.close();
    }
  }
}

function signInPage(address: string): boolean {
  try {
    return isSignInPath(new URL(address).pathname);
  } catch {
    return false;
  }
}
