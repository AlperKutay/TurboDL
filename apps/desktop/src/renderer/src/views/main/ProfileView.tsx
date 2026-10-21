import { useCallback, useEffect, useState } from "react";
import { isLocked, type BackupPlan, type BackupView, type InstagramProfile, type ProfileResult } from "@turbodl/shared";
import { api } from "../../api";
import { PickBar, PostGrid, useFeed } from "./PostGrid";
import { BackupConfirm, BackupPanel } from "./SavedBackup";

/**
 * Someone's profile: who it is, its posts page by page (pinned first, as on Instagram), picks opened with Next, and
 * a backup into Instagram › <username>.
 */
export function ProfileView({ username, backup }: { username: string; backup: BackupView | null }) {
  const [result, setResult] = useState<ProfileResult | "loading">("loading");
  const [busy, setBusy] = useState(false);

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

  const { profile } = result;
  return (
    <>
      <ProfileHeader profile={profile} />
      {isLocked(profile) ? <p>This account is private</p> : <ProfilePosts profile={profile} backup={backup} busy={busy} onSignIn={() => void signIn()} />}
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
      {backup && <BackupPanel backup={backup} onSignedIn={() => undefined} />}
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
