import path from "node:path";
import {
  SavedError,
  isLocked,
  sanitizeFilename,
  type BackupPlan,
  type BrowserCookie,
  type Highlight,
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
  private readonly profiles = new Map<string, InstagramProfile>();
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

  /** Backs up the open profile into its username's folder, its ledger keyed by the account's number. */
  async startBackup(username: string): Promise<Result> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running." };
    const key = username.toLowerCase();
    const profile = this.profiles.get(key);
    const source = this.current?.key === key ? this.current.source : null;
    if (!profile || !source) return { ok: false, error: "Open the profile first." };
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
    );
    if (!result.ok) return result;
    this.deps.index.record(profile, this.deps.now());
    this.backupSource = source;
    void this.deps.backups.settled().then(() => {
      if (this.backupSource !== source) return;
      this.backupSource = null;
      if (this.current?.source !== source) source.close();
    });
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

  private sourceFor(key: string): ProfileSource {
    if (this.current?.key === key) return this.current.source;
    this.release();
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
