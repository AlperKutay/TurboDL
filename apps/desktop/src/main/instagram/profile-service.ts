import path from "node:path";
import {
  SavedError,
  isLocked,
  sanitizeFilename,
  type BackupPlan,
  type BrowserCookie,
  type Highlight,
  type HighlightResult,
  type InstagramItem,
  type InstagramProfile,
  type ProfileEntry,
  type ProfileResult,
  type Result,
  type SavedPage,
  type SavedPageResult,
  type SavedPost,
} from "@turbodl/shared";
import type { Backups } from "./backups";
import { failedPage, type InstagramPacer } from "./pacer";
import type { ProfileIndex } from "./profile-index";
import type { InstagramSession } from "./session";

/** A profile's page as the service needs it (`ProfileFeed` over a hidden page, or a demo). */
export interface ProfileSource {
  /** loads the page once; throws SavedError */
  profile(): Promise<InstagramProfile>;
  readonly highlights: Highlight[];
  /** no cursor: the posts its page loaded */
  page(cursor?: string, signal?: AbortSignal): Promise<SavedPage>;
  close(): void;
}

export interface ProfileServiceDeps {
  session: InstagramSession;
  open(username: string, cookies: BrowserCookie[]): ProfileSource;
  /** one highlight's stories from its own page; null when it showed none; throws SavedError("signedOut") */
  findHighlight(id: string, signal?: AbortSignal): Promise<InstagramItem[] | null>;
  pacer: InstagramPacer;
  backups: Backups;
  index: ProfileIndex;
  baseDir(): string;
  now(): number;
}

/** posts kept per profile for estimates */
const SAMPLE = 500;

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

  async load(username: string): Promise<ProfileResult> {
    if (!this.deps.session.signedIn()) return { type: "signedOut" };
    const key = username.toLowerCase();
    const source = this.sourceFor(key);
    try {
      const profile = await source.profile();
      this.profiles.set(key, profile);
      this.trays.set(key, source.highlights);
      return { type: "profile", profile, highlights: source.highlights };
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

  /** The picked posts' items, in pick order; posts never served are left out. */
  pickedItems(postIds: string[]): InstagramItem[] {
    return postIds.flatMap((id) => this.posts.get(id)?.items ?? []);
  }

  /** `<baseDir>/Instagram/<username>`: a profile's picks and backups. */
  folder(username: string): string {
    return path.join(this.deps.baseDir(), "Instagram", sanitizeFilename(username));
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
  async startBackup(username: string): Promise<Result> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running." };
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return { ok: false, error: opened.error };
    const { profile, source } = opened;
    if (isLocked(profile)) return { ok: false, error: "This account is private." };
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
      if (this.current?.source !== source && this.backupSource !== source) source.close();
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

  /** `<baseDir>/Instagram/<username> · Highlights`: a profile's highlight picks and backups. */
  highlightsFolder(username: string): string {
    return path.join(this.deps.baseDir(), "Instagram", sanitizeFilename(`${username} · Highlights`));
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
  async startHighlightsBackup(username: string): Promise<Result> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running." };
    const key = username.toLowerCase();
    const opened = await this.pageFor(key);
    if ("error" in opened) return { ok: false, error: opened.error };
    const { profile, source } = opened;
    // the tray came with the page; a page opened only for this is no longer needed
    if (this.current?.source !== source && this.backupSource !== source) source.close();
    if (isLocked(profile)) return { ok: false, error: "This account is private." };
    const tray = this.trays.get(key) ?? [];
    if (tray.length === 0) return { ok: false, error: "This profile has no highlights." };
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
  private async pageFor(key: string): Promise<{ profile: InstagramProfile; source: ProfileSource } | { error: string }> {
    const known = this.profiles.get(key);
    if (this.current?.key === key && known) return { profile: known, source: this.current.source };
    if (this.backupKey === key && this.backupSource && known) return { profile: known, source: this.backupSource };
    if (!this.deps.session.signedIn()) return { error: "Sign in to Instagram first." };
    const source = this.deps.open(key, this.deps.session.cookies());
    try {
      const profile = await source.profile();
      this.profiles.set(key, profile);
      this.trays.set(key, source.highlights);
      return { profile, source };
    } catch (err) {
      source.close();
      const failed = failedPage(err);
      return { error: failed.type === "failed" ? failed.message : failed.type === "signedOut" ? "Sign in to Instagram again." : "Instagram asked TurboDL to slow down. Try again in a few minutes." };
    }
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

/** The last part of an address's path (a file name), without its query. */
function lastSegment(address: string): string {
  try {
    return new URL(address).pathname.split("/").filter(Boolean).pop() ?? address;
  } catch {
    return address;
  }
}
