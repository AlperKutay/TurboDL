import { formatSpeed, type BackupView, type BridgeStatus, type DownloadView } from "@turbodl/shared";

export function StatusBar({ downloads, bridge, backup }: { downloads: DownloadView[]; bridge: BridgeStatus; backup: BackupView | null }) {
  const active = downloads.filter((d) => d.status === "downloading");
  const speed = active.reduce((sum, d) => sum + d.speed, 0);
  return (
    <footer className="statusbar">
      <span>{active.length > 0 ? `${active.length} downloading · ${formatSpeed(speed)}` : "Idle"}</span>
      {backup?.state === "running" && (
        <span>
          Backing up {backup.name} · {backup.done} done
        </span>
      )}
      <span className={bridge.ok ? "ok" : "error-text"}>
        {bridge.ok ? `Browser bridge: 127.0.0.1:${bridge.port}` : "Browser bridge closed"}
      </span>
    </footer>
  );
}
