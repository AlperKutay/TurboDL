import { writeFileSync } from "node:fs";
import { SavedError, type Highlight, type InstagramItem, type InstagramProfile, type PostDetails, type SavedPost } from "@turbodl/shared";
import type { InstagramDeps } from "../../src/main/controller";
import type { HttpGet } from "../../src/main/instagram/saved-client";

/** Profile pages stood in for: each username's profile, its pages of posts, its highlights (one, unless given). */
export function fakeProfiles(profiles: Record<string, { profile: InstagramProfile; pages: SavedPost[][]; highlights?: Highlight[] }>, o: { hangFetch?: boolean } = {}) {
  let now = 0;
  const opened: string[] = [];
  const closed: string[] = [];
  /** each page asked of a profile, with the fake clock's time */
  const asked: { username: string; cursor?: string; at: number }[] = [];
  const fetched: string[] = [];
  const deps: InstagramDeps = {
    find: async () => ({ type: "nothing" }),
    signIn: async () => null,
    crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
    agent: "TestAgent/1",
    get: async (url) => {
      asked.push({ username: "saved", cursor: url, at: now });
      return { status: 200, body: JSON.stringify({ items: [], more_available: false, status: "ok" }) };
    },
    wait: async (ms) => {
      now += ms;
    },
    now: () => now,
    fetch: async (url, file, { signal }) => {
      fetched.push(url);
      if (o.hangFetch) await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Cancelled."))));
      writeFileSync(file, "x");
    },
    openProfile: (username) => {
      opened.push(username);
      const found = profiles[username];
      return {
        profile: async () => {
          if (!found) throw new SavedError("badAnswer");
          return found.profile;
        },
        highlights: found?.highlights ?? [{ id: "17900000000000002", title: "Summer" }],
        limited: false,
        page: async (cursor) => {
          asked.push({ username, cursor, at: now });
          const k = cursor ? Number(cursor) : 0;
          return { posts: found?.pages[k] ?? [], ...(found && k + 1 < found.pages.length ? { next: String(k + 1) } : {}) };
        },
        moreHighlights: async () => null,
        close: () => closed.push(username),
      };
    },
  };
  return { deps, opened, closed, asked, fetched };
}

/** sample.user as signed-out visitors see it: public, not followed. */
export const PUBLIC_PROFILE: InstagramProfile = { id: "5100000000000000001", username: "sample.user", fullName: "Sample User", isPrivate: false, following: false };

/** A post a profile's page shows signed out: only its cover, its items read from its own page. */
export const signedOutCover = (id: string, code: string): SavedPost => ({ id, code, cover: `https://cdn.example/${id}.jpg`, items: [], unread: true, mediaType: 8 });

/** A post's page that shows its details too, for `fakeSignedOut`. */
export interface DetailedPage {
  items: InstagramItem[];
  details: PostDetails;
}

/**
 * A public profile seen signed out (covers only: `listing`, page by page; p1 and p2 on one page unless given), and
 * post or highlight pages that show `pages[code or id]` (a post's with its details when given). Its clock moves only
 * when something waits.
 */
export function fakeSignedOut(pages: Record<string, InstagramItem[] | DetailedPage>, o: { listing?: SavedPost[][]; profile?: InstagramProfile; tray?: Highlight[][] } = {}) {
  let now = 0;
  const listing = o.listing ?? [[signedOutCover("p1", "C1"), signedOutCover("p2", "C2")]];
  const tray = o.tray ?? [[{ id: "17900000000000002", title: "Summer" }]];
  /** the clock's time at each further page of the tray asked for */
  const trayAsked: number[] = [];
  const opened: { username: string; cookies: string[] }[] = [];
  const closed: string[] = [];
  const read: string[] = [];
  /** each page of the listing asked for, with the fake clock's time */
  const asked: { cursor?: string; at: number }[] = [];
  const deps: InstagramDeps = {
    find: async (link) => {
      const key = link.kind === "post" ? link.code : link.kind === "highlight" ? link.id : link.kind;
      read.push(key);
      const found = pages[key];
      if (!found) return { type: "nothing" };
      return Array.isArray(found) ? { type: "items", items: found } : { type: "items", items: found.items, details: found.details };
    },
    signIn: async () => null,
    crypt: { available: () => false, encrypt: (t: string) => Buffer.from(t), decrypt: (b: Buffer) => b.toString() },
    agent: "TestAgent/1",
    wait: async (ms) => {
      now += ms;
    },
    now: () => now,
    fetch: async (_url, file) => writeFileSync(file, "x"),
    openProfile: (username, cookies) => {
      opened.push({ username, cookies: cookies.map((c) => c.name) });
      let shown = 0;
      return {
        profile: async () => o.profile ?? PUBLIC_PROFILE,
        // the tray read so far, as the real feed keeps it
        get highlights() {
          return tray.slice(0, shown + 1).flat();
        },
        limited: true,
        get trayCursor() {
          return shown + 1 < tray.length ? String(shown + 1) : undefined;
        },
        page: async (cursor) => {
          asked.push({ cursor, at: now });
          const k = cursor ? Number(cursor) : 0;
          return { posts: listing[k] ?? [], ...(k + 1 < listing.length ? { next: String(k + 1) } : {}) };
        },
        moreHighlights: async () => {
          if (shown + 1 >= tray.length) return null;
          trayAsked.push(now);
          return tray[++shown];
        },
        close: () => closed.push(username),
      };
    },
  };
  return { deps, opened, closed, read, asked, trayAsked };
}

/**
 * Instagram's answers for Saved stood in for: the account is sample.user, and every feed answers `posts` on one page
 * (the first feed a 429 with `limitFirst`); `sent` hears every request.
 */
export function savedGet(posts: object[], o: { limitFirst?: boolean; sent?: (url: string) => void } = {}): HttpGet {
  let feeds = 0;
  return async (url) => {
    o.sent?.(url);
    if (url.endsWith("/web_form_data/")) return { status: 200, body: JSON.stringify({ form_data: { username: "sample.user" }, status: "ok" }) };
    if (o.limitFirst && feeds++ === 0) return { status: 429, body: "" };
    return { status: 200, body: JSON.stringify({ items: posts.map((media) => ({ media })), more_available: false, status: "ok" }) };
  };
}
