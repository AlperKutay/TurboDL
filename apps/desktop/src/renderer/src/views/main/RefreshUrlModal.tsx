import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

export function RefreshUrlModal({ id, onClose }: { id: string; onClose(): void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const result = await api.refreshUrl(id, url);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <Modal
      title="Refresh link"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="refresh-url" className="btn btn-primary" disabled={!url.trim()}>
            Save and resume
          </button>
        </>
      }
    >
      <form id="refresh-url" onSubmit={submit}>
        <p className="muted">If the link has expired, paste the file's new download address. If the file is the same, the download continues where it left off.</p>
        <label className="field">
          <span>New address</span>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        {error && <p className="error-text">{error}</p>}
      </form>
    </Modal>
  );
}
