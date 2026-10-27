import { SavedError, type BrowserCookie, type Highlight, type InstagramProfile, type SavedCollection, type SavedPost } from "@turbodl/shared";
import type { InstagramDeps } from "../controller";

export const DEMO_COOKIE: BrowserCookie = { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "demo" };

const COLLECTIONS: SavedCollection[] = [
  { id: "demo-all", name: "All posts", count: 6, isAll: true },
  { id: "demo-trips", name: "Trips", count: 3, isAll: false },
];

/** demo.public's post that Instagram shows only to signed-in visitors */
const SIGN_IN_ONLY = "DP5";

/** The profile seen signed out a post's code belongs to: demo.public's DP…, demo.open's DO…. */
function signedOutOwner(code: string): string | undefined {
  return code.startsWith("DP") ? "demo.public" : code.startsWith("DO") ? "demo.open" : undefined;
}

/**
 * Test runs only (TURBODL_USER_DATA with TURBODL_INSTAGRAM_DEMO_BASE): every link is a post of three photos served at
 * `<base>/ig/<n>.png`, signed in already as demo.user (unless TURBODL_INSTAGRAM_DEMO_SIGNED_OUT), nothing kept on disk.
 * Saved: All holds six posts on two pages (the first a carousel), "Trips" three; profiles demo.person (with two
 * highlights), demo.locked, demo.plain, and two as signed-out visitors see them, with or without the session:
 * demo.public (seven posts on three pages; two highlights, the second on the tray's next page) and demo.open (three
 * posts on two pages, none hidden, no highlights). demo.public's DP5 answers signInOnly whatever the cookies are, as
 * if Instagram showed it only to signed-in visitors. Waits are short.
 */
export function demoInstagram(base: string): InstagramDeps {
  const picture = (n: number) => ({ candidates: [{ url: `${base}/ig/${n}.png`, width: 640, height: 640 }] });
  const photo = (pk: string, n: number) => ({ pk, code: `D${pk}`, image_versions2: picture(n) });
  const all = [
    [{ ...photo("d1", 0), carousel_media: [photo("d1a", 0), photo("d1b", 1)] }, photo("d2", 1), photo("d3", 2)],
    [photo("d4", 0), photo("d5", 1), photo("d6", 2)],
  ];
  const trips = [photo("t1", 2), photo("t2", 1), photo("t3", 0)];
  const feed = (posts: object[], next?: string) => JSON.stringify({ items: posts.map((media) => ({ media })), more_available: Boolean(next), ...(next ? { next_max_id: next } : {}), status: "ok" });
  return {
    find: async (link) => {
      if (link.kind === "highlight" && link.id === "17900000000000099") return { type: "signedOut" };
      if (link.kind === "post" && link.code === SIGN_IN_ONLY) return { type: "signInOnly" };
      const owner = link.kind === "post" ? signedOutOwner(link.code) : undefined;
      return {
        type: "items",
        // a highlight's two stories, named after it; the signed-out profiles' posts (DP…, DO…) two photos of that account; any other link three photos
        items:
          link.kind === "post" && owner
            ? [1, 2].map((n) => ({ kind: "image" as const, url: `${base}/ig/${n}.png`, thumbnail: `${base}/ig/${n}.png`, mediaId: `${link.code}-${n}`, owner }))
            : link.kind === "highlight"
            ? [1, 2].map((n) => ({ kind: "image" as const, url: `${base}/ig/${n}.png`, thumbnail: `${base}/ig/${n}.png`, mediaId: `h${link.id}-${n}` }))
            : [0, 1, 2].map((n) => ({ kind: "image" as const, url: `${base}/ig/${n}.png`, thumbnail: `${base}/ig/${n}.png`, width: 64, height: 64, mediaId: `demo${n}` })),
      };
    },
    signIn: async () => [DEMO_COOKIE],
    crypt: { available: () => false, encrypt: (text) => Buffer.from(text), decrypt: (data) => data.toString() },
    agent: "",
    get: async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("/web_form_data/")) return { status: 200, body: JSON.stringify({ form_data: { username: "demo.user" }, status: "ok" }) };
      if (u.pathname.includes("/feed/collection/")) return { status: 200, body: feed(trips) };
      return { status: 200, body: u.searchParams.get("max_id") === "page2" ? feed(all[1]) : feed(all[0], "page2") };
    },
    collections: async () => COLLECTIONS,
    openProfile: (username) => {
      const post = (k: number): SavedPost => ({ id: `p${k}`, cover: `${base}/ig/${k % 3}.png`, items: [{ kind: "image", url: `${base}/ig/${k % 3}.png`, mediaId: `p${k}` }], ...(k === 1 ? { pinned: true } : {}) });
      const cover = (code: string, mediaType: number): SavedPost => ({ id: `${code}-post`, code, cover: `${base}/ig/0.png`, items: [], unread: true, mediaType });
      const profiles: Record<string, { profile: InstagramProfile; pages: SavedPost[][]; highlights?: Highlight[]; moreHighlights?: Highlight[]; limited?: boolean }> = {
        "demo.person": {
          profile: { id: "5100000000000000007", username: "demo.person", fullName: "Demo Person", isPrivate: false, following: true, postCount: 6 },
          pages: [[post(1), post(2), post(3)], [post(4), post(5), post(6)]],
          highlights: [
            { id: "17900000000000002", title: "Summer", cover: `${base}/ig/1.png` },
            { id: "17900000000000003", title: "Winter", cover: `${base}/ig/2.png` },
          ],
        },
        "demo.expired": {
          profile: { id: "5100000000000000010", username: "demo.expired", fullName: "Demo Expired", isPrivate: false, following: true, postCount: 1 },
          pages: [[post(1)]],
          highlights: [{ id: "17900000000000099", title: "Gone", cover: `${base}/ig/0.png` }],
        },
        // seen signed out: covers only, each read from its own page; Instagram doesn't say how many posts it holds
        "demo.public": {
          profile: { id: "5100000000000000011", username: "demo.public", fullName: "Demo Public", isPrivate: false, following: false },
          pages: [
            [cover("DP1", 8), cover("DP2", 2), cover("DP3", 1)],
            [cover("DP4", 1), cover(SIGN_IN_ONLY, 1), cover("DP6", 8)],
            [cover("DP7", 1)],
          ],
          highlights: [{ id: "17900000000000005", title: "Trips", cover: `${base}/ig/1.png` }],
          moreHighlights: [{ id: "17900000000000006", title: "Food", cover: `${base}/ig/2.png` }],
          limited: true,
        },
        // seen signed out too, every post shown to signed-out visitors
        "demo.open": {
          profile: { id: "5100000000000000012", username: "demo.open", fullName: "Demo Open", isPrivate: false, following: false },
          pages: [[cover("DO1", 1), cover("DO2", 8)], [cover("DO3", 1)]],
          limited: true,
        },
        "demo.plain": {
          profile: { id: "5100000000000000009", username: "demo.plain", fullName: "Demo Plain", isPrivate: false, following: true, postCount: 3 },
          pages: [[post(1), post(2), post(3)]],
        },
        "demo.locked": {
          profile: { id: "5100000000000000008", username: "demo.locked", fullName: "Demo Locked", isPrivate: true, following: false, postCount: 4 },
          pages: [[]],
        },
      };
      const found = profiles[username];
      // the tray as read so far, and its one next page until it is read (a signed-out tray), as ProfileFeed keeps them
      let highlights = found?.highlights ?? [];
      let trayCursor = found?.moreHighlights ? "tray2" : undefined;
      return {
        profile: async () => {
          if (!found) throw new SavedError("badAnswer");
          return found.profile;
        },
        get highlights() {
          return highlights;
        },
        limited: found?.limited === true,
        get trayCursor() {
          return trayCursor;
        },
        page: async (cursor) => {
          const k = cursor ? Number(cursor) : 0;
          return { posts: found?.pages[k] ?? [], ...(found && k + 1 < found.pages.length ? { next: String(k + 1) } : {}) };
        },
        moreHighlights: async () => {
          const more = trayCursor ? (found?.moreHighlights ?? []) : null;
          trayCursor = undefined;
          if (more) highlights = [...highlights, ...more];
          return more;
        },
        close: () => undefined,
      };
    },
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    signOut: async () => undefined,
  };
}
