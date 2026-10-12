import { describe, expect, it } from "vitest";
import type { AppSnapshot, DownloadView } from "@turbodl/shared";
import { applyEvent, filterDownloads, matchesFilter, sameFilter } from "./state";

function view(id: string, patch: Partial<DownloadView> = {}): DownloadView {
  return {
    id,
    kind: "http",
    url: `https://x/${id}`,
    filename: `${id}.zip`,
    dir: "/dl",
    category: "archives",
    size: 100,
    received: 0,
    status: "queued",
    headers: {},
    resumable: true,
    segments: [],
    viaScheduler: false,
    createdAt: 1,
    speed: 0,
    eta: null,
    connections: 0,
    ...patch,
  };
}

const snapshot = (downloads: DownloadView[]): AppSnapshot => ({
  downloads,
  settings: {} as AppSnapshot["settings"],
  bridge: { ok: true, port: 47123 },
  countdown: null,
  version: "1",
});

describe("applyEvent", () => {
  it("upserts downloads keeping order", () => {
    const s = applyEvent(snapshot([view("a"), view("b")]), { type: "downloads", items: [view("a", { received: 50 }), view("c")] });
    expect(s.downloads.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(s.downloads[0].received).toBe(50);
  });

  it("removes downloads", () => {
    const s = applyEvent(snapshot([view("a"), view("b")]), { type: "removed", ids: ["a"] });
    expect(s.downloads.map((d) => d.id)).toEqual(["b"]);
  });

  it("replaces bridge status and countdown", () => {
    let s = applyEvent(snapshot([]), { type: "bridge", status: { ok: false, port: 1, error: "x" } });
    s = applyEvent(s, { type: "countdown", state: { action: "sleep", secondsLeft: 9 } });
    expect(s.bridge.ok).toBe(false);
    expect(s.countdown?.secondsLeft).toBe(9);
  });
});

describe("filters", () => {
  const list = [
    view("a", { status: "completed", category: "video", createdAt: 1 }),
    view("b", { status: "downloading", createdAt: 3 }),
    view("c", { status: "scheduled", createdAt: 2 }),
    view("d", { status: "error", category: "music", createdAt: 4 }),
  ];

  it("filters by category and status, newest first", () => {
    expect(filterDownloads(list, { kind: "all" }).map((d) => d.id)).toEqual(["d", "b", "c", "a"]);
    expect(filterDownloads(list, { kind: "category", category: "video" }).map((d) => d.id)).toEqual(["a"]);
    expect(filterDownloads(list, { kind: "status", status: "completed" }).map((d) => d.id)).toEqual(["a"]);
    expect(filterDownloads(list, { kind: "status", status: "queue" }).map((d) => d.id)).toEqual(["c"]);
    expect(filterDownloads(list, { kind: "status", status: "active" }).map((d) => d.id)).toEqual(["d", "b", "c"]);
    expect(matchesFilter(list[0], { kind: "all" })).toBe(true);
  });

  it("compares filters", () => {
    expect(sameFilter({ kind: "category", category: "video" }, { kind: "category", category: "video" })).toBe(true);
    expect(sameFilter({ kind: "all" }, { kind: "status", status: "queue" })).toBe(false);
  });
});
