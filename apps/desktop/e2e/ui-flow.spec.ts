import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startTestServer } from "../test/fixtures/test-server";
import { launchApp } from "./helpers";

test("adds a URL from the UI, confirms it in the dialog and finishes the download", async () => {
  const server = await startTestServer();
  const data = randomBytes(3 * 1024 * 1024);
  server.setFile("/files/report.pdf", { data, contentType: "application/pdf", throttle: 4 * 1024 * 1024 });
  const { app, userData, baseDir } = await launchApp();
  try {
    const main = await app.firstWindow();
    await main.getByRole("button", { name: "Add URL" }).click();
    await main.getByPlaceholder("https://…").fill(server.url("/files/report.pdf"));
    const dialogOpened = app.waitForEvent("window");
    await main.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = await dialogOpened;
    await expect(dialog.getByLabel("File name")).toHaveValue("report.pdf");
    await expect(dialog.getByText("Documents", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Download now", exact: true }).click();

    const row = main.locator("tr[data-status='completed']");
    await expect(row).toContainText("report.pdf", { timeout: 30_000 });
    const file = path.join(baseDir, "Documents", "report.pdf");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file).equals(data)).toBe(true);

    await row.click({ button: "right" });
    await expect(main.getByRole("menu")).toContainText("Show in folder");
  } finally {
    await app.close();
    await server.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
