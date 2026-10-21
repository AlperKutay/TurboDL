import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  SavedError,
  sanitizeFilename,
  type BackupPlan,
  type InstagramAccount,
  type InstagramItem,
  type Result,
  type SavedCollection,
  type SavedPageResult,
  type SavedPost,
  type SavedSource,
} from "@turbodl/shared";
import type { Backups } from "./backups";
import { failedPage, type InstagramPacer } from "./pacer";
import { SavedClient, type HttpGet } from "./saved-client";
import type { InstagramSession } from "./session";

export interface SavedServiceDeps {
  session: InstagramSession;
  /** the user agent Instagram gets */
  agent: string;
  get: HttpGet;
  /** the account's collections from its saved page; null when it listed none in time */
  collections(username: string, cookies: ReturnType<InstagramSession["cookies"]>): Promise<SavedCollection[] | null>;
  /** forgets the session in the hidden pages' partition too */
  signOut(): Promise<void>;
  userDataDir: string;
  baseDir(): string;
  pacer: InstagramPacer;
  backups: Backups;
}

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
  /** the grid's latest request; one that waited while another feed was asked for is dropped */
  private latestBrowse = { ticket: 0, feed: "" };
  private readonly cacheFile: string;
  private readonly client: SavedClient;

  constructor(private readonly deps: SavedServiceDeps) {
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
    await this.deps.backups.stop();
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

  /**
   * One page of a feed for the grid, in the account's pace (a backup's requests too), not at all while Instagram's
   * "slow down" holds, or when another feed was asked for meanwhile.
   */
  async page(source: SavedSource, cursor?: string): Promise<SavedPageResult> {
    if (!this.deps.session.signedIn()) return { type: "signedOut" };
    const { pacer } = this.deps;
    const key = source.kind === "all" ? "all" : source.id;
    const ticket = ++this.latestBrowse.ticket;
    this.latestBrowse.feed = key;
    if (pacer.held()) return { type: "rateLimited" };
    await pacer.pace();
    if (this.latestBrowse.ticket !== ticket && this.latestBrowse.feed !== key) return { type: "failed", message: "Another feed was asked for." };
    if (pacer.held()) return { type: "rateLimited" };
    try {
      const page = await pacer.ask(() => this.client.page(source, cursor));
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

  plan(collectionId: string): Promise<BackupPlan> {
    const collection = this.collection(collectionId);
    return this.deps.backups.plan(collectionId, collection?.count, this.samples.get(collectionId) ?? [], collection ? this.folder(collection) : this.deps.baseDir());
  }

  /** Starts backing up one of the account's own collections, in the account's one backup slot. */
  async startBackup(collectionId: string): Promise<Result> {
    if (this.deps.backups.isRunning()) return { ok: false, error: "A backup is already running." };
    const collection = this.collection(collectionId);
    if (!collection || collection.isAll) return { ok: false, error: "Only your own collections can be backed up." };
    const { pacer } = this.deps;
    const source: SavedSource = { kind: "collection", id: collection.id };
    return this.deps.backups.start(
      {
        id: collection.id,
        kind: "collection",
        name: collection.name,
        ...(collection.count !== undefined ? { count: collection.count } : {}),
        dir: this.folder(collection),
        allowsEarlyStop: true,
      },
      async (cursor, signal) => {
        await pacer.pace(signal);
        if (pacer.held()) throw new SavedError("rateLimited");
        return pacer.ask(() => this.client.page(source, cursor, signal));
      },
    );
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

  private readCache(): { username: string; list: SavedCollection[] } | null {
    try {
      const data = JSON.parse(readFileSync(this.cacheFile, "utf8")) as { username?: unknown; list?: unknown };
      return typeof data.username === "string" && Array.isArray(data.list) ? { username: data.username, list: data.list as SavedCollection[] } : null;
    } catch {
      return null;
    }
  }
}
