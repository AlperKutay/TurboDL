import { useCallback, useEffect, useState } from "react";
import type { BackupPlan, BackupView, InstagramAccount, SavedCollection, SavedSource } from "@turbodl/shared";
import { api } from "../../api";
import { sameFeed, select, type FeedSource } from "../../saved-state";
import { PickBar, PostGrid, useFeed } from "./PostGrid";
import { BackupConfirm, BackupPanel } from "./SavedBackup";

const ALL: SavedCollection = { id: "all", name: "All posts", isAll: true };

/** All first (it's there even before the list is read), then the account's own collections. */
function withAll(list: SavedCollection[]): SavedCollection[] {
  const all = list.find((c) => c.isAll) ?? ALL;
  return [all, ...list.filter((c) => !c.isAll)];
}

const sourceOf = (c: SavedCollection): SavedSource => (c.isAll ? { kind: "all" } : { kind: "collection", id: c.id });

/** Saved's feeds only; a grid here never shows a profile. */
const savedPage = (source: FeedSource, cursor?: string) =>
  source.kind === "profile" ? Promise.resolve({ type: "failed" as const, message: "Not a saved feed." }) : api.savedPage(source, cursor);

/**
 * Instagram → Saved: the account, All and its collections, a grid that loads page by page as it scrolls, posts
 * picked in order and opened in the picker with Next.
 */
export function SavedView({ backup }: { backup: BackupView | null }) {
  const [account, setAccount] = useState<InstagramAccount | null>(null);
  const [collections, setCollections] = useState<SavedCollection[]>([ALL]);
  const { state, setState, sentinel } = useFeed({ kind: "all" }, savedPage);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<{ collection: SavedCollection; plan: BackupPlan } | null>(null);
  const [resumes, setResumes] = useState(false);

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

  const choose = (c: SavedCollection) => {
    if (sameFeed(sourceOf(c), state.source)) return;
    setState(select(state, sourceOf(c)));
  };

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
          <button key={c.id} type="button" role="tab" aria-selected={sameFeed(sourceOf(c), state.source)} className="saved-collection" onClick={() => choose(c)}>
            {c.cover ? <img src={c.cover} alt="" draggable={false} /> : <span className="saved-collection-blank" />}
            <span>{c.name || "Untitled"}</span>
            {c.count !== undefined && <span className="count">{c.count}</span>}
          </button>
        ))}
      </div>

      {backup && <BackupPanel backup={backup} onSignedIn={() => void api.instagramAccount().then(setAccount)} />}
      {shown && backup?.state !== "running" && (
        <div>
          <button type="button" className="btn" onClick={() => void askBackup(shown)}>
            {resumes ? "Continue backup" : "Back up this collection"}
          </button>
        </div>
      )}
      {confirming && (
        <BackupConfirm
          title={`Back up ${confirming.collection.name}`}
          folder={`Instagram › Saved › ${confirming.collection.name}`}
          plan={confirming.plan}
          onStart={() => void startBackup(confirming.collection)}
          onClose={() => setConfirming(null)}
        />
      )}

      <PostGrid state={state} setState={setState} sentinel={sentinel} emptyText="Nothing saved here." busy={busy} onSignIn={() => void signIn()} />
      <PickBar picked={state.picked.length} error={error} onNext={() => void next()} />
    </div>
  );
}
