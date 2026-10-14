import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

export function AddUrlModal({ initialUrl = "", autoSubmit = false, onClose }: { initialUrl?: string; autoSubmit?: boolean; onClose(): void }) {
  const [url, setUrl] = useState(initialUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitted = useRef(false);

  const add = async (value: string) => {
    setBusy(true);
    setError(null);
    const result = await api.addUrl(value);
    setBusy(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  useEffect(() => {
    // Ctrl/⌘V in the main window: add the pasted link straight away, keep the window for errors
    if (autoSubmit && initialUrl && !submitted.current) {
      submitted.current = true;
      void add(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void add(url);
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
        <p className="muted">If you enter a video page (for example YouTube), the quality window opens. In the main window, Ctrl+V (⌘V on Mac) adds the copied link directly.</p>
      </form>
    </Modal>
  );
}
