import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstagramItem, InstagramMediaKind, SavedPost } from "@turbodl/shared";

/**
 * What a collection's backups saved so far: item ids only, never addresses (Instagram's expire). "Done" and "reached
 * the end" are kept per kind of media, so a run asking for a kind earlier runs left out goes back through older posts.
 */
export interface BackupLedger {
  saved: string[];
  /** posts with at least one item that failed; the next run tries them again */
  failedPosts: string[];
  /** posts Instagram shows only to signed-in visitors, left for a run with a session; not failed */
  signInPosts: string[];
  /** per kind, posts with every item of that kind saved (or none of that kind), by their id: a re-run knows them before reading their items */
  done: Record<InstagramMediaKind, string[]>;
  /** per kind, a run asking for it went through to the collection's end */
  reachedEnd: Record<InstagramMediaKind, boolean>;
  /** the last run that recorded anything didn't get to the listing's end (stopped, signed out, slowed down, failed): Continue goes on with it */
  unfinished: boolean;
}

const empty = (): BackupLedger => ({ saved: [], failedPosts: [], signInPosts: [], done: { image: [], video: [] }, reachedEnd: { image: false, video: false }, unfinished: false });

/** The items of the kinds asked for. */
export function wantedItems(post: SavedPost, kinds: readonly InstagramMediaKind[]): InstagramItem[] {
  return post.items.filter((item) => kinds.includes(item.kind));
}

/**
 * A post is done for `kinds` when it is among the done posts of each of them, or every one of its items of those kinds
 * is saved; a post with items but none of those kinds has nothing to save and is done. A post with no items never is.
 */
export function postDone(
  post: SavedPost,
  kinds: readonly InstagramMediaKind[],
  done: Record<InstagramMediaKind, ReadonlySet<string>>,
  saved: ReadonlySet<string>,
): boolean {
  if (kinds.length > 0 && kinds.every((kind) => done[kind].has(post.id))) return true;
  return post.items.length > 0 && wantedItems(post, kinds).every((item) => saved.has(itemId(post, item)));
}

/** A carousel child's id, or the post's own for a single photo or video: what the ledger saves it under. */
export function itemId(post: SavedPost, item: InstagramItem): string {
  return item.mediaId ?? post.id;
}

/**
 * Only after a complete pass for each kind asked, with nothing left failed, may a run stop at the first page it already
 * has; and never after a run that stopped before the listing's end (what is below its last page isn't known).
 */
export function allowsEarlyStop(ledger: BackupLedger, kinds: readonly InstagramMediaKind[]): boolean {
  return kinds.length > 0 && kinds.every((kind) => ledger.reachedEnd[kind]) && ledger.failedPosts.length === 0 && !ledger.unfinished;
}

/** One JSON file per collection. */
export class LedgerStore {
  constructor(private readonly folder: string) {}

  /**
   * A missing or unreadable ledger is an empty one; one written before a field existed has it empty. One written before
   * kinds were kept (`donePosts`, a single `reachedEnd`) counts for photos and videos alike. One written before
   * `unfinished` is unfinished unless it reached the end for both kinds (what Continue was offered by then).
   */
  load(id: string): BackupLedger {
    try {
      const data = JSON.parse(readFileSync(this.file(id), "utf8")) as Record<string, unknown>;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      const field = (v: unknown, key: string): unknown => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[key] : undefined);
      const oldDone = data.done === undefined && Array.isArray(data.donePosts) ? strings(data.donePosts) : undefined;
      const oldEnd = typeof data.reachedEnd === "boolean" ? data.reachedEnd : undefined;
      const reachedEnd = {
        image: oldEnd ?? field(data.reachedEnd, "image") === true,
        video: oldEnd ?? field(data.reachedEnd, "video") === true,
      };
      return {
        saved: strings(data.saved),
        failedPosts: strings(data.failedPosts),
        signInPosts: strings(data.signInPosts),
        done: {
          image: oldDone ? [...oldDone] : strings(field(data.done, "image")),
          video: oldDone ? [...oldDone] : strings(field(data.done, "video")),
        },
        reachedEnd,
        unfinished: typeof data.unfinished === "boolean" ? data.unfinished : !(reachedEnd.image && reachedEnd.video),
      };
    } catch {
      return empty();
    }
  }

  save(id: string, ledger: BackupLedger): void {
    mkdirSync(this.folder, { recursive: true });
    const file = this.file(id);
    writeFileSync(`${file}.tmp`, JSON.stringify(ledger));
    renameSync(`${file}.tmp`, file);
  }

  /** Forgets everything backups of it saved; the next backup starts over. */
  remove(id: string): void {
    rmSync(this.file(id), { force: true });
  }

  private file(id: string): string {
    return path.join(this.folder, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
  }
}
