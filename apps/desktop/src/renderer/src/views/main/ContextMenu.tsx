import { useEffect, useRef } from "react";
import type { DownloadView } from "@turbodl/shared";
import { api } from "../../api";

export interface MenuState {
  x: number;
  y: number;
  item: DownloadView;
  ids: string[];
}

export interface ContextMenuProps {
  menu: MenuState;
  onClose(): void;
  onRefresh(id: string): void;
  onDelete(ids: string[], withFiles: boolean): void;
}

export function ContextMenu({ menu, onClose, onRefresh, onDelete }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { item, ids } = menu;

  useEffect(() => {
    const close = (e: Event) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const left = Math.min(menu.x, window.innerWidth - 230);
  const top = Math.min(menu.y, window.innerHeight - 300);
  const canPause = item.status === "downloading" || item.status === "queued";
  const canResume = item.status === "paused" || item.status === "error" || item.status === "scheduled";

  return (
    <div ref={ref} className="context-menu" style={{ left, top }} role="menu">
      {item.status === "completed" && (
        <button type="button" onClick={act(() => void api.openFile(item.id))}>
          Open
        </button>
      )}
      <button type="button" onClick={act(() => void api.showInFolder(item.id))}>
        {item.status === "completed" ? "Show in folder" : "Open folder"}
      </button>
      {canPause && (
        <button type="button" onClick={act(() => void api.pause(ids))}>
          Pause
        </button>
      )}
      {canResume && (
        <button type="button" onClick={act(() => void api.resume(ids))}>
          {item.status === "scheduled" ? "Start now" : "Resume"}
        </button>
      )}
      <button type="button" onClick={act(() => void api.copyText(item.url))}>
        Copy link
      </button>
      {item.kind === "http" && (item.status === "error" || item.status === "paused") && (
        <button type="button" onClick={act(() => onRefresh(item.id))}>
          Refresh link…
        </button>
      )}
      <hr />
      <button type="button" onClick={act(() => onDelete(ids, false))}>
        Remove from list
      </button>
      <button type="button" className="danger" onClick={act(() => onDelete(ids, true))}>
        Delete with file
      </button>
    </div>
  );
}
