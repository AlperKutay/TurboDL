import { useCallback, useEffect, useRef, useState, type Dispatch, type RefCallback, type SetStateAction } from "react";
import type { SavedPageResult, SavedPost } from "@turbodl/shared";
import { canLoadMore, initialSaved, loading, pageArrived, pageFailed, retry, select, toggle, type FeedSource, type SavedState } from "../../saved-state";

function length(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What a post's tile shows large: its first photo, or a video's cover. */
const large = (post: SavedPost) => (post.items[0]?.kind === "image" ? post.items[0].url : (post.items[0]?.thumbnail ?? post.cover));

/**
 * A grid's feed, page by page: the first page as soon as a feed is chosen, the next when the end of the grid comes
 * into view, one request at a time per feed.
 */
export function useFeed(initial: FeedSource, fetchPage: (source: FeedSource, cursor?: string) => Promise<SavedPageResult>) {
  const [state, setState] = useState<SavedState>(() => select(initialSaved(), initial));
  const current = useRef(state);
  current.current = state;
  const fetcher = useRef(fetchPage);
  fetcher.current = fetchPage;
  // the end of the grid, watched once it is on screen (the grid may come after the feed started loading)
  const [end, sentinel] = useState<HTMLDivElement | null>(null);
  /** the feed (generation) a page is being asked for */
  const asking = useRef<number | null>(null);

  const loadMore = useCallback(async () => {
    const s = current.current;
    if (asking.current === s.generation || !canLoadMore(s)) return;
    asking.current = s.generation;
    setState(loading(s));
    const answer = await fetcher.current(s.source, s.next);
    if (asking.current === s.generation) asking.current = null;
    setState((now) => (answer.type === "page" ? pageArrived(now, s.generation, answer.page) : pageFailed(now, s.generation, answer)));
  }, []);

  // the next page when the end of the grid comes into view
  useEffect(() => {
    if (!end) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    watcher.observe(end);
    return () => watcher.disconnect();
  }, [end, loadMore, state.posts.length, state.status]);

  // a new feed starts loading as soon as it is chosen
  useEffect(() => {
    if (state.status === "idle" && state.posts.length === 0) void loadMore();
  }, [state.generation, state.status, state.posts.length, loadMore]);

  return { state, setState, sentinel };
}

/** Posts as tiles: click to pick (numbered), hover to see one large; the feed's state below them. */
export function PostGrid({
  state,
  setState,
  sentinel,
  emptyText,
  busy,
  onSignIn,
}: {
  state: SavedState;
  setState: Dispatch<SetStateAction<SavedState>>;
  sentinel: RefCallback<HTMLDivElement>;
  emptyText: string;
  busy: boolean;
  onSignIn(): void;
}) {
  const [viewing, setViewing] = useState<SavedPost | null>(null);
  return (
    <>
      <div className="saved-scroll">
        <ul className="ig-grid">
          {state.posts.map((post, i) => {
            const number = state.picked.indexOf(post.id);
            const only = post.items.length === 1 ? post.items[0] : undefined;
            return (
              <li key={post.id}>
                <button
                  type="button"
                  className="ig-tile"
                  aria-label={`Post ${i + 1}`}
                  aria-pressed={number >= 0}
                  onClick={() => setState((s) => toggle(s, post.id))}
                  onMouseEnter={() => setViewing(post)}
                  onMouseLeave={() => setViewing(null)}
                >
                  {post.cover ? <img src={post.cover} alt="" draggable={false} /> : <span className="ig-blank" />}
                  <span className="ig-pick">{number >= 0 ? number + 1 : ""}</span>
                  {post.pinned && <span className="ig-badge ig-pin">Pinned</span>}
                  {post.items.length > 1 && <span className="ig-badge">{post.items.length} items</span>}
                  {only?.kind === "video" && <span className="ig-badge">▶ {only.duration !== undefined ? length(only.duration) : "Video"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div ref={sentinel} className="saved-end">
          {state.status === "loading" && <span className="muted">Loading…</span>}
          {state.status === "end" && state.posts.length === 0 && <span className="muted">{emptyText}</span>}
          {state.status === "signedOut" && (
            <span>
              Instagram signed TurboDL out.{" "}
              <button type="button" className="link-button" disabled={busy} onClick={onSignIn}>
                Sign in again
              </button>
            </span>
          )}
          {state.status === "rateLimited" && (
            <span>
              Instagram asked TurboDL to slow down. Try again later.{" "}
              <button type="button" className="link-button" onClick={() => setState((s) => retry(s))}>
                Try again
              </button>
            </span>
          )}
          {state.status === "failed" && (
            <span className="error-text">
              {state.error}{" "}
              <button type="button" className="link-button" onClick={() => setState((s) => retry(s))}>
                Retry
              </button>
            </span>
          )}
        </div>
      </div>
      {viewing && large(viewing) && (
        <div className="ig-large" aria-hidden="true">
          <img src={large(viewing)} alt="" />
        </div>
      )}
    </>
  );
}

/** The bottom bar: why the last action failed, and Next over the picked posts. */
export function PickBar({ picked, error, onNext }: { picked: number; error: string | null; onNext(): void }) {
  return (
    <div className="saved-actions">
      {error && <span className="error-text">{error}</span>}
      <span className="muted">Click to pick · hover to see it large</span>
      <button type="button" className="btn btn-primary" disabled={picked === 0} onClick={onNext}>
        Next ({picked})
      </button>
    </div>
  );
}
