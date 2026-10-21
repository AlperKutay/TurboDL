import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import {
  SavedError,
  sanitizeFilename,
  type BackupPlan,
  type BackupView,
  type InstagramAccount,
  type InstagramItem,
  type Result,
  type SavedCollection,
  type SavedPageResult,
  type SavedPost,
  type SavedSource,
} from "@turbodl/shared";
import { BackupRun } from "./backup";
import type { fetchMedia } from "./fetch-media";
import { LedgerStore } from "./ledger";
import { SavedClient, type HttpGet } from "./saved-client";
import type { InstagramSession } from "./session";

export interface SavedServiceDeps {
  session: InstagramSession;
  /** the user agent Instagram and its CDN get */
  agent: string;
  get: HttpGet;
  /** the account's collections from its saved page; null when it listed none in time */
  collections(username: string, cookies: ReturnType<InstagramSession["cookies"]>): Promise<SavedCollection[] | null>;
  fetch: typeof fetchMedia;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  /** forgets the session in the hidden pages' partition too */
  signOut(): Promise<void>;
  userDataDir: string;
  baseDir(): string;
  onBackup(view: BackupView): void;
}

/** ms between saved page requests while browsing */
const PAGE_GAP = 1500;
const VIDEO_BYTES = 8_000_000;
const PHOTO_BYTES = 600_000;
const LARGE_COLLECTION = 1000;
/** posts kept per feed for estimates */
const SAMPLE = 500;

/** The Saved section's side in the main process: the account, its collections, paced pages, picks and backups. */
export class SavedService {
  private account?: { session: string; username: string };
  private list: SavedCollection[] | null = null;
  /** every post served, by id, so picks are read from what Instagram answered */
  private readonly posts = new Map<string, SavedPost>();
  /** posts served per feed ("all" or a collection id) */
  private readonly samples = new Map<string, SavedPost[]>();
  private nextPageAt = 0;
  private backup: BackupRun | null = null;
  private readonly ledgers: LedgerStore;
  private readonly cacheFile: string;
  private readonly client: SavedClient;

  constructor(private readonly deps: SavedServiceDeps) {
    this.ledgers = new LedgerStore(path.join(deps.userDataDir, "instagram-backups"));
    this.cacheFile = path.join(deps.userDataDir, "instagram-collections.json");
    this.client = new SavedClient(() => deps.session.cookies(), deps.agent, deps.get);
  }

  async accountInfo(): Promise<InstagramAccount> {
    if (!this.deps.session.signedIn()) return { signedIn: false };
    try {
      return { signedIn: true, username: await this.username() };
    } catch (err) {
      return err instanceof SavedError && err.kind === "signedOut" ? { signedIn: false } : { signedIn: true };
    }
  }

  /** The account's username, asked once per session; undefined when Instagram won't say. */
  async usernameIfAny(): Promise<string | undefined> {
    try {
      return await this.username();
    } catch {
      return undefined;
    }
  }

  async signOut(): Promise<void> {
    this.stopBackup();
    this.deps.session.clear();
    this.account = undefined;
    this.list = null;
    this.posts.clear();
    this.samples.clear();
    try {
      writeFileSync(this.cacheFile, "{}");
    } catch {
      // nothing kept
    }
    await this.deps.signOut();
  }

  async collections(refresh: boolean): Promise<SavedCollection[] | "signedOut"> {
    if (!this.deps.session.signedIn()) return "signedOut";
    const cached = this.readCache();
    if (!refresh) return (this.list ??= cached?.list ?? null) ?? [];
    let username: string;
    try {
      username = await this.username();
    } catch (err) {
      if (err instanceof SavedError && err.kind === "signedOut") return "signedOut";
      return this.list ?? cached?.list ?? [];
    }
    const list = await this.deps.collections(username, this.deps.session.cookies()).catch(() => null);
    if (!list) return cached?.username === username ? cached.list : (this.list ?? []);
    this.list = list;
    try {
      writeFileSync(this.cacheFile, JSON.stringify({ username, list }));
    } catch {
      // shown now, read again next time
    }
    return list;
  }

  /** One page of a feed, never sooner than 1.5 s after the last one asked. */
  async page(source: SavedSource, cursor?: string): Promise<SavedPageResult> {
    if (!this.deps.session.signedIn()) return { type: "signedOut" };
    await this.pace();
    try {
      const page = await this.client.page(source, cursor);
      const key = source.kind === "all" ? "all" : source.id;
      const sample = this.samples.get(key) ?? [];
      for (const post of page.posts) {
        this.posts.set(post.id, post);
        if (sample.length < SAMPLE && !sample.some((p) => p.id === post.id)) sample.push(post);
      }
      this.samples.set(key, sample);
      return { type: "page", page };
    } catch (err) {
      if (err instanceof SavedError && (err.kind === "signedOut" || err.kind === "rateLimited")) return { type: err.kind };
      return { type: "failed", message: failureText(err) };
    }
  }

  /** The picked posts' items, in pick order; posts never served are left out. */
  pickedItems(postIds: string[]): InstagramItem[] {
    return postIds.flatMap((id) => this.posts.get(id)?.items ?? []);
  }

  async plan(collectionId: string): Promise<BackupPlan> {
    const collection = this.collection(collectionId);
    const count = collection?.count;
    const sample = this.samples.get(collectionId) ?? [];
    const sampleBytes = sample.flatMap((p) => p.items).reduce((sum, item) => sum + (item.kind === "video" ? VIDEO_BYTES : PHOTO_BYTES), 0);
    const ledger = this.ledgers.load(collectionId);
    const freeBytes = await free(collection ? this.folder(collection) : this.deps.baseDir());
    return {
      ...(count !== undefined ? { count } : {}),
      ...(count !== undefined && sample.length > 0 ? { bytes: (count * sampleBytes) / sample.length } : {}),
      ...(freeBytes !== undefined ? { freeBytes } : {}),
      large: (count ?? 0) > LARGE_COLLECTION,
      resumes: ledger.saved.length > 0 && !ledger.reachedEnd,
    };
  }

  /** Starts backing up one of the account's own collections; one backup at a time. */
  startBackup(collectionId: string): Result {
    if (this.backup?.isRunning) return { ok: false, error: "A backup is already running." };
    const collection = this.collection(collectionId);
    if (!collection || collection.isAll) return { ok: false, error: "Only your own collections can be backed up." };
    const run = new BackupRun(
      {
        id: collection.id,
        name: collection.name,
        ...(collection.count !== undefined ? { count: collection.count } : {}),
        source: { kind: "collection", id: collection.id },
        dir: this.folder(collection),
        allowsEarlyStop: true,
      },
      {
        page: (source, cursor, signal) => this.client.page(source, cursor, signal),
        fetch: this.deps.fetch,
        ledgers: this.ledgers,
        wait: (ms, signal) => this.deps.wait(ms, signal),
        headers: { Referer: "https://www.instagram.com/", ...(this.deps.agent ? { "User-Agent": this.deps.agent } : {}) },
      },
      (view) => this.deps.onBackup(view),
    );
    this.backup = run;
    void run.start();
    return { ok: true };
  }

  stopBackup(): void {
    this.backup?.stop();
  }

  backupView(): BackupView | null {
    return this.backup?.view() ?? null;
  }

  private async username(): Promise<string> {
    const session = this.deps.session.cookies().find((c) => c.name === "sessionid")?.value ?? "";
    if (this.account?.session === session) return this.account.username;
    const username = await this.client.username();
    this.account = { session, username };
    return username;
  }

  private collection(id: string): SavedCollection | undefined {
    return (this.list ?? this.readCache()?.list ?? []).find((c) => c.id === id);
  }

  /** `<baseDir>/Instagram/Saved/<collection>`, its name made safe for a folder. */
  private folder(collection: SavedCollection): string {
    const name = collection.name.trim() ? sanitizeFilename(collection.name) : `Collection ${collection.id}`;
    return path.join(this.deps.baseDir(), "Instagram", "Saved", name);
  }

  private async pace(): Promise<void> {
    const now = this.deps.now();
    const at = Math.max(now, this.nextPageAt);
    this.nextPageAt = at + PAGE_GAP;
    if (at > now) await this.deps.wait(at - now);
  }

  private readCache(): { username: string; list: SavedCollection[] } | null {
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, "utf8")) as { username?: unknown; list?: unknown };
      return typeof data.username === "string" && Array.isArray(data.list) ? { username: data.username, list: data.list as SavedCollection[] } : null;
    } catch {
      return null;
    }
  }
}

function failureText(err: unknown): string {
  if (err instanceof SavedError) return err.kind === "http" ? err.message : "Instagram's answer couldn't be read.";
  return err instanceof Error ? err.message : String(err);
}

/** Free bytes on the drive of `dir` (or of its nearest folder that exists). */
async function free(dir: string): Promise<number | undefined> {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  try {
    const s = await statfs(at);
    return s.bavail * s.bsize;
  } catch {
    return undefined;
  }
}
