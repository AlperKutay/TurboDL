import type { BrowserCookie } from "@turbodl/shared";
import type { InstagramDeps } from "../controller";

export const DEMO_COOKIE: BrowserCookie = { domain: ".instagram.com", hostOnly: false, path: "/", secure: true, expires: 0, name: "sessionid", value: "demo" };

/**
 * Test runs only (TURBODL_USER_DATA with TURBODL_INSTAGRAM_DEMO_BASE): every link is a post of three photos served at
 * `<base>/ig/<n>.png`, signed in already, nothing kept on disk.
 */
export function demoInstagram(base: string): InstagramDeps {
  return {
    find: async () => ({
      type: "items",
      items: [0, 1, 2].map((n) => ({ kind: "image" as const, url: `${base}/ig/${n}.png`, thumbnail: `${base}/ig/${n}.png`, width: 64, height: 64, mediaId: `demo${n}` })),
    }),
    signIn: async () => [DEMO_COOKIE],
    crypt: { available: () => false, encrypt: (text) => Buffer.from(text), decrypt: (data) => data.toString() },
    agent: "",
  };
}
