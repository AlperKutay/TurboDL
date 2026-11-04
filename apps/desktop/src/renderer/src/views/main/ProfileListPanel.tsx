import { useEffect, useState } from "react";
import type { BackupView, ProfileListView, Result } from "@turbodl/shared";
import { api } from "../../api";
import { listActions, listPosition, listStateLine, rowText } from "../../profile-list-state";

/**
 * The profile list on the Profiles screen: its file, where it is, its state (the wait before the next profile counting
 * down), Stop, Continue, sign-in and Close as its state calls for, and a row per profile, which opens that profile.
 * `backup`: the backup running, which names the part a running profile is at.
 */
export function ProfileListPanel({ list, backup, onOpen }: { list: ProfileListView; backup: BackupView | null; onOpen(username: string): void }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticking = list.state === "waiting" && list.nextAt !== undefined;
  const actions = listActions(list.state);

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const act = async (what: () => Promise<Result | void>) => {
    setBusy(true);
    setError(null);
    const res = await what();
    setBusy(false);
    if (res && !res.ok) setError(res.error);
  };
  // signed out midway: sign in, then Continue goes on from the profile it stopped at
  const signIn = () =>
    act(async () => {
      if (!(await api.instagramSignIn())) return { ok: false, error: "Not signed in to Instagram." };
    });

  return (
    <section className="list-panel" aria-label="Profile list">
      <div className="list-panel-head">
        <div className="backup-text">
          <strong>
            {list.name} · {listPosition(list)}
          </strong>
          <span>{listStateLine(list, now, backup)}</span>
          {list.state === "running" && list.progress?.note && <span className="muted">{list.progress.note}</span>}
          {error && <span className="error-text">{error}</span>}
        </div>
        {actions.stop && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.stopProfileList())}>
            Stop
          </button>
        )}
        {actions.signIn && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void signIn()}>
            Sign in
          </button>
        )}
        {actions.continue && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.continueProfileList())}>
            Continue
          </button>
        )}
        {actions.close && (
          <button type="button" className="btn" disabled={busy} onClick={() => void act(() => api.closeProfileList())}>
            Close
          </button>
        )}
      </div>
      <ol className="list-rows">
        {list.rows.map((row) => (
          <li key={row.username}>
            <button type="button" className="list-row" data-state={row.state} title={`Open @${row.username}`} onClick={() => onOpen(row.username)}>
              {rowText(row)}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
