import type { SavedPage, SavedPageResult, SavedPost, SavedSource } from "@turbodl/shared";

/** The Saved grid: one feed, loaded page by page, and the posts picked in it. */
export interface SavedState {
  source: SavedSource;
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

export function select(state: SavedState, source: SavedSource): SavedState {
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

export function toggle(state: SavedState, postId: string): SavedState {
  const picked = state.picked.includes(postId) ? state.picked.filter((id) => id !== postId) : [...state.picked, postId];
  return { ...state, picked };
}
