import { useState, type MouseEvent } from "react";
import { STATUS_LABELS, formatBytes, formatDuration, formatPercent, formatSpeed, type DownloadView } from "@turbodl/shared";
import { Icon } from "../../components/Icon";
import { CATEGORY_ICONS, formatDate } from "../../ui";

export interface DownloadTableProps {
  items: DownloadView[];
  selected: string[];
  onSelect(ids: string[]): void;
  onOpen(item: DownloadView): void;
  onContextMenu(item: DownloadView, x: number, y: number): void;
}

function Progress({ d }: { d: DownloadView }) {
  const pct = d.size ? Math.min(100, (d.received / d.size) * 100) : d.status === "completed" ? 100 : 0;
  let label: string = STATUS_LABELS[d.status];
  if (d.note) label = d.note;
  else if (d.status === "downloading") label = d.size ? formatPercent(d.received, d.size) : formatBytes(d.received);
  else if (d.status === "paused" && d.size) label = `${STATUS_LABELS.paused} · ${formatPercent(d.received, d.size)}`;
  return (
    <div className={`progress progress-${d.status}`} title={d.error ?? label}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
      <span className="progress-label">{label}</span>
    </div>
  );
}

export function DownloadTable({ items, selected, onSelect, onOpen, onContextMenu }: DownloadTableProps) {
  const [anchor, setAnchor] = useState<string | null>(null);

  const click = (e: MouseEvent, d: DownloadView) => {
    if (e.shiftKey && anchor) {
      const a = items.findIndex((i) => i.id === anchor);
      const b = items.findIndex((i) => i.id === d.id);
      if (a >= 0 && b >= 0) {
        const [from, to] = a < b ? [a, b] : [b, a];
        onSelect(items.slice(from, to + 1).map((i) => i.id));
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      onSelect(selected.includes(d.id) ? selected.filter((id) => id !== d.id) : [...selected, d.id]);
    } else {
      onSelect([d.id]);
    }
    setAnchor(d.id);
  };

  if (items.length === 0) {
    return (
      <div className="empty">
        <Icon name="download" size={40} />
        <p>No downloads yet.</p>
        <p className="muted">Click a file in your browser or start with “Add URL”.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="downloads">
        <thead>
          <tr>
            <th className="col-name">File name</th>
            <th className="col-size">Size</th>
            <th className="col-progress">Status</th>
            <th className="col-speed">Speed</th>
            <th className="col-eta">Time left</th>
            <th className="col-date">Added</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr
              key={d.id}
              data-status={d.status}
              className={selected.includes(d.id) ? "selected" : undefined}
              onClick={(e) => click(e, d)}
              onDoubleClick={() => onOpen(d)}
              onContextMenu={(e) => {
                e.preventDefault();
                onContextMenu(d, e.clientX, e.clientY);
              }}
            >
              <td className="col-name">
                <span className={`cat cat-${d.category}`}>
                  <Icon name={CATEGORY_ICONS[d.category]} />
                </span>
                <span className="name" title={d.filename}>
                  {d.filename}
                </span>
              </td>
              <td className="col-size">{formatBytes(d.size)}</td>
              <td className="col-progress">
                <Progress d={d} />
              </td>
              <td className="col-speed">{d.status === "downloading" ? formatSpeed(d.speed) : ""}</td>
              <td className="col-eta">{d.status === "downloading" ? formatDuration(d.eta) : ""}</td>
              <td className="col-date">{formatDate(d.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
