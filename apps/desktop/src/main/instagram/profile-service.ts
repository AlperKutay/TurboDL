import {
  SavedError,
  isLocked,
  type BackupPlan,
  type BrowserCookie,
  type Highlight,
  type HighlightResult,
  type InstagramItem,
  type InstagramPostInfo,
  type InstagramPostItem,
  type InstagramProfile,
  type PostDetails,
  type ProfileEntry,
  type ProfileResult,
  type SavedPage,
  type SavedPageResult,
  type SavedPost,
} from "@turbodl/shared";
import type { Backups, StartResult } from "./backups";
import { accountFolder, highlightsFolder } from "./folders";
import { SLOW_DOWN, failedPage, failureText, type InstagramPacer } from "./pacer";
import type { ProfileIndex } from "./profile-index";
import type { InstagramSession } from "./session";

/** A profile's page as the service needs it (`ProfileFeed` over a hidden page, or a demo). */
export interface ProfileSource {
  /** loads the page once; throws SavedError */
  profile(): Promise<InstagramProfile>;
  readonly highlights: Highlight[];
  /** seen as signed-out visitors see it: posts known by their covers */
  readonly limited: boolean;
  /** the tray's next page when it has more (signed out) */
  readonly trayCursor?: string;
  /** no cursor: the posts its page loaded */
  page(cursor?: string, signal?: AbortSignal): Promise<SavedPage>;
  /** the tray's next page; null when there is none */
  moreHighlights(signal?: AbortSignal): Promise<Highlight[] | null>;
  close(): void;
}

export interface ProfileServiceDeps {
  session: InstagramSession;
  open(username: string, cookies: BrowserCookie[]): ProfileSource;
  /** one highlight's stories from its own page; null when it showed none; throws SavedError("signedOut"), or "rateLimited" when a signed-out read lands on the login wall */
  findHighlight(id: string, signal?: AbortSignal): Promise<InstagramItem[] | null>;
  /** one post's items from its own page (it works signed out for public posts); null when it showed none; "signInOnly" when Instagram shows it only to signed-in visitors */
  findPost(code: string, signal?: AbortSignal): Promise<InstagramItem[] | null | "signInOnly">;
  /** as `findPost`, with what the same page says of the post: its time, caption, owner, tagged users */
  findPostDetails(code: string, signal?: AbortSignal): Promise<{ items: InstagramItem[]; details: PostDetails } | null | "signInOnly">;
  /** downloads kept in a folder per account */
  byAccount(): boolean;
  pacer: InstagramPacer;
  backups: Backups;
  index: ProfileIndex;
  baseDir(): string;
  now(): number;
  /**
   * The one read slot the screens and jobs share: `fn` runs once no other read holds it, 3–6 s after the last one
   * ended. Rejects, running nothing, when `signal` aborts before the slot is its.
   */
  read<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

/** A backup that didn't start, and why. */
type Refusal = Extract<StartResult, { ok: false }>;

export interface PostListOptions {
  /** unix seconds: the list ends at the first post taken at or before it that isn't pinned, after the first 3 places (they may hold pinned posts) */
  since?: number;
  /** at most this many posts are sent, known and pinned ones included */
  limit?: number;
  /** codes of posts the client already holds: sent as stubs, their pages not read */
  known?: ReadonlySet<string>;
  signal: AbortSignal;
  onPost(post: InstagramPostInfo): void;
}

/** How a list ended; what it sent before stays sent. `empty`: posts left out because their page showed nothing, read twice. */
export type PostListOutcome =
  | { type: "done"; signInOnly: number; empty: number }
  | { type: "refused"; error: string; reason: "private" | "notFound" | "signInRequired" | "rateLimited" | "error" }
  | { type: "cancelled" };

type ListRefusal = Extract<PostListOutcome, { type: "refused" }>;

/** posts kept per profile for estimates */
const SAMPLE = 500;
/** further pages of a signed-out highlights tray read at most */
const TRAY_PAGES = 20;
/** a backup Instagram's slow-down keeps from starting (as `Backups.start` answers it) */
const SLOWED_DOWN: Refusal = { ok: false, error: SLOW_DOWN, reason: "rateLimited" };
/** a list Instagram's slow-down (or its login wall) ends */
const LIST_SLOWED_DOWN: ListRefusal = { type: "refused", error: SLOW_DOWN, reason: "rateLimited" };
const LIST_CANCELLED: PostListOutcome = { type: "cancelled" };
/** posts Instagram lets a profile pin to its top */
const MOST_PINNED = 3;
/** posts in a row whose page shows nothing (read twice) or no time before a list takes Instagram's pages to have changed */
const UNREADABLE_RUN = 3;
/** a list ended by that many: it would otherwise read the whole profile, nothing ever ending it at `since` */
const PAGES_CHANGED: ListRefusal = { type: "refused", error: "TurboDL couldn't read 3 posts in a row from their pages; Instagram may have changed them, or is slow.", reason: "error" };
/** a list whose next page names its own cursor again, or brings only posts it already took: it would read on forever */
const LISTING_STALLED: ListRefusal = { type: "refused", error: "Instagram kept answering the same posts; TurboDL stopped the list.", reason: "error" };

/**
 * Profiles in the main process: one hidden page per open profile (it holds the request its posts are paged with),
 * paced next pages, picks, backups into `Instagram/<username>`, and the Profiles list.
 */
export class ProfileService {
  /** the screen's profile page; `stale` once a sign-in came after it was seen signed out: the next load opens it afresh, its grid pages on meanwhile */
  private current: { key: string; source: ProfileSource; stale?: boolean } | null = null;
  /** the page a running backup pages through; it stays open until the backup ends */
  private backupSource: ProfileSource | null = null;
  private backupKey = "";
  private readonly profiles = new Map<string, InstagramProfile>();
  /** each profile's highlights tray, as its page listed it */
  private readonly trays = new Map<string, Highlight[]>();
  /** each highlight's stories as last read (null: its page showed none) */
  private readonly stories = new Map<string, InstagramItem[] | null>();
  private readonly posts = new Map<string, SavedPost>();
  private readonly samples = new Map<string, SavedPost[]>();

  constructor(private readonly deps: ProfileServiceDeps) {}

  /** Without a session, a public profile shows as signed-out visitors see it (`limited`). */
  async load(username: string): Promise<ProfileResult> {
    const key = username.toLowerCase();
    const source = this.sourceFor(key);
    try {
      // a slow-down on the page holds the whole account; so does its login wall without a session
      const profile = await this.deps.pacer.ask(() => this.walled(() => source.profile()));
      this.profiles.set(key, profile);
      // signed out, the screen shows the tray as far as it was read (the page's first page); a highlights backup reads the rest
      this.trays.set(key, source.highlights);
      return { type: "profile", profile, highlights: source.highlights, ...(source.limited ? { limited: true } : {}) };
    } catch (err) {
      // a page that failed is not tried again: the next load opens a fresh one
      if (this.current?.source === source) this.release();
      return failedPage(err);
    }
  }

  /** A page of the open profile's posts; next pages in the account's pace. */
  async page(username: string, cursor?: string): Promise<SavedPageResult> {
    const key = username.toLowerCase();
    const source = this.current?.key === key ? this.current.source : null;
    const profile = this.profiles.get(key);
    if (!source || !profile) return { type: "failed", message: "Open the profile first." };
    if (isLocked(profile)) return { type: "page", page: { posts: [] } };
    try {
      const page = await this.paged(source, cursor);
      const sample = this.samples.get(key) ?? [];
      for (const post of page.posts) {
        this.posts.set(post.id, post);
        if (sample.length < SAMPLE && !sample.some((p) => p.id === post.id)) sample.push(post);
      }
      this.samples.set(key, sample);
      return { type: "page", page };
    } catch (err) {
      return failedPage(err);
    }
  }

  /**
   * The picked posts' items, in pick order; a post known only by its cover (seen signed out) is read from its own
   * page first (`readPost`), and left out when it shows nothing or can't be read. Posts never served are left out.
   * Throws SavedError("rateLimited") while Instagram's slow-down holds or when a post's page lands on its login wall,
   * and SavedError("signedOut") when the session expired: no part of the picks is answered then.
   */
  async readPicks(postIds: string[]): Promise<InstagramItem[]> {
    const items: InstagramItem[] = [];
    for (const id of postIds) {
      const post = this.posts.get(id);
      if (!post) continue;
      if (!post.unread || !post.code) {
        items.push(...post.items);
        continue;
      }
      if (this.deps.pacer.held()) throw new SavedError("rateLimited");
      const read = await this.readPost(post).catch((err: unknown) => {
        if (err instanceof SavedError && (err.kind === "rateLimited" || err.kind === "signedOut")) throw err;
        return null;
      });
      if (read) items.push(...read.items);
    }
    return items;
  }

  /**
   * A profile's posts in the order its page shows them, each with its details and items, saving nothing. It reads
   * through a page of its own, closed when the list ends (the screen's and a backup's pages are left alone). A post in
   * `known` is sent as a stub, its page not read; seen signed out, every other post is read from its own page (one that
   * shows nothing twice is left out, counted in `done.empty`); signed in, the feed's items and details are sent as they
   * are. A code met again is skipped. Every page it loads, its profile's included, takes the jobs' read slot here, in
   * the account's pace: unlike a backup's start (`pageFor`), it must not be called from inside the read slot
   * (`deps.read`), which would wait for itself.
   */
  async listPosts(username: string, o: PostListOptions): Promise<PostListOutcome> {
    const { signal } = o;
    if (signal.aborted) return LIST_CANCELLED;
    // no page is opened for a list that would end at once
    if (this.deps.pacer.held()) return LIST_SLOWED_DOWN;
    let opened: { profile: InstagramProfile; source: ProfileSource };
    try {
      // the profile's page is a page read like any other, signed in too
      opened = await this.paced(() => this.openOwn(username.toLowerCase()), signal, true);
    } catch (err) {
      if (signal.aborted) return LIST_CANCELLED;
      // the feed gives up on a page that never shows the profile: no such profile, or a page too slow to tell
      if (err instanceof SavedError && err.kind === "badAnswer") {
        return { type: "refused", error: `Instagram didn't show the profile ${username}; it may not exist, or the page was too slow.`, reason: "error" };
      }
      return listRefusal(err, "Sign in to Instagram again.");
    }
    const { profile, source } = opened;
    try {
      if (isLocked(profile)) return { type: "refused", error: "This account is private.", reason: "private" };
      return await this.listed(source, profile, o);
    } catch (err) {
      return signal.aborted ? LIST_CANCELLED : listRefusal(err, "Instagram signed TurboDL out. Sign in to Instagram again.");
    } finally {
      source.close();
    }
  }

  /**
   * One post or reel link as a list sends a post, read from its own page in the jobs' read slot (taken here, as
   * `listPosts` does) and the account's pace: "signInOnly" when Instagram shows it only to signed-in visitors, null when
   * its page showed nothing. Throws SavedError("rateLimited") while Instagram's slow-down holds and when the page lands
   * on the login wall (the hold starts then), SavedError("signedOut") when the session expired, and "Cancelled." when
   * `signal` aborts first.
   */
  async readPostInfo(code: string, signal: AbortSignal): Promise<InstagramPostInfo | "signInOnly" | null> {
    const read = await this.readDetails(code, signal);
    if (signal.aborted) throw new Error("Cancelled.");
    if (read === null || read === "signInOnly") return read;
    return postInfo(code, read.items, read.details, read.details.pinned === true, read.items.find((item) => item.owner)?.owner ?? null);
  }

  /** The list's own page, its profile loaded; closed again when the load fails. */
  private async openOwn(key: string): Promise<{ profile: InstagramProfile; source: ProfileSource }> {
    const source = this.deps.open(key, this.deps.session.cookies());
    try {
      return { profile: await this.walled(() => source.profile()), source };
    } catch (err) {
      source.close();
      throw err;
    }
  }

  /** `listPosts` from the profile's loaded page on: its pages as a backup pages them, its posts in page order. */
  private async listed(source: ProfileSource, profile: InstagramProfile, o: PostListOptions): Promise<PostListOutcome> {
    const { signal, since, limit, known } = o;
    let sent = 0;
    let signInOnly = 0;
    let empty = 0;
    /** the place in the list of the post at hand; posts left out take none */
    let position = 0;
    /** posts read in a row whose page showed nothing (read twice) or no time */
    let unreadable = 0;
    /** the codes this list has taken, sent or not: one met again is skipped */
    const taken = new Set<string>();
    const ended = (): PostListOutcome => (signal.aborted ? LIST_CANCELLED : { type: "done", signInOnly, empty });
    const full = () => limit !== undefined && sent >= limit;
    const send = (post: InstagramPostInfo) => {
      o.onPost(post);
      sent++;
    };
    let cursor: string | undefined;
    for (;;) {
      if (signal.aborted) return LIST_CANCELLED;
      const at = cursor;
      // signed out, a next page takes the read slot too
      const page = await (source.limited && at !== undefined ? this.deps.read(() => this.paged(source, at, signal), signal) : this.paged(source, at, signal));
      // a next page with nothing new would have the list ask on forever; an empty last page is the profile's end
      const brought = page.posts.some((entry) => entry.code && !taken.has(entry.code));
      if (at !== undefined && !brought && (page.posts.length > 0 || page.next)) return LISTING_STALLED;
      for (const entry of page.posts) {
        if (full()) return ended();
        if (signal.aborted) return LIST_CANCELLED;
        const { code } = entry;
        if (!code || taken.has(code)) continue;
        taken.add(code);
        const pinned = entry.pinned === true;
        if (known?.has(code)) {
          position++;
          send({ ...postInfo(code, [], NO_DETAILS, pinned, profile.username), known: true });
          continue;
        }
        let read = entry.unread ? await this.readDetails(code, signal) : { items: entry.items, details: feedDetails(entry) };
        if (signal.aborted) return LIST_CANCELLED;
        // a slow page shows nothing too: it is read once more (in the read slot and the pace) before the post counts as empty
        if (read === null) {
          read = await this.readDetails(code, signal);
          if (signal.aborted) return LIST_CANCELLED;
        }
        if (read === "signInOnly") {
          position++;
          signInOnly++;
          send({ ...postInfo(code, [], NO_DETAILS, pinned, profile.username), signInOnly: true });
          continue;
        }
        // with no times nothing would end it: a few pages in a row without one end the list instead (a time starts the count again)
        if (entry.unread) {
          unreadable = read === null || read.details.takenAt === undefined ? unreadable + 1 : 0;
          if (unreadable >= UNREADABLE_RUN) return PAGES_CHANGED;
        }
        // a page that showed nothing twice: the post isn't sent and takes no place, and the list goes on
        if (read === null) {
          empty++;
          continue;
        }
        position++;
        const { items, details } = read;
        const post = postInfo(code, items, details, pinned || details.pinned === true, profile.username);
        // the first old post that isn't pinned ends the list unsent; Instagram's pinned places are spared, as nothing
        // marks pinned posts signed out and a signed-in feed's mark may be missing
        const old = since !== undefined && details.takenAt !== undefined && details.takenAt <= since;
        if (old && !post.pinned && position > MOST_PINNED) return ended();
        send(post);
      }
      if (full() || !page.next) return ended();
      if (page.next === at) return LISTING_STALLED;
      cursor = page.next;
    }
  }

  /** A post's page with its details, in the shared read slot and the account's pace, as `readPost` reads one. */
  private readDetails(code: string, signal?: AbortSignal): Promise<{ items: InstagramItem[]; details: PostDetails } | null | "signInOnly"> {
    return this.paced(() => this.deps.findPostDetails(code, signal), signal, true);
  }

  /**
   * Signed in just now: the open profile's page, seen signed out, is let go at the screen's next load, which opens it
   * with the session; a backup started meanwhile opens its own. A running backup's page stays.
   */
  reopenSignedIn(): void {
    if (this.current?.source.limited && this.current.source !== this.backupSource) this.current.stale = true;
  }

  /** `<baseDir>/Instagram/<username>`: a profile's picks and backups. */
  folder(username: string): string {
    return accountFolder(this.deps.baseDir(), username);
  }

  plan(username: string): Promise<BackupPlan> {
    const key = username.toLowerCase();
    const profile = this.profiles.get(key);
    return this.deps.backups.plan(profile ? `profile-${profile.id}` : "", profile?.postCount, this.samples.get(key) ?? [], this.folder(profile?.username ?? username));
  }

  /**
   * Backs up a profile into its username's folder, its ledger keyed by the account's number: through the open
   * profile's page, or a page of its own when the profile isn't open (Continue after leaving it). Seen signed out
   * (with or without a session), each post's items are read from its own page, and every page it reads (its listing's
   * next pages too) takes the shared read slot.
   */
  async startBackup(username: string): Promise<StartResult> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running.", reason: "busy" };
    // no page is opened for a backup that wouldn't start
    if (this.deps.pacer.held()) return SLOWED_DOWN;
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return opened;
    const { profile, source } = opened;
    const refused = refusal(profile);
    if (refused) {
      this.letGo(source);
      return refused;
    }
    const { limited } = source;
    const result = await this.deps.backups.start(
      {
        id: `profile-${profile.id}`,
        kind: "profile",
        name: profile.username,
        ...(profile.postCount !== undefined ? { count: profile.postCount } : {}),
        dir: this.folder(profile.username),
        allowsEarlyStop: true,
        // the signed-out listing may end short of the count
        ...(limited ? { checkCount: true } : {}),
      },
      (cursor, signal) => (limited && cursor !== undefined ? this.deps.read(() => this.paged(source, cursor, signal), signal) : this.paged(source, cursor, signal)),
      () => this.startBackup(key),
      limited ? (post, signal) => this.readPost(post, signal) : undefined,
    );
    if (!result.ok) {
      this.letGo(source);
      return result;
    }
    this.deps.index.record(profile, this.deps.now());
    this.keepUntilSettled(source, key);
    return result;
  }

  /** A running backup's page stays open until the backup ends; the screen's, seen signed out before a sign-in meanwhile, is then let go at its next load. */
  private keepUntilSettled(source: ProfileSource, key: string): void {
    this.backupSource = source;
    this.backupKey = key;
    void this.deps.backups.settled().then(() => {
      if (this.backupSource !== source) return;
      this.backupSource = null;
      if (this.current?.source !== source) source.close();
      else if (source.limited && this.deps.session.signedIn()) this.current.stale = true;
    });
  }

  /** One highlight's stories, from its own page, in the account's pace; remembered for picks. */
  async loadHighlight(id: string): Promise<HighlightResult> {
    try {
      // a highlight's page is a page read in the account's pace; signed out it takes the read slot too
      const found = await this.readHighlight(id);
      this.stories.set(id, found);
      return found && found.length > 0 ? { type: "stories", count: found.length } : { type: "nothing" };
    } catch (err) {
      return failedPage(err);
    }
  }

  /** The read stories of the picked highlights, in pick order; highlights that showed nothing left out. */
  pickedStories(ids: string[]): InstagramItem[] {
    return ids.flatMap((id) => this.stories.get(id) ?? []);
  }

  /** A profile's highlight picks and backups: `Instagram/<username>/Highlights`, or `Instagram/<username> · Highlights`. */
  highlightsFolder(username: string): string {
    return highlightsFolder(this.deps.baseDir(), username, this.deps.byAccount());
  }

  highlightsPlan(username: string): Promise<BackupPlan> {
    const key = username.toLowerCase();
    const profile = this.profiles.get(key);
    // a tray that may have more pages isn't counted
    // (the open page's own tray: it grows as a backup pages it)
    const open = this.current?.key === key ? this.current.source : this.backupKey === key ? this.backupSource : null;
    const count = open?.limited && open.trayCursor !== undefined ? undefined : (open?.highlights ?? this.trays.get(key))?.length;
    return this.deps.backups.plan(profile ? `highlights-${profile.id}` : "", count, [], this.highlightsFolder(profile?.username ?? username));
  }

  /**
   * Backs up every story of every highlight, one highlight per page (its own page load, 3–6 s apart), into its own
   * folder. New stories land in old highlights, so every run goes through all of them: no early stop.
   */
  async startHighlightsBackup(username: string): Promise<StartResult> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running.", reason: "busy" };
    if (this.deps.pacer.held()) return SLOWED_DOWN;
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return opened;
    const { profile, source } = opened;
    const refused = refusal(profile);
    if (refused) {
      this.letGo(source);
      return refused;
    }
    // the tray as the page listed it; a signed-out tray with more pages is read on, page by page, while the backup runs
    const tray = [...source.highlights];
    this.trays.set(key, source.highlights);
    // a tray that may have more pages has no known count
    const counted = !(source.limited && source.trayCursor !== undefined);
    let trayPages = 0;
    // a page that came back empty with more to come: the tray isn't read to its end
    let stalled = false;
    const moreTray = () => source.limited && source.trayCursor !== undefined && trayPages < TRAY_PAGES && !stalled;
    // the page stays open for the tray's next pages only
    if (!moreTray() || tray.length === 0) this.letGo(source);
    if (tray.length === 0) return { ok: false, error: "This profile has no highlights.", reason: "empty" };
    const result = await this.deps.backups.start(
      {
        id: `highlights-${profile.id}`,
        kind: "highlights",
        name: `${profile.username} · Highlights`,
        ...(counted ? { count: tray.length } : {}),
        dir: this.highlightsFolder(profile.username),
        allowsEarlyStop: false,
        pageGap: [3000, 6000],
        endNote: () => (source.limited && source.trayCursor !== undefined && (trayPages >= TRAY_PAGES || stalled) ? "Instagram has more highlights than TurboDL read in one run." : undefined),
      },
      async (cursor, signal) => {
        const index = cursor ? Number(cursor) : 0;
        while (!tray[index] && moreTray()) {
          trayPages++;
          const more = await this.readTrayPage(source, signal);
          if (!more || more.length === 0) {
            stalled = true;
            break;
          }
          tray.push(...more);
        }
        const highlight = tray[index];
        if (!highlight) return { posts: [] };
        const found = (await this.readHighlight(highlight.id, signal)) ?? [];
        // a story is remembered by its pk, or its file name when the page gives none (as the iPhone does)
        const items = found.map((item) => ({ ...item, mediaId: item.mediaId ?? lastSegment(item.url) }));
        return { posts: [{ id: highlight.id, ...(highlight.cover ? { cover: highlight.cover } : {}), items }], ...(index + 1 < tray.length || moreTray() ? { next: String(index + 1) } : {}) };
      },
      () => this.startHighlightsBackup(key),
    );
    if (!result.ok) {
      this.letGo(source);
      return result;
    }
    this.deps.index.record(profile, this.deps.now());
    if (moreTray()) this.keepUntilSettled(source, key);
    else this.letGo(source);
    return result;
  }

  profilesList(): ProfileEntry[] {
    return this.deps.index.list();
  }

  remove(id: string): void {
    this.deps.index.remove(id);
  }

  /** The profile screen closed: its page goes, unless a backup is using it. */
  close(username: string): void {
    if (this.current?.key === username.toLowerCase()) this.release();
  }

  closeAll(): void {
    this.release();
    this.backupSource?.close();
    this.backupSource = null;
  }

  /** The open profile's page and profile, a running backup's, or a page of its own for a backup (without a session too). */
  private async pageFor(key: string): Promise<{ profile: InstagramProfile; source: ProfileSource } | Refusal> {
    const known = this.profiles.get(key);
    // a page seen signed out before a sign-in isn't backed up from: the backup opens one with the session
    const reused = this.current?.key === key && !this.current.stale ? this.current.source : this.backupKey === key ? this.backupSource : null;
    if (reused && known) {
      // the tray as that page has read it so far
      this.trays.set(key, reused.highlights);
      return { profile: known, source: reused };
    }
    if (!this.deps.session.signedIn()) {
      // a signed-out page load in the account's pace (not the read slot: a job starting a backup already holds it)
      await this.deps.pacer.pace();
      if (this.deps.pacer.held()) return SLOWED_DOWN;
    }
    const source = this.deps.open(key, this.deps.session.cookies());
    try {
      // a slow-down on the page holds the whole account
      const profile = await this.deps.pacer.ask(() => this.walled(() => source.profile()));
      this.profiles.set(key, profile);
      this.trays.set(key, source.highlights);
      return { profile, source };
    } catch (err) {
      source.close();
      const failed = failedPage(err);
      if (failed.type === "failed") return { ok: false, error: failed.message, reason: "error" };
      if (failed.type === "signedOut") return { ok: false, error: "Sign in to Instagram again.", reason: "signInRequired" };
      return SLOWED_DOWN;
    }
  }

  /** Closes a page `pageFor` opened only for a backup that isn't using it; the screen's and a running backup's stay. */
  private letGo(source: ProfileSource): void {
    if (this.current?.source !== source && this.backupSource !== source) source.close();
  }

  private sourceFor(key: string): ProfileSource {
    if (this.current?.key === key && !this.current.stale) return this.current.source;
    this.release();
    // a running backup's page is the profile's page too
    if (this.backupKey === key && this.backupSource) {
      this.current = { key, source: this.backupSource };
      return this.backupSource;
    }
    const source = this.deps.open(key, this.deps.session.cookies());
    this.current = { key, source };
    return source;
  }

  /** Lets go of the open profile's page; a running backup's page is closed when the backup ends instead. */
  private release(): void {
    const source = this.current?.source;
    this.current = null;
    if (source && source !== this.backupSource) source.close();
  }

  /** The first page from what the page loaded; next pages are requests Instagram sees, in the account's pace. */
  private async paged(source: ProfileSource, cursor?: string, signal?: AbortSignal): Promise<SavedPage> {
    if (cursor === undefined) return source.page(undefined, signal);
    const { pacer } = this.deps;
    if (pacer.held()) throw new SavedError("rateLimited");
    await pacer.pace(signal);
    if (pacer.held()) throw new SavedError("rateLimited");
    if (signal?.aborted) throw new Error("Cancelled.");
    return pacer.ask(() => this.walled(() => source.page(cursor, signal)));
  }

  /**
   * A post known only by its cover, read from its own page in the shared read slot and the account's pace: with its
   * items, as shown only to signed-in visitors (`signInOnly`), or with none. Throws SavedError("rateLimited") while
   * Instagram's slow-down holds, and when its page lands on the login wall (the hold starts then).
   */
  private async readPost(post: SavedPost, signal?: AbortSignal): Promise<SavedPost> {
    const { code } = post;
    if (!code) return { ...post, items: [] };
    const { pacer } = this.deps;
    const found = await this.deps.read(async () => {
      if (pacer.held()) throw new SavedError("rateLimited");
      await pacer.pace(signal);
      if (pacer.held()) throw new SavedError("rateLimited");
      if (signal?.aborted) throw new Error("Cancelled.");
      return pacer.ask(() => this.deps.findPost(code, signal));
    }, signal);
    if (found === "signInOnly") return { ...post, signInOnly: true };
    return found && found.length > 0 ? { ...post, items: found, unread: false } : { ...post, items: [] };
  }

  /**
   * One highlight's stories from its own page, in the account's pace; signed out also in the shared read slot (signed
   * in, as before, the pace only). Throws SavedError("rateLimited") while Instagram's slow-down holds, and when a
   * signed-out page lands on the login wall.
   */
  private readHighlight(id: string, signal?: AbortSignal): Promise<InstagramItem[] | null> {
    return this.paced(() => this.deps.findHighlight(id, signal), signal);
  }

  /** The tray's next page (signed out), in the read slot and the account's pace; null when there is none. */
  private readTrayPage(source: ProfileSource, signal?: AbortSignal): Promise<Highlight[] | null> {
    return this.paced(() => this.walled(() => source.moreHighlights(signal)), signal, true);
  }

  /** `request` after the hold check and the account's pace; signed out (or `slotted`) in the read slot. */
  private paced<T>(request: () => Promise<T>, signal?: AbortSignal, slotted = false): Promise<T> {
    const { pacer } = this.deps;
    const run = async () => {
      if (pacer.held()) throw new SavedError("rateLimited");
      await pacer.pace(signal);
      if (pacer.held()) throw new SavedError("rateLimited");
      if (signal?.aborted) throw new Error("Cancelled.");
      return pacer.ask(request);
    };
    return slotted || !this.deps.session.signedIn() ? this.deps.read(run, signal) : run();
  }

  /** Without a session, a page that asks to sign in is Instagram's login wall for this computer: a slow-down. */
  private async walled<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (err) {
      if (err instanceof SavedError && err.kind === "signedOut" && !this.deps.session.signedIn()) throw new SavedError("rateLimited");
      throw err;
    }
  }
}

/** A post's details when nothing says more of it. */
const NO_DETAILS: PostDetails = { taggedUsers: [] };

/** A list Instagram pushed back on (its slow-down or login wall; the session gone, said as `signedOut`), or why else it ended. */
function listRefusal(err: unknown, signedOut: string): ListRefusal {
  if (err instanceof SavedError && err.kind === "rateLimited") return LIST_SLOWED_DOWN;
  if (err instanceof SavedError && err.kind === "signedOut") return { type: "refused", error: signedOut, reason: "signInRequired" };
  return { type: "refused", error: failureText(err), reason: "error" };
}

/** What a signed-in feed says of a post beyond its items. */
function feedDetails(post: SavedPost): PostDetails {
  const owner = post.items.find((item) => item.owner)?.owner;
  return {
    ...(post.takenAt !== undefined ? { takenAt: post.takenAt } : {}),
    ...(post.caption ? { caption: post.caption } : {}),
    taggedUsers: post.taggedUsers ?? [],
    ...(owner ? { owner } : {}),
  };
}

/** A post as a list sends it: its time in ISO 8601 UTC (null without one), the owner its page names or `owner`. */
function postInfo(code: string, items: InstagramItem[], details: PostDetails, pinned: boolean, owner: string | null): InstagramPostInfo {
  return {
    code,
    url: `https://www.instagram.com/p/${encodeURIComponent(code)}/`,
    takenAt: isoTime(details.takenAt),
    pinned,
    owner: details.owner ?? owner,
    ...(details.caption ? { caption: details.caption } : {}),
    taggedUsers: details.taggedUsers,
    items: items.map(postItem),
  };
}

/** An item as a list sends it: what a client downloads it by, without what only the app's screens use. */
function postItem(item: InstagramItem): InstagramPostItem {
  const { kind, url, mediaId, width, height, duration } = item;
  return {
    kind,
    url,
    ...(mediaId !== undefined ? { mediaId } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

/** Unix seconds as ISO 8601 UTC; null for none (or a time no date has). */
function isoTime(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Why a profile can't be backed up from its page: private and not followed (Instagram shows it to nobody else). */
function refusal(profile: InstagramProfile): Refusal | null {
  return isLocked(profile) ? { ok: false, error: "This account is private.", reason: "private" } : null;
}

/** The last part of an address's path (a file name), without its query. */
function lastSegment(address: string): string {
  try {
    return new URL(address).pathname.split("/").filter(Boolean).pop() ?? address;
  } catch {
    return address;
  }
}
