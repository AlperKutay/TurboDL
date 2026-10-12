import { Icon, type IconName } from "../../components/Icon";

export interface ToolbarProps {
  hasSelection: boolean;
  schedulerOn: boolean;
  onAdd(): void;
  onResume(): void;
  onPause(): void;
  onDelete(): void;
  onStartAll(): void;
  onStopAll(): void;
  onScheduler(): void;
  onSettings(): void;
}

function ToolButton(p: { icon: IconName; label: string; onClick(): void; disabled?: boolean; primary?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      className={`tool-button${p.primary ? " primary" : ""}${p.active ? " active" : ""}`}
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.label}
    >
      <Icon name={p.icon} size={18} />
      <span>{p.label}</span>
    </button>
  );
}

export function Toolbar(p: ToolbarProps) {
  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">
          <Icon name="download" size={18} />
        </span>
        TurboDL
      </div>
      <ToolButton icon="plus" label="Add URL" onClick={p.onAdd} primary />
      <div className="tool-sep" />
      <ToolButton icon="play" label="Resume" onClick={p.onResume} disabled={!p.hasSelection} />
      <ToolButton icon="pause" label="Pause" onClick={p.onPause} disabled={!p.hasSelection} />
      <ToolButton icon="trash" label="Delete" onClick={p.onDelete} disabled={!p.hasSelection} />
      <div className="tool-sep" />
      <ToolButton icon="playAll" label="Start all" onClick={p.onStartAll} />
      <ToolButton icon="stop" label="Stop all" onClick={p.onStopAll} />
      <div className="tool-spacer" />
      <ToolButton icon="clock" label="Scheduler" onClick={p.onScheduler} active={p.schedulerOn} />
      <ToolButton icon="sliders" label="Settings" onClick={p.onSettings} />
    </header>
  );
}
