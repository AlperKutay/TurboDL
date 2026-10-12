import type { DownloadRecord } from "@turbodl/shared";

/** A running unit of work for one download record. */
export interface TaskHandle {
  readonly record: DownloadRecord;
  readonly speed: number;
  readonly eta: number | null;
  readonly connections: number;
  readonly note: string | undefined;
  /** Runs until completed, paused or failed. Never rejects; sets record.status. */
  start(): Promise<void>;
  pause(): void;
}
