import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

/** The demo Instagram (TURBODL_INSTAGRAM_DEMO_BASE): signed in as demo.user, All = 6 posts on 2 pages, "Trips" = 3. */
async function demo() {
  const server = await startTestServer();
  [0, 1, 2].forEach((n) => server.setFile(`/ig/${n}.png`, { data: randomBytes(3000), contentType: "image/png" }));
  const launched = await launchApp({}, { TURBODL_INSTAGRAM_DEMO_BASE: server.url("").replace(/\/$/, "") });
  return { server, ...launched };
}

test("saved: picks two posts and downloads their items", async () => {
  const { server, app, userData, baseDir } = await demo();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    await expect(main.getByText("Signed in as @demo.user")).toBeVisible({ timeout: 15_000 });
    const tiles = main.getByRole("button", { name: /^Post \d+$/ });
    await expect(tiles).toHaveCount(6, { timeout: 15_000 });

    await main.getByRole("button", { name: "Post 1", exact: true }).click();
    await main.getByRole("button", { name: "Post 2", exact: true }).click();
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Next (2)" }).click();
    const dialog = await dialogOpened;
    const download = dialog.getByRole("button", { name: /^Download (all )?\d+$/ });
    await expect(download).toHaveText("Download all 3", { timeout: 15_000 });
    await download.click();

    await main.getByRole("button", { name: "All downloads" }).click();
    await expect(main.locator("tr[data-status='completed']")).toHaveCount(3, { timeout: 30_000 });
    expect(readdirSync(path.join(baseDir, "Instagram")).sort()).toEqual(["d1a.png", "d1b.png", "d2.png"]);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("saved: a saved collection shows its own posts", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    await main.getByRole("tab", { name: /^Trips/ }).click();
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(3, { timeout: 15_000 });
    expect(existsSync(path.join(userData, "instagram-collections.json"))).toBe(true);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("saved: backs up a collection, and a run again fetches nothing new", async () => {
  const { server, app, userData, baseDir } = await demo();
  // the backup's own fetches carry Instagram as Referer; the grid's pictures don't
  const backupFetches = () => server.requests.filter((r) => r.path.startsWith("/ig/") && r.headers.referer === "https://www.instagram.com/").length;
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    await main.getByRole("tab", { name: /^Trips/ }).click();
    await expect(main.getByRole("button", { name: /^Post \d+$/ })).toHaveCount(3, { timeout: 15_000 });

    await main.getByRole("button", { name: "Back up this collection" }).click();
    const confirm = main.getByRole("dialog", { name: "Back up Trips" });
    await expect(confirm).toContainText("3 posts");
    await expect(confirm).toContainText("estimate");
    await confirm.getByRole("button", { name: "Start backup" }).click();
    const panel = main.getByRole("region", { name: "Backup" });
    await expect(panel).toContainText("Backup finished", { timeout: 30_000 });
    await expect(panel).toContainText("New 3");
    expect(readdirSync(path.join(baseDir, "Instagram", "Saved", "Trips")).sort()).toEqual(["t1.png", "t2.png", "t3.png"]);
    expect(backupFetches()).toBe(3);

    await main.getByRole("button", { name: "Back up this collection" }).click();
    await main.getByRole("dialog", { name: "Back up Trips" }).getByRole("button", { name: "Start backup" }).click();
    await expect(panel).toContainText("New 0", { timeout: 30_000 });
    await expect(panel).toContainText("Backup finished");
    expect(backupFetches()).toBe(3);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test("saved: holding a post shows it large; pointing at it doesn't, and a hold picks nothing", async () => {
  const { server, app, userData } = await demo();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Saved", exact: true }).click();
    const tile = main.getByRole("button", { name: "Post 2", exact: true });
    await expect(tile).toBeVisible({ timeout: 15_000 });
    await tile.hover();
    await main.waitForTimeout(600);
    await expect(main.locator(".ig-large")).toHaveCount(0);
    await main.mouse.down();
    await expect(main.locator(".ig-large")).toBeVisible();
    await main.mouse.up();
    await expect(main.locator(".ig-large")).toHaveCount(0);
    await expect(tile).toHaveAttribute("aria-pressed", "false");
    await tile.click();
    await expect(tile).toHaveAttribute("aria-pressed", "true");
    await expect(main.locator(".ig-large")).toHaveCount(0);
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
