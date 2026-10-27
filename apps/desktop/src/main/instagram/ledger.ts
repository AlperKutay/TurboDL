import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { InstagramItem, SavedPost } from "@turbodl/shared";

/** What a collection's backups saved so far: item ids only, never addresses (Instagram's expire). */
export interface BackupLedger {
  saved: string[];
  /** posts with at least one item that failed; the next run tries them again */
  failedPosts: string[];
  /** the last run went through to the collection's end */
  reachedEnd: boolean;
  /** posts with every item saved, by their id: a re-run knows them before reading their items */
  donePosts: string[];
  /** posts Instagram shows only to signed-in visitors, left for a run with a session; not failed */
  signInPosts: string[];
}

const empty = (): BackupLedger => ({ saved: [], failedPosts: [], reachedEnd: false, donePosts: [], signInPosts: [] });

/** A post is done when it is among the done posts, or every one of its items is saved (a post with none never is). */
export function postDone(post: SavedPost, donePosts: ReadonlySet<string>, saved: ReadonlySet<string>): boolean {
  if (donePosts.has(post.id)) return true;
  return post.items.length > 0 && post.items.every((item) => saved.has(itemId(post, item)));
}

/** A carousel child's id, or the post's own for a single photo or video: what the ledger saves it under. */
export function itemId(post: SavedPost, item: InstagramItem): string {
  return item.mediaId ?? post.id;
}

/** Only after a complete pass with nothing left failed may a run stop at the first page it already has. */
export function allowsEarlyStop(ledger: BackupLedger): boolean {
  return ledger.reachedEnd && ledger.failedPosts.length === 0;
}

/** One JSON file per collection. */
export class LedgerStore {
  constructor(private readonly folder: string) {}

  /** A missing or unreadable ledger is an empty one; one written before a field existed has it empty. */
  load(id: string): BackupLedger {
    try {
      const data = JSON.parse(readFileSync(this.file(id), "utf8")) as Partial<BackupLedger>;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return {
        saved: strings(data.saved),
        failedPosts: strings(data.failedPosts),
        reachedEnd: data.reachedEnd === true,
        donePosts: strings(data.donePosts),
        signInPosts: strings(data.signInPosts),
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
