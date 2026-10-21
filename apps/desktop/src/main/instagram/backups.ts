import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { BackupPlan, BackupView, Result, SavedPost } from "@turbodl/shared";
import { BackupRun, type BackupDeps, type BackupTarget } from "./backup";
import type { fetchMedia } from "./fetch-media";
import type { LedgerStore } from "./ledger";
import { SLOW_DOWN } from "./pacer";

const VIDEO_BYTES = 8_000_000;
const PHOTO_BYTES = 600_000;
const LARGE = 1000;

export interface BackupsDeps {
  ledgers: LedgerStore;
  fetch: typeof fetchMedia;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
  /** what the CDN gets with every fetch */
  headers(): Record<string, string>;
  /** Instagram asked to slow down a moment ago */
  held(): boolean;
  onBackup(view: BackupView): void;
}

/** The account's one backup slot, Saved's collections and profiles alike: one backup at a time. */
export class Backups {
  private run: BackupRun | null = null;
  private starting = false;

  constructor(private readonly deps: BackupsDeps) {}

  isRunning(): boolean {
    return this.run?.isRunning === true || this.starting;
  }

  /** Starts `target`; refused while another runs. A stopped run records its last item before this one reads the ledger. */
  async start(target: BackupTarget, page: BackupDeps["page"]): Promise<Result> {
    if (this.isRunning()) return { ok: false, error: "A backup is already running." };
    this.starting = true;
    try {
      await this.run?.settled();
      if (this.deps.held()) return { ok: false, error: SLOW_DOWN };
      const run: BackupRun = new BackupRun(
        target,
        { page, fetch: this.deps.fetch, ledgers: this.deps.ledgers, wait: (ms, signal) => this.deps.wait(ms, signal), headers: this.deps.headers() },
        // a run replaced by a newer one reports nothing more
        (view) => {
          if (this.run === run) this.deps.onBackup(view);
        },
      );
      this.run = run;
      void run.start();
      return { ok: true };
    } finally {
      this.starting = false;
    }
  }

  /** Resolves once the item in flight is dropped. */
  stop(): Promise<void> {
    return this.run?.stop() ?? Promise.resolve();
  }

  view(): BackupView | null {
    return this.run?.view() ?? null;
  }

  /** The backup going on or last run. */
  target(): BackupTarget | undefined {
    return this.run?.target;
  }

  /** Resolves when no backup is going on any more. */
  settled(): Promise<void> {
    return this.run?.settled() ?? Promise.resolve();
  }

  /** What a backup's confirmation says: the count, an estimate from the posts loaded so far, free space, warnings. */
  async plan(id: string, count: number | undefined, sample: SavedPost[], dir: string): Promise<BackupPlan> {
    const sampleBytes = sample.flatMap((p) => p.items).reduce((sum, item) => sum + (item.kind === "video" ? VIDEO_BYTES : PHOTO_BYTES), 0);
    const ledger = this.deps.ledgers.load(id);
    const freeBytes = await free(dir);
    return {
      ...(count !== undefined ? { count } : {}),
      ...(count !== undefined && sample.length > 0 ? { bytes: (count * sampleBytes) / sample.length } : {}),
      ...(freeBytes !== undefined ? { freeBytes } : {}),
      large: (count ?? 0) > LARGE,
      resumes: ledger.saved.length > 0 && !ledger.reachedEnd,
    };
  }
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
