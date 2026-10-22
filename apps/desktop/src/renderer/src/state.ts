import type { AppEvent, AppSnapshot, Category, DownloadView } from "@turbodl/shared";

export type Filter =
  | { kind: "all" }
  | { kind: "category"; category: Category }
  | { kind: "status"; status: "active" | "completed" | "queue" };

export function applyEvent(state: AppSnapshot, event: AppEvent): AppSnapshot {
  switch (event.type) {
    case "downloads": {
      const byId = new Map(state.downloads.map((d) => [d.id, d] as const));
      for (const item of event.items) byId.set(item.id, item);
      return { ...state, downloads: [...byId.values()] };
    }
    case "removed": {
      const ids = new Set(event.ids);
      return { ...state, downloads: state.downloads.filter((d) => !ids.has(d.id)) };
    }
    case "settings":
      return { ...state, settings: event.settings };
    case "bridge":
      return { ...state, bridge: event.status };
    case "countdown":
      return { ...state, countdown: event.state };
    case "instagramBackup":
      return { ...state, instagramBackup: event.backup };
    case "openSaved":
    case "openProfile":
      return state;
  }
}

export function matchesFilter(d: DownloadView, filter: Filter): boolean {
  switch (filter.kind) {
    case "all":
      return true;
    case "category":
      return d.category === filter.category;
    case "status":
      if (filter.status === "completed") return d.status === "completed";
      if (filter.status === "queue") return d.status === "queued" || d.status === "scheduled";
      return d.status !== "completed";
  }
}

export function filterDownloads(list: DownloadView[], filter: Filter): DownloadView[] {
  return list.filter((d) => matchesFilter(d, filter)).sort((a, b) => b.createdAt - a.createdAt);
}

export function sameFilter(a: Filter, b: Filter): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
