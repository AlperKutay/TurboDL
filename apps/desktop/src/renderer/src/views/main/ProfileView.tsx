import { useCallback, useEffect, useRef, useState } from "react";
import {
  effectiveSaveOptions,
  isLocked,
  saveOptionsProblem,
  type BackupPlan,
  type BackupView,
  type Highlight,
  type InstagramProfile,
  type ProfileListView,
  type ProfileResult,
  type ProfileSaveOptions,
  type Result,
  type ScreenBackupView,
} from "@turbodl/shared";
import { api } from "../../api";
import { readHighlights, togglePick } from "../../highlight-state";
import { usePressPreview } from "../../press-preview";
import { PickBar, PostGrid, useFeed } from "./PostGrid";
import { BackupConfirm, BackupPanel } from "./SavedBackup";
import { SaveOptions } from "./SaveOptions";

/** A backup's confirmation as asked for: its plan, and whether Instagram's session is there (tagged posts need it). */
type Confirming = { plan: BackupPlan; signedIn: boolean };

/**
 * Someone's profile: who it is, then its Posts (page by page, pinned first, as on Instagram) and its Highlights, each
 * side with its own picks, Next and backup. `saveOptions`: what the last backup chose to save, offered again. `screen`: the
 * profile backup the screen started last, which goes on between its parts. `list`: the profile list, whose own backups
 * go on through it.
 */
export function ProfileView({
  username,
  backup,
  screen,
  list,
  saveOptions,
}: {
  username: string;
  backup: BackupView | null;
  screen: ScreenBackupView | null;
  list: ProfileListView | null;
  saveOptions: ProfileSaveOptions;
}) {
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
  const limited = result.limited === true;
  // a backup runs, or the screen's goes on between its parts: no other starts
  const backingUp = backup?.state === "running" || screen?.state === "running";
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
      {limited && (
        <p className="profile-limited">
          <strong>Seen signed out:</strong> TurboDL reads each post from its own page, which is slower.{" "}
          <button type="button" className="link-button" disabled={busy} onClick={() => void signIn()}>
            Sign in to Instagram
          </button>
        </p>
      )}
      {backup && <BackupPanel backup={backup} screen={screen} list={list} username={username} onSignedIn={() => undefined} />}
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
        <ProfilePosts profile={profile} limited={limited} backup={backup} backingUp={backingUp} saveOptions={saveOptions} busy={busy} onSignIn={() => void signIn()} />
      </div>
      <div className="profile-side" hidden={tab !== "highlights"}>
        <ProfileHighlights profile={profile} highlights={highlights} backup={backup} backingUp={backingUp} saveOptions={saveOptions} busy={busy} onSignIn={() => void signIn()} />
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

/** What a backup seen signed out costs: one page per post. */
export const SIGNED_OUT_PACE = "Seen signed out, each post is read from its own page, a few seconds apart: a 50-post profile takes a few minutes; a 1,000-post profile takes hours.";

/** The confirmation's plan and the account's session, read together. */
async function askConfirm(plan: Promise<BackupPlan>): Promise<Confirming> {
  const [read, account] = await Promise.all([plan, api.instagramAccount()]);
  return { plan: read, signedIn: account.signedIn };
}

/**
 * A profile backup's confirmation with the choice of what it saves, starting from what the last backup chose. Start
 * remembers the choice and waits for the backup to start (or say why it can't), staying open meanwhile.
 */
function OptionsConfirm({
  initial,
  signedIn,
  kindsOnly = false,
  signingIn,
  start,
  onSignIn,
  onClose,
  ...confirm
}: {
  title: string;
  folder: string;
  where?: string;
  unit?: string;
  plan: BackupPlan;
  note?: string;
  initial: ProfileSaveOptions;
  signedIn: boolean;
  kindsOnly?: boolean;
  /** a sign-in is going on */
  signingIn: boolean;
  start(options: ProfileSaveOptions): Promise<Result>;
  onSignIn(): void;
  onClose(): void;
}) {
  const [options, setOptions] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // the Highlights tab's backup saves highlights alone: only the kinds can be wrong
  const problem = kindsOnly ? saveOptionsProblem({ ...options, posts: false, highlights: true, tagged: false }) : saveOptionsProblem(effectiveSaveOptions(options, signedIn));

  const go = async () => {
    setStarting(true);
    setError(undefined);
    // the whole object: settings take it as it is
    void api.updateSettings({ instagramSave: options });
    const res = await start(options);
    if (res.ok) return onClose();
    setStarting(false);
    setError(res.error);
  };

  return (
    <BackupConfirm {...confirm} {...(problem ? { startBlocked: problem } : {})} starting={starting} {...(error ? { error } : {})} onStart={() => void go()} onClose={onClose}>
      <SaveOptions
        value={options}
        onChange={(next) => {
          setOptions(next);
          setError(undefined);
        }}
        signedIn={signedIn}
        kindsOnly={kindsOnly}
        signingIn={signingIn}
        onSignIn={onSignIn}
      />
    </BackupConfirm>
  );
}

function ProfilePosts({
  profile,
  limited,
  backup,
  backingUp,
  saveOptions,
  busy,
  onSignIn,
}: {
  profile: InstagramProfile;
  /** seen as signed-out visitors see it */
  limited: boolean;
  backup: BackupView | null;
  /** a backup runs, or the screen's goes on between its parts */
  backingUp: boolean;
  saveOptions: ProfileSaveOptions;
  busy: boolean;
  onSignIn(): void;
}) {
  const { username } = profile;
  const folder = `Instagram › ${username}`;
  const { state, setState, sentinel } = useFeed({ kind: "profile", username }, (_source, cursor) => api.profilePage(username, cursor));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [resumes, setResumes] = useState(false);
  const [reading, setReading] = useState(false);

  // "Continue backup" when an earlier backup of it stopped before the end
  useEffect(() => {
    void api.profileBackupPlan(username).then((plan) => setResumes(plan.resumes));
  }, [username, backup?.state, backingUp]);

  // posts seen signed out are read from their own pages first, which takes a moment each
  const next = async () => {
    setError(null);
    setReading(true);
    const res = await api.openProfilePicks(username, state.picked);
    setReading(false);
    if (res.ok) setState((s) => ({ ...s, picked: [] }));
    else setError(res.error);
  };

  return (
    <>
      {!backingUp && (
        <div>
          <button type="button" className="btn" onClick={() => void askConfirm(api.profileBackupPlan(username)).then(setConfirming)}>
            {resumes ? "Continue backup" : "Back up this profile"}
          </button>
        </div>
      )}
      {confirming && (
        <OptionsConfirm
          title={`Back up @${username}`}
          folder={folder}
          where={`Every photo and video goes into ${folder} (highlights and tagged posts into folders of their own). A later backup saves only what is new — and what you tick later is fetched for older posts too.`}
          plan={confirming.plan}
          {...(limited ? { note: SIGNED_OUT_PACE } : {})}
          initial={saveOptions}
          signedIn={confirming.signedIn}
          signingIn={busy}
          start={(options) => api.startProfileBackup(username, effectiveSaveOptions(options, confirming.signedIn))}
          onSignIn={onSignIn}
          onClose={() => setConfirming(null)}
        />
      )}
      <PostGrid state={state} setState={setState} sentinel={sentinel} emptyText="No posts yet" busy={busy} onSignIn={onSignIn} />
      <PickBar picked={state.picked.length} error={error} working={reading ? "Reading the picked posts…" : undefined} onNext={() => void next()} />
    </>
  );
}

/**
 * The profile's highlights in its tray's order: pick some (numbered), hold one to see its cover large; Next reads the
 * picked ones one at a time and opens their stories in the picker. Backed up all at once into their own folder.
 */
function ProfileHighlights({
  profile,
  highlights,
  backup,
  backingUp,
  saveOptions,
  busy,
  onSignIn,
}: {
  profile: InstagramProfile;
  highlights: Highlight[];
  backup: BackupView | null;
  /** a backup runs, or the screen's goes on between its parts */
  backingUp: boolean;
  saveOptions: ProfileSaveOptions;
  busy: boolean;
  onSignIn(): void;
}) {
  const { username } = profile;
  const [picked, setPicked] = useState<string[]>([]);
  const [loading, setLoading] = useState<{ index: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [resumes, setResumes] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  /** bumped by every Next, Cancel and the screen going: an older reading stops and its answers count for nothing */
  const reading = useRef(0);
  const { viewing, pressable, endedHold } = usePressPreview<Highlight>();

  useEffect(
    () => () => {
      reading.current++;
    },
    [],
  );

  useEffect(() => {
    void api.highlightsBackupPlan(username).then((plan) => setResumes(plan.resumes));
  }, [username, backup?.state, backingUp]);

  // each picked highlight's page is read in turn; one that shows nothing is left out
  const next = async () => {
    const mine = ++reading.current;
    const stillWanted = () => reading.current === mine;
    setError(null);
    setSignedOut(false);
    const outcome = await readHighlights(picked, (id) => api.loadHighlight(username, id), {
      stillWanted,
      onProgress: (index, total) => setLoading({ index, total }),
    });
    if (!stillWanted()) return;
    setLoading(null);
    if (outcome === "signedOut") return setSignedOut(true);
    if (outcome === "rateLimited") return setError("Instagram asked TurboDL to slow down. Try again later.");
    const res = await api.openHighlightPicks(username, picked);
    if (res.ok) setPicked([]);
    else setError(res.error);
  };

  if (highlights.length === 0) return <p className="muted">No highlights</p>;
  return (
    <>
      {!backingUp && (
        <div>
          <button type="button" className="btn" onClick={() => void askConfirm(api.highlightsBackupPlan(username)).then(setConfirming)}>
            {resumes ? "Continue backup" : "Back up highlights"}
          </button>
        </div>
      )}
      {confirming && (
        <OptionsConfirm
          title={`Back up @${username}'s highlights`}
          folder={`Instagram › ${username} · Highlights`}
          unit="highlights"
          plan={confirming.plan}
          initial={saveOptions}
          signedIn={confirming.signedIn}
          kindsOnly
          signingIn={busy}
          start={({ photos, videos }) => api.startHighlightsBackup(username, { photos, videos })}
          onSignIn={onSignIn}
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
              reading.current++;
              setLoading(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          {signedOut && (
            <p>
              Instagram signed TurboDL out.{" "}
              <button type="button" className="link-button" disabled={busy} onClick={onSignIn}>
                Sign in again
              </button>
            </p>
          )}
          <PickBar picked={picked.length} error={error} onNext={() => void next()} />
        </>
      )}
    </>
  );
}
