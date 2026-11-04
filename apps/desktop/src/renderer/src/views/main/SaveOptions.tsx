import { TAGGED_AVAILABLE, type ProfileSaveOptions } from "@turbodl/shared";

/**
 * What a profile backup saves: its parts (posts, highlights, tagged posts) and the kinds of media in them. Tagged needs a
 * session: without one it shows unticked and can't be ticked, while the remembered choice stays for after a sign-in.
 */
export function SaveOptions({
  value,
  onChange,
  signedIn,
  kindsOnly = false,
  signingIn = false,
  onSignIn,
}: {
  value: ProfileSaveOptions;
  onChange(next: ProfileSaveOptions): void;
  signedIn: boolean;
  /** only the Photos/Videos row (the Highlights tab's backup) */
  kindsOnly?: boolean;
  /** a sign-in is going on: its link waits */
  signingIn?: boolean;
  onSignIn(): void;
}) {
  const box = (key: keyof ProfileSaveOptions, label: string, checked = value[key], disabled = false) => (
    <label className="check inline">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange({ ...value, [key]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <div className="save-options">
      {!kindsOnly && (
        <div className="save-row" role="group" aria-label="Save">
          <span className="save-row-label">Save:</span>
          {box("posts", "Posts")}
          {box("highlights", "Highlights")}
          {TAGGED_AVAILABLE && box("tagged", "Tagged", signedIn && value.tagged, !signedIn)}
        </div>
      )}
      {!kindsOnly && TAGGED_AVAILABLE && !signedIn && (
        <p className="muted">
          Tagged needs a sign-in to Instagram.{" "}
          <button type="button" className="link-button" disabled={signingIn} onClick={onSignIn}>
            Sign in
          </button>
        </p>
      )}
      <div className="save-row" role="group" aria-label="Kinds">
        <span className="save-row-label">Kinds:</span>
        {box("photos", "Photos")}
        {box("videos", "Videos")}
      </div>
    </div>
  );
}
