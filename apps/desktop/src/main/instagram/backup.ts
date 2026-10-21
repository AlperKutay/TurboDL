import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { SavedError, sanitizeFilename, type BackupView, type InstagramItem, type SavedPage, type SavedPost } from "@turbodl/shared";
import type { fetchMedia } from "./fetch-media";
import { instagramExtension } from "./files";
import { allowsEarlyStop, type LedgerStore } from "./ledger";

/** What a backup goes through: one of the account's collections, or a profile. */
export interface BackupTarget {
  /** the ledger's name; it stays when the collection or the account is renamed */
  id: string;
  kind: BackupView["kind"];
  name: string;
  /** how many posts it holds, when Instagram says */
  count?: number;
  /** where its files go */
  dir: string;
  /** a later run may stop at the first page already saved: where the newest come first and old ones don't change */
  allowsEarlyStop: boolean;
}

export interface BackupDeps {
  /** no cursor: the first page */
  page(cursor?: string, signal?: AbortSignal): Promise<SavedPage>;
  fetch: typeof fetchMedia;
  ledgers: LedgerStore;
  /** resolves after `ms`, or early when `signal` aborts; tests record instead of sleeping */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** 0…1, for the gap between posts */
  random?: () => number;
  /** what the CDN gets with every fetch */
  headers: Record<string, string>;
}

/** ms between posts fetched (picked at random in the range) and before each next page, as the iPhone app waits. */
const POST_GAP: [number, number] = [1500, 3000];
const PAGE_GAP = 2000;
/** ms between progress reports while an item is fetched */
const PROGRESS_EVERY = 100;

/**
 * Backs up a collection: every item of every post, one by one, recorded in its ledger so a stopped run continues and
 * a later run only saves what is new. Paced so it never looks like a burst; stops at Instagram's first push-back.
 */
export class BackupRun {
  private state: BackupView["state"] = "stopped";
  private error?: string;
  private done = 0;
  private failed = 0;
  private saved = 0;
  private cover?: string;
  private progress = 0;
  private lastReport = 0;
  private stopper: AbortController | null = null;
  private running: Promise<void> | null = null;

  constructor(
    readonly target: BackupTarget,
    private readonly deps: BackupDeps,
    private readonly onChange: (view: BackupView) => void,
  ) {}

  view(): BackupView {
    const { count } = this.target;
    return {
      targetId: this.target.id,
      kind: this.target.kind,
      name: this.target.name,
      state: this.state,
      ...(this.error ? { error: this.error } : {}),
      done: this.done,
      failed: this.failed,
      ...(count !== undefined ? { left: Math.max(count - this.done - this.failed, 0) } : {}),
      saved: this.saved,
      ...(this.cover ? { cover: this.cover } : {}),
      progress: this.progress,
    };
  }

  get isRunning(): boolean {
    return this.stopper !== null && !this.stopper.signal.aborted;
  }

  /** Runs until the end, a stop or Instagram pushing back; resolves then. Can be called again after any of them. */
  async start(): Promise<void> {
    if (this.isRunning) return;
    // a stopped run may still be recording its last item; it finishes before this one reads the ledger
    if (this.running) await this.running;
    if (this.stopper) return;
    const stopper = new AbortController();
    this.stopper = stopper;
    Object.assign(this, { state: "running", error: undefined, done: 0, failed: 0, saved: 0, cover: undefined, progress: 0 });
    this.report();
    this.running = this.run(stopper.signal)
      .catch((err: unknown) => {
        if (stopper.signal.aborted) return;
        this.state = "failed";
        this.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.stopper = null;
        this.running = null;
        this.cover = undefined;
        this.progress = 0;
        this.report();
      });
    return this.running;
  }

  /** Stops at once; resolves once the item in flight is dropped. Everything saved so far is already recorded. */
  stop(): Promise<void> {
    if (this.isRunning) {
      this.state = "stopped";
      this.stopper?.abort();
      this.report();
    }
    return this.settled();
  }

  /** Resolves when no run is going on any more (a stopped one included). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { target, deps } = this;
    mkdirSync(target.dir, { recursive: true });
    const ledger = deps.ledgers.load(target.id);
    const saved = new Set(ledger.saved);
    const failedPosts = new Set(ledger.failedPosts);
    let reachedEnd = ledger.reachedEnd;
    const record = () => deps.ledgers.save(target.id, { saved: [...saved], failedPosts: [...failedPosts], reachedEnd });
    const isDone = (post: SavedPost) => post.items.every((item) => saved.has(itemId(post, item)));
    // newest posts come first, so after a clean complete pass a page already saved means nothing new is below it
    const earlyStop = target.allowsEarlyStop && allowsEarlyStop(ledger);
    let cursor: string | undefined;
    for (;;) {
      if (cursor !== undefined) await this.pause(PAGE_GAP, signal);
      if (signal.aborted) return;
      let page: SavedPage;
      try {
        page = await deps.page(cursor, signal);
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof SavedError && (err.kind === "signedOut" || err.kind === "rateLimited")) this.state = err.kind;
        else throw err;
        return;
      }
      if (earlyStop && page.posts.every(isDone)) {
        // this page and everything below it were saved before
        const below = this.done + page.posts.length;
        this.done = target.count !== undefined ? Math.max(target.count - this.failed, below) : below;
        this.state = "finished";
        return;
      }
      for (const post of page.posts) {
        if (signal.aborted) return;
        if (isDone(post)) {
          this.done++;
          this.report();
          continue;
        }
        this.cover = post.cover;
        let failed = false;
        let asked = false;
        for (const item of post.items) {
          const id = itemId(post, item);
          if (saved.has(id)) continue;
          const outcome = await this.save(id, item, signal);
          if (signal.aborted) return;
          if (outcome === "failed") {
            failed = true;
          } else {
            saved.add(id);
            record();
          }
          if (outcome !== "onDisk") asked = true;
        }
        if (failed) {
          failedPosts.add(post.id);
          this.failed++;
        } else {
          failedPosts.delete(post.id);
          this.done++;
        }
        record();
        this.report();
        if (asked) await this.pause(POST_GAP[0] + (deps.random ?? Math.random)() * (POST_GAP[1] - POST_GAP[0]), signal);
      }
      if (!page.next) {
        reachedEnd = true;
        record();
        this.state = "finished";
        return;
      }
      cursor = page.next;
    }
  }

  /** One item into the collection's folder; a file already there counts as saved. */
  private async save(id: string, item: InstagramItem, signal: AbortSignal): Promise<"fetched" | "onDisk" | "failed"> {
    const file = path.join(this.target.dir, sanitizeFilename(`${id}.${instagramExtension(item)}`));
    if (existsSync(file)) return "onDisk";
    this.progress = 0;
    try {
      await this.deps.fetch(item.url, file, {
        headers: this.deps.headers,
        signal,
        onProgress: (fraction) => {
          this.progress = fraction;
          if (Date.now() - this.lastReport >= PROGRESS_EVERY) this.report();
        },
      });
      this.saved++;
      return "fetched";
    } catch {
      return "failed";
    }
  }

  private async pause(ms: number, signal: AbortSignal): Promise<void> {
    await this.deps.wait(Math.round(ms), signal).catch(() => undefined);
  }

  private report(): void {
    this.lastReport = Date.now();
    this.onChange(this.view());
  }
}

/** A carousel child's id, or the post's own for a single photo or video. */
function itemId(post: SavedPost, item: InstagramItem): string {
  return item.mediaId ?? post.id;
}
