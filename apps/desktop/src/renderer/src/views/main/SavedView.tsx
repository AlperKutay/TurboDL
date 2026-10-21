import { useCallback, useEffect, useRef, useState } from "react";
import type { BackupPlan, BackupView, InstagramAccount, SavedCollection, SavedPost, SavedSource } from "@turbodl/shared";
import { api } from "../../api";
import { canLoadMore, initialSaved, loading, pageArrived, pageFailed, retry, select, toggle, type SavedState } from "../../saved-state";
import { BackupConfirm, BackupPanel } from "./SavedBackup";

const ALL: SavedCollection = { id: "all", name: "All posts", isAll: true };

/** All first (it's there even before the list is read), then the account's own collections. */
function withAll(list: SavedCollection[]): SavedCollection[] {
  const all = list.find((c) => c.isAll) ?? ALL;
  return [all, ...list.filter((c) => !c.isAll)];
}

const sourceOf = (c: SavedCollection): SavedSource => (c.isAll ? { kind: "all" } : { kind: "collection", id: c.id });
const sameSource = (a: SavedSource, b: SavedSource) => a.kind === b.kind && (a.kind === "all" || (b.kind === "collection" && a.id === b.id));

function length(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** What a post's tile shows large: its first photo, or a video's cover. */
const large = (post: SavedPost) => (post.items[0]?.kind === "image" ? post.items[0].url : (post.items[0]?.thumbnail ?? post.cover));

/**
 * Instagram → Saved: the account, All and its collections, a grid that loads page by page as it scrolls, posts
 * picked in order and opened in the picker with Next.
 */
export function SavedView({ backup }: { backup: BackupView | null }) {
  const [account, setAccount] = useState<InstagramAccount | null>(null);
  const [collections, setCollections] = useState<SavedCollection[]>([ALL]);
  const [state, setState] = useState<SavedState>(() => select(initialSaved(), { kind: "all" }));
  const [viewing, setViewing] = useState<SavedPost | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{ collection: SavedCollection; plan: BackupPlan } | null>(null);
  const [resumes, setResumes] = useState(false);
  const current = useRef(state);
  current.current = state;
  const sentinel = useRef<HTMLDivElement>(null);
  /** the feed (generation) a page is being asked for */
  const asking = useRef<number | null>(null);

  const loadMore = useCallback(async () => {
    const s = current.current;
    if (asking.current === s.generation || !canLoadMore(s)) return;
    asking.current = s.generation;
    setState(loading(s));
    const answer = await api.savedPage(s.source, s.next);
    if (asking.current === s.generation) asking.current = null;
    setState((now) => (answer.type === "page" ? pageArrived(now, s.generation, answer.page) : pageFailed(now, s.generation, answer)));
  }, []);

  const refresh = useCallback(async () => {
    const who = await api.instagramAccount();
    setAccount(who);
    if (!who.signedIn) return;
    const kept = await api.savedCollections(false);
    if (kept !== "signedOut") setCollections(withAll(kept));
    const fresh = await api.savedCollections(true);
    if (fresh !== "signedOut") setCollections(withAll(fresh));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // the next page when the end of the grid comes into view
  useEffect(() => {
    const end = sentinel.current;
    if (!end) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    });
    watcher.observe(end);
    return () => watcher.disconnect();
  }, [loadMore, state.posts.length, state.status]);

  const choose = (c: SavedCollection) => {
    if (sameSource(sourceOf(c), state.source)) return;
    setState(select(state, sourceOf(c)));
  };
  // a new feed starts loading as soon as it is chosen
  useEffect(() => {
    if (state.status === "idle" && state.posts.length === 0) void loadMore();
  }, [state.generation, state.status, state.posts.length, loadMore]);

  const shown = state.source.kind === "collection" ? collections.find((c) => !c.isAll && state.source.kind === "collection" && c.id === state.source.id) : undefined;
  // "Continue backup" when an earlier backup of it stopped before the end
  useEffect(() => {
    setResumes(false);
    if (shown) void api.backupPlan(shown.id).then((plan) => setResumes(plan.resumes));
  }, [shown?.id, backup?.state]);

  const askBackup = async (collection: SavedCollection) => {
    setConfirming({ collection, plan: await api.backupPlan(collection.id) });
  };
  const startBackup = async (collection: SavedCollection) => {
    setConfirming(null);
    const res = await api.startBackup(collection.id);
    if (!res.ok) setError(res.error);
  };

  const signIn = async () => {
    setBusy(true);
    const ok = await api.instagramSignIn();
    setBusy(false);
    if (!ok) return setError("Not signed in to Instagram.");
    setError(null);
    setState((s) => select(s, s.source));
    await refresh();
  };
  const signOut = async () => {
    await api.instagramSignOut();
    setAccount({ signedIn: false });
    setCollections([ALL]);
    setState((s) => select(s, { kind: "all" }));
  };
  const next = async () => {
    setError(null);
    const res = await api.openSavedPicks(state.picked);
    if (res.ok) setState((s) => ({ ...s, picked: [] }));
    else setError(res.error);
  };

  if (account === null) return <div className="saved muted">Loading…</div>;
  if (!account.signedIn) {
    return (
      <div className="saved saved-empty">
        <p>Sign in to Instagram to see your saved posts.</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
          Sign in to Instagram
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  return (
    <div className="saved">
      <div className="saved-head">
        <span className="muted">{account.username ? `Signed in as @${account.username}` : "Signed in to Instagram"}</span>
        <button type="button" className="link-button" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
      <div className="saved-collections" role="tablist">
        {collections.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={sameSource(sourceOf(c), state.source)}
            className="saved-collection"
            onClick={() => choose(c)}
          >
            {c.cover ? <img src={c.cover} alt="" draggable={false} /> : <span className="saved-collection-blank" />}
            <span>{c.name || "Untitled"}</span>
            {c.count !== undefined && <span className="count">{c.count}</span>}
          </button>
        ))}
      </div>

      {backup && <BackupPanel backup={backup} />}
      {shown && backup?.state !== "running" && (
        <div>
          <button type="button" className="btn" onClick={() => void askBackup(shown)}>
            {resumes ? "Continue backup" : "Back up this collection"}
          </button>
        </div>
      )}
      {confirming && (
        <BackupConfirm collection={confirming.collection} plan={confirming.plan} onStart={() => void startBackup(confirming.collection)} onClose={() => setConfirming(null)} />
      )}

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
                  {post.items.length > 1 && <span className="ig-badge">{post.items.length} items</span>}
                  {only?.kind === "video" && <span className="ig-badge">▶ {only.duration !== undefined ? length(only.duration) : "Video"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <div ref={sentinel} className="saved-end">
          {state.status === "loading" && <span className="muted">Loading…</span>}
          {state.status === "end" && state.posts.length === 0 && <span className="muted">Nothing saved here.</span>}
          {state.status === "signedOut" && (
            <span>
              Instagram signed TurboDL out.{" "}
              <button type="button" className="link-button" disabled={busy} onClick={() => void signIn()}>
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
      <div className="saved-actions">
        {error && <span className="error-text">{error}</span>}
        <span className="muted">Click to pick · hover to see it large</span>
        <button type="button" className="btn btn-primary" disabled={state.picked.length === 0} onClick={() => void next()}>
          Next ({state.picked.length})
        </button>
      </div>
    </div>
  );
}
