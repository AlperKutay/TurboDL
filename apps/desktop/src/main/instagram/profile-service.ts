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
  /** seen as signed-out visitors see it: posts known by their covers, no next pages */
  readonly limited: boolean;
  /** no cursor: the posts its page loaded */
  page(cursor?: string, signal?: AbortSignal): Promise<SavedPage>;
  close(): void;
}

export interface ProfileServiceDeps {
  session: InstagramSession;
  open(username: string, cookies: BrowserCookie[]): ProfileSource;
  /** one highlight's stories from its own page; null when it showed none; throws SavedError("signedOut") */
  findHighlight(id: string, signal?: AbortSignal): Promise<InstagramItem[] | null>;
  /** one post's items from its own page (it works signed out for public posts); null when it showed none */
  findPost(code: string, signal?: AbortSignal): Promise<InstagramItem[] | null>;
  /** downloads kept in a folder per account */
  byAccount(): boolean;
  pacer: InstagramPacer;
  backups: Backups;
  index: ProfileIndex;
  baseDir(): string;
  now(): number;
}

/** A job's read of a profile's first posts: their items, or why there are none. */
export type FirstPosts =
  /** `posts`: how many posts the page showed (a carousel's items are more); `failed`: those whose own page showed nothing */
  | { type: "items"; profile: InstagramProfile; items: InstagramItem[]; limited: boolean; posts: number; failed: number }
  | { type: "signedOut" }
  | { type: "rateLimited" }
  | { type: "private" }
  | { type: "failed"; message: string };

/** A backup that didn't start, and why. */
type Refusal = Extract<StartResult, { ok: false }>;

/** posts kept per profile for estimates */
const SAMPLE = 500;
const SIGN_IN_TO_BACK_UP = "Sign in to Instagram to back up a profile.";

/**
 * Profiles in the main process: one hidden page per open profile (it holds the request its posts are paged with),
 * paced next pages, picks, backups into `Instagram/<username>`, and the Profiles list.
 */
export class ProfileService {
  private current: { key: string; source: ProfileSource } | null = null;
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
      // a slow-down on the page holds the whole account
      const profile = await this.deps.pacer.ask(() => source.profile());
      this.profiles.set(key, profile);
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
   * page first, in the account's pace, and left out when it shows nothing. Posts never served are left out.
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
      const code = post.code;
      const { pacer } = this.deps;
      if (pacer.held()) break;
      await pacer.pace();
      const found = await pacer.ask(() => this.deps.findPost(code)).catch(() => null);
      items.push(...(found ?? []));
    }
    return items;
  }

  /**
   * A job's read of a profile's first posts on a page of its own: the screen's page is never used or closed. The
   * profile's page, then the own page of each post known only by its cover, load one at a time in the job's read slot,
   * in the account's pace; the profile's page is closed before any post's page loads. Nothing is asked while
   * Instagram's slow-down holds. Called off before its page opens: failed, "Cancelled.".
   */
  async readFirstPosts(username: string, o: { read<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>; signal?: AbortSignal }): Promise<FirstPosts> {
    const { pacer } = this.deps;
    if (pacer.held()) return { type: "rateLimited" };
    if (o.signal?.aborted) return { type: "failed", message: "Cancelled." };
    /** one page Instagram sees, in the read slot and the account's pace; a slow-down on it holds the whole account */
    const paced = <T>(load: () => Promise<T>): Promise<T> =>
      o.read(async () => {
        if (pacer.held()) throw new SavedError("rateLimited");
        await pacer.pace(o.signal);
        if (pacer.held()) throw new SavedError("rateLimited");
        if (o.signal?.aborted) throw new Error("Cancelled.");
        return pacer.ask(load);
      }, o.signal);
    let opened: { source: ProfileSource; profile: InstagramProfile };
    try {
      opened = await paced(async () => {
        const source = this.deps.open(username.toLowerCase(), this.deps.session.cookies());
        try {
          return { source, profile: await source.profile() };
        } catch (err) {
          source.close();
          throw err;
        }
      });
    } catch (err) {
      return failedPage(err);
    }
    const { source, profile } = opened;
    const limited = source.limited;
    let posts: SavedPost[];
    try {
      if (isLocked(profile)) return { type: "private" };
      posts = (await source.page(undefined, o.signal)).posts;
    } catch (err) {
      return failedPage(err);
    } finally {
      // its posts are taken: the profile's page goes before any post's page loads
      source.close();
    }
    const items: InstagramItem[] = [];
    let failed = 0;
    for (const post of posts) {
      if (!post.unread || !post.code) {
        items.push(...post.items);
        continue;
      }
      // a called-off read asks Instagram nothing more
      if (o.signal?.aborted) break;
      const code = post.code;
      const found = await paced(() => this.deps.findPost(code, o.signal)).catch(() => null);
      if (pacer.held()) return { type: "rateLimited" };
      if (found && found.length > 0) items.push(...found);
      else if (!o.signal?.aborted) failed++;
    }
    return { type: "items", profile, items, limited, posts: posts.length, failed };
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
   * profile's page, or a page of its own when the profile isn't open (Continue after leaving it).
   */
  async startBackup(username: string): Promise<StartResult> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running.", reason: "busy" };
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return opened;
    const { profile, source } = opened;
    const refused = refusal(profile, source);
    if (refused) {
      this.letGo(source);
      return refused;
    }
    const result = await this.deps.backups.start(
      {
        id: `profile-${profile.id}`,
        kind: "profile",
        name: profile.username,
        ...(profile.postCount !== undefined ? { count: profile.postCount } : {}),
        dir: this.folder(profile.username),
        allowsEarlyStop: true,
      },
      (cursor, signal) => this.paged(source, cursor, signal),
      () => this.startBackup(key),
    );
    if (!result.ok) {
      this.letGo(source);
      return result;
    }
    this.deps.index.record(profile, this.deps.now());
    this.backupSource = source;
    this.backupKey = key;
    void this.deps.backups.settled().then(() => {
      if (this.backupSource !== source) return;
      this.backupSource = null;
      if (this.current?.source !== source) source.close();
    });
    return result;
  }

  /** One highlight's stories, from its own page, in the account's pace; remembered for picks. */
  async loadHighlight(id: string): Promise<HighlightResult> {
    if (!this.deps.session.signedIn()) return { type: "signedOut" };
    const { pacer } = this.deps;
    if (pacer.held()) return { type: "rateLimited" };
    await pacer.pace();
    if (pacer.held()) return { type: "rateLimited" };
    try {
      const found = await pacer.ask(() => this.deps.findHighlight(id));
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
    const count = this.trays.get(key)?.length;
    return this.deps.backups.plan(profile ? `highlights-${profile.id}` : "", count, [], this.highlightsFolder(profile?.username ?? username));
  }

  /**
   * Backs up every story of every highlight, one highlight per page (its own page load, 3–6 s apart), into its own
   * folder. New stories land in old highlights, so every run goes through all of them: no early stop.
   */
  async startHighlightsBackup(username: string): Promise<StartResult> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running.", reason: "busy" };
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return opened;
    const { profile, source } = opened;
    // the tray came with the page; a page opened only for this is no longer needed
    this.letGo(source);
    const refused = refusal(profile, source);
    if (refused) return refused;
    const tray = this.trays.get(key) ?? [];
    if (tray.length === 0) return { ok: false, error: "This profile has no highlights.", reason: "empty" };
    const { pacer } = this.deps;
    const result = await this.deps.backups.start(
      {
        id: `highlights-${profile.id}`,
        kind: "highlights",
        name: `${profile.username} · Highlights`,
        count: tray.length,
        dir: this.highlightsFolder(profile.username),
        allowsEarlyStop: false,
        pageGap: [3000, 6000],
      },
      async (cursor, signal) => {
        const index = cursor ? Number(cursor) : 0;
        const highlight = tray[index];
        if (!highlight) return { posts: [] };
        if (pacer.held()) throw new SavedError("rateLimited");
        await pacer.pace(signal);
        if (pacer.held()) throw new SavedError("rateLimited");
        const found = (await pacer.ask(() => this.deps.findHighlight(highlight.id, signal))) ?? [];
        // a story is remembered by its pk, or its file name when the page gives none (as the iPhone does)
        const items = found.map((item) => ({ ...item, mediaId: item.mediaId ?? lastSegment(item.url) }));
        return { posts: [{ id: highlight.id, ...(highlight.cover ? { cover: highlight.cover } : {}), items }], ...(index + 1 < tray.length ? { next: String(index + 1) } : {}) };
      },
      () => this.startHighlightsBackup(key),
    );
    if (result.ok) this.deps.index.record(profile, this.deps.now());
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

  /** The open profile's page and profile, a running backup's, or a page of its own for a backup. */
  private async pageFor(key: string): Promise<{ profile: InstagramProfile; source: ProfileSource } | Refusal> {
    const known = this.profiles.get(key);
    if (this.current?.key === key && known) return { profile: known, source: this.current.source };
    if (this.backupKey === key && this.backupSource && known) return { profile: known, source: this.backupSource };
    if (!this.deps.session.signedIn()) return { ok: false, error: SIGN_IN_TO_BACK_UP, reason: "signInRequired" };
    const source = this.deps.open(key, this.deps.session.cookies());
    try {
      // a slow-down on the page holds the whole account
      const profile = await this.deps.pacer.ask(() => source.profile());
      this.profiles.set(key, profile);
      this.trays.set(key, source.highlights);
      return { profile, source };
    } catch (err) {
      source.close();
      const failed = failedPage(err);
      if (failed.type === "failed") return { ok: false, error: failed.message, reason: "error" };
      if (failed.type === "signedOut") return { ok: false, error: "Sign in to Instagram again.", reason: "signInRequired" };
      return { ok: false, error: SLOW_DOWN, reason: "rateLimited" };
    }
  }

  /** Closes a page `pageFor` opened only for a backup that isn't using it; the screen's and a running backup's stay. */
  private letGo(source: ProfileSource): void {
    if (this.current?.source !== source && this.backupSource !== source) source.close();
  }

  private sourceFor(key: string): ProfileSource {
    if (this.current?.key === key) return this.current.source;
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
    return pacer.ask(() => source.page(cursor, signal));
  }
}

/** Why a profile can't be backed up from its page: seen as signed-out visitors see it, or private and not followed. */
function refusal(profile: InstagramProfile, source: ProfileSource): Refusal | null {
  if (source.limited) return { ok: false, error: SIGN_IN_TO_BACK_UP, reason: "signInRequired" };
  if (isLocked(profile)) return { ok: false, error: "This account is private.", reason: "private" };
  return null;
}

/** The last part of an address's path (a file name), without its query. */
function lastSegment(address: string): string {
  try {
    return new URL(address).pathname.split("/").filter(Boolean).pop() ?? address;
  } catch {
    return address;
  }
}
