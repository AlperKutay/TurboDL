import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ReportWriterOptions {
  /** how many of its own reports the folder keeps, the newest (default 5) */
  keep?: number;
  /** the report's time, in ms */
  now?: () => number;
  /** where a report that can't be written is told (default: console.warn) */
  warn?: (message: string, err: unknown) => void;
}

/**
 * What an Instagram page held when nothing readable was on it, as `<folder>/<time><suffix>` (`{ url, documents }`).
 * Only the newest `keep` reports with that suffix stay; other files in the folder are left alone. Never throws: a
 * report that can't be written doesn't change why the page failed.
 */
export function reportWriter(folder: string, suffix: string, o: ReportWriterOptions = {}): (url: string, documents: string[]) => void {
  const keep = o.keep ?? 5;
  return (url, documents) => {
    try {
      mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, `${(o.now ?? Date.now)()}${suffix}`), JSON.stringify({ url, documents }));
      const reports = readdirSync(folder)
        .filter((name) => name.endsWith(suffix) && /^\d+$/.test(name.slice(0, -suffix.length)))
        .map((name) => ({ name, time: Number(name.slice(0, -suffix.length)) }))
        .sort((a, b) => b.time - a.time);
      for (const old of reports.slice(keep)) rmSync(path.join(folder, old.name), { force: true });
    } catch (err) {
      (o.warn ?? console.warn)("Could not write the Instagram report:", err);
    }
  };
}
