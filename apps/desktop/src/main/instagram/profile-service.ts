import {
  SavedError,
  isLocked,
  type BackupPlan,
  type BrowserCookie,
  type Highlight,
  type HighlightResult,
  type InstagramItem,
  type InstagramProfile,
  type ProfileEntry,
  type ProfileResult,
  type SavedPage,
  type SavedPageResult,
  type SavedPost,
} from "@turbodl/shared";
import type { Backups, StartResult } from "./backups";
import { accountFolder, highlightsFolder } from "./folders";
import { SLOW_DOWN, failedPage, type InstagramPacer } from "./pacer";
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

/** posts kept per profile for estimates */
const SAMPLE = 500;
/** further pages of a signed-out highlights tray read at most */
const TRAY_PAGES = 20;
/** a backup Instagram's slow-down keeps from starting (as `Backups.start` answers it) */
const SLOWED_DOWN: Refusal = { ok: false, error: SLOW_DOWN, reason: "rateLimited" };

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
