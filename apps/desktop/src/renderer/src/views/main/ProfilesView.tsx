import { useEffect, useState } from "react";
import { profileName, type BackupView, type ListWait, type ProfileEntry, type ProfileListView, type ProfileSaveOptions, type ScreenBackupView } from "@turbodl/shared";
import { api } from "../../api";
import { LIST_UNFINISHED, listBanner } from "../../profile-list-state";
import { ProfileListDialog } from "./ProfileListDialog";
import { ProfileListPanel } from "./ProfileListPanel";
import { ProfileView } from "./ProfileView";

/**
 * Instagram → Profiles: the open profile (by link, username, or one backed up before), or the list of them with the
 * profile list (a .txt backed up one profile after another) above it.
 */
export function ProfilesView({
  backup,
  screen,
  list,
  saveOptions,
  listWait,
  open,
  onOpen,
  onBack,
}: {
  backup: BackupView | null;
  /** the profile backup the screen started last */
  screen: ScreenBackupView | null;
  /** the profile list running or last run */
  list: ProfileListView | null;
  /** what the last profile backup chose to save */
  saveOptions: ProfileSaveOptions;
  /** the wait the last list had between its profiles */
  listWait: ListWait;
  open: string | null;
  onOpen(username: string): void;
  onBack(): void;
}) {
  if (open) {
    const banner = listBanner(list);
    return (
      <div className="saved">
        <div className="saved-head">
          <button type="button" className="link-button" onClick={onBack}>
            All profiles
          </button>
        </div>
        {banner && (
          <p className="list-banner">
            <button type="button" className="link-button" onClick={onBack}>
              {banner}
            </button>
          </p>
        )}
        <ProfileView key={open} username={open} backup={backup} screen={screen} list={list} saveOptions={saveOptions} />
      </div>
    );
  }
  return <ProfileList backup={backup} list={list} saveOptions={saveOptions} listWait={listWait} onOpen={onOpen} />;
}

/** The field to open a profile or back up a list, the list running, and the profiles backed up so far (newest run first). */
function ProfileList({
  backup,
  list,
  saveOptions,
  listWait,
  onOpen,
}: {
  backup: BackupView | null;
  list: ProfileListView | null;
  saveOptions: ProfileSaveOptions;
  listWait: ListWait;
  onOpen(username: string): void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ProfileEntry[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** the list's dialog, with whether Instagram's session was there when it opened */
  const [listDialog, setListDialog] = useState<{ signedIn: boolean } | null>(null);

  const refresh = () => void api.instagramProfiles().then(setEntries);
  // the list's profiles join the index as their backups end
  const ended = list?.rows.filter((r) => r.state !== "waiting" && r.state !== "running").length ?? 0;
  useEffect(refresh, [ended]);

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
  // one list at a time: a finished one makes way for the next
  const backUpList = async () => {
    if (list && list.state !== "finished") return setError(LIST_UNFINISHED);
    setError(null);
    const account = await api.instagramAccount();
    setListDialog({ signedIn: account.signedIn });
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
        <button type="button" className="btn" onClick={() => void backUpList()}>
          Back up a list…
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
      {list && <ProfileListPanel list={list} backup={backup} onOpen={onOpen} />}
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
      {listDialog && <ProfileListDialog initialOptions={saveOptions} initialWait={listWait} signedIn={listDialog.signedIn} onClose={() => setListDialog(null)} />}
    </div>
  );
}
