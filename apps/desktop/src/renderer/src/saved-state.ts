import { type BackupView, type SavedPage, type SavedPageResult, type SavedPost, type SavedSource, type ScreenBackupView } from "@turbodl/shared";

/** What a grid shows: All, one of the account's collections, or someone's profile. */
export type FeedSource = SavedSource | { kind: "profile"; username: string };

/** Whether two grids show the same feed. */
export function sameFeed(a: FeedSource, b: FeedSource): boolean {
  if (a.kind === "all" || b.kind === "all") return a.kind === b.kind;
  if (a.kind === "collection") return b.kind === "collection" && a.id === b.id;
  return b.kind === "profile" && a.username.toLowerCase() === b.username.toLowerCase();
}

/** A grid (Saved's or a profile's): one feed, loaded page by page, and the posts picked in it. */
export interface SavedState {
  source: FeedSource;
  posts: SavedPost[];
  /** the next page's cursor; none before the first page and after the last */
  next?: string;
  status: "idle" | "loading" | "end" | "signedOut" | "rateLimited" | "failed";
  error?: string;
  /** post ids, in the order they were picked */
  picked: string[];
  /** bumped by `select`, so a page that arrives for an earlier feed is dropped */
  generation: number;
}

export function initialSaved(): SavedState {
  return { source: { kind: "all" }, posts: [], status: "idle", picked: [], generation: 0 };
}

export function select(state: SavedState, source: FeedSource): SavedState {
  return { source, posts: [], status: "idle", picked: [], generation: state.generation + 1 };
}

/** Whether the next page may be asked for now. */
export function canLoadMore(state: SavedState): boolean {
  return state.status === "idle" && (state.posts.length === 0 || state.next !== undefined);
}

export function loading(state: SavedState): SavedState {
  return { ...state, status: "loading", error: undefined };
}

export function pageArrived(state: SavedState, generation: number, page: SavedPage): SavedState {
  if (generation !== state.generation) return state;
  const known = new Set(state.posts.map((p) => p.id));
  const fresh = page.posts.filter((p) => !known.has(p.id) && known.add(p.id));
  const { next: _old, ...rest } = state;
  return { ...rest, posts: [...state.posts, ...fresh], ...(page.next ? { next: page.next } : {}), status: page.next ? "idle" : "end" };
}

export function pageFailed(state: SavedState, generation: number, result: Exclude<SavedPageResult, { type: "page" }>): SavedState {
  if (generation !== state.generation) return state;
  return result.type === "failed" ? { ...state, status: "failed", error: result.message } : { ...state, status: result.type };
}

/** After a failure or Instagram asking to slow down, when the owner asks again. */
export function retry(state: SavedState): SavedState {
  return state.status === "failed" || state.status === "rateLimited" ? { ...state, status: "idle", error: undefined } : state;
}

/** Whether the backup is one of the profile's parts: its posts' ("sample.user"), highlights' or tagged posts' ("sample.user · Highlights"). */
export function belongsTo(backup: BackupView, username: string): boolean {
  const name = backup.name.toLowerCase();
  const user = username.toLowerCase();
  if (backup.kind === "profile") return name === user;
  if (backup.kind === "highlights") return name === `${user} · highlights`;
  return backup.kind === "tagged" && name === `${user} · tagged`;
}

/** The screen's backup, when it is the one the panel's backup is a part of: one that never ran, or ran for another profile, isn't. */
function ownScreen(backup: BackupView, screen: ScreenBackupView | null): ScreenBackupView | null {
  return screen?.ran && belongsTo(backup, screen.username) ? screen : null;
}

/**
 * What the backup panel says of the backup: its own state, except while the screen's profile backup goes on (between
 * its parts too, when no backup runs: Stop), and how that ended once its last part had finished (stopped between parts,
 * or a later part refused). Only for the screen's own profile's backup: a screen backup refused before it ran, or
 * running for another profile, leaves the panel alone.
 */
export function panelState(backup: BackupView, screen: ScreenBackupView | null): { state: BackupView["state"]; error?: string } {
  const own = ownScreen(backup, screen);
  if (own?.state === "running") return { state: "running" };
  if (backup.state === "finished" && own?.state === "cancelled") return { state: "stopped" };
  if (backup.state === "finished" && own?.state === "failed") return { state: "failed", ...(own.error ? { error: own.error } : {}) };
  return { state: backup.state, ...(backup.state === "failed" && backup.error ? { error: backup.error } : {}) };
}

/** What the screen's backup warned of beyond the backup's own progress; the part's own warning (shown with it) not twice. */
export function panelWarnings(backup: BackupView, screen: ScreenBackupView | null): string[] {
  return ownScreen(backup, screen)?.warnings.filter((w) => w !== backup.warning) ?? [];
}

/**
 * What a backup's panel offers: Stop while it runs, sign-in when Instagram signed TurboDL out, else Continue. A backup a
 * profile list goes on with by itself (`listed` "active": its slow-down wait) offers no more than Stop.
 */
export function backupAction(state: BackupView["state"], listed: "active" | "resumable" | null = null): "stop" | "continue" | "signIn" | "none" {
  if (state === "running") return "stop";
  if (listed === "active") return "none";
  if (state === "signedOut") return "signIn";
  return state === "finished" ? "none" : "continue";
}

export function toggle(state: SavedState, postId: string): SavedState {
  const picked = state.picked.includes(postId) ? state.picked.filter((id) => id !== postId) : [...state.picked, postId];
  return { ...state, picked };
}
