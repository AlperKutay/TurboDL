import { useEffect, useState } from "react";
import type { BackupView, ProfileEntry } from "@turbodl/shared";
import { api } from "../../api";
import { profileName } from "../../saved-state";
import { ProfileView } from "./ProfileView";

/** Instagram → Profiles: the open profile (by link, username, or one backed up before), or the list. */
export function ProfilesView({ backup, open, onOpen, onBack }: { backup: BackupView | null; open: string | null; onOpen(username: string): void; onBack(): void }) {
  if (open) {
    return (
      <div className="saved">
        <div className="saved-head">
          <button type="button" className="link-button" onClick={onBack}>
            All profiles
          </button>
        </div>
        <ProfileView key={open} username={open} backup={backup} />
      </div>
    );
  }
  return <ProfileList onOpen={onOpen} />;
}

/** The field to open a profile, and the profiles backed up so far (newest run first). */
function ProfileList({ onOpen }: { onOpen(username: string): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ProfileEntry[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const refresh = () => void api.instagramProfiles().then(setEntries);
  useEffect(refresh, []);

  const submit = () => {
    const name = profileName(text);
    if (!name) return setError("Enter a profile link or a username.");
    setError(null);
    onOpen(name);
  };
  const remove = async (id: string) => {
    await api.removeInstagramProfile(id);
    setRemoving(null);
    refresh();
  };

  return (
    <div className="saved">
      <form
        className="profile-open"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Profile link or @username" aria-label="Profile link or @username" />
        <button type="submit" className="btn btn-primary">
          Open
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {entries && entries.length === 0 && <p className="muted">Profiles you back up are listed here.</p>}
      <ul className="profile-list">
        {entries?.map((e) => (
          <li key={e.id}>
            <button type="button" className="profile-row" onClick={() => onOpen(e.username)}>
              {e.picture ? <img src={e.picture} alt="" draggable={false} /> : <span className="saved-collection-blank" />}
              <span className="profile-names">
                <strong>@{e.username}</strong>
                <span className="muted">{e.fullName}</span>
              </span>
              <span className="muted">
                {e.saved.toLocaleString()} saved · last backup {new Date(e.lastRun).toLocaleDateString()}
              </span>
            </button>
            {removing === e.id ? (
              <span className="profile-remove">
                Remove from the list? Its files stay; a later backup starts over.{" "}
                <button type="button" className="link-button" onClick={() => void remove(e.id)}>
                  Remove
                </button>{" "}
                <button type="button" className="link-button" onClick={() => setRemoving(null)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="link-button" onClick={() => setRemoving(e.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
