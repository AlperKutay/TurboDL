import {
  SavedError,
  highlightsTray,
  isSignInPath,
  profileIn,
  profilePosts,
  profilePostsAnswer,
  signedOutProfile,
  signedOutProfileView,
  type Highlight,
  type InstagramProfile,
  type ProfilePosts,
  type SavedPage,
} from "@turbodl/shared";
import { within, type PageDriver } from "./finder";

/** The profile page as the feed needs it: also its own posts request sent again, and an end to keeping its answers. */
export interface ProfileDriver extends PageDriver {
  /** the page's own posts request from after `cursor`; null until the page has made one */
  resend(cursor: string): Promise<{ status: number; text: string } | null>;
  /** the first load is read: forget its answers and keep no more (each posts answer is over a megabyte) */
  stopCollecting(): void;
}

export interface ProfileFeedOptions {
  /** ms between looks at the page */
  poll?: number;
  /** ms the first load may take */
  firstLoad?: number;
  /** ms more the first load waits for the highlights tray once the profile and posts are in */
  trayWait?: number;
  /** ms a next page waits for the page to make its own posts request */
  requestWait?: number;
  /** where the page is loaded from: Instagram, or a stand-in in end-to-end tests */
  site?: string;
  /** the page was loaded with a session: its signed-out view counts only when the signed-in one never comes */
  signedIn?: boolean;
}

/** ms one look at the page may take */
const LOOK = 3000;

/**
 * A profile's posts, page by page: the first ones from its loaded page, the rest by sending the page's own posts
 * request again with the last cursor (Instagram answers REST requests for profiles as spam). Keeps nothing per caller,
 * so the grid and a backup page through it alike.
 */
export class ProfileFeed {
  private loading: Promise<InstagramProfile> | null = null;
  private first: ProfilePosts | null = null;
  /** the profile's highlights, once it is loaded; empty when it has none or the page didn't send them in time */
  highlights: Highlight[] = [];
  /** seen as signed-out visitors see it: its first posts by their covers, no next pages */
  limited = false;

  constructor(
    private readonly driver: ProfileDriver,
    readonly username: string,
    private readonly o: ProfileFeedOptions = {},
  ) {}

  /** Loads the profile page once and waits for the profile and its first posts; throws SavedError. */
  profile(): Promise<InstagramProfile> {
    this.loading ??= this.load().catch((err: unknown) => {
      // a failed load may be tried again
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  /** No cursor: the posts the page loaded; otherwise the page after it. */
  async page(cursor?: string, signal?: AbortSignal): Promise<SavedPage> {
    const first = this.first;
    if (!first) throw new SavedError("badAnswer");
    if (cursor === undefined) return toPage(first);
    let answer = await this.driver.resend(cursor);
    if (!answer) {
      // the page asks for more only when it is scrolled
      await this.driver.scrollToEnd();
      const deadline = Date.now() + (this.o.requestWait ?? 6000);
      while (!answer && Date.now() < deadline && !signal?.aborted) {
        await sleep(this.o.poll ?? 500);
        answer = await this.driver.resend(cursor);
      }
    }
    if (!answer) throw new SavedError("badAnswer");
    return toPage(profilePostsAnswer(answer.text, answer.status));
  }

  close(): void {
    this.driver.close();
  }

  private async load(): Promise<InstagramProfile> {
    const poll = this.o.poll ?? 500;
    const deadline = Date.now() + (this.o.firstLoad ?? 15_000);
    let failed = false;
    this.driver.load(`${this.o.site ?? "https://www.instagram.com"}/${encodeURIComponent(this.username)}/`).catch(() => {
      failed = true;
    });
    let lastLook = false;
    while (!lastLook) {
      lastLook = Date.now() >= deadline;
      if (failed) break;
      if (onSignInPage(this.driver.finalUrl())) throw new SavedError("signedOut");
      let documents = (await within(this.driver.documents(), Date.now() + LOOK)) ?? [];
      const profile = profileIn(documents, this.username);
      const posts = profilePosts(documents);
      // posts carry their owner without the count and may come before the profile does; only the last look settles for that
      if (profile && (profile.postCount !== undefined || lastLook) && posts) {
        let tray = highlightsTray(documents);
        const trayDeadline = Date.now() + (this.o.trayWait ?? 2000);
        while (!tray && Date.now() < trayDeadline) {
          await sleep(poll);
          documents = (await within(this.driver.documents(), Date.now() + LOOK)) ?? documents;
          tray = highlightsTray(documents);
        }
        this.first = profilePosts(documents) ?? posts;
        this.highlights = tray ?? [];
        this.driver.stopCollecting();
        return profile;
      }
      // a public profile as signed-out visitors see it (with a session: only when the signed-in view never came)
      const open = signedOutProfile(documents, this.username);
      if (open && (!this.o.signedIn || lastLook)) {
        this.first = { posts: open.posts, hasNext: false };
        this.highlights = open.highlights;
        this.limited = true;
        this.driver.stopCollecting();
        return open.profile;
      }
      if (signedOutProfileView(documents, this.username)) throw new SavedError("signedOut");
      if (!lastLook) await sleep(poll);
    }
    throw new SavedError("badAnswer");
  }
}

function toPage(posts: ProfilePosts): SavedPage {
  return { posts: posts.posts, ...(posts.hasNext && posts.cursor ? { next: posts.cursor } : {}) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function onSignInPage(address: string): boolean {
  try {
    return isSignInPath(new URL(address).pathname);
  } catch {
    return false;
  }
}
