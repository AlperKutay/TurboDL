import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

/** A v1 post as Instagram's pages carry it: a carousel of photos served by the test server. */
function post(code: string, base: string, count: number) {
  return {
    code,
    pk: `${code}0`,
    carousel_media: Array.from({ length: count }, (_, n) => ({
      pk: `${code}${n + 1}`,
      image_versions2: { candidates: [{ url: `${base}/ig/${n}.png`, width: 640, height: 640 }] },
    })),
  };
}

test("reads a post from its real page in a hidden window: from the page's own JSON and from what it fetches", async () => {
  const server = await startTestServer();
  const base = server.url("").replace(/\/$/, "");
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(2048), contentType: "image/png" }));
  const page = (body: string) => ({ data: Buffer.from(`<!doctype html><html><body>${body}</body></html>`), contentType: "text/html" });
  // the signed-out page's way: the post in the page itself
  server.setFile("/p/EMBED1/", page(`<script type="application/json">${JSON.stringify({ data: { xig_polaris_media: post("EMBED1", base, 2) } })}</script>`));
  // the signed-in page's way: the post in an answer the page fetches
  server.setFile("/p/FETCH1/", page(`<script>fetch("/api/graphql").then((r) => r.text())</script>`));
  server.setFile("/api/graphql", { data: Buffer.from(JSON.stringify({ data: { items: [post("FETCH1", base, 3)] } })), contentType: "application/json" });
  // TURBODL_INSTAGRAM_SITE: the real hidden page, loading the test server in Instagram's place
  const { app, userData } = await launchApp({}, { TURBODL_INSTAGRAM_SITE: base });
  try {
    const main = await app.firstWindow();
    for (const [code, count] of [["EMBED1", 2], ["FETCH1", 3]] as const) {
      await main.getByRole("button", { name: "Add URL" }).click();
      await main.getByPlaceholder("https://…").fill(`https://www.instagram.com/p/${code}/`);
      const dialogOpened = app.waitForEvent("window");
      await main.getByRole("button", { name: "Add", exact: true }).click();
      const dialog = await dialogOpened;
      await expect(dialog.getByRole("button", { name: /^Download (all )?\d+$/ }), code).toHaveText(`Download all ${count}`, { timeout: 30_000 });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("picks two photos of an Instagram post and downloads them into the Instagram folder", async () => {
  const server = await startTestServer();
  const photos = [0, 1, 2].map(() => randomBytes(4096));
  photos.forEach((data, n) => server.setFile(`/ig/${n}.png`, { data, contentType: "image/png" }));
  // A made-up Instagram: three photos from the test server, already signed in (TURBODL_INSTAGRAM_DEMO_BASE).
  const { app, userData, baseDir } = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, "") });
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Add URL" }).click();
    await main.getByPlaceholder("https://…").fill("https://www.instagram.com/p/DEMO123/");
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = await dialogOpened;

    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 3", { timeout: 30_000 });
    await dialog.getByRole("button", { name: "Item 1", exact: true }).click();
    await dialog.getByRole("button", { name: "Item 3", exact: true }).click();
    await expect(download).toHaveText("Download 2");
    await download.click();

    const done = main.locator("tr[data-status='completed']");
    await expect(done).toHaveCount(2, { timeout: 30_000 });
    for (const n of [0, 2]) {
      const file = path.join(baseDir, "Instagram", `demo${n}.png`);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file).equals(photos[n])).toBe(true);
    }
    expect(existsSync(path.join(baseDir, "Instagram", "demo1.png"))).toBe(false);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
