import { SavedError, signedOutProfileView, taggedAnswer, taggedPosts, type ProfilePosts, type SavedPage } from "@turbodl/shared";
import { within } from "./finder";
import { LOOK, onSignInPage, resendPaging, sleep, toPage, type ProfileDriver } from "./profile-feed";

/** The tagged page as the feed needs it (`ElectronInstagramPage` with the tagged paging matcher, or a stand-in in tests). */
export type TaggedDriver = Pick<ProfileDriver, "load" | "documents" | "finalUrl" | "scrollToEnd" | "resend" | "stopCollecting" | "close">;

/** A profile's tagged posts as the service needs them (`TaggedFeed` over a hidden page, or a demo). */
export interface TaggedSource {
  /** loads /<username>/tagged/ once; throws SavedError("signedOut") on the sign-in page, SavedError("badAnswer") when nothing readable came */
  load(): Promise<void>;
  /** no cursor: the posts the page loaded */
  page(cursor?: string, signal?: AbortSignal): Promise<SavedPage>;
  close(): void;
}

export interface TaggedFeedOptions {
  /** ms between looks at the page */
  poll?: number;
  /** ms the first load may take */
  firstLoad?: number;
  /** ms a next page waits for the page to make its own paging request */
  requestWait?: number;
  /** where the page is loaded from: Instagram, or a stand-in in end-to-end tests */
  site?: string;
  /** what the page held when nothing readable was on it, for a debug dump */
  report?: (url: string, documents: string[]) => void;
}

/**
 * The posts a profile is tagged in, page by page, as its signed-in Tagged tab shows them: the first ones from the loaded
 * page, the rest by sending the page's own paging request again with the last cursor. There is no signed-out view of
 * the tab. Keeps nothing per caller.
 */
export class TaggedFeed implements TaggedSource {
  private loading: Promise<void> | null = null;
  private first: ProfilePosts | null = null;

  constructor(
    private readonly driver: TaggedDriver,
    readonly username: string,
    private readonly o: TaggedFeedOptions = {},
  ) {}

  load(): Promise<void> {
    this.loading ??= this.read().catch((err: unknown) => {
      // a failed load may be tried again
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  async page(cursor?: string, signal?: AbortSignal): Promise<SavedPage> {
    const first = this.first;
    if (!first) throw new SavedError("badAnswer");
    if (cursor === undefined) return toPage(first);
    const answer = await resendPaging(this.driver, cursor, this.o, signal);
    return toPage(taggedAnswer(answer.text, answer.status));
  }

  close(): void {
    this.driver.close();
  }

  private async read(): Promise<void> {
    const url = `${this.o.site ?? "https://www.instagram.com"}/${encodeURIComponent(this.username)}/tagged/`;
    const poll = this.o.poll ?? 500;
    const deadline = Date.now() + (this.o.firstLoad ?? 15_000);
    let failed = false;
    this.driver.load(url).catch(() => {
      failed = true;
    });
    let documents: string[] = [];
    let lastLook = false;
    while (!lastLook && !failed) {
      lastLook = Date.now() >= deadline;
      if (onSignInPage(this.driver.finalUrl())) throw new SavedError("signedOut");
      documents = (await within(this.driver.documents(), Date.now() + LOOK)) ?? documents;
      const posts = taggedPosts(documents);
      if (posts) {
        this.first = posts;
        this.driver.stopCollecting();
        return;
      }
      // the session is gone: Instagram showed the profile as everyone sees it, without the tab
      if (signedOutProfileView(documents, this.username)) throw new SavedError("signedOut");
      if (!lastLook) await sleep(poll);
    }
    this.o.report?.(url, documents);
    throw new SavedError("badAnswer");
  }
}
