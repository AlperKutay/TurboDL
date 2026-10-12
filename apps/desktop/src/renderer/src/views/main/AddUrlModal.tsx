import { useState, type FormEvent } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

export function AddUrlModal({ onClose }: { onClose(): void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await api.addUrl(url);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <Modal
      title="Add URL"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="add-url" className="btn btn-primary" disabled={busy || !url.trim()}>
            {busy ? "Checking…" : "Add"}
          </button>
        </>
      }
    >
      <form id="add-url" onSubmit={submit}>
        <label className="field">
          <span>Download address</span>
          <input autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <p className="muted">If you enter a video page (for example YouTube), the quality window opens.</p>
      </form>
    </Modal>
  );
}
