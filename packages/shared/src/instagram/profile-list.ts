import { profileName, type ProfileSaveOptions } from "./options";

/** Most profiles one list may hold. */
export const PROFILE_LIST_MAX = 1000;
/** How long a list waits after Instagram asks to slow down. */
export const SLOW_DOWN_WAIT_MINUTES = 15;

/** The random wait between a list's profiles, in minutes. */
export interface ListWait {
  min: number;
  max: number;
}

export const DEFAULT_LIST_WAIT: ListWait = { min: 2, max: 5 };

export interface ParsedProfileList {
  usernames: string[];
  /** lines that are neither a profile nor blank/comment, with their 1-based line numbers */
  invalid: { line: number; text: string }[];
  /** more than PROFILE_LIST_MAX distinct names (the names are still all returned) */
  tooMany: boolean;
}

/** Reads a .txt of profile links, `@names` and names: one per line, `#` comments and blank lines skipped, repeats dropped. */
export function parseProfileList(text: string): ParsedProfileList {
  const usernames: string[] = [];
  const seen = new Set<string>();
  const invalid: { line: number; text: string }[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const name = profileName(line);
    if (!name) {
      invalid.push({ line: i + 1, text: line });
      return;
    }
    if (seen.has(name)) return;
    seen.add(name);
    usernames.push(name);
  });
  return { usernames, invalid, tooMany: usernames.length > PROFILE_LIST_MAX };
}

const WAIT_MAX_MINUTES = 1440;

/** Null when the wait is fine, else why not. Takes unknown values: it checks untrusted input too. */
export function waitProblem(w: { min: unknown; max: unknown }): string | null {
  const { min, max } = w;
  if (
    typeof min === "number" &&
    typeof max === "number" &&
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min >= 0 &&
    max <= WAIT_MAX_MINUTES &&
    max >= min
  ) {
    return null;
  }
  return "Waits are whole minutes from 0 to 1440, the most at least the least.";
}

export type ListRowState = "waiting" | "running" | "done" | "skipped" | "failed";

export interface ProfileListRow {
  username: string;
  state: ListRowState;
  /** skipped/failed: why; done: a warning when there is one */
  note?: string;
  /** done: items the profile's backups have saved in all (`ProfileEntry.saved` from the Profiles index, read after the job; absent when the index has no entry, e.g. a highlights-only or tagged-only row), and how many files this run fetched */
  files?: number;
  fetched?: number;
}

export type ListState = "running" | "waiting" | "slowedDown" | "stopped" | "signedOut" | "rateLimited" | "finished";

export interface ProfileListView {
  /** the .txt's file name (or "API list") */
  name: string;
  rows: ProfileListRow[];
  /** index of the row running, waiting to run, or to run next */
  index: number;
  state: ListState;
  /** epoch ms the next profile starts (waiting / slowedDown) */
  nextAt?: number;
  /** the state's message (slowedDown, rateLimited, signedOut) */
  message?: string;
  options: ProfileSaveOptions;
  wait: ListWait;
  /** the running row's job progress, when it has one */
  progress?: { done: number; total?: number; note?: string };
}
