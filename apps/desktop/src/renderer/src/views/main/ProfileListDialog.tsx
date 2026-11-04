import { useState } from "react";
import { effectiveSaveOptions, waitProblem, type ListWait, type ParsedProfileList, type ProfileSaveOptions } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { LIST_TOO_MANY, fileSummary, invalidLines, listStartProblem, namesPreview, waitNumber } from "../../profile-list-state";
import { SIGNED_OUT_PACE } from "./ProfileView";
import { SaveOptions } from "./SaveOptions";

/**
 * "Back up a list": a .txt of profiles (the app shows the open dialog and reads it), what each backup saves and the
 * random wait between profiles, starting from what the last list or backup chose. Start waits for the list to start
 * (or say why it can't), staying open meanwhile.
 */
export function ProfileListDialog({
  initialOptions,
  initialWait,
  signedIn: signedInAtFirst,
  onClose,
}: {
  initialOptions: ProfileSaveOptions;
  initialWait: ListWait;
  /** whether Instagram's session was there when the dialog opened */
  signedIn: boolean;
  onClose(): void;
}) {
  const [file, setFile] = useState<{ name: string; list: ParsedProfileList } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [options, setOptions] = useState(initialOptions);
  const [min, setMin] = useState(String(initialWait.min));
  const [max, setMax] = useState(String(initialWait.max));
  const [signedIn, setSignedIn] = useState(signedInAtFirst);
  const [signingIn, setSigningIn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wait = { min: waitNumber(min), max: waitNumber(max) };
  const waitWrong = waitProblem(wait);
  const problem = listStartProblem({ file, wait, options, signedIn });
  const close = starting ? () => undefined : onClose;

  const choose = async () => {
    const path = await api.pickProfileListFile();
    if (!path) return;
    const read = await api.readProfileList(path);
    setError(null);
    if ("error" in read) {
      setFile(null);
      setReadError(read.error);
    } else {
      setFile(read);
      setReadError(null);
    }
  };

  const signIn = async () => {
    setSigningIn(true);
    const ok = await api.instagramSignIn();
    setSigningIn(false);
    if (ok) setSignedIn(true);
  };

  // what the dialog shows ticked (Tagged off while signed out); the app keeps the wait and the ticks for the next list
  const start = async () => {
    if (!file || problem) return;
    setStarting(true);
    setError(null);
    const res = await api.startProfileList({ name: file.name, usernames: file.list.usernames, options: effectiveSaveOptions(options, signedIn), wait });
    if (res.ok) return onClose();
    setStarting(false);
    setError(res.error);
  };

  return (
    <Modal
      title="Back up a list"
      width={540}
      onClose={close}
      footer={
        <>
          <button type="button" className="btn" disabled={starting} onClick={close}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={starting || problem !== null} title={problem ?? undefined} onClick={() => void start()}>
            {starting ? "Starting…" : "Start"}
          </button>
        </>
      }
    >
      <div className="list-file">
        <button type="button" className="btn" disabled={starting} onClick={() => void choose()}>
          Choose a .txt file…
        </button>
        {file ? <strong>{fileSummary(file.name, file.list)}</strong> : <span className="muted">One profile per line: a link, @name or name.</span>}
      </div>
      {readError && <p className="error-text">{readError}</p>}
      {file && (
        <>
          {file.list.tooMany && <p className="error-text">{LIST_TOO_MANY}</p>}
          {file.list.usernames.length > 0 && <p className="list-names muted">{namesPreview(file.list.usernames)}</p>}
          {file.list.invalid.length > 0 && (
            <ul className="list-invalid">
              {invalidLines(file.list).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <SaveOptions
        value={options}
        onChange={(next) => {
          setOptions(next);
          setError(null);
        }}
        signedIn={signedIn}
        signingIn={signingIn}
        onSignIn={() => void signIn()}
      />
      <p className="list-wait">
        Wait between profiles: at least{" "}
        <input type="number" min={0} max={1440} step={1} aria-label="At least" value={min} onChange={(e) => setMin(e.target.value)} /> and at most{" "}
        <input type="number" min={0} max={1440} step={1} aria-label="At most" value={max} onChange={(e) => setMax(e.target.value)} /> minutes, picked at random.
      </p>
      {waitWrong && <p className="error-text">{waitWrong}</p>}
      {!signedIn && <p>{SIGNED_OUT_PACE}</p>}
      {/* what else stops it: what is ticked (the wait's and the file's own say so above) */}
      {file && !file.list.tooMany && !waitWrong && problem && <p className="error-text">{problem}</p>}
      {error && <p className="error-text">{error}</p>}
    </Modal>
  );
}
