import {
  PROFILE_LIST_MAX,
  effectiveSaveOptions,
  saveOptionsProblem,
  waitProblem,
  type BackupView,
  type ListState,
  type ParsedProfileList,
  type ProfileListRow,
  type ProfileListView,
  type ProfileSaveOptions,
  type Result,
} from "@turbodl/shared";
import { belongsTo } from "./saved-state";

/** the list goes on by itself in these */
const ACTIVE: ReadonlySet<ListState> = new Set(["running", "waiting", "slowedDown"]);
/** Continue runs these on */
const RESUMABLE: ReadonlySet<ListState> = new Set(["stopped", "rateLimited", "signedOut"]);

/** how many names the dialog shows before "+N more" */
const NAMES_SHOWN = 8;
/** how many lines that aren't profiles the dialog names before "and N more" */
const INVALID_SHOWN = 3;

export const LIST_TOO_MANY = `A list can hold at most ${PROFILE_LIST_MAX.toLocaleString("en-US")} profiles.`;
/** the runner's own words for a second list while one is unfinished */
export const LIST_UNFINISHED = "Close the list that is there first.";

const count = (n: number) => n.toLocaleString("en-US");
const counted = (n: number, one: string) => `${count(n)} ${n === 1 ? one : `${one}s`}`;

/** The time left to `at`: "m:ss", "h:mm:ss" from an hour; never below "0:00". */
export function countdown(at: number, now: number): string {
  const total = Math.max(0, Math.ceil((at - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** "5 of 14": the row running, waiting to run or to run next; a finished list's last. */
export function listPosition(list: ProfileListView): string {
  const total = list.rows.length;
  return `${count(Math.min(list.index + 1, total))} of ${count(total)}`;
}

/** What the backup running for a profile saves, in words, when it is that profile's: "posts", "highlights", "tagged posts". */
function partOf(backup: BackupView | null, username: string): string | undefined {
  if (!backup || !belongsTo(backup, username)) return undefined;
  return backup.kind === "highlights" ? "highlights" : backup.kind === "tagged" ? "tagged posts" : "posts";
}

/** The list's state in a line; `backup` (the one running) names the part a running profile is at. */
export function listStateLine(list: ProfileListView, now: number, backup: BackupView | null = null): string {
  switch (list.state) {
    case "running": {
      const row = list.rows[list.index];
      if (!row) return "Backing up";
      const doing = `Backing up @${row.username}`;
      const p = list.progress;
      if (!p) return doing;
      const part = partOf(backup, row.username);
      return `${doing} · ${part ? `${part} ` : ""}${count(p.done)}${p.total !== undefined ? ` / ${count(p.total)}` : ""}`;
    }
    case "waiting":
      // a slow-down's wait that was stopped and continued comes back as waiting too: worded for either
      return list.nextAt !== undefined ? `Next profile in ${countdown(list.nextAt, now)}` : "Waiting for the next profile";
    case "slowedDown":
      return list.message ?? "Instagram asked TurboDL to slow down.";
    case "rateLimited":
      return list.message ?? "Instagram asked TurboDL to slow down 3 times in a row. Continue later.";
    case "signedOut":
      return list.message ?? "Instagram signed TurboDL out. Sign in, then continue.";
    case "stopped":
      // a reason only when something went wrong
      return list.message ? `Stopped: ${list.message}` : "Stopped";
    case "finished": {
      const rows = (state: ProfileListRow["state"]) => list.rows.filter((r) => r.state === state).length;
      const failed = rows("failed");
      return `Finished: ${count(rows("done"))} backed up, ${count(rows("skipped"))} skipped${failed ? `, ${count(failed)} failed` : ""}`;
    }
  }
}

/** What the list's panel offers in a state. */
export function listActions(state: ListState): { stop: boolean; continue: boolean; signIn: boolean; close: boolean } {
  return { stop: ACTIVE.has(state), continue: RESUMABLE.has(state), signIn: state === "signedOut", close: RESUMABLE.has(state) || state === "finished" };
}

/** A row of the list: how its profile's backup went, or that it runs or waits. */
export function rowText(row: ProfileListRow): string {
  const name = `@${row.username}`;
  switch (row.state) {
    case "done": {
      const files = row.files !== undefined ? `${counted(row.files, "file")} · ` : "";
      return `✓ ${name} — ${files}${count(row.fetched ?? 0)} new${row.note ? ` · ${row.note}` : ""}`;
    }
    case "skipped":
      return `⚠ ${name} — ${row.note ?? "skipped"}`;
    case "failed":
      return `✗ ${name} — ${row.note ?? "failed"}`;
    case "running":
      return `⏳ ${name} — running`;
    case "waiting":
      return `· ${name} — waiting`;
  }
}

/** The line above an open profile that leads back to an unfinished list: "List: 5 of 14 — @name". */
export function listBanner(list: ProfileListView | null): string | null {
  if (!list || list.state === "finished" || list.rows.length === 0) return null;
  const row = list.rows[Math.min(list.index, list.rows.length - 1)];
  return `List: ${listPosition(list)} — @${row.username}`;
}

/**
 * Whether the backup is the unfinished list's own (a part of the profile it is at): "active" while the list goes on by
 * itself (its slow-down wait runs that profile again), "resumable" when the list's Continue is the one to use; null when
 * the backup isn't the list's.
 */
export function listOwnsBackup(backup: BackupView, list: ProfileListView | null): "active" | "resumable" | null {
  if (!list || list.state === "finished") return null;
  const row = list.rows[list.index];
  if (!row || !belongsTo(backup, row.username)) return null;
  return ACTIVE.has(list.state) ? "active" : "resumable";
}

/** "list.txt · 14 profiles" */
export function fileSummary(name: string, list: ParsedProfileList): string {
  return `${name} · ${counted(list.usernames.length, "profile")}`;
}

/** The list's first names, then "+N more". */
export function namesPreview(usernames: string[]): string {
  const shown = usernames.slice(0, NAMES_SHOWN).map((u) => `@${u}`).join(", ");
  const more = usernames.length - NAMES_SHOWN;
  return more > 0 ? `${shown} +${count(more)} more` : shown;
}

/** The file's lines that aren't profiles, a few by number, then how many more. */
export function invalidLines(list: ParsedProfileList): string[] {
  const lines = list.invalid.slice(0, INVALID_SHOWN).map((l) => `Line ${l.line} isn't a profile: ${l.text}`);
  const more = list.invalid.length - INVALID_SHOWN;
  return more > 0 ? [...lines, `and ${count(more)} more`] : lines;
}

/**
 * Runs a list action of the panel or the dialog with `setBusy(true)` meanwhile and `setBusy(false)` however it ends; an
 * answer that never came (the app threw) is the action's error.
 */
export async function whileBusy<T extends Result | void>(setBusy: (busy: boolean) => void, action: () => Promise<T>): Promise<T | Result> {
  setBusy(true);
  try {
    return await action();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    setBusy(false);
  }
}

/** A wait's field as a number: empty is no number (not 0). */
export function waitNumber(text: string): number {
  return text.trim() === "" ? Number.NaN : Number(text);
}

/** Why the list's dialog can't start it yet: no file, a file that can't be a list, the wait, or what it saves. */
export function listStartProblem(o: {
  file: { list: ParsedProfileList } | null;
  wait: { min: number; max: number };
  options: ProfileSaveOptions;
  signedIn: boolean;
}): string | null {
  if (!o.file) return "Choose a .txt file first.";
  if (o.file.list.tooMany) return LIST_TOO_MANY;
  if (o.file.list.usernames.length === 0) return "The file holds no profiles.";
  return waitProblem(o.wait) ?? saveOptionsProblem(effectiveSaveOptions(o.options, o.signedIn));
}
