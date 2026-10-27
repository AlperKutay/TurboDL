/** Version of the local jobs API; clients check it against `api.json`. */
export const API_VERSION = 1;
/** Name of the file in the user data folder that tells clients how to reach the app. */
export const API_FILE = "api.json";

export type JobKind =
  | "file"
  | "media"
  | "instagramPost"
  | "instagramStory"
  | "instagramHighlight"
  | "instagramProfile"
  | "instagramSaved";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobReason = "signInRequired" | "rateLimited" | "private" | "notFound" | "unsupported" | "stopped" | "error";

/** Per-job switches; each applies only to the kinds it makes sense for. */
export interface JobOptions {
  highlights?: boolean;
  highlightsOnly?: boolean;
  collections?: string[];
  allCollections?: boolean;
  audio?: boolean;
  maxHeight?: number;
}

/** What a client sends to start a job. */
export interface JobRequest {
  url: string;
  dir?: string;
  name?: string;
  options?: JobOptions;
}

export interface JobProgress {
  done: number;
  total?: number;
  bytes?: number;
  totalBytes?: number;
  speed?: number;
  /** what the job is doing, in words, when the counts don't say it */
  note?: string;
}

export interface Job {
  id: string;
  url: string;
  kind: JobKind;
  state: JobState;
  reason?: JobReason;
  error?: string;
  limited?: boolean;
  warnings: string[];
  files: string[];
  failedItems: number;
  progress: JobProgress;
  createdAt: number;
  endedAt?: number;
}

export type JobEventBody =
  | { type: "job"; job: Job }
  | { type: "state"; state: JobState }
  | { type: "progress"; progress: JobProgress }
  | { type: "file"; path: string; existing?: boolean }
  | { type: "warning"; message: string }
  | { type: "end"; job: Job };
export type JobEvent = JobEventBody & { jobId: string };

export interface ApiInfo {
  app: string;
  version: string;
  api: number;
  instagram: { signedIn: boolean; username?: string };
}

/** The command that starts the app in the background. */
export interface ApiLaunch {
  file: string;
  args: string[];
}

/** Contents of `api.json`. */
export interface ApiFile {
  api: number;
  version: string;
  port: number | null;
  /** the app's own message while `port` is null (the port is taken); absent while the port is open */
  error?: string;
  token: string;
  launch: ApiLaunch;
}

export interface InstagramLoginResult {
  signedIn: boolean;
  username?: string;
}

/** done, failed or cancelled */
export function isJobEnded(state: JobState): boolean {
  return state === "done" || state === "failed" || state === "cancelled";
}
