import { useState } from "react";
import { formatBytes, type BackupPlan, type BackupView } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { backupAction } from "../../saved-state";

/** What starting a backup means: how many posts, roughly how large, where they go, and the warnings that go with it. */
export function BackupConfirm({ title, folder, plan, onStart, onClose }: { title: string; folder: string; plan: BackupPlan; onStart(): void; onClose(): void }) {
  const tooBig = plan.bytes !== undefined && plan.freeBytes !== undefined && plan.bytes > plan.freeBytes;
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={onStart}>
            Start backup
          </button>
        </>
      }
    >
      <p>
        {plan.count !== undefined ? `${plan.count.toLocaleString()} posts` : "Instagram doesn't say how many posts it holds."}{" "}
        {plan.bytes !== undefined ? `About ${formatBytes(plan.bytes)} (an estimate from the posts loaded so far).` : "No size estimate yet."}
      </p>
      <p className="muted">Every photo and video goes into {folder}. A later backup saves only what is new.</p>
      {plan.resumes && <p>An earlier backup stopped before the end; this one goes on from there.</p>}
      {plan.large && <p className="error-text">This holds more than 1,000 posts. Backing it up may take many hours, and Instagram may ask TurboDL to slow down.</p>}
      {tooBig && <p className="error-text">That is more than the free space on this drive ({formatBytes(plan.freeBytes ?? 0)} free).</p>}
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

/** The running or last backup: its post, Done · Left · Failed · New, and Stop, Continue or sign-in. */
export function BackupPanel({ backup, onSignedIn }: { backup: BackupView; onSignedIn(): void }) {
  const running = backup.state === "running";
  const action = backupAction(backup.state);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resume = async () => {
    setError(null);
    const res = backup.kind === "collection" ? await api.startBackup(backup.targetId) : await api.startProfileBackup(backup.name);
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
          {STATES[backup.state]}
          {backup.state === "failed" && backup.error ? `: ${backup.error}` : ""}
        </span>
        <span className="muted">
          Done {backup.done} · Left {backup.left ?? "?"} · Failed {backup.failed} · New {backup.saved}
        </span>
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
