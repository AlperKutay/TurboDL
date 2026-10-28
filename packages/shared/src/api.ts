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
  /** a profile: list its posts instead of downloading them */
  postsOnly?: boolean;
  /** a profile: only posts taken at or after this time (ISO 8601) */
  since?: string;
  /** a profile: at most this many posts */
  limit?: number;
  /** a profile's posts a client already holds, by code: they are listed as known and not read again */
  known?: string[];
}

/** One photo or video of a listed post. */
export interface InstagramPostItem {
  kind: "image" | "video";
  url: string;
  mediaId?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/** A profile post as a listing reports it. */
export interface InstagramPostInfo {
  code: string;
  url: string;
  /** ISO 8601, or null when the page gave no time */
  takenAt: string | null;
  pinned: boolean;
  owner: string | null;
  caption?: string;
  taggedUsers: string[];
  /** shown only to signed-in visitors */
  signInOnly?: true;
  /** one the client listed in `known`: not read again */
  known?: true;
  items: InstagramPostItem[];
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
  | { type: "post"; post: InstagramPostInfo }
  | { type: "warning"; message: string }
  | { type: "end"; job: Job };
export type JobEvent = JobEventBody & { jobId: string };

export interface ApiInfo {
  app: string;
  version: string;
  api: number;
  instagram: { signedIn: boolean; username?: string };
  /** what this app version can do beyond the base API, so clients can tell */
  features: string[];
}

/** The features this version reports in `ApiInfo.features`. */
export const API_FEATURES: readonly string[] = ["posts"];

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
