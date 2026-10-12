import { useState } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

export function DeleteModal({ ids, withFiles, onClose }: { ids: string[]; withFiles: boolean; onClose(): void }) {
  const [deleteFiles, setDeleteFiles] = useState(withFiles);
  const confirm = async () => {
    await api.remove(ids, deleteFiles);
    onClose();
  };
  return (
    <Modal
      title="Delete downloads"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-danger" onClick={() => void confirm()}>
            Delete
          </button>
        </>
      }
    >
      <p>{ids.length} download(s) will be removed from the list.</p>
      <label className="check">
        <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
        Also delete the files from disk
      </label>
    </Modal>
  );
}
