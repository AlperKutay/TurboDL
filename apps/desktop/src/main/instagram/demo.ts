import type { BrowserCookie, SavedCollection } from "@turbodl/shared";
import type { InstagramDeps } from "../controller";

export const DEMO_COOKIE: BrowserCookie = { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "demo" };

const COLLECTIONS: SavedCollection[] = [
  { id: "demo-all", name: "All posts", count: 6, isAll: true },
  { id: "demo-trips", name: "Trips", count: 3, isAll: false },
];

/**
 * Test runs only (TURBODL_USER_DATA with TURBODL_INSTAGRAM_DEMO_BASE): every link is a post of three photos served at
 * `<base>/ig/<n>.png`, signed in already as demo.user, nothing kept on disk. Saved: All holds six posts on two pages
 * (the first a carousel), "Trips" three; waits are short.
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
    find: async () => ({
      type: "items",
      items: [0, 1, 2].map((n) => ({ kind: "image" as const, url: `${base}/ig/${n}.png`, thumbnail: `${base}/ig/${n}.png`, width: 64, height: 64, mediaId: `demo${n}` })),
    }),
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
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    signOut: async () => undefined,
  };
}
