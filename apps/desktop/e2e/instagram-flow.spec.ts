import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

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
