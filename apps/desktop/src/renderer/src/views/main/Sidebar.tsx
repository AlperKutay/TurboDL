import { CATEGORY_LABELS, CATEGORY_ORDER, type DownloadView } from "@turbodl/shared";
import { Icon, type IconName } from "../../components/Icon";
import { matchesFilter, sameFilter, type Filter } from "../../state";
import { CATEGORY_ICONS } from "../../ui";

const STATUS_FILTERS: { filter: Filter; label: string; icon: IconName }[] = [
  { filter: { kind: "status", status: "active" }, label: "Active", icon: "download" },
  { filter: { kind: "status", status: "completed" }, label: "Completed", icon: "check" },
  { filter: { kind: "status", status: "queue" }, label: "Queue", icon: "queue" },
];

/** What the main window shows: the downloads (filtered) or Instagram's Saved section. */
export type Section = "downloads" | "saved";

export function Sidebar({
  downloads,
  filter,
  section,
  onChange,
  onSection,
}: {
  downloads: DownloadView[];
  filter: Filter;
  section: Section;
  onChange(f: Filter): void;
  onSection(s: Section): void;
}) {
  const item = (f: Filter, label: string, icon: IconName) => (
    <button key={label} type="button" className={`side-item${section === "downloads" && sameFilter(f, filter) ? " active" : ""}`} onClick={() => onChange(f)}>
      <Icon name={icon} />
      <span className="side-label">{label}</span>
      <span className="count">{downloads.filter((d) => matchesFilter(d, f)).length}</span>
    </button>
  );
  return (
    <nav className="sidebar">
      {item({ kind: "all" }, "All downloads", "list")}
      <div className="side-title">Categories</div>
      {CATEGORY_ORDER.map((c) => item({ kind: "category", category: c }, CATEGORY_LABELS[c], CATEGORY_ICONS[c]))}
      <div className="side-title">Status</div>
      {STATUS_FILTERS.map((s) => item(s.filter, s.label, s.icon))}
      <div className="side-title">Instagram</div>
      <button type="button" className={`side-item${section === "saved" ? " active" : ""}`} onClick={() => onSection("saved")}>
        <Icon name="bookmark" />
        <span className="side-label">Saved</span>
      </button>
    </nav>
  );
}
