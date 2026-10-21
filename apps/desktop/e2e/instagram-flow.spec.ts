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
    // pointing at an item shows nothing; holding it shows it large and picks nothing
    const second = dialog.getByRole("button", { name: "Item 2", exact: true });
    await second.hover();
    await dialog.waitForTimeout(600);
    await expect(dialog.locator(".ig-large")).toHaveCount(0);
    await dialog.mouse.down();
    await expect(dialog.locator(".ig-large")).toBeVisible();
    await dialog.mouse.up();
    await expect(dialog.locator(".ig-large")).toHaveCount(0);
    await expect(second).toHaveAttribute("aria-pressed", "false");
    await dialog.getByRole("button", { name: "Item 1", exact: true }).click();
    await dialog.getByRole("button", { name: "Item 3", exact: true }).click();
    await expect(dialog.locator(".ig-large")).toHaveCount(0);
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

test("reads a profile from its real page and pages on by re-sending the page's own request", async () => {
  const server = await startTestServer();
  const base = server.url("").replace(/\/$/, "");
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(2048), contentType: "image/png" }));
  const node = (k: number) => ({ pk: `38000000000000000${k}`, code: `C000${k}`, image_versions2: { candidates: [{ url: `${base}/ig/${k % 3}.png`, width: 640, height: 640 }] } });
  const connection = (ks: number[], cursor?: string) =>
    JSON.stringify({
      data: {
        xdt_api__v1__feed__user_timeline_graphql_connection: {
          edges: ks.map((k) => ({ node: node(k) })),
          page_info: { end_cursor: cursor ?? null, has_next_page: Boolean(cursor) },
        },
      },
    });
  const user = { pk: "5100000000000000001", username: "sample.user", full_name: "Sample User", is_private: false, media_count: 6, friendship_status: { following: true } };
  const variables = JSON.stringify({ after: "cursor-1", first: 12, username: "sample.user" });
  // the page as Instagram sends it: the profile and its first posts in the page, the next ones asked for at once
  const page = `<!doctype html><html><body>
<script type="application/json">${JSON.stringify({ data: { user } })}</script>
<script type="application/json">${connection([1, 2], "cursor-1")}</script>
<script>
const xhr = new XMLHttpRequest();
xhr.open("POST", "/api/graphql");
xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
xhr.setRequestHeader("X-FB-Friendly-Name", "PolarisProfilePostsTabContentQuery_connection");
xhr.send("variables=" + encodeURIComponent(${JSON.stringify(variables)}) + "&doc_id=1");
</script></body></html>`;
  server.setFile("/sample.user/", { data: Buffer.from(page), contentType: "text/html" });
  const answered: string[] = [];
  server.setHandler("/api/graphql", (body) => {
    const after = JSON.parse(new URLSearchParams(body).get("variables") ?? "{}").after as string;
    answered.push(after);
    return { data: Buffer.from(after === "cursor-1" ? connection([3, 4], "cursor-2") : connection([5, 6])), contentType: "text/javascript" };
  });
  const { app, userData } = await launchApp({}, { TURBODL_INSTAGRAM_SITE: base });
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Add URL" }).click();
    await main.getByPlaceholder("https://…").fill("https://www.instagram.com/sample.user/");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    await expect(main.getByText("@sample.user")).toBeVisible({ timeout: 30_000 });
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(6, { timeout: 30_000 });
    // the page's own request (cursor-1), then TurboDL's re-send of it (cursor-2)
    expect(answered).toEqual(["cursor-1", "cursor-2"]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
