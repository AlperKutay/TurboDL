import {
  SIGNED_OUT_POSTS_QUERY,
  SIGNED_OUT_TRAY_QUERY,
  SavedError,
  highlightsTray,
  isSignInPath,
  profileIn,
  profilePosts,
  profilePostsAnswer,
  signedOutPostsAnswer,
  signedOutProfile,
  signedOutProfileView,
  signedOutTrayAnswer,
  type Highlight,
  type InstagramProfile,
  type ProfilePosts,
  type SavedPage,
} from "@turbodl/shared";
import { within, type PageDriver } from "./finder";
import { STALE_SIGNED_OUT, STALE_SIGNED_OUT_TRAY, operationIds } from "./signed-out";

/**
 * The profile page as the feed needs it: also its own posts request sent again, Instagram's signed-out queries, and
 * an end to keeping its answers.
 */
export interface ProfileDriver extends PageDriver {
  /** the page's own posts request from after `cursor`; null until the page has made one */
  resend(cursor: string): Promise<{ status: number; text: string } | null>;
  /**
   * a signed-out query sent from inside the page with the id known as the call starts; null while that id is unknown.
   * Throws (never SavedError("badAnswer")) when the page can't send it or nothing comes back in time.
   */
  signedOutQuery(name: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<{ status: number; text: string } | null>;
  /** once per app run: fetch the scripts the page lists (performance resources) and scan them for ids */
  rescanScripts(): Promise<void>;
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
  /** ms more a signed-out first load waits for the posts query's id, when the profile has more posts */
  opWait?: number;
  /** where the page is loaded from: Instagram, or a stand-in in end-to-end tests */
  site?: string;
  /** the page was loaded with a session: its signed-out view counts only when the signed-in one never comes */
  signedIn?: boolean;
}

/** ms one look at the page may take */
const LOOK = 3000;

/** posts per signed-out page, as Instagram's own page asks for them */
const SIGNED_OUT_PAGE = 12;

/**
 * The look through a page's scripts again that is under way, whichever feed began it: the app looks once per run, so
 * another profile's feed that meets a stale id meanwhile waits for that look instead of giving up.
 */
let rescanning: Promise<void> | null = null;

/**
 * A profile's posts, page by page: the first ones from its loaded page, the rest by sending the page's own posts
 * request again with the last cursor (Instagram answers REST requests for profiles as spam), or signed out Instagram's
 * own signed-out query. Keeps nothing per caller, so the grid and a backup page through it alike.
 */
export class ProfileFeed {
  private loading: Promise<InstagramProfile> | null = null;
  private first: ProfilePosts | null = null;
  /** the profile's number, for the signed-out tray query */
  private profileId: string | null = null;
  /** the page's scripts fetched again for a stale query id: once for this feed, shared by every read that meets one */
  private rescan: Promise<void> | null = null;
  /** the profile's highlights, once it is loaded; empty when it has none or the page didn't send them in time */
  highlights: Highlight[] = [];
  /** seen as signed-out visitors see it: its posts by their covers, the next pages through the signed-out query */
  limited = false;
  /** the tray's next page when it has more (signed out) */
  trayCursor?: string;

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
    if (this.limited) {
      const variables = { after: cursor, first: SIGNED_OUT_PAGE, username: this.username, __relay_internal__pv__PolarisSEOIsCrawlerrelayprovider: false };
      return toPage(await this.signedOut(SIGNED_OUT_POSTS_QUERY, variables, signedOutPostsAnswer, STALE_SIGNED_OUT, signal));
    }
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

  /**
   * The tray's next page, seen signed out (Instagram's signed-out tray query); null when there is none, and always
   * signed in. Throws as a signed-out page of posts does.
   */
  async moreHighlights(signal?: AbortSignal): Promise<Highlight[] | null> {
    const after = this.trayCursor;
    if (!this.limited || !after || !this.profileId) return null;
    const variables = { after, first: SIGNED_OUT_PAGE, id: this.profileId };
    const tray = await this.signedOut(SIGNED_OUT_TRAY_QUERY, variables, signedOutTrayAnswer, STALE_SIGNED_OUT_TRAY, signal);
    this.trayCursor = tray.hasNext && tray.cursor ? tray.cursor : undefined;
    // the tray read so far stays on the feed: a profile opened again keeps all of it
    this.highlights = [...this.highlights, ...tray.highlights];
    return tray.highlights;
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
      // a public profile as signed-out visitors see it (with a session: only when the signed-in view never came), once
      // its posts' piece is in too (a private profile has none)
      const open = signedOutProfile(documents, this.username);
      if (open && (!this.o.signedIn || lastLook) && (open.timeline || open.profile.isPrivate || lastLook)) {
        this.first = { posts: open.posts, hasNext: open.hasNext, ...(open.cursor ? { cursor: open.cursor } : {}) };
        this.highlights = open.highlights;
        if (open.trayHasNext && open.trayCursor) this.trayCursor = open.trayCursor;
        this.profileId = open.profile.id;
        this.limited = true;
        // the queries' ids come in the scripts the page is still loading; the next pages of posts and of the tray need them
        const needed = [...(open.hasNext && open.cursor ? [SIGNED_OUT_POSTS_QUERY] : []), ...(this.trayCursor ? [SIGNED_OUT_TRAY_QUERY] : [])];
        const opDeadline = Date.now() + (this.o.opWait ?? 3000);
        while (needed.some((name) => !operationIds.get(name)) && Date.now() < opDeadline) await sleep(poll);
        this.driver.stopCollecting();
        return open.profile;
      }
      if (signedOutProfileView(documents, this.username)) throw new SavedError("signedOut");
      if (!lastLook) await sleep(poll);
    }
    throw new SavedError("badAnswer");
  }

  /**
   * One of Instagram's signed-out queries, its answer read by `read`. An unknown id, or an answer without what was
   * asked for (`read` throws badAnswer: a stale id), is tried once more: at once with a newer id another page noted
   * meanwhile, otherwise after the feed's one look through the page's scripts again (a read that meets a stale id while
   * a look runs, this feed's or another's, waits for it). Still nothing: throws `stale`. Anything else (Instagram's
   * push-back, no answer at all) throws as it is and keeps the id. Called off: "Cancelled.".
   */
  private async signedOut<T>(
    name: string,
    variables: Record<string, unknown>,
    read: (body: string, status: number) => T,
    stale: string,
    signal?: AbortSignal,
  ): Promise<T> {
    let retried = false;
    for (;;) {
      if (signal?.aborted) throw new Error("Cancelled.");
      // the id the page sends with: it takes the one known as the call starts
      const docId = operationIds.get(name);
      const answer = await this.driver.signedOutQuery(name, variables, signal);
      if (answer) {
        try {
          return read(answer.text, answer.status);
        } catch (err) {
          if (!(err instanceof SavedError && err.kind === "badAnswer")) throw err;
        }
        if (docId) operationIds.forget(name, docId);
      }
      if (retried) throw new Error(stale);
      retried = true;
      if (!operationIds.get(name)) {
        this.rescan ??= rescanning ??= this.driver
          .rescanScripts()
          .catch(() => undefined)
          .finally(() => {
            rescanning = null;
          });
        await within(this.rescan, Infinity, signal);
      }
    }
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
