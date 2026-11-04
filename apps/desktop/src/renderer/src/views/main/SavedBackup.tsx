import { useState, type ReactNode } from "react";
import { formatBytes, type BackupPlan, type BackupView, type ScreenBackupView } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { backupAction, panelState } from "../../saved-state";

/**
 * What starting a backup means: how many posts, roughly how large, where they go, and the warnings that go with it; then
 * what it saves (`children`, when it offers a choice), and why it can't start.
 */
export function BackupConfirm({
  title,
  folder,
  where,
  unit = "posts",
  plan,
  note,
  children,
  startBlocked,
  starting = false,
  error,
  onStart,
  onClose,
}: {
  title: string;
  folder: string;
  /** the whole line saying where the files go, when more than one folder is filled */
  where?: string;
  /** what the count counts */
  unit?: string;
  plan: BackupPlan;
  /** what else this backup means (how long it takes seen signed out) */
  note?: string;
  /** the choice of what it saves */
  children?: ReactNode;
  /** why the backup can't start with what is chosen; Start is disabled */
  startBlocked?: string;
  /** the start was asked for and isn't answered yet: Start waits, and the dialog stays until the answer */
  starting?: boolean;
  /** why the start was refused */
  error?: string;
  onStart(): void;
  onClose(): void;
}) {
  const tooBig = plan.bytes !== undefined && plan.freeBytes !== undefined && plan.bytes > plan.freeBytes;
  const close = starting ? () => undefined : onClose;
  return (
    <Modal
      title={title}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" disabled={starting} onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={starting || startBlocked !== undefined} onClick={onStart}>
            {starting ? "Starting…" : "Start backup"}
          </button>
        </>
      }
    >
      <p>
        {plan.count !== undefined ? `${plan.count.toLocaleString()} ${unit}` : `Instagram doesn't say how many ${unit} it holds.`}{" "}
        {plan.bytes !== undefined ? `About ${formatBytes(plan.bytes)} (an estimate from the posts loaded so far).` : "No size estimate yet."}
      </p>
      <p className="muted">{where ?? `Every photo and video goes into ${folder}. A later backup saves only what is new.`}</p>
      {note && <p>{note}</p>}
      {plan.resumes && <p>An earlier backup stopped before the end; this one goes on from there.</p>}
      {plan.large && <p className="error-text">This holds more than 1,000 posts. Backing it up may take many hours, and Instagram may ask TurboDL to slow down.</p>}
      {tooBig && <p className="error-text">That is more than the free space on this drive ({formatBytes(plan.freeBytes ?? 0)} free).</p>}
      {children}
      {startBlocked && <p className="error-text">{startBlocked}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}

const STATES: Record<BackupView["state"], string> = {
  running: "Backing up…",
  stopped: "Backup stopped",
  finished: "Backup finished",
  signedOut: "Instagram signed TurboDL out. Sign in again, then continue.",
  rateLimited: "Instagram asked TurboDL to slow down. Continue later.",
  failed: "Backup failed",
};

/**
 * The running or last backup: its post, Done · Left · Failed · New, and Stop, Continue or sign-in. `screen`: the profile
 * backup the screen started, whose parts run in turn (it goes on between them: Stop); its warnings and how it ended show
 * on its own profile's screen (`username`).
 */
export function BackupPanel({ backup, screen = null, username, onSignedIn }: { backup: BackupView; screen?: ScreenBackupView | null; username?: string; onSignedIn(): void }) {
  const shown = panelState(backup, screen);
  const running = shown.state === "running";
  const action = backupAction(shown.state);
  const own = screen && username !== undefined && screen.username.toLowerCase() === username.toLowerCase() ? screen : null;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setError(null);
    const res = await api.continueBackup();
    if (!res.ok) setError(res.error);
  };
  // signed out midway: sign in again, then go on where it stopped
  const signIn = async () => {
    setBusy(true);
    const ok = await api.instagramSignIn();
    setBusy(false);
    if (!ok) return setError("Not signed in to Instagram.");
    onSignedIn();
    await resume();
  };
  return (
    <section className="backup-panel" aria-label="Backup">
      {backup.cover ? <img src={backup.cover} alt="" draggable={false} /> : <span className="saved-collection-blank" />}
      <div className="backup-text">
        <strong>{backup.name}</strong>
        <span>
          {STATES[shown.state]}
          {shown.error ? `: ${shown.error}` : ""}
        </span>
        {backup.reading && <span className="muted">Signed out: reading each post from its own page</span>}
        <span className="muted">
          Done {backup.done} · Left {backup.left ?? "?"} · Failed {backup.failed} · New {backup.saved}
        </span>
        {backup.signInOnly ? <span className="muted">{backup.signInOnly} shown only to signed-in visitors</span> : null}
        {backup.warning && <span className="muted">{backup.warning}</span>}
        {own?.warnings.map((warning, k) => (
          <span key={k} className="muted">
            {warning}
          </span>
        ))}
        {running && <progress max={1} value={backup.progress} />}
        {error && <span className="error-text">{error}</span>}
      </div>
      {action === "stop" && (
        <button type="button" className="btn" onClick={() => void api.stopBackup()}>
          Stop
        </button>
      )}
      {action === "continue" && (
        <button type="button" className="btn" onClick={() => void resume()}>
          Continue
        </button>
      )}
      {action === "signIn" && (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
          Sign in to Instagram
        </button>
      )}
    </section>
  );
}
