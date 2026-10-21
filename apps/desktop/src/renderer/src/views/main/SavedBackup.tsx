import { formatBytes, type BackupPlan, type BackupView, type SavedCollection } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

/** What starting a backup means: how many posts, roughly how large, and the warnings that go with it. */
export function BackupConfirm({ collection, plan, onStart, onClose }: { collection: SavedCollection; plan: BackupPlan; onStart(): void; onClose(): void }) {
  const tooBig = plan.bytes !== undefined && plan.freeBytes !== undefined && plan.bytes > plan.freeBytes;
  return (
    <Modal
      title={`Back up ${collection.name}`}
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
      <p className="muted">Every photo and video goes into Instagram › Saved › {collection.name}. A later backup saves only what is new.</p>
      {plan.resumes && <p>An earlier backup stopped before the end; this one goes on from there.</p>}
      {plan.large && <p className="error-text">This collection holds more than 1,000 posts. Backing it up may take many hours, and Instagram may ask TurboDL to slow down.</p>}
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

/** The running or last backup: its post, Done · Left · Failed, and Stop or Continue. */
export function BackupPanel({ backup }: { backup: BackupView }) {
  const running = backup.state === "running";
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
      </div>
      {running ? (
        <button type="button" className="btn" onClick={() => void api.stopBackup()}>
          Stop
        </button>
      ) : (
        backup.state !== "finished" && (
          <button type="button" className="btn" onClick={() => void api.startBackup(backup.targetId)}>
            Continue
          </button>
        )
      )}
    </section>
  );
}
