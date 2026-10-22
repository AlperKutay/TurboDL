import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SavedPost } from "@turbodl/shared";

/** What a collection's backups saved so far: item ids only, never addresses (Instagram's expire). */
export interface BackupLedger {
  saved: string[];
  /** posts with at least one item that failed; the next run tries them again */
  failedPosts: string[];
  /** the last run went through to the collection's end */
  reachedEnd: boolean;
}

const empty = (): BackupLedger => ({ saved: [], failedPosts: [], reachedEnd: false });

/** A post is done when every one of its items is saved. */
export function isDone(ledger: BackupLedger, post: SavedPost): boolean {
  return post.items.every((item) => item.mediaId !== undefined && ledger.saved.includes(item.mediaId));
}

/** Only after a complete pass with nothing left failed may a run stop at the first page it already has. */
export function allowsEarlyStop(ledger: BackupLedger): boolean {
  return ledger.reachedEnd && ledger.failedPosts.length === 0;
}

/** One JSON file per collection. */
export class LedgerStore {
  constructor(private readonly folder: string) {}

  /** A missing or unreadable ledger is an empty one. */
  load(id: string): BackupLedger {
    try {
      const data = JSON.parse(readFileSync(this.file(id), "utf8")) as Partial<BackupLedger>;
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return { saved: strings(data.saved), failedPosts: strings(data.failedPosts), reachedEnd: data.reachedEnd === true };
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
