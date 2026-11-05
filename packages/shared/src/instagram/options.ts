import type { JobOptions } from "../api";
import { parseInstagramLink } from "./links";

/** Same values as `InstagramItem.kind` (named apart from the capture protocol's `MediaKind`). */
export type InstagramMediaKind = "image" | "video";
export const MEDIA_KINDS: readonly InstagramMediaKind[] = ["image", "video"];

/** What a profile backup saves: which parts of the account, and which kinds of media. */
export interface ProfileSaveOptions {
  posts: boolean;
  highlights: boolean;
  tagged: boolean;
  photos: boolean;
  videos: boolean;
}

export const DEFAULT_SAVE_OPTIONS: ProfileSaveOptions = { posts: true, highlights: true, tagged: true, photos: true, videos: true };

/** Whether backups can save tagged posts at all. */
export const TAGGED_AVAILABLE = true;

export function mediaKinds(o: { photos: boolean; videos: boolean }): InstagramMediaKind[] {
  const kinds: InstagramMediaKind[] = [];
  if (o.photos) kinds.push("image");
  if (o.videos) kinds.push("video");
  return kinds;
}

/** Null when a backup can start with these options; otherwise the reason it cannot. */
export function saveOptionsProblem(o: ProfileSaveOptions): string | null {
  if (!o.posts && !o.highlights && !o.tagged) return "Pick at least one of posts, highlights and tagged posts.";
  if (!o.photos && !o.videos) return "Pick photos, videos or both.";
  return null;
}

/** What a backup really does: tagged posts only with a session and while they are available. */
export function effectiveSaveOptions(o: ProfileSaveOptions, signedIn: boolean): ProfileSaveOptions {
  return { ...o, tagged: o.tagged && signedIn && TAGGED_AVAILABLE };
}

/** The job options for these save options: only what differs from a profile job's defaults (posts, photos and videos on; highlights and tagged off). */
export function saveJobOptions(o: ProfileSaveOptions): JobOptions {
  const out: JobOptions = {};
  if (!o.posts) out.posts = false;
  if (o.highlights) out.highlights = true;
  if (o.tagged) out.tagged = true;
  if (!o.photos) out.photos = false;
  if (!o.videos) out.videos = false;
  return out;
}

/** The username in a profile link or in what was typed (`@` or not), lowercased; null for anything else. */
export function profileName(text: string): string | null {
  const typed = text.trim();
  if (/^https?:\/\//i.test(typed)) {
    const link = parseInstagramLink(typed);
    return link?.kind === "profile" ? link.username : null;
  }
  const name = typed.replace(/^@/, "");
  return /^[a-z0-9._]{1,30}$/i.test(name) ? name.toLowerCase() : null;
}

/** The link to a profile's page. */
export function profileUrl(name: string): string {
  return `https://www.instagram.com/${encodeURIComponent(name)}/`;
}
