import { useCallback, useEffect, useRef, useState } from "react";
import { isLocked, type BackupPlan, type BackupView, type Highlight, type InstagramProfile, type ProfileResult } from "@turbodl/shared";
import { api } from "../../api";
import { nextLoad, togglePick } from "../../highlight-state";
import { usePressPreview } from "../../press-preview";
import { PickBar, PostGrid, useFeed } from "./PostGrid";
import { BackupConfirm, BackupPanel } from "./SavedBackup";

/**
 * Someone's profile: who it is, then its Posts (page by page, pinned first, as on Instagram) and its Highlights, each
 * side with its own picks, Next and backup.
 */
export function ProfileView({ username, backup }: { username: string; backup: BackupView | null }) {
  const [result, setResult] = useState<ProfileResult | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<"posts" | "highlights">("posts");

  const load = useCallback(async () => {
    setResult("loading");
    setResult(await api.profileLoad(username));
  }, [username]);

  // the profile's hidden page stays while it is the open profile (the app reads it once); "All profiles" lets it go
  useEffect(() => {
    void load();
  }, [load]);

  const signIn = async () => {
    setBusy(true);
    const ok = await api.instagramSignIn();
    setBusy(false);
    if (ok) await load();
  };

  if (result === "loading") return <p className="muted spinner">Reading Instagram…</p>;
  if (result.type === "signedOut") {
    return (
      <div className="saved-empty">
        <p>Sign in to Instagram to see this profile's posts.</p>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
          Sign in to Instagram
        </button>
      </div>
    );
  }
  if (result.type !== "profile") {
    return (
      <p>
        {result.type === "rateLimited" ? "Instagram asked TurboDL to slow down. Try again later." : result.message}{" "}
        <button type="button" className="link-button" onClick={() => void load()}>
          Try again
        </button>
      </p>
    );
  }

  const { profile, highlights } = result;
  if (isLocked(profile)) {
    return (
      <>
        <ProfileHeader profile={profile} />
        <p>This account is private</p>
      </>
    );
  }
  return (
    <>
      <ProfileHeader profile={profile} />
      {backup && <BackupPanel backup={backup} onSignedIn={() => undefined} />}
      <div className="saved-collections" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "posts"} className="saved-collection" onClick={() => setTab("posts")}>
          Posts
        </button>
        <button type="button" role="tab" aria-selected={tab === "highlights"} className="saved-collection" onClick={() => setTab("highlights")}>
          Highlights
          <span className="count">{highlights.length}</span>
        </button>
      </div>
      {/* both sides stay, each with its own picks; only the one chosen shows */}
      <div className="profile-side" hidden={tab !== "posts"}>
        <ProfilePosts profile={profile} backup={backup} busy={busy} onSignIn={() => void signIn()} />
      </div>
      <div className="profile-side" hidden={tab !== "highlights"}>
        <ProfileHighlights profile={profile} highlights={highlights} backup={backup} />
      </div>
    </>
  );
}

function ProfileHeader({ profile }: { profile: InstagramProfile }) {
  return (
    <div className="profile-head">
      {profile.picture ? <img src={profile.picture} alt="" draggable={false} /> : <span className="saved-collection-blank" />}
      <div>
        <strong>{profile.fullName || profile.username}</strong>
        <span className="muted">@{profile.username}</span>
        {profile.postCount !== undefined && <span className="muted">{profile.postCount.toLocaleString()} posts</span>}
      </div>
    </div>
  );
}

function ProfilePosts({ profile, backup, busy, onSignIn }: { profile: InstagramProfile; backup: BackupView | null; busy: boolean; onSignIn(): void }) {
  const { username } = profile;
  const { state, setState, sentinel } = useFeed({ kind: "profile", username }, (_source, cursor) => api.profilePage(username, cursor));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BackupPlan | null>(null);
  const [resumes, setResumes] = useState(false);

  // "Continue backup" when an earlier backup of it stopped before the end
  useEffect(() => {
    void api.profileBackupPlan(username).then((plan) => setResumes(plan.resumes));
  }, [username, backup?.state]);

  const startBackup = async () => {
    setConfirming(null);
    const res = await api.startProfileBackup(username);
    if (!res.ok) setError(res.error);
  };
  const next = async () => {
    setError(null);
    const res = await api.openProfilePicks(username, state.picked);
    if (res.ok) setState((s) => ({ ...s, picked: [] }));
    else setError(res.error);
  };

  return (
    <>
      {backup?.state !== "running" && (
        <div>
          <button type="button" className="btn" onClick={() => void api.profileBackupPlan(username).then(setConfirming)}>
            {resumes ? "Continue backup" : "Back up this profile"}
          </button>
        </div>
      )}
      {confirming && (
        <BackupConfirm title={`Back up @${username}`} folder={`Instagram › ${username}`} plan={confirming} onStart={() => void startBackup()} onClose={() => setConfirming(null)} />
      )}
      <PostGrid state={state} setState={setState} sentinel={sentinel} emptyText="No posts yet" busy={busy} onSignIn={onSignIn} />
      <PickBar picked={state.picked.length} error={error} onNext={() => void next()} />
    </>
  );
}

/**
 * The profile's highlights in its tray's order: pick some (numbered), hold one to see its cover large; Next reads the
 * picked ones one at a time and opens their stories in the picker. Backed up all at once into their own folder.
 */
function ProfileHighlights({ profile, highlights, backup }: { profile: InstagramProfile; highlights: Highlight[]; backup: BackupView | null }) {
  const { username } = profile;
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState<{ index: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<BackupPlan | null>(null);
  const [resumes, setResumes] = useState(false);
  const cancelled = useRef(false);
  const { viewing, pressable, endedHold } = usePressPreview<Highlight>();

  useEffect(() => {
    void api.highlightsBackupPlan(username).then((plan) => setResumes(plan.resumes));
  }, [username, backup?.state]);

  // each picked highlight's page is read in turn; one that shows nothing is left out
  const next = async () => {
    setError(null);
    cancelled.current = false;
    for (let loaded = 0; ; loaded++) {
      const step = nextLoad(picked, loaded);
      if (!step) break;
      setLoading({ index: step.index, total: step.total });
      const res = await api.loadHighlight(username, step.id);
      if (cancelled.current) return setLoading(null);
      if (res.type === "signedOut" || res.type === "rateLimited") {
        setLoading(null);
        return setError(res.type === "signedOut" ? "Instagram signed TurboDL out. Sign in again." : "Instagram asked TurboDL to slow down. Try again later.");
      }
    }
    setLoading(null);
    const res = await api.openHighlightPicks(username, picked);
    if (res.ok) setPicked([]);
    else setError(res.error);
  };
  const startBackup = async () => {
    setConfirming(null);
    const res = await api.startHighlightsBackup(username);
    if (!res.ok) setError(res.error);
  };

  if (highlights.length === 0) return <p className="muted">No highlights</p>;
  return (
    <>
      {backup?.state !== "running" && (
        <div>
          <button type="button" className="btn" onClick={() => void api.highlightsBackupPlan(username).then(setConfirming)}>
            {resumes ? "Continue backup" : "Back up highlights"}
          </button>
        </div>
      )}
      {confirming && (
        <BackupConfirm
          title={`Back up @${username}'s highlights`}
          folder={`Instagram › ${username} · Highlights`}
          unit="highlights"
          plan={confirming}
          onStart={() => void startBackup()}
          onClose={() => setConfirming(null)}
        />
      )}
      <div className="saved-scroll">
        <ul className="ig-grid">
          {highlights.map((h) => {
            const number = picked.indexOf(h.id);
            return (
              <li key={h.id} className="hl-cell">
                <button
                  type="button"
                  className="ig-tile"
                  aria-label={h.title || "Highlight"}
                  aria-pressed={number >= 0}
                  disabled={loading !== null}
                  onClick={() => {
                    if (!endedHold()) setPicked((list) => togglePick(list, h.id));
                  }}
                  {...pressable(h)}
                >
                  {h.cover ? <img src={h.cover} alt="" draggable={false} /> : <span className="ig-blank" />}
                  <span className="ig-pick">{number >= 0 ? number + 1 : ""}</span>
                </button>
                <span className="hl-title">{h.title}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {viewing?.cover && (
        <div className="ig-large" aria-hidden="true">
          <img src={viewing.cover} alt="" />
        </div>
      )}
      {loading ? (
        <div className="saved-actions">
          <span className="muted">
            Loading highlight {loading.index} of {loading.total}…
          </span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              cancelled.current = true;
              setLoading(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <PickBar picked={picked.length} error={error} onNext={() => void next()} />
      )}
    </>
  );
}
