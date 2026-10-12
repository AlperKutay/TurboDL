import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchWithExtension } from "../../extension/e2e/fixtures";
import { startSiteServer } from "../../extension/e2e/servers";
import { launchApp } from "./helpers";

// Real app + real extension in Chromium: the video button sends the page to the
// app over the loopback bridge, the app's media window downloads the file.
test("a video sent from the page by the extension is downloaded by the TurboDL app", async () => {
  const { app, userData, baseDir, port } = await launchApp();
  const site = await startSiteServer();
  const { context, sw } = await launchWithExtension();
  try {
    const main = await app.firstWindow();
    await sw.evaluate((p) => chrome.storage.local.set({ port: p }), port);
    const page = await context.newPage();
    await page.goto(site.url("/video.html"));
    await expect
      .poll(() => sw.evaluate(async () => (Object.values(await chrome.storage.session.get(null)) as unknown[][]).flat().length), { timeout: 15_000 })
      .toBe(2);

    const box = await page.locator("#v").boundingBox();
    const button = page.getByRole("button", { name: "⬇ TurboDL" });
    // the content script is injected at document_idle; keep hovering until it reacts
    await expect(async () => {
      await page.mouse.move(box!.x + 100 + Math.random() * 40, box!.y + 120);
      await expect(button).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 10_000 });
    const dialogOpened = app.waitForEvent("window");
    await button.click();
    const dialog = await dialogOpened;
    await expect(dialog.getByText("HLS stream")).toBeVisible();
    await dialog.getByText("Video file (mp4)").click();
    await dialog.getByRole("button", { name: "Download now", exact: true }).click();

    const file = path.join(baseDir, "Video", "Test page.mp4");
    await expect.poll(() => (existsSync(file) ? statSync(file).size : 0), { timeout: 60_000 }).toBe(1024 * 1024);
    await expect(main.locator("tr[data-status='completed']")).toContainText("Test page.mp4");
  } finally {
    await context.close();
    await app.close();
    await site.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
