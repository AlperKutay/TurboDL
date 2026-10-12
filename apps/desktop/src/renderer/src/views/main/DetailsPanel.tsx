import { STATUS_LABELS, formatBytes, type DownloadView } from "@turbodl/shared";

function SegmentBar({ item }: { item: DownloadView }) {
  const size = item.size;
  if (!size) {
    return (
      <div className="segbar">
        <div className="segbar-fill" style={{ left: 0, width: item.status === "completed" ? "100%" : "0%" }} />
      </div>
    );
  }
  const segments = item.segments.length > 0 ? item.segments : [{ start: 0, end: size - 1, received: item.received }];
  return (
    <div className="segbar" aria-label="Segment status">
      {segments.map((s) => (
        <div
          key={s.start}
          className="segbar-fill"
          style={{ left: `${(s.start / size) * 100}%`, width: `${(Math.min(s.received, s.end - s.start + 1) / size) * 100}%` }}
        />
      ))}
    </div>
  );
}

function connectionText(item: DownloadView): string {
  if (item.kind === "ytdlp") return "via yt-dlp";
  if (item.status === "downloading") return `${item.connections} connections`;
  return item.resumable ? "Can be resumed" : "Cannot be resumed";
}

export function DetailsPanel({ item }: { item: DownloadView }) {
  return (
    <section className="details">
      <div className="details-head">
        <strong title={item.filename}>{item.filename}</strong>
        <span className={`badge badge-${item.status}`}>{STATUS_LABELS[item.status]}</span>
      </div>
      <SegmentBar item={item} />
      <dl className="details-grid">
        <dt>Address</dt>
        <dd title={item.url}>{item.url}</dd>
        <dt>Folder</dt>
        <dd title={item.dir}>{item.dir}</dd>
        <dt>Downloaded</dt>
        <dd>
          {formatBytes(item.received)} / {formatBytes(item.size)}
        </dd>
        <dt>Connection</dt>
        <dd>{connectionText(item)}</dd>
        {item.error && (
          <>
            <dt>Error</dt>
            <dd className="error-text">{item.error}</dd>
          </>
        )}
      </dl>
    </section>
  );
}
