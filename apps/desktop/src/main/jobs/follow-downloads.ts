import path from "node:path";
import type { DownloadRecord, DownloadView } from "@turbodl/shared";
import type { DownloadManager } from "../manager";
import type { JobRecord } from "./job-record";

/** How following a job's downloads ended. */
export type FollowOutcome = { type: "completed" } | { type: "error"; message: string } | { type: "stopped"; message: string } | { type: "cancelled" };

const PAUSED = "A download was paused in TurboDL.";
const REMOVED = "A download was removed in TurboDL.";

/** Follows the downloads `ids` until each one has ended; reports their files and progress on `job`. */
export function followDownloads(manager: DownloadManager, ids: string[], job: JobRecord): Promise<FollowOutcome> {
  return new Promise((resolve) => {
    const wanted = new Set(ids);
    const latest = new Map<string, DownloadView>();
    const completed = new Set<string>();
    const removed = new Set<string>();
    const errors = new Map<string, string>();
    let settled = false;

    const detach = () => {
      manager.off("update", onUpdate);
      manager.off("removed", onRemoved);
      manager.off("completed", onCompleted);
      job.signal.removeEventListener("abort", onAbort);
    };
    const settle = (outcome: FollowOutcome) => {
      if (settled) return;
      settled = true;
      detach();
      resolve(outcome);
    };
    const reportProgress = () => {
      let bytes = 0;
      let totalBytes = 0;
      let sizesKnown = true;
      let speed = 0;
      for (const id of ids) {
        const view = latest.get(id);
        if (!view) {
          sizesKnown = false;
          continue;
        }
        bytes += view.received;
        speed += view.speed;
        if (view.size === null) sizesKnown = false;
        else totalBytes += view.size;
      }
      job.progress({ done: completed.size, total: ids.length, bytes, ...(sizesKnown ? { totalBytes } : {}), speed });
    };
    const finishIfEnded = () => {
      if (settled) return;
      reportProgress();
      if (completed.size + errors.size + removed.size < wanted.size) return;
      const first = errors.values().next();
      settle(first.done ? { type: "completed" } : { type: "error", message: first.value });
    };
    const see = (record: DownloadRecord) => {
      if (settled || !wanted.has(record.id) || completed.has(record.id) || removed.has(record.id)) return;
      if (manager.isRemoving(record.id)) return; // a removal pauses the task first; its `removed` event follows
      if (record.status === "paused") {
        settle({ type: "stopped", message: PAUSED });
      } else if (record.status === "completed") {
        errors.delete(record.id);
        completed.add(record.id);
        job.file(path.join(record.dir, record.filename));
      } else if (record.status === "error") {
        errors.set(record.id, record.error ?? "The download failed.");
      } else {
        errors.delete(record.id);
      }
    };
    function onUpdate(views: DownloadView[]): void {
      for (const view of views) {
        if (!wanted.has(view.id)) continue;
        latest.set(view.id, view);
        see(view);
      }
      finishIfEnded();
    }
    function onCompleted(record: DownloadRecord): void {
      const view = manager.list().find((v) => v.id === record.id);
      if (view) latest.set(record.id, view);
      see(record);
      finishIfEnded();
    }
    function onRemoved(removedIds: string[]): void {
      if (removedIds.some((id) => wanted.has(id))) settle({ type: "stopped", message: REMOVED });
    }
    function onAbort(): void {
      if (settled) return;
      settled = true;
      detach();
      const unfinished = ids.filter((id) => !completed.has(id));
      manager.remove(unfinished, true).then(
        () => resolve({ type: "cancelled" }),
        () => resolve({ type: "cancelled" }),
      );
    }

    if (job.signal.aborted) {
      settled = true;
      const unfinished = ids.filter((id) => manager.get(id)?.status !== "completed");
      manager.remove(unfinished, true).then(
        () => resolve({ type: "cancelled" }),
        () => resolve({ type: "cancelled" }),
      );
      return;
    }

    manager.on("update", onUpdate);
    manager.on("removed", onRemoved);
    manager.on("completed", onCompleted);
    job.signal.addEventListener("abort", onAbort);

    // downloads that ended before we started listening still count
    const views = new Map(manager.list().map((v) => [v.id, v]));
    for (const id of ids) {
      const view = views.get(id);
      if (!view) {
        removed.add(id);
        continue;
      }
      latest.set(id, view);
      see(view);
    }
    if (removed.size > 0) settle({ type: "stopped", message: REMOVED });
    else finishIfEnded();
  });
}
