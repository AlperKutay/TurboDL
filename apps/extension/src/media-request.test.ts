import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildMediaRequest } from "./media-request";

beforeEach(() => {
  vi.stubGlobal("chrome", {
    cookies: {
      getAll: async ({ url }: { url: string }) =>
        url.startsWith("https://www.youtube.com/")
          ? [
              { domain: ".youtube.com", hostOnly: false, path: "/", secure: true, httpOnly: true, session: false, expirationDate: 1999999999.5, name: "SID", value: "x", storeId: "0", sameSite: "no_restriction" },
              { domain: "www.youtube.com", hostOnly: true, path: "/", secure: false, httpOnly: false, session: true, name: "PREF", value: "y", storeId: "0", sameSite: "lax" },
            ]
          : [],
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildMediaRequest", () => {
  it("sends the page's cookies with their domains and flags, so the app can sign in to the video site", async () => {
    const req = await buildMediaRequest("https://www.youtube.com/watch?v=1", "Clip", [{ url: "https://cdn.example/a.m3u8", kind: "hls" }]);
    expect(req.cookieJar).toEqual([
      { domain: ".youtube.com", hostOnly: false, path: "/", secure: true, expires: 1999999999, name: "SID", value: "x", httpOnly: true, sameSite: "no_restriction" },
      { domain: "www.youtube.com", hostOnly: true, path: "/", secure: false, expires: 0, name: "PREF", value: "y", httpOnly: false, sameSite: "lax" },
    ]);
    expect(req).toMatchObject({ pageUrl: "https://www.youtube.com/watch?v=1", title: "Clip", cookies: "SID=x; PREF=y", referrer: "https://www.youtube.com/watch?v=1" });
    expect(req.items).toEqual([{ url: "https://cdn.example/a.m3u8", kind: "hls", cookies: undefined }]);
  });
});
