import { readFileSync, writeFileSync } from "node:fs";
import type { InstagramProfile, ProfileEntry } from "@turbodl/shared";
import type { LedgerStore } from "./ledger";

/** A profile's backups' ledgers: its posts', its highlights', its tagged posts'. */
const ledgerIds = (id: string) => [`profile-${id}`, `highlights-${id}`, `tagged-${id}`];

interface ProfileRecord {
  id: string;
  username: string;
  fullName: string;
  picture?: string;
  /** when its last backup started, ms */
  lastRun: number;
}

/** The backed-up profiles, in one file next to their ledgers, so the list doesn't open every ledger to name them. */
export class ProfileIndex {
  constructor(
    private readonly file: string,
    private readonly ledgers: LedgerStore,
  ) {}

  /** Newest run first, with what its backups (posts, highlights and tagged posts) saved. */
  list(): ProfileEntry[] {
    return this.load()
      .sort((a, b) => b.lastRun - a.lastRun)
      .map((r) => ({ ...r, saved: ledgerIds(r.id).reduce((sum, id) => sum + this.ledgers.load(id).saved.length, 0) }));
  }

  /** Adds the profile, or refreshes its name, picture and the time of its last run. */
  record(profile: InstagramProfile, at: number): void {
    const records = this.load().filter((r) => r.id !== profile.id);
    records.push({ id: profile.id, username: profile.username, fullName: profile.fullName, ...(profile.picture ? { picture: profile.picture } : {}), lastRun: at });
    this.save(records);
  }

  /** Forgets the profile and what its backups saved; its files stay. */
  remove(id: string): void {
    this.save(this.load().filter((r) => r.id !== id));
    for (const ledger of ledgerIds(id)) this.ledgers.remove(ledger);
  }

  private load(): ProfileRecord[] {
    try {
      const data: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(data) ? data.filter((r): r is ProfileRecord => typeof r?.id === "string" && typeof r.username === "string" && typeof r.lastRun === "number") : [];
    } catch {
      return [];
    }
  }

  private save(records: ProfileRecord[]): void {
    try {
      writeFileSync(this.file, JSON.stringify(records));
    } catch {
      // the list is a convenience; the ledgers are what count
    }
  }
}
