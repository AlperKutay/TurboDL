import { useState } from "react";
import type { AfterAllAction, Settings } from "@turbodl/shared";
import { api } from "../../api";
import { Modal } from "../../components/Modal";

const AFTER_ALL: { value: AfterAllAction; label: string }[] = [
  { value: "none", label: "Do nothing" },
  { value: "sleep", label: "Put the computer to sleep" },
  { value: "shutdown", label: "Shut down the computer" },
  { value: "quit", label: "Quit TurboDL" },
];

export function SchedulerModal({ settings, onClose }: { settings: Settings; onClose(): void }) {
  const [enabled, setEnabled] = useState(settings.scheduler.enabled);
  const [start, setStart] = useState(settings.scheduler.startTime);
  const [useStop, setUseStop] = useState(settings.scheduler.stopTime !== null);
  const [stop, setStop] = useState(settings.scheduler.stopTime ?? "07:00");
  const [afterAll, setAfterAll] = useState<AfterAllAction>(settings.scheduler.afterAll);

  const save = async () => {
    await api.updateSettings({ scheduler: { enabled, startTime: start, stopTime: useStop ? stop : null, afterAll } });
    onClose();
  };

  return (
    <Modal
      title="Scheduler"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="muted">The scheduler starts downloads queued with “Download later” every day at the time you set.</p>
      <label className="check">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enable the scheduler
      </label>
      <div className="field-grid">
        <label className="field">
          <span>Start time</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!enabled} />
        </label>
        <label className="field">
          <span className="check inline">
            <input type="checkbox" checked={useStop} onChange={(e) => setUseStop(e.target.checked)} disabled={!enabled} />
            Stop time
          </span>
          <input type="time" value={stop} onChange={(e) => setStop(e.target.value)} disabled={!enabled || !useStop} />
        </label>
      </div>
      <label className="field">
        <span>When all scheduled downloads finish</span>
        <select value={afterAll} onChange={(e) => setAfterAll(e.target.value as AfterAllAction)} disabled={!enabled}>
          {AFTER_ALL.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
    </Modal>
  );
}
