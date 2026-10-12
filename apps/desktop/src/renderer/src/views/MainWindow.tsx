import { useEffect, useMemo, useState } from "react";
import type { DownloadView } from "@turbodl/shared";
import { api } from "../api";
import { filterDownloads, type Filter } from "../state";
import { useAppState } from "../useAppState";
import { AddUrlModal } from "./main/AddUrlModal";
import { ContextMenu, type MenuState } from "./main/ContextMenu";
import { CountdownOverlay } from "./main/CountdownOverlay";
import { DeleteModal } from "./main/DeleteModal";
import { DetailsPanel } from "./main/DetailsPanel";
import { DownloadTable } from "./main/DownloadTable";
import { RefreshUrlModal } from "./main/RefreshUrlModal";
import { SchedulerModal } from "./main/SchedulerModal";
import { SettingsModal } from "./main/SettingsModal";
import { Sidebar } from "./main/Sidebar";
import { StatusBar } from "./main/StatusBar";
import { Toolbar } from "./main/Toolbar";

type ModalState =
  | null
  | { type: "add" }
  | { type: "settings" }
  | { type: "scheduler" }
  | { type: "refresh"; id: string }
  | { type: "delete"; ids: string[]; withFiles: boolean };

export function MainWindow() {
  const state = useAppState();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selected, setSelected] = useState<string[]>([]);
  const [modal, setModal] = useState<ModalState>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    document.title = "TurboDL";
  }, []);

  const items = useMemo(() => (state ? filterDownloads(state.downloads, filter) : []), [state, filter]);
  const selectedIds = useMemo(() => items.filter((d) => selected.includes(d.id)).map((d) => d.id), [items, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modal || (e.target instanceof HTMLElement && e.target.closest("input, textarea, select"))) return;
      if (e.key === "Delete" && selectedIds.length > 0) setModal({ type: "delete", ids: selectedIds, withFiles: false });
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelected(items.map((d) => d.id));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, selectedIds, items]);

  if (!state) return <div className="loading">Loading…</div>;

  const current = items.find((d) => d.id === selectedIds[0]) ?? null;
  const open = (d: DownloadView) => {
    if (d.status === "completed") void api.openFile(d.id);
    else if (d.status === "paused" || d.status === "error") void api.resume([d.id]);
  };

  return (
    <div className="app">
      <Toolbar
        hasSelection={selectedIds.length > 0}
        schedulerOn={state.settings.scheduler.enabled}
        onAdd={() => setModal({ type: "add" })}
        onResume={() => void api.resume(selectedIds)}
        onPause={() => void api.pause(selectedIds)}
        onDelete={() => setModal({ type: "delete", ids: selectedIds, withFiles: false })}
        onStartAll={() => void api.startAll()}
        onStopAll={() => void api.stopAll()}
        onScheduler={() => setModal({ type: "scheduler" })}
        onSettings={() => setModal({ type: "settings" })}
      />
      {!state.bridge.ok && <div className="banner banner-error">The browser extension cannot reach the app: {state.bridge.error ?? "bridge closed"}</div>}
      <div className="body">
        <Sidebar downloads={state.downloads} filter={filter} onChange={setFilter} />
        <main className="content">
          <DownloadTable
            items={items}
            selected={selected}
            onSelect={setSelected}
            onOpen={open}
            onContextMenu={(d, x, y) => {
              const ids = selected.includes(d.id) ? selectedIds : [d.id];
              if (!selected.includes(d.id)) setSelected([d.id]);
              setMenu({ x, y, item: d, ids });
            }}
          />
          {current && <DetailsPanel item={current} />}
        </main>
      </div>
      <StatusBar downloads={state.downloads} bridge={state.bridge} />

      {menu && (
        <ContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onRefresh={(id) => setModal({ type: "refresh", id })}
          onDelete={(ids, withFiles) => setModal({ type: "delete", ids, withFiles })}
        />
      )}
      {modal?.type === "add" && <AddUrlModal onClose={() => setModal(null)} />}
      {modal?.type === "refresh" && <RefreshUrlModal id={modal.id} onClose={() => setModal(null)} />}
      {modal?.type === "delete" && (
        <DeleteModal
          ids={modal.ids}
          withFiles={modal.withFiles}
          onClose={() => {
            setModal(null);
            setSelected([]);
          }}
        />
      )}
      {modal?.type === "settings" && <SettingsModal settings={state.settings} version={state.version} onClose={() => setModal(null)} />}
      {modal?.type === "scheduler" && <SchedulerModal settings={state.settings} onClose={() => setModal(null)} />}
      {state.countdown && <CountdownOverlay state={state.countdown} />}
    </div>
  );
}
