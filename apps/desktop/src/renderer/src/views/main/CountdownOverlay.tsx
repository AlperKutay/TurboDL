import type { CountdownState } from "@turbodl/shared";
import { api } from "../../api";

const TEXT: Record<CountdownState["action"], string> = {
  shutdown: "The computer will shut down",
  sleep: "The computer will go to sleep",
  quit: "TurboDL will quit",
};

export function CountdownOverlay({ state }: { state: CountdownState }) {
  return (
    <div className="modal-backdrop">
      <div className="modal countdown" role="alertdialog" aria-label="Countdown">
        <div className="modal-body">
          <h2>Scheduled downloads finished</h2>
          <p className="countdown-text">
            {TEXT[state.action]} in <strong>{state.secondsLeft}</strong> seconds
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" className="btn btn-primary" onClick={() => void api.cancelCountdown()}>
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
