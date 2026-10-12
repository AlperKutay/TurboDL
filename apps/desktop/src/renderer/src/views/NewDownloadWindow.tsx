import { useEffect, useState } from "react";
import { CATEGORY_LABELS, formatBytes, type PendingDownload } from "@turbodl/shared";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { CATEGORY_ICONS } from "../ui";
import "./dialogs.css";

async function cancel(pendingId: string): Promise<void> {
  await api.cancelPending(pendingId);
  await api.closeWindow();
}

export function NewDownloadWindow({ pendingId }: { pendingId: string }) {
  const [pending, setPending] = useState<PendingDownload | null | undefined>(undefined);
  const [filename, setFilename] = useState("");
  const [dir, setDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "New download";
    void api.getPending(pendingId).then((p) => {
      if (p && p.type === "download") {
        setPending(p);
        setFilename(p.item.filename);
        setDir(p.item.dir);
      } else {
        setPending(null);
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void cancel(pendingId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingId]);

  if (pending === undefined) return <div className="dialog loading">Loading…</div>;
  if (pending === null) {
    return (
      <div className="dialog">
        <p>This download no longer exists.</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => void api.closeWindow()}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { item } = pending;
  const submit = async (mode: "now" | "later") => {
    setBusy(true);
    setError(null);
    const result = await api.confirmDownload(pendingId, { filename, dir, mode });
    if (!result.ok) {
      setError(result.error);
      setBusy(false);
    }
  };
  const browse = async () => {
    const folder = await api.chooseFolder(dir);
    if (folder) setDir(folder);
  };

  return (
    <div className="dialog">
      <div className="dialog-head">
        <div className="dialog-icon">
          <Icon name={CATEGORY_ICONS[item.category]} size={22} />
        </div>
        <div>
          <h1>File download details</h1>
          <p className="muted url" title={item.url}>
            {item.url}
          </p>
        </div>
      </div>
      <label className="field">
        <span>File name</span>
        <input autoFocus value={filename} onChange={(e) => setFilename(e.target.value)} />
      </label>
      <label className="field">
        <span>Save to folder</span>
        <div className="field-row">
          <input value={dir} onChange={(e) => setDir(e.target.value)} />
          <button type="button" className="btn" onClick={() => void browse()}>
            Browse…
          </button>
        </div>
      </label>
      <div className="facts">
        <span>
          Size: <strong>{item.size === null ? "Unknown" : formatBytes(item.size)}</strong>
        </span>
        <span>
          Kategori: <strong>{CATEGORY_LABELS[item.category]}</strong>
        </span>
        <span>{item.resumable ? "Can be resumed" : "Cannot be resumed"}</span>
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={() => void cancel(pendingId)} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn" onClick={() => void submit("later")} disabled={busy || !filename.trim()}>
          Download later
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void submit("now")} disabled={busy || !filename.trim()}>
          Download now
        </button>
      </div>
    </div>
  );
}
