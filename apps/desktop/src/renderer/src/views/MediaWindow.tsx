import { useEffect, useState } from "react";
import { describeMedia, formatBytes, type MediaChoice, type MediaFormatOption, type PendingMedia } from "@turbodl/shared";
import { api } from "../api";
import { Icon } from "../components/Icon";
import "./dialogs.css";

type FormatsState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; title: string; options: MediaFormatOption[]; usedLogin: boolean }
  | { state: "error"; error: string };

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 48 ? `${u.pathname.slice(0, 45)}…` : u.pathname;
    return `${u.hostname}${path}`;
  } catch {
    return url;
  }
}

export function MediaWindow({ pendingId }: { pendingId: string }) {
  const [pending, setPending] = useState<PendingMedia | null | undefined>(undefined);
  const [dir, setDir] = useState("");
  const [choice, setChoice] = useState<MediaChoice | null>(null);
  const [formats, setFormats] = useState<FormatsState>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFormats = async () => {
    setFormats({ state: "loading" });
    const result = await api.probeMediaFormats(pendingId);
    if (result.ok) {
      setFormats({ state: "done", title: result.title, options: result.options, usedLogin: result.usedLogin });
      setChoice((current) => current ?? { kind: "format", option: result.options[0] });
    } else {
      setFormats({ state: "error", error: result.error });
    }
  };

  useEffect(() => {
    document.title = "Download video";
    void api.getPending(pendingId).then((p) => {
      if (!p || p.type !== "media") {
        setPending(null);
        return;
      }
      setPending(p);
      setDir(p.defaultDir);
      if (p.items.length > 0) setChoice({ kind: "item", index: 0 });
      else void loadFormats();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void api.cancelPending(pendingId).then(() => api.closeWindow());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingId]);

  if (pending === undefined) return <div className="dialog loading">Loading…</div>;
  if (pending === null) {
    return (
      <div className="dialog">
        <p>This request no longer exists.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => void api.closeWindow()}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const submit = async (mode: "now" | "later") => {
    if (!choice) return;
    setBusy(true);
    setError(null);
    const result = await api.confirmMedia(pendingId, choice, { dir, mode });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
    }
  };
  const browse = async () => {
    const folder = await api.chooseFolder(dir);
    if (folder) setDir(folder);
  };
  const title = formats.state === "done" ? formats.title : pending.title || "Download video";

  return (
    <div className="dialog">
      <div className="dialog-head">
        <div className="dialog-icon">
          <Icon name="video" size={22} />
        </div>
        <div>
          <h1>{title}</h1>
          <p className="muted url" title={pending.pageUrl}>
            {pending.pageUrl}
          </p>
        </div>
      </div>

      {pending.items.length > 0 && (
        <section>
          <h2>Media found on the page</h2>
          <ul className="choices">
            {pending.items.map((m, i) => (
              <li key={m.url}>
                <label className="choice">
                  <input type="radio" name="choice" checked={choice?.kind === "item" && choice.index === i} onChange={() => setChoice({ kind: "item", index: i })} />
                  <span className="choice-main">{describeMedia(m)}</span>
                  <span className="choice-meta">{m.size ? formatBytes(m.size) : ""}</span>
                  <span className="choice-url" title={m.url}>
                    {shortUrl(m.url)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2>Choose quality (yt-dlp)</h2>
        {formats.state === "idle" && (
          <button type="button" className="btn" onClick={() => void loadFormats()}>
            Get qualities
          </button>
        )}
        {formats.state === "loading" && <p className="muted spinner">Inspecting the page… The first time this can take a while because the video tools are downloaded.</p>}
        {formats.state === "error" && (
          <p className="error-text">
            {formats.error}{" "}
            <button type="button" className="link-button" onClick={() => void loadFormats()}>
              Try again
            </button>
          </p>
        )}
        {formats.state === "done" && (
          <>
            <ul className="choices compact">
              {formats.options.map((o) => (
                <li key={o.id}>
                  <label className="choice">
                    <input type="radio" name="choice" checked={choice?.kind === "format" && choice.option.id === o.id} onChange={() => setChoice({ kind: "format", option: o })} />
                    <span className="choice-main">{o.label}</span>
                  </label>
                </li>
              ))}
            </ul>
            {formats.usedLogin && <p className="muted">Your browser session is used for this video.</p>}
          </>
        )}
      </section>

      <label className="field">
        <span>Save to folder</span>
        <div className="field-row">
          <input value={dir} onChange={(e) => setDir(e.target.value)} />
          <button type="button" className="btn" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => void api.cancelPending(pendingId).then(() => api.closeWindow())}
        >
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => void submit("later")} disabled={busy || !choice}>
          Download later
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit("now")} disabled={busy || !choice}>
          Download now
        </button>
      </div>
    </div>
  );
}
